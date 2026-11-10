import { createNetwork, createState } from '@inngest/agent-kit'
import { describe, expect, it } from 'vitest'
import { assertSafe, formatReport, runScenario, type FaultResult, type Report } from '../../src/index.js'
import {
  TASK,
  createRefundAgent,
  newWorld,
  processTicket,
  refundScenario,
  type ScenarioOptions,
  type World,
} from './refund-agent.js'
import { scriptedRefundModel, type ObservedToolResult } from './scripted-model.js'

const model = () => scriptedRefundModel()
type Outcome = 'pass' | 'FAIL' | 'MISS'

function outcomes(r: Report<World>): Record<string, Outcome> {
  return Object.fromEntries(r.results.map((x) => [x.label, x.faultNotTriggered ? 'MISS' : x.passed ? 'pass' : 'FAIL']))
}
const byLabel = (r: Report<World>) => Object.fromEntries(r.results.map((x) => [x.label, x])) as Record<string, FaultResult<World>>
/** Compact trace of write calls: tool@phase + C(ommitted) D(eduped) B(locked) E(rror, not blocked). */
const writes = (r: FaultResult<World>) =>
  r.calls
    .filter((c) => c.effect === 'write')
    .map(
      (c) =>
        `${c.tool}@${c.phase}${c.committed ? ' C' : ''}${c.deduped ? ' D' : ''}${c.blocked ? ' B' : ''}${c.outcome === 'error' && !c.blocked && !c.committed ? ' E' : ''}`,
    )
/** Scenario whose `observed` list holds only the LAST run (the fault run), not the baseline too. */
function observing(o: Omit<ScenarioOptions, 'makeModel'>, observed: ObservedToolResult[]) {
  const sc = refundScenario({ ...o, makeModel: () => scriptedRefundModel(observed) })
  return { ...sc, setup: () => ((observed.length = 0), sc.setup()) }
}
const scenario = (o: Omit<ScenarioOptions, 'makeModel'> & { makeModel?: ScenarioOptions['makeModel'] }) =>
  runScenario(refundScenario({ makeModel: model, ...o }))

const LABELS = [
  'baseline (no fault)',
  'error-before-commit on refund',
  'timeout-after-commit on refund',
  'duplicate-delivery on refund',
  'crash-after-commit on refund',
  'error-before-commit on send_email',
  'timeout-after-commit on send_email',
  'duplicate-delivery on send_email',
  'crash-after-commit on send_email',
  'job-redelivery',
] as const
const table = (...o: Outcome[]) => Object.fromEntries(LABELS.map((l, i) => [l, o[i]!]))

// Observed on @inngest/agent-kit 0.13.2 + inngest 4.26.2 with the scripted model (see README).
const ALL_PASS = table('pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass')
/** Plain network: same shape as the other frameworks. job-redelivery passes via the stored thread. */
const NAIVE_PLAIN = table('pass', 'pass', 'FAIL', 'FAIL', 'FAIL', 'pass', 'FAIL', 'FAIL', 'FAIL', 'pass')
/** Inside Inngest, naive tools fail everything, starting with the baseline. */
const NAIVE_INNGEST = table('FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL')
/** step.run fixes the baseline (memoization) but not the after-commit faults, and the redelivery is a new run. */
const STEP_RUN_INNGEST = table('pass', 'pass', 'FAIL', 'FAIL', 'FAIL', 'pass', 'FAIL', 'FAIL', 'FAIL', 'FAIL')

describe('AgentKit network, plain (no Inngest; History adapter as the recovery path)', () => {
  it('naive tools: after-commit faults double-refund / double-email', async () => {
    const report = await scenario({ mode: 'naive', runtime: 'plain' })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_PLAIN)
    const r = byLabel(report)
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    // The router's crashSignal() check stopped the loop: the crash propagated, not swallowed.
    expect(report.results.every((x) => !x.crashSwallowed && x.agentError === undefined)).toBe(true)
    expect(() => assertSafe(report)).toThrow(/FAIL/)
  })

  it('History.appendResults runs only when network.run finishes, so a crash in send_email also repeats the refund', async () => {
    const report = await scenario({ mode: 'naive', runtime: 'plain' })
    const crash = byLabel(report)['crash-after-commit on send_email']!
    expect(crash.violations).toEqual([
      'expected exactly 5000 refunded on ch_1, found 10000',
      'expected at most 1 refund(s) on ch_1, found 2',
      'expected exactly 1 email(s) to ada@example.com, found 2',
    ])
    expect(writes(crash)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume C', 'send_email@resume C'])
    // One append, from the resumed run: the crashed run saved nothing, though 3 agent calls had finished.
    expect(crash.world.threads.appends).toEqual([4])
    // A finished thread makes the redelivered job a no-op: the router gets the stored
    // final answer as lastResult and stops before any model call, and network.run
    // returns before saveThreadToStorage, so nothing new is appended either.
    const redelivery = byLabel(report)['job-redelivery']!
    expect(writes(redelivery)).toEqual(['refund@run C', 'send_email@run C'])
    expect(redelivery.world.threads.appends).toEqual([4])
  })

  it('fixed (volatile ledger + key sent downstream): every default fault passes', async () => {
    const report = await scenario({ mode: 'fixed', runtime: 'plain' })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(ALL_PASS)
    const r = byLabel(report)
    expect(writes(r['timeout-after-commit on refund']!)).toEqual(['refund@run C', 'refund@run D', 'send_email@run C'])
    expect(writes(r['crash-after-commit on send_email']!)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume D', 'send_email@resume D'])
  })
})

describe('AgentKit network inside an Inngest function (LocalInngest, v4 default checkpointing)', () => {
  it('naive tools: even the no-fault baseline refunds twice, because tool handlers re-run on every replay', async () => {
    const report = await scenario({ mode: 'naive', runtime: 'inngest' })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_INNGEST)
    const base = byLabel(report)['baseline (no fault)']!
    expect(base.violations).toEqual([
      'expected exactly 5000 refunded on ch_1, found 10000',
      'expected at most 1 refund(s) on ch_1, found 2',
      'expected exactly 1 email(s) to ada@example.com, found 2',
    ])
    // The 3rd refund was refused by Stripe only because the charge was used up.
    expect(writes(base)).toEqual(['refund@run C', 'refund@run C', 'send_email@run C', 'refund@run E', 'send_email@run C'])

    const run = base.world.server.runs[0]!
    // Checkpointing really ran (step.run results were POSTed from inside requests)...
    expect(base.world.server.checkpoints).toBeGreaterThan(0)
    expect(run.log.some((l) => l.checkpointed)).toBe(true)
    // ...but step.ai.infer cannot run in the worker: each of the 4 inferences ends a
    // request, and the next request replays the handler from the top.
    expect(run.log.filter((l) => l.op === 'AIGateway').map((l) => l.name)).toEqual(['refund-agent', 'refund-agent', 'refund-agent', 'refund-agent'])
    expect(run.requests).toBe(5)
    // Nothing in AgentKit memoized the tool calls: no step for lookup/refund/send_email.
    expect(run.log.map((l) => l.name).filter((n) => /lookup|refund$|send_email/.test(n))).toEqual([])
  })

  it('naive tools with checkpointing off (classic replay): every step is a request boundary, so it is worse', async () => {
    const report = await runScenario({ ...refundScenario({ mode: 'naive', runtime: 'inngest', checkpointing: false, makeModel: model }), faults: [], allowUntriggered: true })
    const base = report.results[0]!
    expect(base.violations).toEqual([
      'expected exactly 5000 refunded on ch_1, found 10000',
      'expected at most 1 refund(s) on ch_1, found 2',
      'expected exactly 1 email(s) to ada@example.com, found 3',
    ])
    expect(base.world.server.checkpoints).toBe(0)
    expect(base.world.server.runs[0]!.requests).toBe(10)
  })

  it('step.run tools: baseline passes, after-commit faults still duplicate, redelivery is a new run', async () => {
    const report = await scenario({ mode: 'step-run', runtime: 'inngest' })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(STEP_RUN_INNGEST)
    const r = byLabel(report)
    // A completed step is memoized: a crash in send_email does NOT repeat the refund...
    expect(writes(r['crash-after-commit on send_email']!)).toEqual(['refund@run C', 'send_email@run C', 'send_email@resume C'])
    // ...but the crashed step itself never reported back, so the server runs it again.
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    // The redelivered event starts a second run with empty step state.
    const redelivery = r['job-redelivery']!
    expect(redelivery.world.server.runs).toHaveLength(2)
    expect(writes(redelivery)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume C', 'send_email@resume C'])
  })

  it('step.run tools: Inngest retries the timed-out step itself; the model never sees the error', async () => {
    const observed: ObservedToolResult[] = []
    const report = await runScenario({
      ...observing({ mode: 'step-run', runtime: 'inngest' }, observed),
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
    })
    const r = report.results[1]!
    expect(r.violations).toContain('expected at most 1 refund(s) on ch_1, found 2')
    const log = r.world.server.runs[0]!.log.filter((l) => l.name === 'refund')
    expect(log.map((l) => `${l.op}@${l.attempt}`)).toEqual(['StepError@0', 'StepRun@1'])
    expect(log[0]!.error).toBe('Request to refund timed out after 30000ms (no response received)')
    // The model saw only successes: the retry was the platform's, not the model's.
    expect(observed.filter((o) => o.kind === 'error')).toEqual([])
    expect(observed.filter((o) => o.toolName === 'refund')).toHaveLength(1)
  })

  it('fixed (step.run + volatile ledger + downstream key): every default fault passes', async () => {
    const report = await scenario({ mode: 'fixed', runtime: 'inngest' })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(ALL_PASS)
    expect(report.results.every((x) => x.agentError === undefined && !x.crashSwallowed)).toBe(true)
    const r = byLabel(report)
    // Inngest's own step retry reached Stripe again; Stripe replayed it from the key.
    expect(writes(r['timeout-after-commit on refund']!)).toEqual(['refund@run C', 'refund@run D', 'send_email@run C'])
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume D', 'send_email@resume C'])
    expect(writes(r['job-redelivery']!)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume D', 'send_email@resume D'])
  })

  it('key-only tools (ledger + key, no step.run) pass the baseline; the in-process ledger absorbs the replays', async () => {
    const report = await runScenario({
      ...refundScenario({ mode: 'key-only', runtime: 'inngest', makeModel: model }),
      faults: [],
      allowUntriggered: true,
    })
    const base = report.results[0]!
    expect(base.passed).toBe(true)
    // The handlers still re-ran on replay (3 ledger hits); none of them reached shake()/Stripe.
    expect(writes(base)).toEqual(['refund@run C', 'send_email@run C'])
    expect(base.dedupes).toBe(3)
  })
})

describe('how AgentKit surfaces tool errors (observations)', () => {
  it('a thrown tool error reaches the model as { error: { name, message, stack } } JSON; the loop continues', async () => {
    const observed: ObservedToolResult[] = []
    const report = await runScenario({
      ...observing({ mode: 'naive', runtime: 'plain' }, observed),
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined()
    const seen = observed.find((o) => o.kind === 'error')!
    const err = (seen.content as { error: Record<string, unknown> }).error
    expect(seen.toolName).toBe('refund')
    expect(err.name).toBe('TimeoutError')
    expect(err.message).toBe('Request to refund timed out after 30000ms (no response received)')
    // inngest's serializeError keeps the stack trace, and AgentKit puts it in the prompt.
    expect(String(err.stack)).toMatch(/\n\s+at /)
    expect(err.__serialized).toBe(true)
    // Shakedown sees clean tool input (the handler passes only `input`).
    expect(run.calls.find((c) => c.tool === 'refund')!.args).toEqual({ ticket: 'T-1', charge: 'ch_1', amount: 5000 })
  })

  it('without the router check, AgentKit swallows a crash too: the model is told and the run keeps going', async () => {
    const observed: ObservedToolResult[] = []
    let finalText = ''
    const report = await runScenario<World>({
      ...observing({ mode: 'naive', runtime: 'plain' }, observed),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      run: async (w) => {
        const agent = createRefundAgent({ mode: 'naive', backends: w, model: w.makeModel() })
        const network = createNetwork({
          name: 'no-crash-check',
          agents: [agent],
          maxIter: 12,
          router: ({ lastResult }) => (!lastResult || lastResult.toolCalls.length > 0 ? agent : undefined),
        })
        const res = await network.run(TASK)
        const last = res.state.results.at(-1)!.output.at(-1)!
        finalText = last.type === 'text' && typeof last.content === 'string' ? last.content : ''
      },
      resume: async () => {},
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined()
    expect(run.crashSwallowed).toBe(true)
    expect(observed.filter((o) => o.kind === 'error' && o.toolName === 'refund')).toHaveLength(3)
    expect(writes(run)).toEqual(['refund@run C', 'refund@run B', 'refund@run B'])
    expect(finalText).toMatch(/could not complete refund after 3 attempts/)
    expect(run.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
  })

  it('AgentKit itself never retries a tool: one thrown error, one tool result, the model decides', async () => {
    const observed: ObservedToolResult[] = []
    const report = await runScenario({
      ...observing({ mode: 'naive', runtime: 'plain' }, observed),
      faults: [{ kind: 'error-before-commit', tool: 'refund' }],
    })
    const r = report.results[1]!
    expect(r.passed).toBe(true)
    // Two refund calls: the failed one and the model's re-issue (a new tool call id).
    expect(writes(r)).toEqual(['refund@run E', 'refund@run C', 'send_email@run C'])
    expect(observed.filter((o) => o.toolName === 'refund').map((o) => o.kind)).toEqual(['error', 'data'])
  })

  it('inside Inngest, a step.run that keeps failing runs 4 times (3 retries) per model attempt: 3 model attempts = 12 Stripe calls', async () => {
    const observed: ObservedToolResult[] = []
    const w = newWorld({ mode: 'step-run', runtime: 'inngest', makeModel: () => scriptedRefundModel(observed) })
    let stripeCalls = 0
    w.stripe.refunds.create = () => {
      stripeCalls++
      throw new Error('stripe is down')
    }
    const text = await processTicket(w)
    expect(stripeCalls).toBe(12)
    const errors = observed.filter((o) => o.kind === 'error')
    expect(errors).toHaveLength(3)
    // What the model gets after the step fails for good: the original error (not a StepError wrapper), with its stack.
    const e = (errors[0]!.content as { error: { name: string; message: string; stack: string } }).error
    expect(e).toMatchObject({ name: 'Error', message: 'stripe is down' })
    expect(e.stack).toMatch(/\n\s+at /)
    expect(text).toMatch(/could not complete refund after 3 attempts/)
    // Each model attempt is a new step (same id, de-duplicated by Inngest as refund:1, refund:2), each retried 3 times.
    const steps = w.server.runs[0]!.log.filter((l) => l.name === 'refund')
    const oneStep = ['StepError@0', 'StepError@1', 'StepError@2', 'StepFailed@3']
    expect(steps.map((l) => `${l.op}@${l.attempt}`)).toEqual([...oneStep, ...oneStep, ...oneStep])
    expect(new Set(steps.map((l) => l.stepId)).size).toBe(3)
  })

  it('agent.run({ maxIter }) on its own never shows the model its tool results', async () => {
    const m = scriptedRefundModel()
    const w = newWorld({ mode: 'naive', runtime: 'plain', makeModel: () => m })
    let lookups = 0
    const realRetrieve = w.stripe.charges.retrieve
    w.stripe.charges.retrieve = (id) => (lookups++, realRetrieve(id))
    const agent = createRefundAgent({ mode: 'naive', backends: w, model: m })
    await agent.run(TASK, { maxIter: 3, state: createState({}) })
    // Each iteration's history is only the previous inference output (the tool call),
    // without the tool result, so the scripted model starts the plan over every time.
    expect(m.scriptedRequests).toHaveLength(3)
    expect(m.scriptedRequests.map((r) => r.messages.filter((x) => x.role === 'tool').length)).toEqual([0, 0, 0])
    expect(m.scriptedRequests[1]!.messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant'])
    expect(lookups).toBe(3)
    expect(w.stripe.refunds.list({ charge: 'ch_1' }).data).toHaveLength(0)
  })
})

describe('human-in-the-loop: refund waits for an approval event (step.waitForEvent)', () => {
  it('naive tools: the human approves once, the approved refund runs on every later replay', async () => {
    const report = await scenario({ mode: 'naive', runtime: 'inngest', refundNeedsApproval: true })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_INNGEST)
    const base = byLabel(report)['baseline (no fault)']!
    expect(base.world.approvalsAsked).toBe(1)
    expect(writes(base)).toEqual(['refund@run C', 'refund@run C', 'send_email@run C', 'refund@run E', 'send_email@run C'])
  })

  it('step.run tools: a timed-out approved refund is retried by Inngest without asking again', async () => {
    const report = await scenario({ mode: 'step-run', runtime: 'inngest', refundNeedsApproval: true })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(STEP_RUN_INNGEST)
    const r = byLabel(report)
    for (const label of ['timeout-after-commit on refund', 'crash-after-commit on refund'] as const) {
      expect(r[label]!.world.approvalsAsked).toBe(1)
      expect(r[label]!.violations).toContain('expected at most 1 refund(s) on ch_1, found 2')
    }
    // A redelivered event is a new run: the human is asked again, and (approving) refunds again.
    expect(r['job-redelivery']!.world.approvalsAsked).toBe(2)
  })

  it('fixed tools: every fault passes; the redelivery still asks the human a second time', async () => {
    const report = await scenario({ mode: 'fixed', runtime: 'inngest', refundNeedsApproval: true })
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(ALL_PASS)
    const r = byLabel(report)
    expect(report.results.filter((x) => x.label !== 'job-redelivery').every((x) => x.world.approvalsAsked === 1)).toBe(true)
    expect(r['job-redelivery']!.world.approvalsAsked).toBe(2)
  })
})
