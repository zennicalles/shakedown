import { describe, expect, it } from 'vitest'
import { run, RunState, setTracingDisabled, UserError } from '@openai/agents'
import { formatReport, isSimulatedCrash, runScenario, type FaultResult, type Report, type Scenario } from '../../src/index.js'
import { TERMINAL_STATE_ERROR, approvalScenario, jobSignal, makeWorld, MAX_TURNS, refundScenario, type World } from './harness.js'
import { ReactiveRefundModel, TASK } from './mock-model.js'

setTracingDisabled(true)

type Verdict = 'pass' | 'fail' | 'miss'

/**
 * Observed with @openai/agents 0.21.0 + the reactive mock model, naive tools.
 * Both scenarios give the same table; job-redelivery passes for different
 * reasons in each (see the tests below).
 */
const NAIVE_EXPECTED: Record<string, Verdict> = {
  'baseline (no fault)': 'pass',
  'error-before-commit on refund': 'pass',
  'timeout-after-commit on refund': 'fail',
  'duplicate-delivery on refund': 'fail',
  'crash-after-commit on refund': 'fail',
  'error-before-commit on send_email': 'pass',
  'timeout-after-commit on send_email': 'fail',
  'duplicate-delivery on send_email': 'fail',
  'crash-after-commit on send_email': 'fail',
  'job-redelivery': 'pass',
}

const SDK_GENERIC_TOOL_ERROR = 'An error occurred while running the tool. Please try again.'

async function shake(scenario: Scenario<World>) {
  const report = await runScenario(scenario)
  console.log(formatReport(report))
  const byLabel = new Map(report.results.map((r) => [r.label, r]))
  return { report, get: (label: string) => byLabel.get(label)! }
}

const verdicts = (r: Report<World>) =>
  Object.fromEntries(r.results.map((x) => [x.label, x.faultNotTriggered ? 'miss' : x.passed ? 'pass' : 'fail']))

function expectNaiveTable(report: Report<World>) {
  expect(verdicts(report)).toEqual(NAIVE_EXPECTED)
  expect(report.passed).toBe(false)
}

/** crashSignal() is passed as the run's AbortSignal, so the SDK stops on a crash instead of swallowing it. */
function expectCrashesStopTheRun(report: Report<World>) {
  const crashes = report.results.filter((r) => r.fault?.kind === 'crash-after-commit')
  expect(crashes).toHaveLength(2)
  for (const c of crashes) expect(c.crashSwallowed).toBe(false)
}

function modelSaw(w: World, tool: string): string[] {
  return [...(w.model as ReactiveRefundModel).observedResults.values()].filter((o) => o.name === tool).map((o) => o.output)
}

const resumeTools = (r: FaultResult<World>) => r.calls.filter((c) => c.phase === 'resume').map((c) => c.tool)

describe('scenario 1: run() with a durable Session, a fresh worker reruns the job after a crash or redelivery', () => {
  it('naive tools: every after-commit fault duplicates a side effect', async () => {
    const { report, get } = await shake(refundScenario({ fixed: false }))
    expectNaiveTable(report)
    expectCrashesStopTheRun(report)

    // The model never sees the real error, only the SDK's generic retry prompt.
    const timeout = get('timeout-after-commit on refund')
    expect(modelSaw(timeout.world, 'refund')[0]).toBe(SDK_GENERIC_TOOL_ERROR)
    expect(timeout.world.stripe.listRefunds('ch_1')).toHaveLength(2)

    // Non-streaming run() wrote nothing to the Session before the crash (the SDK's
    // checkpoint-on-abort writes were made by the dead process and dropped), so the
    // rerun starts from scratch: lookup_charge runs again in the resume phase.
    const crash = get('crash-after-commit on send_email')
    expect(crash.world.session.droppedWrites).toBeGreaterThan(0)
    expect(resumeTools(crash)).toEqual(['lookup_charge', 'refund', 'send_email'])
  })

  it('naive tools: a redelivered completed job makes no tool calls, because the Session holds the finished run', async () => {
    // Depends on the model: the mock reads the history the SDK sends and sees every step done.
    const { get } = await shake(refundScenario({ fixed: false }))
    const redelivery = get('job-redelivery')
    expect(redelivery.passed).toBe(true)
    expect(redelivery.world.workers).toBe(2)
    expect(resumeTools(redelivery)).toEqual([])
    expect(redelivery.agentError).toBeUndefined()
  })

  it('ledger + downstream key: every fault passes with a volatile ledger', async () => {
    const { report, get } = await shake(refundScenario({ fixed: true }))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    expectCrashesStopTheRun(report)

    // The retry after the timeout reaches Stripe again and is replayed by the Idempotency-Key.
    const timeout = get('timeout-after-commit on refund')
    expect(timeout.dedupes).toBe(1)
    expect(timeout.calls.filter((c) => c.tool === 'refund').map((c) => [c.committed, !!c.deduped])).toEqual([
      [true, false],
      [false, true],
    ])
    // After the crash the ledger was wiped with the process; the fresh worker's refund is a key replay.
    const crash = get('crash-after-commit on send_email')
    expect(crash.calls.filter((c) => c.phase === 'resume' && c.effect === 'write').every((c) => c.deduped)).toBe(true)
    expect(crash.dedupes).toBe(2)
  })
})

describe('scenario 2: refund needsApproval, RunState persisted at the interruption and resumed', () => {
  it('naive tools: approval does not prevent duplicates; resume re-executes the approved refund', async () => {
    const { report, get } = await shake(approvalScenario({ fixed: false }))
    // The worker follows the SDK's "start a new run" hint on redelivery, so the redelivered job
    // really runs again: with naive tools that is a second refund and a second email.
    expect(verdicts(report)).toEqual({ ...NAIVE_EXPECTED, 'job-redelivery': 'fail' })
    expect(report.passed).toBe(false)
    expectCrashesStopTheRun(report)

    // Timeout after commit: the model retries, the retry needs a NEW approval, the human approves it.
    const timeout = get('timeout-after-commit on refund')
    expect(timeout.world.approvals).toHaveLength(2)
    expect(timeout.world.stripe.listRefunds('ch_1')).toHaveLength(2)

    // Crash after the approved refund committed: the last durable checkpoint is the
    // approved RunState, and run(agent, state) executes the approved call again
    // without asking the human a second time.
    const crash = get('crash-after-commit on refund')
    expect(crash.world.approvals).toHaveLength(1)
    expect(resumeTools(crash)).toEqual(['refund', 'send_email'])

    // A crash in send_email ALSO duplicates the refund: there is no checkpoint
    // between the approved refund and the email.
    const emailCrash = get('crash-after-commit on send_email')
    expect(resumeTools(emailCrash)).toEqual(['refund', 'send_email'])
    expect(emailCrash.world.stripe.listRefunds('ch_1')).toHaveLength(2)
    expect(emailCrash.world.mailer.outbox()).toHaveLength(2)
  })

  it('the SDK refuses to resume a completed RunState; a worker that just gives up proves nothing (UNTESTED)', async () => {
    const { get } = await shake(approvalScenario({ fixed: false, redelivery: 'raw' }))
    const redelivery = get('job-redelivery')
    expect(redelivery.agentError).toMatch(TERMINAL_STATE_ERROR)
    expect(resumeTools(redelivery)).toEqual([])
    expect(redelivery.untested).toBe(true)
    expect(redelivery.passed).toBe(false)
  })

  it('ledger + downstream key: every fault passes with a volatile ledger (the human is still asked twice after a timeout)', async () => {
    const { report, get } = await shake(approvalScenario({ fixed: true }))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    expectCrashesStopTheRun(report)
    expect(get('timeout-after-commit on refund').world.approvals).toHaveLength(2)
    expect(get('crash-after-commit on send_email').dedupes).toBe(2)
  })

  for (const fixed of [false, true]) {
    it(`a worker that follows the SDK's "start a new run" hint on redelivery ${fixed ? 'is deduplicated by the downstream key' : 'refunds and emails twice'}`, async () => {
      const base = approvalScenario({ fixed })
      const { report, get } = await shake({
        ...base,
        resume: async (w) => {
          try {
            await base.resume!(w)
          } catch (e) {
            // The SDK says: "Start a new run from persisted session history". This job has
            // no Session, so the new run starts from the task, and asks the human again.
            if (!(e instanceof UserError) || !TERMINAL_STATE_ERROR.test(e.message)) throw e
            await base.run(w)
          }
        },
        faults: [{ kind: 'job-redelivery' }],
      })
      const r = get('job-redelivery')
      expect(r.agentError).toBeUndefined()
      expect(r.world.approvals).toHaveLength(2)
      expect(resumeTools(r)).toEqual(['lookup_charge', 'refund', 'send_email'])
      expect(report.passed).toBe(fixed)
      expect(r.world.stripe.listRefunds('ch_1')).toHaveLength(fixed ? 1 : 2)
      expect(r.world.mailer.outbox()).toHaveLength(fixed ? 1 : 2)
      expect(r.dedupes).toBe(fixed ? 2 : 0)
    })
  }

  for (const fixed of [false, true]) {
    it(`resuming the same approved RunState in two workers ${fixed ? 'is deduplicated by the downstream key' : 'refunds twice'}`, async () => {
      const w = makeWorld({ fixed, approveRefunds: true })
      const first = await run(w.agent, TASK, { maxTurns: MAX_TURNS })
      expect(first.interruptions).toHaveLength(1)
      const state = await RunState.fromString(w.agent, first.state.toString())
      state.approve(state.getInterruptions()[0]!)
      const approved = state.toString()

      // Two workers (fresh processes, fresh in-memory ledgers) pick up the same "approved" job.
      for (let i = 0; i < 2; i++) {
        w.newWorker()
        await run(w.agent, await RunState.fromString(w.agent, approved), { maxTurns: MAX_TURNS })
      }

      expect(w.stripe.listRefunds('ch_1')).toHaveLength(fixed ? 1 : 2)
      expect(w.mailer.outbox()).toHaveLength(fixed ? 1 : 2)
    })
  }
})

describe('how @openai/agents surfaces a thrown tool error to the model', () => {
  it('replaces every error with a fixed generic string, even non-retryable ones', async () => {
    const w = makeWorld({ fixed: false })
    // Refund a charge that does not exist: Stripe throws "No such charge" (not retryable).
    w.stripe.restore(JSON.stringify({ seq: { ch: 0, re: 0 }, charges: {}, refunds: [], idempotency: {} }))
    const r = await run(w.agent, TASK, { maxTurns: MAX_TURNS })
    const seen = modelSaw(w, 'lookup_charge')
    expect(seen).toEqual([SDK_GENERIC_TOOL_ERROR, SDK_GENERIC_TOOL_ERROR, SDK_GENERIC_TOOL_ERROR])
    const allInput = JSON.stringify((w.model as ReactiveRefundModel).requests.map((q) => q.input))
    expect(allInput).not.toContain('No such charge')
    expect(String(r.finalOutput)).toMatch(/could not complete lookup_charge/)
  })

  it('swallows a crash too: without crashSignal(), run() resolves normally and the model keeps retrying', async () => {
    const base = refundScenario({ fixed: false })
    const { report } = await shake({
      ...base,
      // Plain run(), no signal: observe what the SDK does on its own.
      run: async (w) => {
        const r = await run(w.agent, TASK, { session: w.session, maxTurns: MAX_TURNS })
        w.finalOutput = String(r.finalOutput ?? '')
      },
      resume: async () => {},
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    const res = report.results[1]!
    expect(res.agentError).toBeUndefined()
    expect(res.crashSwallowed).toBe(true)
    expect(formatReport(report)).toContain('framework caught the simulated crash')
    // The model retried the refund twice more; shake() blocked both (the process is "dead").
    expect(modelSaw(res.world, 'refund')).toEqual([SDK_GENERIC_TOOL_ERROR, SDK_GENERIC_TOOL_ERROR, SDK_GENERIC_TOOL_ERROR])
    expect(res.world.finalOutput).toMatch(/could not complete refund/)
    expect(res.calls.filter((c) => c.tool === 'refund').map((c) => (c.blocked ? 'blocked' : c.fault))).toEqual([
      'crash-after-commit',
      'blocked',
      'blocked',
    ])
    // ...and the "dead" job gave up before emailing: sentExactly catches the job that stopped early.
    expect(res.incomplete).toContain('expected exactly 1 email(s) to ada@example.com, found 0')
  })

  it('with crashSignal() as the run signal the SDK rejects with the crash and makes no further tool calls', async () => {
    const base = refundScenario({ fixed: false })
    let rejection: unknown
    const { report } = await shake({
      ...base,
      run: async (w) => {
        try {
          await run(w.agent, TASK, { session: w.session, signal: jobSignal(), maxTurns: MAX_TURNS })
        } catch (e) {
          rejection = e
          throw e
        }
      },
      resume: async () => {},
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    const res = report.results[1]!
    expect(res.crashSwallowed).toBe(false)
    expect(isSimulatedCrash(rejection)).toBe(true)
    expect(res.calls.filter((c) => c.phase === 'run').map((c) => c.tool)).toEqual(['lookup_charge', 'refund'])
    expect(res.calls.some((c) => c.blocked)).toBe(false)
  })
})
