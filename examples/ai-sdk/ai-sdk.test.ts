import { describe, expect, it } from 'vitest'
import { assertSafe, crashSignal, formatReport, runScenario, type FaultResult, type Report } from '../../src/index.js'
import { bootAgent, createRefundAgent, processTicket, refundScenario, TASK, type World } from './refund-agent.js'
import { scriptedRefundModel, type ObservedToolResult } from './scripted-model.js'

const model = () => scriptedRefundModel()
type Outcome = 'pass' | 'FAIL' | 'MISS'

function outcomes(r: Report<World>): Record<string, Outcome> {
  return Object.fromEntries(r.results.map((x) => [x.label, x.faultNotTriggered ? 'MISS' : x.passed ? 'pass' : 'FAIL']))
}
const byLabel = (r: Report<World>) => Object.fromEntries(r.results.map((x) => [x.label, x])) as Record<string, FaultResult<World>>
/** Compact trace of write calls: tool@phase + C(ommitted) D(eduped) B(locked). */
const writes = (r: FaultResult<World>) =>
  r.calls
    .filter((c) => c.effect === 'write')
    .map((c) => `${c.tool}@${c.phase}${c.committed ? ' C' : ''}${c.deduped ? ' D' : ''}${c.blocked ? ' B' : ''}`)

// Observed on ai 7.0.162 with the scripted model (see README). Same table for the
// plain agent, the toolApproval agent and the ledger-only variant.
// job-redelivery passes here because the redelivered job resumes the stored,
// already-finished conversation and the model just answers again (see below).
const NAIVE_EXPECTED: Record<string, Outcome> = {
  'baseline (no fault)': 'pass',
  'error-before-commit on refund': 'pass',
  'timeout-after-commit on refund': 'FAIL',
  'duplicate-delivery on refund': 'FAIL',
  'crash-after-commit on refund': 'FAIL',
  'error-before-commit on send_email': 'pass',
  'timeout-after-commit on send_email': 'FAIL',
  'duplicate-delivery on send_email': 'FAIL',
  'crash-after-commit on send_email': 'FAIL',
  'job-redelivery': 'pass',
}

describe('AI SDK ToolLoopAgent refund agent', () => {
  it('naive tools: after-commit faults double-refund / double-email', async () => {
    const report = await runScenario(refundScenario({ mode: 'naive', makeModel: model }))
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
    const r = byLabel(report)
    expect(r['timeout-after-commit on refund']!.violations).toContain('expected exactly 5000 refunded on ch_1, found 10000')
    expect(r['crash-after-commit on send_email']!.violations).toEqual(['expected exactly 1 email(s) to ada@example.com, found 2'])
    // The crash runs really went through resume, and the re-issued write happened there.
    const crash = r['crash-after-commit on refund']!
    expect(writes(crash)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    expect(crash.agentError).toBeUndefined()
    // crashSignal() as the SDK's abortSignal stopped the loop: the crash propagated, not swallowed.
    expect(report.results.every((x) => !x.crashSwallowed)).toBe(true)
    expect(() => assertSafe(report)).toThrow(/FAIL/)
  })

  it('ledger only (no key downstream): still fails every after-commit fault', async () => {
    // The ledger is written only after the call returns, so a timeout, a duplicate
    // delivery or a crash at the side-effect boundary never reaches it; a crash
    // also wipes the (volatile) ledger.
    const report = await runScenario(refundScenario({ mode: 'ledger-only', makeModel: model }))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
  })

  it('fixed (volatile ledger + key sent downstream): every default fault passes', async () => {
    const report = await runScenario(refundScenario({ mode: 'fixed', makeModel: model }))
    console.log(formatReport(report))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    expect(report.results.every((r) => r.agentError === undefined && !r.crashSwallowed)).toBe(true)
    const r = byLabel(report)
    // Retry after the timeout reached Stripe again; Stripe replayed it from the Idempotency-Key.
    expect(writes(r['timeout-after-commit on refund']!)).toEqual(['refund@run C', 'refund@run D', 'send_email@run C'])
    // The crash wiped the in-memory ledger; the resumed process re-issued the
    // refund and Stripe deduped it, so the job finished exactly once.
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume D', 'send_email@resume C'])
    expect(r['crash-after-commit on refund']!.dedupes).toBe(1)
  })
})

describe('job redelivery', () => {
  // Same fault, but the redelivered job is handled by a worker that starts the
  // ticket from scratch (e.g. the conversation is keyed by delivery, not ticket,
  // or the app does not persist it). That is resume = run.
  const fresh = (mode: 'naive' | 'fixed') => {
    const sc = refundScenario({ mode, makeModel: model })
    return runScenario<World>({ ...sc, resume: sc.run, faults: [{ kind: 'job-redelivery' }] })
  }

  it('a worker that starts over double-refunds with naive tools', async () => {
    const r = (await fresh('naive')).results[1]!
    expect(r.passed).toBe(false)
    expect(r.violations).toEqual([
      'expected exactly 5000 refunded on ch_1, found 10000',
      'expected at most 1 refund(s) on ch_1, found 2',
      'expected exactly 1 email(s) to ada@example.com, found 2',
    ])
  })

  it('the downstream key covers it even though the ledger was wiped', async () => {
    const r = (await fresh('fixed')).results[1]!
    expect(r.passed).toBe(true)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume D', 'send_email@resume D'])
  })

  it('a worker that resumes the stored conversation makes no new tool call (scripted model)', async () => {
    const r = byLabel(await runScenario(refundScenario({ mode: 'naive', makeModel: model })))['job-redelivery']!
    expect(r.passed).toBe(true)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C'])
  })
})

describe('AI SDK toolApproval (refund requires user approval, approve-and-continue)', () => {
  it('naive tools: approval does not prevent the duplicate', async () => {
    const report = await runScenario(refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model }))
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)

    const r = byLabel(report)
    // crash-after-commit: the refund ran in the continuation call (approved call
    // executed from message history). Resume replays the persisted approval and
    // the SDK executes the approved refund again, without asking the human again.
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])

    // Worse: a crash in send_email (a DIFFERENT tool, in the continuation's first
    // step) also double-refunds. The approved refund ran at the start of
    // generate(), outside any step, so step-end checkpointing never saved its
    // result; resume replays the stored approval and refunds again.
    const emailCrash = r['crash-after-commit on send_email']!
    expect(emailCrash.violations).toEqual([
      'expected exactly 5000 refunded on ch_1, found 10000',
      'expected at most 1 refund(s) on ch_1, found 2',
      'expected exactly 1 email(s) to ada@example.com, found 2',
    ])
    expect(writes(emailCrash)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume C', 'send_email@resume C'])
  })

  it('naive tools + checkpoint in onStepStart: closes the replayed-approval hole, not the duplicates', async () => {
    const report = await runScenario(
      refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model, process: { checkpointBeforeEachStep: true } }),
    )
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
    const emailCrash = byLabel(report)['crash-after-commit on send_email']!
    expect(emailCrash.violations).toEqual(['expected exactly 1 email(s) to ada@example.com, found 2'])
    expect(writes(emailCrash)).toEqual(['refund@run C', 'send_email@run C', 'send_email@resume C'])
  })

  it('counts how many approval prompts the human saw', async () => {
    const prompts: Record<string, number> = {}
    for (const kind of ['timeout-after-commit', 'crash-after-commit'] as const) {
      let n = 0
      const approve = () => (n++, true)
      const sc = refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model })
      const report = await runScenario<World>({
        ...sc,
        setup: () => ((n = 0), sc.setup()), // count per run; the last run is the fault run
        faults: [{ kind, tool: 'refund' }],
        run: (w) => processTicket(bootAgent(w), w.conversation, [{ role: 'user', content: TASK }], { approve }),
        resume: (w) => processTicket(bootAgent(w), w.conversation, w.conversation.load(), { approve }),
      })
      expect(report.results[1]!.passed).toBe(false)
      prompts[kind] = n
    }
    console.log('approval prompts shown to the human:', prompts)
    // timeout: the model retries the refund, which raises a 2nd approval request; the human approves the "retry".
    // crash: the persisted approval is replayed on resume; the 2nd refund needs no new approval.
    expect(prompts).toEqual({ 'timeout-after-commit': 2, 'crash-after-commit': 1 })
  })

  it('fixed tools: every fault passes, including the replayed approval', async () => {
    const report = await runScenario(refundScenario({ mode: 'fixed', refundNeedsApproval: true, makeModel: model }))
    console.log(formatReport(report))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    // The replayed approval still re-executes the refund on resume; Stripe dedupes it.
    expect(writes(byLabel(report)['crash-after-commit on send_email']!)).toEqual([
      'refund@run C',
      'send_email@run C',
      'refund@resume D',
      'send_email@resume D',
    ])
  })
})

describe('how the AI SDK surfaces tool errors (observations)', () => {
  it('a thrown tool error becomes an error-text tool result the model sees; the loop continues', async () => {
    const observed: ObservedToolResult[] = []
    const report = await runScenario({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel(observed) }),
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined() // generate() did not throw
    expect(observed).toContainEqual({
      toolName: 'refund',
      outputType: 'error-text',
      value: 'TimeoutError: Request to refund timed out after 30000ms (no response received)', // Error.toString()
    })
    // Shakedown sees clean tool input (the wrapper passes only `input`, not the SDK's options object).
    expect(run.calls.find((c) => c.tool === 'refund')!.args).toEqual({ ticket: 'T-1', charge: 'ch_1', amount: 5000 })
  })

  it('without an abort signal the SDK swallows a crash too: the model is told and the run keeps going', async () => {
    const observed: ObservedToolResult[] = []
    let finalText = ''
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel(observed) }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      // Plain agent.generate(): no abortSignal, no checkpointing.
      run: async (w) => {
        const agent = createRefundAgent({ mode: 'naive', backends: w, model: w.makeModel() })
        finalText = (await agent.generate({ prompt: TASK })).text
      },
      resume: async () => {},
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined()
    expect(run.crashSwallowed).toBe(true)
    const crashText = 'ConnectionClosedError: Process exited unexpectedly while calling refund (connection closed)'
    // The model saw the crash as an ordinary tool error and retried twice more;
    // shake() blocked both calls in the "dead" process and recorded them.
    expect(observed.filter((o) => o.outputType === 'error-text' && o.value === crashText)).toHaveLength(3)
    expect(writes(run)).toEqual(['refund@run C', 'refund@run B', 'refund@run B'])
    expect(finalText).toMatch(/could not complete refund after 3 attempts/)
    // One refund happened, but the model believes it failed and never emailed the customer.
    expect(run.violations).toEqual([])
    expect(run.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
    expect(formatReport(report)).toContain('framework caught the simulated crash')
  })

  it('passing crashSignal() as abortSignal is enough to make the crash stop generate()', async () => {
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: model }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      run: async (w) => {
        await createRefundAgent({ mode: 'naive', backends: w, model: w.makeModel() }).generate({
          prompt: TASK,
          abortSignal: crashSignal(),
        })
      },
      resume: async () => {},
    })
    const run = report.results[1]!
    expect(run.crashSwallowed).toBe(false)
    expect(run.agentError).toBeUndefined()
    // The SDK checks the signal before the next step, so the model never saw the crash.
    expect(writes(run)).toEqual(['refund@run C'])
  })

  it('but a crash in an approved call does not stop generate(): it returns normally with a fresh approval request', async () => {
    // Approved calls run before step 1, and the SDK only checks abortSignal before
    // steps 2..n. Step 1 shows the model the crash as a tool error, the model
    // retries the refund, that needs approval, and generate() returns. Without
    // the explicit crash?.throwIfAborted() in processTicket, the app would ask
    // the human to approve the "retry" from a process that is already dead.
    let second: { threw: boolean; pendingApprovals: string[] } | undefined
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      run: async (w) => {
        const agent = bootAgent(w)
        const abortSignal = crashSignal()
        const first = await agent.generate({ prompt: TASK, abortSignal })
        const req = first.content.find((p) => p.type === 'tool-approval-request')!
        if (req.type !== 'tool-approval-request') throw new Error('expected an approval request')
        const messages = [
          { role: 'user' as const, content: TASK },
          ...first.responseMessages,
          { role: 'tool' as const, content: [{ type: 'tool-approval-response' as const, approvalId: req.approvalId, approved: true }] },
        ]
        try {
          const r = await agent.generate({ messages, abortSignal })
          second = { threw: false, pendingApprovals: r.content.flatMap((p) => (p.type === 'tool-approval-request' ? [p.toolCall.toolName] : [])) }
        } catch {
          second = { threw: true, pendingApprovals: [] }
        }
      },
      resume: async () => {},
    })
    expect(second).toEqual({ threw: false, pendingApprovals: ['refund'] })
    expect(report.results[1]!.crashSwallowed).toBe(true)
  })
})
