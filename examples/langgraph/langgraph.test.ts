import { describe, expect, it } from 'vitest'
import { formatReport, runScenario, type FaultResult, type Report } from '../../src/index.js'
import { hitlScenario, refundScenario, type RefundAgentOptions, type RefundWorld } from './refund-agent.js'

function byLabel<W>(r: Report<W>): Record<string, FaultResult<W>> {
  return Object.fromEntries(r.results.map((x) => [x.label, x]))
}
const verdicts = <W>(r: Report<W>) =>
  Object.fromEntries(r.results.map((x) => [x.label, x.faultNotTriggered ? 'miss' : x.passed ? 'pass' : 'fail']))
const trace = <W>(res: FaultResult<W>) =>
  res.calls.map((c) => `${c.tool}/${c.phase}/${c.outcome}${c.blocked ? '/blocked' : ''}${c.deduped ? '/deduped' : ''}`)

const DOUBLE_REFUND = [/exactly 5000 refunded on ch_1, found 10000/, /at most 1 refund\(s\) on ch_1, found 2/]
const DOUBLE_EMAIL = [/exactly 1 email\(s\) to ada@example.com, found 2/]

/** Observed violations per fault for the naive agent (default crash-signal mode, thread per ticket). */
const NAIVE_OBSERVED: Record<string, RegExp[]> = {
  'baseline (no fault)': [],
  'error-before-commit on refund': [],
  'timeout-after-commit on refund': DOUBLE_REFUND,
  'duplicate-delivery on refund': DOUBLE_REFUND,
  'crash-after-commit on refund': DOUBLE_REFUND,
  'error-before-commit on send_email': [],
  'timeout-after-commit on send_email': DOUBLE_EMAIL,
  'duplicate-delivery on send_email': DOUBLE_EMAIL,
  'crash-after-commit on send_email': DOUBLE_EMAIL,
  // The redelivered job lands on the finished thread; the mock model sees the earlier tool results and calls nothing.
  'job-redelivery': [],
}

const ALL_PASS = Object.fromEntries(Object.keys(NAIVE_OBSERVED).map((l) => [l, 'pass']))

function expectObserved(report: Report<RefundWorld>, observed: Record<string, RegExp[]>) {
  const r = byLabel(report)
  expect(Object.keys(r).sort()).toEqual(Object.keys(observed).sort())
  for (const [label, want] of Object.entries(observed)) {
    expect(r[label]!.faultNotTriggered, label).toBe(false)
    expect(r[label]!.passed, label).toBe(want.length === 0)
    expect(r[label]!.violations, label).toHaveLength(want.length)
    want.forEach((re, i) => expect(r[label]!.violations[i], label).toMatch(re))
  }
}

describe('LangGraph createAgent refund agent, naive tools', () => {
  it('fails every after-commit fault; passes baseline, error-before-commit and (per-ticket thread) job-redelivery', async () => {
    const report = await runScenario(refundScenario({ fixed: false }))
    console.log(formatReport(report))
    expectObserved(report, NAIVE_OBSERVED)
    for (const res of report.results) {
      // crashSignal() made the crash propagate out of invoke(): nothing swallowed, no unexpected agent error.
      expect(res.agentError, res.label).toBeUndefined()
      expect(res.crashSwallowed, res.label).toBe(false)
    }
    expect(report.passed).toBe(false)
  })

  it('resume = a fresh agent re-invokes the same thread_id with null input; LangGraph re-runs the failed tools task', async () => {
    const report = await runScenario({ ...refundScenario({ fixed: false }), faults: [{ kind: 'crash-after-commit', tool: 'refund' }] })
    const res = report.results[1]!
    // The refund that committed right before the crash is executed again by the resumed thread.
    expect(trace(res)).toEqual(['lookup_charge/run/ok', 'refund/run/error', 'refund/resume/ok', 'send_email/resume/ok'])
    expect(res.world.deliveries.map((d) => d.resumed)).toEqual([false, true])
    expect(res.world.processes).toBe(2)
  })

  it('job-redelivery on a per-ticket thread: a new turn on the finished thread; the (mock) model sees prior results and does nothing', async () => {
    const report = await runScenario({ ...refundScenario({ fixed: false }), faults: [{ kind: 'job-redelivery' }] })
    const res = report.results[1]!
    expect(res.passed).toBe(true)
    expect(res.calls.filter((c) => c.phase === 'resume')).toEqual([])
    expect(res.world.deliveries).toHaveLength(2)
    expect(res.world.deliveries[1]).toMatchObject({ threadId: 'ticket-T-1', resumed: false, toolCalls: 3 })
    expect(res.world.deliveries[1]!.finalMessage).toMatch(/^Done:/)
  })

  it('thread per delivery: the checkpointer never helps, every crash or redelivery redoes the whole job', async () => {
    const report = await runScenario(refundScenario({ fixed: false, thread: 'per-delivery' }))
    console.log(formatReport(report))
    expectObserved(report, {
      ...NAIVE_OBSERVED,
      'crash-after-commit on send_email': [...DOUBLE_REFUND, ...DOUBLE_EMAIL],
      'job-redelivery': [...DOUBLE_REFUND, ...DOUBLE_EMAIL],
    })
    const crash = byLabel(report)['crash-after-commit on refund']!
    expect(trace(crash)).toEqual([
      'lookup_charge/run/ok',
      'refund/run/error',
      'lookup_charge/resume/ok',
      'refund/resume/ok',
      'send_email/resume/ok',
    ])
  })
})

describe('LangGraph createAgent refund agent, ledger + downstream key (volatile ledger)', () => {
  it('passes every default fault, including crash-after-commit and job-redelivery', async () => {
    const report = await runScenario(refundScenario({ fixed: true }))
    console.log(formatReport(report))
    expect(report.results).toHaveLength(1 + 2 * 4 + 1)
    expect(verdicts(report)).toEqual(ALL_PASS)
    expect(report.passed).toBe(true)
    const r = byLabel(report)
    for (const label of ['timeout-after-commit on refund', 'duplicate-delivery on refund', 'crash-after-commit on refund']) {
      expect(r[label]!.dedupes, label).toBe(1)
      expect(r[label]!.calls.filter((c) => c.tool === 'refund' && c.committed), label).toHaveLength(1)
      expect(r[label]!.world.stripe.listRefunds('ch_1'), label).toHaveLength(1)
    }
    // Per-ticket redelivery passes without exercising the fix: the mock model calls no tools on the finished thread.
    expect(r['job-redelivery']!.dedupes).toBe(0)
    expect(r['job-redelivery']!.calls.filter((c) => c.phase === 'resume')).toEqual([])
  })

  it('after a crash the volatile ledger is gone: the resumed refund reaches Stripe and the idempotency key dedupes it', async () => {
    const report = await runScenario({ ...refundScenario({ fixed: true }), faults: [{ kind: 'crash-after-commit', tool: 'refund' }] })
    const res = report.results[1]!
    expect(res.passed).toBe(true)
    // A surviving ledger would have answered before shake(); the resumed call is recorded, so the ledger missed.
    expect(trace(res)).toEqual(['lookup_charge/run/ok', 'refund/run/error', 'refund/resume/ok/deduped', 'send_email/resume/ok'])
    expect(res.calls.find((c) => c.deduped)).toMatchObject({ committed: false })
  })

  it('thread per delivery: still passes every fault, with every replay coming from the downstream key', async () => {
    const report = await runScenario(refundScenario({ fixed: true, thread: 'per-delivery' }))
    expect(verdicts(report)).toEqual(ALL_PASS)
    const redelivery = byLabel(report)['job-redelivery']!
    expect(trace(redelivery).filter((c) => c.includes('/resume/'))).toEqual([
      'lookup_charge/resume/ok',
      'refund/resume/ok/deduped',
      'send_email/resume/ok/deduped',
    ])
  })
})

describe('crash modes: crashSignal() and toolErrorMiddleware give the same verdicts', () => {
  it.each([false, true])('fixed=%s', async (fixed) => {
    const opts: RefundAgentOptions = { fixed }
    const viaSignal = await runScenario(refundScenario(opts))
    const viaMiddleware = await runScenario(refundScenario({ ...opts, crashMode: 'middleware' }))
    expect(verdicts(viaMiddleware)).toEqual(verdicts(viaSignal))
    for (const res of viaMiddleware.results) expect(res.crashSwallowed, res.label).toBe(false)
    // With the middleware LangGraph still tries to record the task error after the crash; the durable saver drops it.
    expect(byLabel(viaMiddleware)['crash-after-commit on refund']!.world.checkpointer.droppedWrites).toBe(1)
    expect(byLabel(viaSignal)['crash-after-commit on refund']!.world.checkpointer.droppedWrites).toBe(0)
  })
})

describe('how LangGraph surfaces a thrown tool error to the model', () => {
  it('turns it into a ToolMessage with status "error" and "<Name>: <message>\\n Please fix your mistakes."', async () => {
    const report = await runScenario({ ...refundScenario({ fixed: false }), faults: [{ kind: 'timeout-after-commit', tool: 'refund' }] })
    const w = report.results[1]!.world
    const refundResults = w.seen.filter((s) => s.tool === 'refund')
    expect(refundResults[0]).toEqual({
      tool: 'refund',
      status: 'error',
      content: 'TimeoutError: Request to refund timed out after 30000ms (no response received)\n Please fix your mistakes.',
    })
    // The model retried once and the retry succeeded (second refund committed).
    expect(refundResults[1]!.status).toBe('success')
    expect(w.stripe.listRefunds('ch_1')).toHaveLength(2)
  })

  it('by default it also swallows the crash: the dead process keeps stepping until the model gives up', async () => {
    // No crashSignal, no middleware: createAgent's ToolNode catches every tool error.
    const report = await runScenario({
      ...refundScenario({ fixed: false, crashMode: 'framework-default' }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    console.log(formatReport(report))
    const res = report.results[1]!
    const w = res.world
    expect(res.crashSwallowed).toBe(true)
    expect(formatReport(report)).toContain('framework caught the simulated crash')
    // The model is shown the neutral crash text three times, as an ordinary tool error.
    expect(w.seen.filter((s) => s.tool === 'refund' && s.status === 'error').map((s) => s.content)).toEqual(
      Array(3).fill('ConnectionClosedError: Process exited unexpectedly while calling refund (connection closed)\n Please fix your mistakes.'),
    )
    // It re-issued refund twice more; shake() blocked and recorded both (the process is "dead").
    expect(trace(res).slice(0, 4)).toEqual(['lookup_charge/run/ok', 'refund/run/error', 'refund/run/error/blocked', 'refund/run/error/blocked'])
    expect(w.deliveries[0]!.finalMessage).toMatch(/could not complete refund after 3 attempts/)
    // Everything the dead process tried to checkpoint after the crash was dropped, so the restarted
    // worker resumes from the last durable checkpoint and re-runs the committed refund.
    expect(w.checkpointer.droppedWrites).toBe(12)
    expect(w.deliveries[1]).toMatchObject({ resumed: true })
    expect(trace(res).slice(4)).toEqual(['refund/resume/ok', 'send_email/resume/ok'])
    expect(res.violations).toHaveLength(2)
    DOUBLE_REFUND.forEach((re, i) => expect(res.violations[i]).toMatch(re))
  })

  it('framework-default handling: same verdicts as a propagated crash, but every crash is flagged as swallowed', async () => {
    const naive = await runScenario(refundScenario({ fixed: false, crashMode: 'framework-default' }))
    const fixed = await runScenario(refundScenario({ fixed: true, crashMode: 'framework-default' }))
    expectObserved(naive, NAIVE_OBSERVED)
    expect(verdicts(fixed)).toEqual(ALL_PASS)
    for (const r of [naive, fixed]) {
      const swallowed = r.results.filter((x) => x.crashSwallowed).map((x) => x.label)
      expect(swallowed).toEqual(['crash-after-commit on refund', 'crash-after-commit on send_email'])
    }
  })
})

describe('human-in-the-loop: refund committed, then interrupt() for approval, resumed with Command({ resume })', () => {
  it('naive: the node re-executes from the top on resume, so the refund is issued twice with no fault at all', async () => {
    const report = await runScenario(hitlScenario(false))
    console.log(formatReport(report))
    const base = report.results[0]!
    expect(base.world.nodeExecutions).toBe(2)
    expect(base.world.approvalsShown).toEqual([{ question: 'Refund re_1 (£50) issued for T-1. Email the customer?', refundId: 're_1' }])
    // The human approved re_1, but the state now carries re_2.
    expect(base.world.final).toEqual({ refundId: 're_2', decision: 'approve', emailId: 'msg_1' })
    expect(base.violations).toHaveLength(2)
    DOUBLE_REFUND.forEach((re, i) => expect(base.violations[i]).toMatch(re))
    // Every fault run inherits the baseline double refund.
    expect(report.results.every((r) => !r.passed && r.violations.some((v) => /found 10000/.test(v)))).toBe(true)
  })

  it('ledger + downstream key: the node still re-executes, but the second refund call returns the first result; every fault passes', async () => {
    const report = await runScenario(hitlScenario(true))
    console.log(formatReport(report))
    expect(verdicts(report)).toEqual(ALL_PASS)
    const base = report.results[0]!
    expect(base.world.nodeExecutions).toBe(2)
    expect(base.world.final).toEqual({ refundId: 're_1', decision: 'approve', emailId: 'msg_1' })
    // Same process: the interrupt resume is answered by the ledger before shake(), so only one refund call is recorded.
    expect(base.dedupes).toBe(1)
    expect(trace(base)).toEqual(['refund/run/ok', 'send_email/run/ok'])
  })

  it('crash before the interrupt: invoke(null) re-runs the node, the wiped ledger misses, Stripe dedupes on the key', async () => {
    const report = await runScenario({ ...hitlScenario(true), faults: [{ kind: 'crash-after-commit', tool: 'refund' }] })
    const res = report.results[1]!
    expect(res.passed).toBe(true)
    // crashSignal() stopped LangGraph's node retry: no blocked retry was attempted in the dead process.
    expect(trace(res)).toEqual(['refund/run/error', 'refund/resume/ok/deduped', 'send_email/resume/ok'])
    expect(res.world.nodeExecutions).toBe(3)
  })

  it('job-redelivery restarts the finished thread from START: the human is asked to approve the same refund again', async () => {
    const report = await runScenario({ ...hitlScenario(true), faults: [{ kind: 'job-redelivery' }] })
    const res = report.results[1]!
    expect(res.passed).toBe(true)
    expect(res.world.approvalsShown).toHaveLength(2)
    expect(res.world.approvalsShown[1]).toEqual(res.world.approvalsShown[0])
    expect(trace(res).filter((c) => c.includes('/resume/'))).toEqual(['refund/resume/ok/deduped', 'send_email/resume/ok/deduped'])
  })
})
