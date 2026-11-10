import { InMemoryStorageAdapter, createOutputMiddleware } from '@voltagent/core'
import { describe, expect, it } from 'vitest'
import { assertSafe, crashSignal, formatReport, runScenario, type FaultResult, type Report } from '../../src/index.js'
import {
  CONVERSATION_ID,
  USER_ID,
  TASK,
  bootAgent,
  newWorld,
  processTicket,
  refundScenario,
  type DurableStorage,
  type World,
} from './refund-agent.js'
import { scriptedRefundModel, type ObservedToolResult, type ScriptOptions } from './scripted-model.js'

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
const parts = (msgs: Array<{ role: string; parts: unknown[] }>) =>
  msgs.map((m) => `${m.role}:${(m.parts as Array<{ type: string; state?: string }>).map((p) => `${p.type}${p.state ? `/${p.state}` : ''}`).join('|')}`)

// Observed on @voltagent/core 2.11.1 + ai 6.0.326 with the scripted model (see
// README). Same table for the plain agent, the needsApproval agent and ledger-only.
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
const TWO_REFUNDS = ['expected exactly 5000 refunded on ch_1, found 10000', 'expected at most 1 refund(s) on ch_1, found 2']

describe('VoltAgent Agent refund agent (memory-backed resume)', () => {
  it('naive tools: after-commit faults double-refund / double-email', async () => {
    const report = await runScenario(refundScenario({ mode: 'naive', makeModel: model }))
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
    const r = byLabel(report)
    expect(r['timeout-after-commit on refund']!.violations).toEqual(TWO_REFUNDS)
    expect(r['crash-after-commit on send_email']!.violations).toEqual(['expected exactly 1 email(s) to ada@example.com, found 2'])
    // The crash runs really went through resume (new Agent, same memory), and the re-issued write happened there.
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    // crashSignal() as abortSignal stopped the loop: generateText() rejected, the crash was not swallowed.
    expect(report.results.every((x) => !x.crashSwallowed && x.agentError === undefined)).toBe(true)
    expect(() => assertSafe(report)).toThrow(/FAIL/)
  })

  it('ledger only (no key downstream): still fails every after-commit fault', async () => {
    const report = await runScenario(refundScenario({ mode: 'ledger-only', makeModel: model }))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
  })

  it('fixed (volatile ledger + key sent downstream): every default fault passes', async () => {
    const report = await runScenario(refundScenario({ mode: 'fixed', makeModel: model }))
    console.log(formatReport(report))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    const r = byLabel(report)
    expect(writes(r['timeout-after-commit on refund']!)).toEqual(['refund@run C', 'refund@run D', 'send_email@run C'])
    // The crash wiped the in-memory ledger; the resumed process re-issued the refund and Stripe deduped it.
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume D', 'send_email@resume C'])
    expect(r['crash-after-commit on refund']!.dedupes).toBe(1)
  })

  it('crash resume: memory holds the steps before the crashed one, not the committed refund', async () => {
    let seen: string[] = []
    const sc = refundScenario({ mode: 'naive', makeModel: model })
    await runScenario<World>({
      ...sc,
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      resume: async (w) => {
        seen = parts(await w.storage.getMessages(USER_ID, CONVERSATION_ID))
        return sc.resume!(w)
      },
    })
    // Step 1 (lookup) was flushed on its tool result; the refund step never finished, so nothing records the refund.
    expect(seen).toEqual(['user:text', 'assistant:tool-lookup_charge/output-available'])
  })
})

describe('job redelivery', () => {
  // The redelivered job is handled by a worker that starts a NEW conversation
  // (conversation keyed per delivery, or no memory): that is resume = run.
  const fresh = (mode: 'naive' | 'fixed') => {
    const sc = refundScenario({ mode, makeModel: model })
    return runScenario<World>({
      ...sc,
      resume: (w) => processTicket(bootAgent(w), w, TASK, { conversationId: 'ticket-T-1-delivery-2' }),
      faults: [{ kind: 'job-redelivery' }],
    })
  }

  it('a worker that starts a new conversation double-refunds with naive tools', async () => {
    const r = (await fresh('naive')).results[1]!
    expect(r.violations).toEqual([...TWO_REFUNDS, 'expected exactly 1 email(s) to ada@example.com, found 2'])
  })

  it('the downstream key covers it even though the ledger was wiped', async () => {
    const r = (await fresh('fixed')).results[1]!
    expect(r.passed).toBe(true)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume D', 'send_email@resume D'])
  })

  it('a worker that redelivers to the same conversation makes no new tool call (scripted model)', async () => {
    const r = byLabel(await runScenario(refundScenario({ mode: 'naive', makeModel: model })))['job-redelivery']!
    expect(r.passed).toBe(true)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C'])
  })
})

describe('VoltAgent needsApproval (refund requires human approval)', () => {
  it('naive tools: approval does not prevent the duplicate; a crash in send_email replays the approved refund', async () => {
    const report = await runScenario(refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model }))
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
    const r = byLabel(report)
    expect(writes(r['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    const emailCrash = r['crash-after-commit on send_email']!
    expect(emailCrash.violations).toEqual([...TWO_REFUNDS, 'expected exactly 1 email(s) to ada@example.com, found 2'])
    expect(writes(emailCrash)).toEqual(['refund@run C', 'send_email@run C', 'refund@resume C', 'send_email@resume C'])
  })

  it('the approved refund ran before any step, so memory never recorded its result', async () => {
    let seen: string[] = []
    const sc = refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model })
    await runScenario<World>({
      ...sc,
      faults: [{ kind: 'crash-after-commit', tool: 'send_email' }],
      resume: async (w) => {
        seen = parts(await w.storage.getMessages(USER_ID, CONVERSATION_ID))
        return sc.resume!(w)
      },
    })
    // Stripe has the refund, memory still says "approved, not run": redelivering the approval runs it again.
    expect(seen).toEqual(['user:text', 'assistant:tool-lookup_charge/output-available|tool-refund/approval-responded'])
  })

  it('counts how many approval prompts the human saw', async () => {
    const prompts: Record<string, number> = {}
    for (const kind of ['timeout-after-commit', 'crash-after-commit'] as const) {
      let n = 0
      const approve = () => (n++, true)
      const sc = refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model, process: { approve } })
      const report = await runScenario<World>({ ...sc, setup: () => ((n = 0), sc.setup()), faults: [{ kind, tool: 'refund' }] })
      expect(report.results[1]!.passed).toBe(false)
      prompts[kind] = n
    }
    console.log('approval prompts shown to the human:', prompts)
    // timeout: the model retries the "failed" refund, which needs a 2nd approval; the human approves the retry.
    // crash: the stored approval is redelivered on resume; the 2nd refund needs no new approval.
    expect(prompts).toEqual({ 'timeout-after-commit': 2, 'crash-after-commit': 1 })
  })

  it('fixed tools: every fault passes, including the replayed approval', async () => {
    const report = await runScenario(refundScenario({ mode: 'fixed', refundNeedsApproval: true, makeModel: model }))
    console.log(formatReport(report))
    expect(report.passed).toBe(true)
    expect(writes(byLabel(report)['crash-after-commit on send_email']!)).toEqual([
      'refund@run C',
      'send_email@run C',
      'refund@resume D',
      'send_email@resume D',
    ])
  })

  it('without the repairApprovals workaround an approved tool call bricks the conversation', async () => {
    const w = newWorld({ mode: 'naive', refundNeedsApproval: true, makeModel: model, repairApprovals: false })
    expect(await processTicket(bootAgent(w), w, TASK)).toMatch(/Refunded/)
    const refundPart = (await w.storage.getMessages(USER_ID, CONVERSATION_ID))
      .flatMap((m) => m.parts as Array<{ type: string; state?: string; approval?: unknown }>)
      .find((p) => p.type === 'tool-refund')!
    // Memory dropped `approved: true` from the part once the tool ran.
    expect(refundPart.state).toBe('output-available')
    expect(refundPart.approval).toEqual({ id: expect.any(String) })
    // Any later turn on this conversation fails the AI SDK's UIMessage validation.
    await expect(processTicket(bootAgent(w), w, 'Did the refund go through?')).rejects.toThrow(/Type validation failed/)

    // The same bug blocks a second approval in one job: after a failed approved refund the
    // model asks again, and the approval message built from memory cannot be sent.
    const report = await runScenario(refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model, repairApprovals: false }))
    const r = byLabel(report)
    expect(r['error-before-commit on refund']!.agentError).toMatch(/Type validation failed/)
    expect(r['error-before-commit on refund']!.incomplete.length).toBeGreaterThan(0)
    expect(r['job-redelivery']!.agentError).toMatch(/after redelivery: Type validation failed/)
  })
})

describe('how VoltAgent surfaces tool errors (observations)', () => {
  it('a thrown tool error reaches the model as a successful JSON result with the stack and every own property', async () => {
    const observed: ObservedToolResult[] = []
    const report = await runScenario({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel({ observed }) }),
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined() // generateText() resolved
    const seen = observed.find((o) => o.toolName === 'refund' && (o.value as { error?: boolean }).error === true)!
    // Not the AI SDK's 'error-text': VoltAgent's buildToolErrorResult returns the error as the tool's OUTPUT.
    expect(seen.outputType).toBe('json')
    expect(seen.value).toMatchObject({
      error: true,
      name: 'TimeoutError',
      message: 'Request to refund timed out after 30000ms (no response received)',
      code: 'ETIMEDOUT', // own enumerable properties are copied too
      toolName: 'refund',
    })
    // The stack trace, with absolute source paths, is part of the prompt.
    expect((seen.value as { stack: string }).stack).toMatch(/shake\.ts/)
    // VoltAgent does not retry the tool itself: one refund call per model request for it (2 = the model's retry).
    expect(run.calls.filter((c) => c.tool === 'refund')).toHaveLength(2)
    expect(run.calls.find((c) => c.tool === 'refund')!.args).toEqual({ ticket: 'T-1', charge: 'ch_1', amount: 5000 })
  })

  it('without an abort signal VoltAgent swallows a crash: the model is told and the run keeps going', async () => {
    const observed: ObservedToolResult[] = []
    let finalText = ''
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel({ observed }) }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      run: async (w) => {
        finalText = (await bootAgent(w).generateText(TASK, { memory: { userId: USER_ID, conversationId: CONVERSATION_ID } })).text
      },
      resume: async () => {},
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined()
    expect(run.crashSwallowed).toBe(true)
    const crashes = observed.filter((o) => o.toolName === 'refund' && (o.value as { name?: string }).name === 'ConnectionClosedError')
    expect(crashes).toHaveLength(3)
    // Shakedown's own marker property rides along to the model, as any error field would.
    expect(crashes[0]!.value).toMatchObject({ shakedownCrash: true })
    expect(writes(run)).toEqual(['refund@run C', 'refund@run B', 'refund@run B'])
    expect(finalText).toMatch(/could not complete refund after 3 attempts/)
    expect(run.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
  })

  it('with crashSignal() as abortSignal, generateText() rejects with VoltAgent AbortError', async () => {
    let thrown: { name: string; message: string } | undefined
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: model }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      run: async (w) => {
        try {
          await bootAgent(w).generateText(TASK, { memory: { userId: USER_ID, conversationId: CONVERSATION_ID }, abortSignal: crashSignal() })
        } catch (e) {
          thrown = { name: (e as Error).name, message: (e as Error).message }
          throw e
        }
      },
      resume: async () => {},
    })
    expect(thrown).toEqual({
      name: 'AbortError',
      message: 'Operation aborted: Process exited unexpectedly while calling refund (connection closed)',
    })
    expect(report.results[1]!.crashSwallowed).toBe(false)
    expect(writes(report.results[1]!)).toEqual(['refund@run C'])
  })

  it('on abort VoltAgent still flushes the in-flight step: memory records the committed refund as an error', async () => {
    // A plain storage adapter (writes are NOT dropped after the crash): what a
    // cancel/abort (client disconnect, request timeout) leaves behind, as
    // opposed to a hard kill.
    let seen: unknown
    const sc = refundScenario({ mode: 'naive', makeModel: model })
    const report = await runScenario<World>({
      ...sc,
      setup: () => ({ ...newWorld({ mode: 'naive', makeModel: model }), storage: new InMemoryStorageAdapter() as DurableStorage }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      resume: async (w) => {
        const msgs = await w.storage.getMessages(USER_ID, CONVERSATION_ID)
        const out = msgs.flatMap((m) => m.parts as Array<{ type: string; output?: unknown }>).find((p) => p.type === 'tool-refund')?.output
        // Stored here in model-output form ({ type: 'json', value }), unlike the raw outputs a normal step flush stores.
        seen = (out as { type?: string; value?: unknown })?.type === 'json' ? (out as { value: unknown }).value : out
        return sc.resume!(w)
      },
    })
    // Stripe committed the refund; memory says it failed (flushPendingMessagesOnError).
    expect(seen).toMatchObject({ error: true, name: 'ConnectionClosedError' })
    // The next turn reads "refund failed" and the model refunds again.
    expect(report.results[1]!.violations).toEqual(TWO_REFUNDS)
  })

  it("a failing tool runs the tool's own hooks.onEnd twice; agent onToolError once", async () => {
    const ends: Array<'ok' | 'error'> = []
    let toolErrors = 0
    const sc = refundScenario({ mode: 'naive', makeModel: model })
    await runScenario<World>({
      ...sc,
      faults: [{ kind: 'error-before-commit', tool: 'refund' }],
      run: (w) =>
        processTicket(
          bootAgent(w, {
            refundToolHooks: { onEnd: ({ error }) => void ends.push(error ? 'error' : 'ok') },
            hooks: { onToolError: () => void toolErrors++ },
          }),
          w,
          TASK,
        ),
    })
    // Baseline run (1 ok) + fault run (1 failed call -> 2 onEnd, then the retry -> 1 ok).
    expect(ends).toEqual(['ok', 'error', 'error', 'ok'])
    expect(toolErrors).toBe(1)
  })
})

describe('VoltAgent retries the whole loop, not the step (observations)', () => {
  const overloaded = () => Object.assign(new Error('Overloaded'), { statusCode: 529 })
  const baselineWith = async (mode: 'naive' | 'fixed', script: ScriptOptions, extra: Parameters<typeof bootAgent>[1] = {}) => {
    const sc = refundScenario({ mode, makeModel: () => scriptedRefundModel(script) })
    const report = await runScenario<World>({ ...sc, faults: [], run: (w) => processTicket(bootAgent(w, extra), w, TASK) })
    return report.results[0]!
  }

  it('a model error after a committed refund re-runs the loop from the original input: naive tools refund twice', async () => {
    const retries: number[] = []
    const r = await baselineWith(
      'naive',
      { failAfterRefund: { times: 1, error: overloaded } },
      { hooks: { onRetry: (a) => void retries.push(a.source === 'llm' ? a.attempt : -1) } },
    )
    // No tool fault at all. VoltAgent calls the AI SDK with maxRetries: 0 and retries
    // generateText itself (default maxRetries 3, 1s backoff) with the messages it
    // prepared before step 1, so the model never sees the refund it already made.
    expect(retries).toEqual([1])
    expect(writes(r)).toEqual(['refund@run C', 'refund@run C', 'send_email@run C'])
    expect(r.violations).toEqual(TWO_REFUNDS)
  }, 30_000)

  it('the downstream key makes that retry safe', async () => {
    const r = await baselineWith('fixed', { failAfterRefund: { times: 1, error: overloaded } })
    expect(r.passed).toBe(true)
    // Same process, so the in-memory ledger answers the replayed refund before it reaches shake()/Stripe.
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C'])
    expect(r.dedupes).toBe(1)
  }, 30_000)

  it('maxRetries: 0 trades the duplicate for a job that stops after the refund', async () => {
    const r = await baselineWith('naive', { failAfterRefund: { times: 1, error: overloaded } }, { maxRetries: 0 })
    expect(r.agentError).toMatch(/Overloaded/)
    expect(writes(r)).toEqual(['refund@run C'])
    expect(r.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
  })

  it('an output-middleware retry re-runs the loop too, but reloads memory, so the scripted model calls no tool again', async () => {
    let runs = 0
    const mw = createOutputMiddleware<string>({
      name: 'cite-refund-id',
      handler: ({ output, abort, retryCount }) => {
        runs++
        if (retryCount === 0) abort('summary must cite the refund id', { retry: true })
        return output
      },
    })
    const r = await baselineWith('naive', {}, { outputMiddlewares: [mw], maxMiddlewareRetries: 1 })
    expect(runs).toBe(2)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C'])
    expect(r.passed).toBe(true)
  })
})

describe('memory race with a model that answers without yielding (latencyMs: 0)', () => {
  // VoltAgent saves the user's input on a setTimeout(0) background queue
  // (fire-and-forget, 5 retries at 50 ms steps). A real provider call yields to
  // the event loop long before the first step flush; an in-process mock may not.
  const settle = () => new Promise((r) => setTimeout(r, 100))

  it('the first-turn user message is stored after the assistant reply', async () => {
    const w = newWorld({ mode: 'naive', makeModel: () => scriptedRefundModel({ latencyMs: 0 }) })
    await processTicket(bootAgent(w), w, TASK)
    await settle()
    expect((await w.storage.getMessages(USER_ID, CONVERSATION_ID)).map((m) => m.role)).toEqual(['assistant', 'user'])

    const ok = newWorld({ mode: 'naive', makeModel: () => scriptedRefundModel() }) // 1 ms latency
    await processTicket(bootAgent(ok), ok, TASK)
    await settle()
    expect((await ok.storage.getMessages(USER_ID, CONVERSATION_ID)).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('an approve-and-continue loses its results: the late input save overwrites the merged assistant message', async () => {
    const w = newWorld({ mode: 'naive', refundNeedsApproval: true, makeModel: () => scriptedRefundModel({ latencyMs: 0 }) })
    await processTicket(bootAgent(w), w, TASK)
    await settle()
    const stored = parts(await w.storage.getMessages(USER_ID, CONVERSATION_ID))
    // The refund ran and the email was sent, but memory keeps the client's copy of the approval message.
    expect(stored).toContain('assistant:tool-lookup_charge/output-available|tool-refund/approval-responded')
    expect(stored.join(' ')).not.toContain('tool-send_email')
    expect(w.stripe.refunds.list({ charge: 'ch_1' }).data).toHaveLength(1)
  })
})
