# Shakedown example: Google Agent Development Kit for TypeScript (`@google/adk` 2.x)

A refund agent built on ADK's own agent loop (`LlmAgent` + `FunctionTool` +
`Runner` over a session service), crash-tested with Shakedown core v2. The model
is a scripted `BaseLlm` subclass, so it plugs into ADK where `Gemini` would. It
reacts to whatever ADK puts in `LlmRequest.contents`: if the last tool result is
an error, it re-issues the same call (up to 3 attempts). No network access is
needed.

```
cd examples/google-adk && pnpm install --ignore-workspace
cd ../.. && npx vitest run --maxWorkers=1 --silent=false examples/google-adk
npx tsc --noEmit -p examples/google-adk
# real model (skipped without a key):
GEMINI_API_KEY=... npx vitest run --maxWorkers=1 --silent=false examples/google-adk/real-model.test.ts
```

Files:
- `refund-agent.ts`: the agent factory, the durable session service, the app driver with approvals, and the Shakedown scenario.
- `scripted-model.ts`: the mock model.
- `google-adk.test.ts`: the tests run against the mock model.
- `real-model.test.ts`: the same scenario against Gemini, key-gated.

## Wiring

`shake()` wraps the raw side effect (`stripe.refunds.create`, `mailer.send`),
where real timeouts and crashes happen. The fix, `idempotent()`, goes outside it:

```ts
const refund = idempotent(
  shake('refund', (a) =>
    stripe.refunds.create(
      { charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } },
      { idempotencyKey: currentIdempotencyKey() },
    )),
  { key: (a) => `refund:${a.ticket}`, store: ledger },
)
// new FunctionTool({ ..., execute: (args) => refund(args) })   // pass only args, not ADK's Context
```

Three variants (`mode`):

- `naive`: plain tool bodies.
- `ledger-only`: `idempotent()` ledger, no key sent downstream.
- `fixed`: ledger + the logical key (`refund:T-1`, `refund-email:T-1`) sent
  downstream as the Stripe / mail `Idempotency-Key`.

The ledger is a plain `new MemoryLedger()`, which is volatile: Shakedown wipes it
on a simulated crash or redelivery, as a real restart would. The fixed variant
does not need it to survive. The downstream key covers the window between the
side effect and the ledger write.

## How ADK handles a thrown tool error

ADK never lets a tool error escape. `FunctionTool.runAsync` catches anything
`execute` throws and rethrows it as
`new Error("Error in tool '<name>': " + err.message)`. The flow
(`handleFunctionCallList`) then catches that error and, unless a plugin's
`onToolErrorCallback` returns something, the model gets a function response
`{ error: err.message }`, for example
`{ error: "Error in tool 'refund': Request to refund timed out after 30000ms (no response received)" }`.

- **The error's class and fields are gone.** `TimeoutError`, `code: 'ETIMEDOUT'`
  and any custom error type never reach the model or a plugin, only the
  message. Plugins see a plain `Error` (the reflect-and-retry plugin reports
  `error_type: 'Error'`).
- `runAsync` does not throw. The loop goes on and the model decides what to do.
- **ADK does not retry tools itself.** Every tool execution in the tests matches
  a function call the model made. The built-in `ReflectAndRetryToolPlugin` does
  not retry either. It replaces the error with "retry attempt 1 of 3 ... Do not
  repeat the exact same call" guidance and leaves the decision to the model. The
  scripted model retried anyway and refunded twice.

The same applies to Shakedown's simulated crash. Left alone, ADK hands
`"Error in tool 'refund': Process exited unexpectedly while calling refund (connection closed)"`
to the model, which retries. shake() blocks those calls (recorded as `blocked`)
and the report flags `crashSwallowed`. The model concludes the refund failed and
never emails the customer.

### Aborts: silent, and "sealed" into the session

The app driver (`processTicket`) passes `crashSignal()` as the Runner's
`abortSignal`. Two ADK behaviours shape what that does:

- **Abort ends `runAsync` silently.** The generator just returns and nothing is
  thrown. ADK does stop: the model is not called again. But a caller that only
  waits for the loop to end cannot tell a cancelled run from a finished one.
  `processTicket` calls `signal.throwIfAborted()` after the loop for that reason
  (test: *abortSignal stops the loop but runAsync returns normally*).
- **The Runner then "seals" the aborted invocation**
  (`Runner.synthesizeAbortEvents`). Every function call in the invocation that
  has no response gets a synthetic `{ error: 'Invocation was aborted by client.' }`
  response with `errorCode: 'INVOCATION_ABORTED'`, and that response is appended
  to the session. ADK also discards the tool's real result when the signal fires
  while a tool runs (`postprocess` returns before it yields the function
  response). So **a refund that succeeded is recorded in the session as aborted.**
  The next turn shows the model a failed refund, and the scripted model refunds
  again (test: *a refund that SUCCEEDED is recorded as "Invocation was aborted by client."*).
  This happens on any graceful cancellation: a client disconnect, or a SIGTERM
  handler that aborts the run.

A real crash (OOM, SIGKILL) never reaches the seal. `DurableSessionService` stands
in for a database-backed session service. It drops durable writes once
`processIsDead()`, so the session holds exactly what a restart would see: the
refund function call **with no response at all**. ADK neither repairs nor flags
it. The dangling call goes to the model as-is on the next turn (test: *after a
hard crash the resumed request carries the refund call with no response*). A
strict provider may reject that history. The scripted model re-plans and refunds
again. `persistAfterCrash: true` models the graceful case instead, where the seal
is written.

### ReflectAndRetryToolPlugin past its limit loops instead of stopping

With `throwExceptionIfRetryExceeded` (the default), the plugin throws once a tool
has failed `maxRetries` times in a row. That exception does not leave `runAsync`.
`LlmAgent.runAndHandleError` turns it into an `UNKNOWN_ERROR` event with no
content. The loop treats a content-less event after a tool call as non-final, so
**it calls the model again**. The failed call is left without a response, and
every later failure throws again. The run only ends when `maxLlmCalls` (default
500) is reached, also as an event, not an exception. The test makes the refund
endpoint commit and then time out on every call. The scripted model made 19
refund attempts in 20 model calls, and only Stripe's own "more than the
unrefunded amount" check held the damage to 2 refunds. With the default limit the
same loop ran 499 refund attempts. A model that refuses to retry, or a provider
that rejects the dangling call, would stop it sooner.

## Recovery path (resume)

ADK writes every non-partial event to the session service as it happens, so the
session is the checkpoint. The TS `Runner` has **no "continue this invocation"
call**. `runAsync` only runs the agent when it gets a `newMessage`; without one it
yields nothing and returns (test: *runAsync without a newMessage runs nothing*).
`ResumabilityConfig.isResumable` only changes which agent in a tree is picked. So
resume is what ADK supports: a new process (fresh model, agent, tools and Runner)
calls `runAsync` with **the same session id** on the same durable session service,
and the message the crashed job was processing. That is an at-least-once queue
redelivering the job. For a plain ticket the message is the task. For
approve-and-continue it is the human's `adk_request_confirmation` response.
`job-redelivery` uses the same path.

## What each fault does here

| Fault | What happens in ADK |
|---|---|
| error-before-commit | No side effect. The model gets `{ error }` and retries; the retry succeeds. Safe. |
| timeout-after-commit | The write commits, then the model gets a timeout `{ error }` and retries, so the write commits a second time. |
| duplicate-delivery | The write runs twice inside one tool call. The model sees one success. |
| crash-after-commit | The write commits and the process "dies": the loop is aborted and nothing more is persisted. The task is redelivered to the same session, the model sees the refund call with no response, and it makes the call again. |
| job-redelivery | The finished job is delivered again to the same session. The scripted model sees the work done and answers without calling a tool. |

## Observed results (`@google/adk` 2.4.0, scripted model, core v2)

| Fault | naive | ledger-only | fixed | naive + requireConfirmation | fixed + requireConfirmation |
|---|---|---|---|---|---|
| baseline | pass | pass | pass | pass | pass |
| error-before-commit on refund | pass | pass | pass | pass | pass |
| timeout-after-commit on refund | FAIL (2 refunds) | FAIL | pass (Stripe dedupe) | FAIL (2 refunds, human approved twice) | pass |
| duplicate-delivery on refund | FAIL (2 refunds) | FAIL | pass | FAIL (2 refunds) | pass |
| crash-after-commit on refund | FAIL (2 refunds) | FAIL | pass | FAIL (2 refunds, approval replayed without asking) | pass |
| error-before-commit on send_email | pass | pass | pass | pass | pass |
| timeout-after-commit on send_email | FAIL (2 emails) | FAIL | pass | FAIL (2 emails) | pass |
| duplicate-delivery on send_email | FAIL (2 emails) | FAIL | pass | FAIL (2 emails) | pass |
| crash-after-commit on send_email | FAIL (2 emails) | FAIL | pass | FAIL (2 emails, refund not replayed) | pass |
| job-redelivery | pass\* | pass\* | pass | pass\* | pass |

A ledger alone fails exactly like naive tools. It is written only after the call
returns, so a timeout, duplicate delivery or crash at the side-effect boundary
never reaches it, and a crash also wipes it.

\* **job-redelivery passes for naive tools only because of how this app
resumes.** The session is keyed by ticket, so the redelivered job lands in the
finished conversation and the scripted model makes no tool call. A real model
might act differently. Now take a worker whose session storage did not survive
(`InMemorySessionService`, which `InMemoryRunner` uses, the getting-started
default). It starts the ticket over and refunds and emails twice with naive tools
(tests under *job redelivery*). The fixed variant passes because Stripe and the
mailer replay the keyed requests, even though the in-memory ledger was wiped.

### Tool confirmation (`FunctionTool({ requireConfirmation: true })`)

The first time, the gated tool does not run. ADK emits an
`adk_request_confirmation` function call and ends the invocation. The app sends
`{ functionResponse: { id, name: 'adk_request_confirmation', response: { confirmed } } }`
as the next message. On that turn, `RequestConfirmationLlmRequestProcessor`
executes the approved call before the model step. Approval does not stop
duplicates:

- **timeout-after-commit**: the approved refund commits, then the model sees a
  timeout and asks for the refund again, which raises a new confirmation request.
  A human who sees a "failed" refund approves the retry. 2 approval prompts,
  2 refunds.
- **crash-after-commit**: the crash keeps the approved call's result out of the
  session, so the redelivered approval makes ADK **execute the approved call
  again, without asking the human**. The model only ever made one refund call.
  The second refund is the framework replaying the approval. 1 approval prompt,
  2 refunds.
- **A crash in a different tool does not replay the approval**, unlike the
  AI SDK example. ADK writes the approved call's result to the session as its own
  event before the model step. It skips any approval whose call already has a
  response from the agent after the gate (`hasRespondedAfter`). So a crash in
  `send_email` duplicates only the email. The same check makes a redelivered
  approval harmless once the job has finished (test: *a redelivered approval
  after the job finished is not executed again*).

With the fixed tools, the replayed approval still re-executes the refund on
resume, and Stripe dedupes it.
