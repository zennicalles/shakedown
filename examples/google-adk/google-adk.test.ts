import { getFunctionCalls, getFunctionResponses, ReflectAndRetryToolPlugin, REFLECT_AND_RETRY_RESPONSE_TYPE, type Event } from '@google/adk'
import { describe, expect, it } from 'vitest'
import { assertSafe, crashSignal, formatReport, runScenario, SimulatedTimeoutError, type FaultResult, type Report } from '../../src/index.js'
import {
  APP,
  SESSION,
  TASK,
  USER,
  DurableSessionService,
  bootRunner,
  createRefundAgent,
  createRunner,
  newWorld,
  processTicket,
  refundScenario,
  taskMessage,
  type World,
} from './refund-agent.js'
import { readToolEvents, scriptedRefundModel, type ObservedToolResult } from './scripted-model.js'

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

/** The durable session, as the next process would load it. */
async function storedEvents(w: World): Promise<Event[]> {
  return (await w.sessions.getSession({ appName: APP, userId: USER, sessionId: SESSION }))!.events
}
/** Function responses the session holds for a tool, in order. */
const responsesFor = (events: Event[], tool: string) =>
  events.flatMap((e) => getFunctionResponses(e)).filter((r) => r.name === tool).map((r) => r.response)
const callsFor = (events: Event[], tool: string) => events.flatMap((e) => getFunctionCalls(e)).filter((c) => c.name === tool)

// Observed on @google/adk 2.4.0 with the scripted model (see README). Same table for the
// plain agent, the requireConfirmation agent and the ledger-only variant.
// job-redelivery passes here because the redelivered job lands in the stored,
// already-finished session and the model just answers again (see below).
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

describe('Google ADK LlmAgent refund agent', () => {
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
    // crashSignal() as the Runner's abortSignal + throwIfAborted() stopped the loop: the crash propagated, not swallowed.
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
  // Same fault, but the redelivered job is handled by a worker whose session
  // storage did not survive (InMemorySessionService / InMemoryRunner, the ADK
  // default for getting started), so it starts the ticket from scratch.
  const fresh = (mode: 'naive' | 'fixed') => {
    const sc = refundScenario({ mode, makeModel: model })
    return runScenario<World>({
      ...sc,
      resume: async (w) => {
        w.sessions = new DurableSessionService()
        await w.sessions.createSession({ appName: APP, userId: USER, sessionId: SESSION })
        await processTicket(bootRunner(w), w.jobs, taskMessage())
      },
      faults: [{ kind: 'job-redelivery' }],
    })
  }

  it('a worker that lost the session double-refunds with naive tools', async () => {
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

  it('a worker that redelivers the task to the stored session makes no new tool call (scripted model)', async () => {
    const r = byLabel(await runScenario(refundScenario({ mode: 'naive', makeModel: model })))['job-redelivery']!
    expect(r.passed).toBe(true)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C'])
    // The task really was appended to the same session a second time.
    const userTexts = (await storedEvents(r.world)).filter((e) => e.author === 'user').map((e) => e.content?.parts?.[0]?.text)
    expect(userTexts).toEqual([TASK, TASK])
  })
})

describe('ADK requireConfirmation (refund needs human approval, approve-and-continue)', () => {
  it('naive tools: approval does not prevent the duplicate', async () => {
    const report = await runScenario(refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model }))
    console.log(formatReport(report))
    expect(outcomes(report)).toEqual(NAIVE_EXPECTED)
    const r = byLabel(report)

    // crash-after-commit on refund: the approved refund ran in the approval job
    // (ADK's RequestConfirmationLlmRequestProcessor executes it before the model
    // step). Its result was never persisted, so the redelivered approval makes
    // ADK execute the approved call again, without asking the human again.
    const refundCrash = r['crash-after-commit on refund']!
    expect(writes(refundCrash)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    const events = await storedEvents(refundCrash.world)
    // Only one refund call from the model ever existed: the second refund is the framework replaying the approval.
    expect(callsFor(events, 'refund')).toHaveLength(1)

    // Unlike the AI SDK, a crash in a DIFFERENT tool does not replay the approval:
    // ADK appends the approved call's result to the session as its own event
    // before the model step, and skips approvals whose call already has a response.
    const emailCrash = r['crash-after-commit on send_email']!
    expect(emailCrash.violations).toEqual(['expected exactly 1 email(s) to ada@example.com, found 2'])
    expect(writes(emailCrash)).toEqual(['refund@run C', 'send_email@run C', 'send_email@resume C'])
  })

  it('counts how many approval prompts the human saw', async () => {
    const prompts: Record<string, number> = {}
    for (const kind of ['timeout-after-commit', 'crash-after-commit'] as const) {
      let n = 0
      const approve = () => (n++, true)
      const sc = refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model, process: { approve } })
      const report = await runScenario<World>({
        ...sc,
        setup: () => ((n = 0), sc.setup()), // count per run; the last run is the fault run
        faults: [{ kind, tool: 'refund' }],
      })
      expect(report.results[1]!.passed).toBe(false)
      prompts[kind] = n
    }
    console.log('approval prompts shown to the human:', prompts)
    // timeout: the model retries the refund, which raises a 2nd confirmation request; the human approves the "retry".
    // crash: the redelivered approval is replayed on resume; the 2nd refund needs no new approval.
    expect(prompts).toEqual({ 'timeout-after-commit': 2, 'crash-after-commit': 1 })
  })

  it('a redelivered approval after the job finished is not executed again', async () => {
    const r = byLabel(await runScenario(refundScenario({ mode: 'naive', refundNeedsApproval: true, makeModel: model })))['job-redelivery']!
    expect(r.passed).toBe(true)
    expect(writes(r)).toEqual(['refund@run C', 'send_email@run C'])
    // The job in flight (and redelivered) was the confirmation response, not the task.
    const events = await storedEvents(r.world)
    const confirmations = events.filter((e) => e.author === 'user' && getFunctionResponses(e).some((fr) => fr.name === 'adk_request_confirmation'))
    expect(confirmations).toHaveLength(2)
    // ADK saw the approved call already had a response and did not run it again.
    expect(responsesFor(events, 'refund')).toHaveLength(1)
  })

  it('fixed tools: every fault passes, including the replayed approval', async () => {
    const report = await runScenario(refundScenario({ mode: 'fixed', refundNeedsApproval: true, makeModel: model }))
    console.log(formatReport(report))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    // The replayed approval still re-executes the refund on resume; Stripe dedupes it.
    expect(writes(byLabel(report)['crash-after-commit on refund']!)).toEqual(['refund@run C', 'refund@resume D', 'send_email@resume C'])
  })
})

describe('how ADK surfaces tool errors and aborts (observations)', () => {
  it('a thrown tool error becomes an { error } function response with the error name dropped; the loop continues and ADK does not retry', async () => {
    const observed: ObservedToolResult[] = []
    const report = await runScenario({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel({ observed }) }),
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined() // runAsync did not throw
    // FunctionTool.runAsync rethrows every error as `new Error("Error in tool '<name>': " + message)`,
    // and the flow puts only `.message` in the response: "TimeoutError" and `code: 'ETIMEDOUT'` never reach the model.
    expect(observed).toContainEqual({
      toolName: 'refund',
      response: { error: "Error in tool 'refund': Request to refund timed out after 30000ms (no response received)" },
    })
    // No framework-level retry: every refund execution corresponds to a refund call the model made.
    const events = await storedEvents(run.world)
    expect(callsFor(events, 'refund')).toHaveLength(2)
    expect(run.calls.filter((c) => c.tool === 'refund')).toHaveLength(2)
    // Shakedown sees clean tool args (the wrapper passes only the parsed args, not ADK's Context).
    expect(run.calls.find((c) => c.tool === 'refund')!.args).toEqual({ ticket: 'T-1', charge: 'ch_1', amount: 5000 })
  })

  it('without an abort signal ADK swallows a crash too: the model is told and the run keeps going', async () => {
    const observed: ObservedToolResult[] = []
    let finalText = ''
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel({ observed }) }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      // Plain runner.runAsync: no abortSignal.
      run: async (w) => {
        const runner = createRunner(createRefundAgent({ mode: 'naive', backends: w, model: w.makeModel() }), w.sessions)
        for await (const ev of runner.runAsync({ userId: USER, sessionId: SESSION, newMessage: taskMessage() })) {
          const text = ev.content?.parts?.[0]?.text
          if (text) finalText = text
        }
      },
      resume: async () => {},
    })
    const run = report.results[1]!
    expect(run.agentError).toBeUndefined()
    expect(run.crashSwallowed).toBe(true)
    const crashText = "Error in tool 'refund': Process exited unexpectedly while calling refund (connection closed)"
    // The model saw the crash as an ordinary tool error and retried twice more;
    // shake() blocked both calls in the "dead" process and recorded them.
    expect(observed.filter((o) => o.toolName === 'refund' && o.response['error'] === crashText)).toHaveLength(3)
    expect(writes(run)).toEqual(['refund@run C', 'refund@run B', 'refund@run B'])
    expect(finalText).toMatch(/could not complete refund after 3 attempts/)
    // One refund happened, but the model believes it failed and never emailed the customer.
    expect(run.violations).toEqual([])
    expect(run.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
    expect(formatReport(report)).toContain('framework caught the simulated crash')
  })

  it('abortSignal stops the loop but runAsync returns normally: without throwIfAborted() the crash looks like a finished run', async () => {
    let streamed: Event[] = []
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: model }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      run: async (w) => {
        streamed = [] // per run; the last run is the fault run
        const runner = createRunner(createRefundAgent({ mode: 'naive', backends: w, model: w.makeModel() }), w.sessions)
        for await (const ev of runner.runAsync({ userId: USER, sessionId: SESSION, newMessage: taskMessage(), abortSignal: crashSignal() })) streamed.push(ev)
      },
      resume: async () => {},
    })
    const run = report.results[1]!
    // No exception reached the caller, so Shakedown reports the crash as swallowed...
    expect(run.agentError).toBeUndefined()
    expect(run.crashSwallowed).toBe(true)
    // ...even though ADK did stop: the model was never called again and nothing else ran.
    expect(writes(run)).toEqual(['refund@run C'])
    // The caller got: lookup call, lookup response, refund call, then a synthetic
    // abort event answering the refund call. The tool's own (error) response was discarded.
    expect(streamed.map((e) => [getFunctionCalls(e).map((c) => c.name), getFunctionResponses(e).map((r) => r.response), e.errorCode ?? null])).toEqual([
      [['lookup_charge'], [], null],
      [[], [expect.objectContaining({ id: 'ch_1' })], null],
      [['refund'], [], null],
      [[], [{ error: 'Invocation was aborted by client.' }], 'INVOCATION_ABORTED'],
    ])
  })

  it('on abort the Runner seals the invocation: a refund that SUCCEEDED is recorded as "Invocation was aborted by client."', async () => {
    // Graceful cancellation (client disconnect, SIGTERM handler aborting the run),
    // no Shakedown fault: the refund call returns normally while the signal fires.
    const w = await newWorld({ mode: 'naive', makeModel: model })
    w.sessions = new DurableSessionService(true)
    await w.sessions.createSession({ appName: APP, userId: USER, sessionId: SESSION })
    const ac = new AbortController()
    const create = w.stripe.refunds.create.bind(w.stripe.refunds)
    w.stripe.refunds.create = (...a: Parameters<typeof create>) => {
      const out = create(...a)
      ac.abort() // the cancel lands while the refund call is in flight; the refund itself succeeds
      return out
    }
    const runner = createRunner(createRefundAgent({ mode: 'naive', backends: w, model: w.makeModel() }), w.sessions)
    for await (const _ of runner.runAsync({ userId: USER, sessionId: SESSION, newMessage: taskMessage(), abortSignal: ac.signal })) {
      /* drain */
    }
    expect(w.stripe.charges.retrieve('ch_1').amount_refunded).toBe(5000)
    // ADK threw the successful result away (postprocess returns on abort before yielding the
    // function response) and Runner.synthesizeAbortEvents persisted an error in its place.
    const events = await storedEvents(w)
    expect(responsesFor(events, 'refund')).toEqual([{ error: 'Invocation was aborted by client.' }])
    expect(events.at(-1)!.errorCode).toBe('INVOCATION_ABORTED')

    // The next delivery of the ticket shows the model a failed refund; the scripted model retries it.
    w.stripe.refunds.create = create
    const observed: ObservedToolResult[] = []
    w.makeModel = () => scriptedRefundModel({ observed })
    await processTicket(bootRunner(w), w.jobs, taskMessage())
    expect(observed[0]).toEqual({ toolName: 'refund', response: { error: 'Invocation was aborted by client.' } })
    expect(w.stripe.charges.retrieve('ch_1').amount_refunded).toBe(10_000)
  })

  it('graceful shutdown (seal persisted) under crash-after-commit: same double refund; the fixed tools dedupe it', async () => {
    const run = async (mode: 'naive' | 'fixed') => {
      const observed: ObservedToolResult[] = []
      const report = await runScenario({
        ...refundScenario({ mode, persistAfterCrash: true, makeModel: () => scriptedRefundModel({ observed }) }),
        faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      })
      return { r: report.results[1]!, observed }
    }
    const naive = await run('naive')
    expect(naive.observed).toContainEqual({ toolName: 'refund', response: { error: 'Invocation was aborted by client.' } })
    expect(writes(naive.r)).toEqual(['refund@run C', 'refund@resume C', 'send_email@resume C'])
    const fixed = await run('fixed')
    expect(fixed.r.passed).toBe(true)
    expect(writes(fixed.r)).toEqual(['refund@run C', 'refund@resume D', 'send_email@resume C'])
  })

  it('after a hard crash the resumed request carries the refund call with no response at all', async () => {
    const requests: Parameters<typeof readToolEvents>[0][] = []
    let phase = 'run'
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel(phase === 'resume' ? { requests } : {}) }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      resume: async (w) => {
        phase = 'resume'
        await processTicket(bootRunner(w), w.jobs, w.jobs.inFlight())
      },
    })
    expect(report.results[1]!.violations.length).toBeGreaterThan(0)
    // ADK neither repairs nor flags the dangling call: it goes to the model as-is,
    // followed by the redelivered task. (A strict provider may reject this history.)
    const first = requests[0]!
    expect(readToolEvents(first).danglingCalls).toEqual(['refund'])
    expect(first.at(-1)).toEqual({ role: 'user', parts: [{ text: TASK }] })
  })

  it('runAsync without a newMessage runs nothing: there is no "continue" call to resume with', async () => {
    const report = await runScenario<World>({
      ...refundScenario({ mode: 'naive', makeModel: model }),
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      resume: async (w) => {
        let n = 0
        // Typed as required; at runtime the Runner silently skips the agent when it is missing.
        for await (const _ of bootRunner(w).runAsync({ userId: USER, sessionId: SESSION, newMessage: undefined as never })) n++
        expect(n).toBe(0)
      },
    })
    const r = report.results[1]!
    expect(r.resumeWrites).toBe(0)
    expect(r.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
    expect(r.untested).toBe(true)
  })

  it('ReflectAndRetryToolPlugin rewrites the error into retry guidance; it does not re-execute the tool itself', async () => {
    const observed: ObservedToolResult[] = []
    const plugin = () => [new ReflectAndRetryToolPlugin({ maxRetries: 3 })]
    const sc = refundScenario({ mode: 'naive', makeModel: () => scriptedRefundModel({ observed }) })
    const report = await runScenario<World>({
      ...sc,
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
      run: (w) => ((observed.length = 0), processTicket(bootRunner(w, plugin()), w.jobs, taskMessage())), // per run
    })
    const run = report.results[1]!
    const seen = observed.find((o) => o.toolName === 'refund')!.response
    expect(seen['response_type']).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE)
    // The class name is gone by the time a plugin sees the error: FunctionTool rewrapped it as a plain Error.
    expect(seen['error_type']).toBe('Error')
    expect(seen['error_details']).toBe("Error in tool 'refund': Request to refund timed out after 30000ms (no response received)")
    expect(seen['reflection_guidance']).toContain('This is retry attempt **1 of 3**')
    expect(seen['reflection_guidance']).toContain('Do not repeat the exact same call')
    // The tool ran once per model call; the second refund is the (scripted) model retrying.
    expect(writes(run)).toEqual(['refund@run C', 'refund@run C', 'send_email@run C'])
    expect(run.violations).toContain('expected exactly 5000 refunded on ch_1, found 10000')
  })

  it('ReflectAndRetryToolPlugin past its limit does not stop the run: the exception becomes a non-final error event and the model is called again', async () => {
    // A refund endpoint that commits and then times out on EVERY call (a slow upstream).
    const w = await newWorld({ mode: 'naive', makeModel: model })
    const create = w.stripe.refunds.create.bind(w.stripe.refunds)
    w.stripe.refunds.create = (...a: Parameters<typeof create>) => {
      create(...a)
      throw new SimulatedTimeoutError('refund')
    }
    let modelCalls = 0
    w.makeModel = () => {
      const m = scriptedRefundModel()
      const gen = m.generateContentAsync.bind(m)
      m.generateContentAsync = (...a) => (modelCalls++, gen(...a))
      return m
    }
    const runner = bootRunner(w, [new ReflectAndRetryToolPlugin({ maxRetries: 1 })])
    const seen: Event[] = []
    // throwExceptionIfRetryExceeded defaults to true, so the plugin throws on the 2nd failure. maxLlmCalls is
    // lowered from its default of 500 to keep the test fast; with the default this loop ran 499 refunds.
    for await (const ev of runner.runAsync({ userId: USER, sessionId: SESSION, newMessage: taskMessage(), runConfig: { maxLlmCalls: 20 } })) {
      seen.push(ev)
    }
    const errors = seen.filter((e) => e.errorCode)
    // LlmAgent.runAndHandleError turns the plugin's exception into an error event with no content. The loop
    // treats a content-less event after a tool call as non-final, so it calls the model again; the failed
    // call is left without a response, and every later failure throws again.
    expect(errors[0]).toMatchObject({
      errorCode: 'UNKNOWN_ERROR',
      errorMessage: "Error in plugin 'reflect_retry_tool_plugin' during 'onToolErrorCallback' callback: Error: Error in tool 'refund': Request to refund timed out after 30000ms (no response received)",
    })
    expect(errors[0]!.content).toBeUndefined()
    // Nothing is thrown to the caller; the run ends only when the LLM-call limit is hit (also as an event).
    expect(seen.at(-1)).toMatchObject({ errorCode: 'UNKNOWN_ERROR', errorMessage: 'Max number of llm calls limit of 20 exceeded' })
    expect(modelCalls).toBe(20)
    // The scripted model re-issues the unanswered refund each time: 19 refund attempts. Only Stripe's own
    // "amount greater than unrefunded amount" check stopped it at the whole £100 charge (2 x £50).
    expect(w.stripe.refunds.list({ charge: 'ch_1' }).data).toHaveLength(2)
    expect(w.stripe.charges.retrieve('ch_1').amount_refunded).toBe(10_000)
    const events = await storedEvents(w)
    expect(callsFor(events, 'refund')).toHaveLength(19)
    expect(responsesFor(events, 'refund')).toHaveLength(1) // only the first failure got a (reflection) response
  })
})
