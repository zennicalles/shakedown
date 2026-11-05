import './no-telemetry.js'
import { describe, expect, it } from 'vitest'
import { formatReport, processIsDead, runScenario, type FaultResult, type Report } from '../../src/index.js'
import {
  MAX_STEPS,
  RUN_ID,
  TASK,
  agentScenario,
  durableScenario,
  liveCrashSignal,
  newWorld,
  startProcess,
  waitUntilSettled,
  type World,
} from './scenarios.js'
import { createRefundAgent } from './refund-agent.js'
import { createScriptedModel, type ScriptedModel } from './scripted-model.js'

const mock = () => createScriptedModel()

const byLabel = (report: Report<World>) => Object.fromEntries(report.results.map((r) => [r.label, r]))
const verdicts = (report: Report<World>) =>
  Object.fromEntries(report.results.map((r) => [r.label, r.faultNotTriggered ? 'miss' : r.passed ? 'pass' : 'fail']))
const trace = (r: FaultResult<World>) => r.calls.map((c) => `${c.phase}:${c.tool}`)

const REFUND_DOUBLED = ['expected exactly 5000 refunded on ch_1, found 10000', 'expected at most 1 refund(s) on ch_1, found 2']
const EMAIL_DOUBLED = ['expected exactly 1 email(s) to ada@example.com, found 2']
const DONE = 'Done: looked up ch_1, refunded £50 on ticket T-1 and emailed ada@example.com.'

/** Naive tools: the control fault passes, every after-commit fault and the redelivery fail. */
const NAIVE = {
  'baseline (no fault)': 'pass',
  'error-before-commit on refund': 'pass',
  'timeout-after-commit on refund': 'fail',
  'duplicate-delivery on refund': 'fail',
  'crash-after-commit on refund': 'fail',
  'error-before-commit on send_email': 'pass',
  'timeout-after-commit on send_email': 'fail',
  'duplicate-delivery on send_email': 'fail',
  'crash-after-commit on send_email': 'fail',
  'job-redelivery': 'fail',
}
const ALL_PASS = Object.fromEntries(Object.keys(NAIVE).map((k) => [k, 'pass']))

describe('mastra Agent.generate() (no durable execution: a crash or redelivery means the job is re-run)', () => {
  it('naive tools: observed results per fault', async () => {
    const report = await runScenario(agentScenario('naive', mock))
    console.log(formatReport(report))
    const r = byLabel(report)

    expect(verdicts(report)).toEqual(NAIVE)
    expect(report.passed).toBe(false)
    expect(r['timeout-after-commit on refund']!.violations).toEqual(REFUND_DOUBLED)
    expect(r['duplicate-delivery on refund']!.violations).toEqual(REFUND_DOUBLED)
    expect(r['crash-after-commit on refund']!.violations).toEqual(REFUND_DOUBLED)
    expect(r['timeout-after-commit on send_email']!.violations).toEqual(EMAIL_DOUBLED)
    expect(r['duplicate-delivery on send_email']!.violations).toEqual(EMAIL_DOUBLED)
    // Re-running the whole job after a crash in the LAST step repeats every earlier side effect too.
    expect(r['crash-after-commit on send_email']!.violations).toEqual([...REFUND_DOUBLED, ...EMAIL_DOUBLED])
    expect(trace(r['crash-after-commit on send_email']!)).toEqual([
      'run:lookup_charge',
      'run:refund',
      'run:send_email',
      'resume:lookup_charge',
      'resume:refund',
      'resume:send_email',
    ])
    expect(r['job-redelivery']!.violations).toEqual([...REFUND_DOUBLED, ...EMAIL_DOUBLED])
    // With crashSignal() as generate()'s abortSignal, the crash really stops the run.
    expect(report.results.every((x) => !x.crashSwallowed)).toBe(true)
  }, 120_000)

  it('a volatile idempotent() ledger without the downstream key fails every after-commit fault', async () => {
    const report = await runScenario(agentScenario('ledger-only', mock))
    // The ledger is written only after the side effect returns, so a timeout or
    // crash at the Stripe/mailer boundary leaves it empty; a crash or redelivery wipes it.
    expect(verdicts(report)).toEqual(NAIVE)
  }, 120_000)

  it('ledger + downstream idempotency key: every fault passes, with volatile ledgers', async () => {
    const report = await runScenario(agentScenario('fixed', mock))
    console.log(formatReport(report))
    expect(verdicts(report)).toEqual(ALL_PASS)
    expect(report.passed).toBe(true)
    const r = byLabel(report)
    // The re-run after a crash on the last step replays the refund AND the email from the downstream keys.
    expect(r['crash-after-commit on send_email']!.dedupes).toBe(2)
    expect(r['job-redelivery']!.dedupes).toBe(2)
    const resumed = r['crash-after-commit on send_email']!.calls.filter((c) => c.phase === 'resume' && c.effect === 'write')
    expect(resumed.map((c) => [c.tool, c.committed, c.deduped])).toEqual([
      ['refund', false, true],
      ['send_email', false, true],
    ])
  }, 120_000)
})

describe('mastra DurableAgent + recover() (Mastra crash recovery from the last running checkpoint)', () => {
  it('naive tools: observed results per fault', async () => {
    const report = await runScenario(durableScenario('naive', mock))
    console.log(formatReport(report))
    const r = byLabel(report)

    expect(verdicts(report)).toEqual(NAIVE)
    expect(r['timeout-after-commit on refund']!.violations).toEqual(REFUND_DOUBLED)
    expect(r['duplicate-delivery on refund']!.violations).toEqual(REFUND_DOUBLED)
    // Recovery re-drives the step that was in flight: the committed refund is issued again.
    expect(r['crash-after-commit on refund']!.violations).toEqual(REFUND_DOUBLED)
    expect(trace(r['crash-after-commit on refund']!)).toEqual(['run:lookup_charge', 'run:refund', 'resume:refund', 'resume:send_email'])
    expect(r['timeout-after-commit on send_email']!.violations).toEqual(EMAIL_DOUBLED)
    expect(r['duplicate-delivery on send_email']!.violations).toEqual(EMAIL_DOUBLED)
    // Unlike a re-run, recovery does not repeat completed steps: only the in-flight email is duplicated.
    expect(r['crash-after-commit on send_email']!.violations).toEqual(EMAIL_DOUBLED)
    expect(trace(r['crash-after-commit on send_email']!)).toEqual(['run:lookup_charge', 'run:refund', 'run:send_email', 'resume:send_email'])
    // A redelivered job reuses the runId of a COMPLETED run: Mastra starts it again from scratch.
    expect(r['job-redelivery']!.violations).toEqual([...REFUND_DOUBLED, ...EMAIL_DOUBLED])
    expect(report.results.every((x) => !x.crashSwallowed)).toBe(true)
  }, 120_000)

  it('a volatile idempotent() ledger without the downstream key fails every after-commit fault', async () => {
    expect(verdicts(await runScenario(durableScenario('ledger-only', mock)))).toEqual(NAIVE)
  }, 120_000)

  it('ledger + downstream idempotency key: every fault passes, with volatile ledgers', async () => {
    const report = await runScenario(durableScenario('fixed', mock))
    console.log(formatReport(report))
    expect(verdicts(report)).toEqual(ALL_PASS)
    expect(report.passed).toBe(true)
    const r = byLabel(report)
    expect(r['crash-after-commit on refund']!.dedupes).toBe(1)
    expect(r['crash-after-commit on send_email']!.dedupes).toBe(1)
    expect(r['job-redelivery']!.dedupes).toBe(2)
  }, 120_000)

  it('really recovers the orphaned run (not a re-run): listActiveRuns() finds it, recover() finishes it', async () => {
    const report = await runScenario({ ...durableScenario('naive', mock), faults: [{ kind: 'crash-after-commit', tool: 'refund' }] })
    const r = report.results[1]!
    expect(r.agentError).toBeUndefined()
    expect(r.crashSwallowed).toBe(false)
    expect(r.world.recovered).toEqual([RUN_ID])
    expect(r.world.redelivered).toEqual([])
    expect(r.world.outputs).toEqual([DONE])
  }, 120_000)

  it('job-redelivery: nothing is orphaned, generate() with the completed runId runs the whole job again', async () => {
    const report = await runScenario({ ...durableScenario('naive', mock), faults: [{ kind: 'job-redelivery' }] })
    const r = report.results[1]!
    expect(r.agentError).toBeUndefined()
    expect(r.world.recovered).toEqual([])
    expect(r.world.redelivered).toEqual([RUN_ID])
    expect(r.world.outputs).toEqual([DONE, DONE])
    expect(trace(r)).toEqual([
      'run:lookup_charge',
      'run:refund',
      'run:send_email',
      'resume:lookup_charge',
      'resume:refund',
      'resume:send_email',
    ])
  }, 120_000)

  it('generate() resolves while storage still lists the run as running; a redelivery in that window is refused (UNTESTED)', async () => {
    // Direct: right after generate() resolves, listActiveRuns() still reports the finished run.
    const w = newWorld()
    const p = startProcess(w, 'naive', mock)
    const out = await p.durable.generate(TASK, { runId: RUN_ID, maxSteps: MAX_STEPS })
    expect(out.text).toBe(DONE)
    expect((await p.durable.listActiveRuns()).runs.map((x) => x.runId)).toEqual([RUN_ID])
    await waitUntilSettled(p.durable, RUN_ID)
    expect((await p.durable.listActiveRuns()).runs).toEqual([])
    await p.mastra.shutdown()

    // Under Shakedown: without waiting for the run to settle, the redelivered job
    // finds the finished run "orphaned", and recover() refuses it because this
    // Node process still holds the run's local execution fence. Nothing runs
    // twice, but the redelivery never actually ran, so Shakedown reports it as
    // UNTESTED rather than as a pass.
    const report = await runScenario({
      ...durableScenario('naive', mock, { waitForSettle: false }),
      faults: [{ kind: 'job-redelivery' }],
    })
    const r = report.results[1]!
    expect(r.passed).toBe(false)
    expect(r.untested).toBe(true)
    expect(r.agentError).toMatch(/after redelivery: .*recover\(run-T-1\): this process is still executing the run/)
    expect(trace(r)).toEqual(['run:lookup_charge', 'run:refund', 'run:send_email'])
  }, 120_000)

  it('the killed process writes no checkpoint after the crash (it only claims and releases run ownership)', async () => {
    const dead: string[] = []
    const s = durableScenario('naive', mock)
    const report = await runScenario<World>({
      ...s,
      setup: async () => {
        const w = await s.setup()
        const ws = (await w.storage.getStore('workflows')) as unknown as Record<string, (a: unknown) => Promise<unknown>>
        for (const m of ['persistWorkflowSnapshot', 'updateWorkflowResults', 'updateWorkflowState', 'deleteWorkflowRunById', 'claimRunOwnership', 'renewRunOwnership', 'releaseRunOwnership']) {
          const orig = ws[m]!.bind(ws)
          ws[m] = async (a) => {
            if (processIsDead()) dead.push(m)
            return await orig(a)
          }
        }
        return w
      },
      faults: [{ kind: 'crash-after-commit', tool: 'send_email' }],
    })
    expect(report.results[1]!.world.recovered).toEqual([RUN_ID])
    // No snapshot, step-result or state write after the crash: recovery starts from the
    // last checkpoint taken before the crashed step. Mastra's shutdown() does claim and then
    // release the run, which a SIGKILLed process would not do (next test).
    expect(dead).toEqual(['claimRunOwnership', 'releaseRunOwnership'])
  }, 120_000)

  it('hard kill (no ownership release): recover() refuses the run while the dead owner still holds its claim; { force: true } takes it over', async () => {
    const s = durableScenario('fixed', mock)
    const errors: string[] = []
    const report = await runScenario<World>({
      ...s,
      setup: async () => {
        const w = await s.setup()
        // A SIGKILLed process cannot release its claim: drop the dead process's ownership writes.
        const ws = (await w.storage.getStore('workflows'))!
        const claim = ws.claimRunOwnership.bind(ws)
        const release = ws.releaseRunOwnership.bind(ws)
        ws.claimRunOwnership = async (a) => (processIsDead() ? { acquired: false, record: await ws.getRunOwnership({ runId: a.runId }) } : claim(a))
        ws.releaseRunOwnership = async (a) => (processIsDead() ? false : release(a))
        return w
      },
      resume: async (w) => {
        const p = startProcess(w, 'fixed', mock)
        try {
          const { runs } = await p.durable.listActiveRuns()
          for (const run of runs) {
            const rec = await p.durable.recover(run.runId).catch(async (e: Error) => {
              errors.push(e.message)
              return await p.durable.recover(run.runId, { force: true })
            })
            w.outputs.push(await rec.output.text)
            w.recovered.push(run.runId)
            rec.cleanup()
          }
        } finally {
          await p.mastra.shutdown()
        }
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    const r = report.results[1]!
    expect(errors).toEqual([expect.stringMatching(/run-T-1 is still being executed\. Retry once it stops, or call recover\(runId, \{ force: true \}\)/)])
    expect(r.world.recovered).toEqual([RUN_ID])
    expect(r.passed).toBe(true)
    expect(r.dedupes).toBe(1)
  }, 120_000)
})

describe('how Mastra feeds a thrown tool error back to the model', () => {
  async function seenUnder(kind: 'timeout-after-commit' | 'crash-after-commit', abortOnCrash = true) {
    const models: ScriptedModel[] = []
    const report = await runScenario({
      ...agentScenario(
        'naive',
        () => {
          const m = createScriptedModel()
          models.push(m)
          return m
        },
        { abortOnCrash },
      ),
      faults: [{ kind, tool: 'refund' }],
    })
    return { models, result: report.results[1]! }
  }

  it('as a tool-result with output.type "error-text" carrying the error message; the loop continues', async () => {
    const { models } = await seenUnder('timeout-after-commit')
    const faultRun = models[1]! // models[0] is the baseline run
    const refundResults = faultRun.seen.at(-1)!.filter((t) => t.toolName === 'refund')
    expect(refundResults).toEqual([
      { toolName: 'refund', outputType: 'error-text', value: 'Request to refund timed out after 30000ms (no response received)' },
      { toolName: 'refund', outputType: 'json', value: expect.objectContaining({ id: 're_2', amount: 5000 }) },
    ])
  }, 120_000)

  it('swallows even a crash: without an abortSignal, generate() resolves and the model is shown the crash as an error and retries', async () => {
    const { models, result } = await seenUnder('crash-after-commit', false)
    const crashedRun = models[1]!
    const refundResults = crashedRun.seen.at(-1)!.filter((t) => t.toolName === 'refund')
    // 3 attempts; shake() blocks attempts 2 and 3 because the "process" is dead.
    expect(refundResults.map((t) => t.outputType)).toEqual(['error-text', 'error-text', 'error-text'])
    expect(refundResults.map((t) => t.value)).toEqual(Array(3).fill('Process exited unexpectedly while calling refund (connection closed)'))
    expect(result.crashSwallowed).toBe(true)
    expect(result.calls.filter((c) => c.phase === 'run' && c.tool === 'refund').map((c) => [c.fault, c.committed, c.blocked])).toEqual([
      ['crash-after-commit', true, undefined],
      [undefined, false, true],
      [undefined, false, true],
    ])
    expect(result.agentError).toBeUndefined()
  }, 120_000)

  it('with crashSignal() as abortSignal the loop stops at once, but generate() resolves (empty text) instead of rejecting', async () => {
    const observed: Array<{ text: string; finishReason: unknown; modelCalls: number; aborted: boolean }> = []
    const s = agentScenario('naive', mock)
    const report = await runScenario<World>({
      ...s,
      run: async (w) => {
        const model = createScriptedModel()
        const agent = createRefundAgent({ fixed: false, stripe: w.stripe, mailer: w.mailer, model })
        const signal = liveCrashSignal()
        const r = await agent.generate(TASK, { maxSteps: MAX_STEPS, ...(signal ? { abortSignal: signal } : {}) })
        observed.push({ text: r.text, finishReason: r.finishReason, modelCalls: model.seen.length, aborted: !!signal?.aborted })
        if (signal?.aborted) throw signal.reason
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    const crashed = observed[1]! // observed[0] is the baseline run
    // lookup, refund; the model is never asked again, and generate() RESOLVES with finishReason 'aborted'
    expect(crashed).toEqual({ text: '', finishReason: 'aborted', aborted: true, modelCalls: 2 })
    expect(observed[2]).toMatchObject({ text: DONE, aborted: false }) // the re-run in a new process
    expect(report.results[1]!.calls.filter((c) => c.phase === 'run').map((c) => c.tool)).toEqual(['lookup_charge', 'refund'])
    expect(report.results[1]!.crashSwallowed).toBe(false)
  }, 120_000)
})
