# Shakedown example: Vercel AI SDK (`ai` 7.x)

A refund agent built on the SDK's own agent loop (`ToolLoopAgent` + `tool()` +
`stopWhen: isStepCount(12)`), crash-tested with Shakedown core v2. The model is the
SDK's `MockLanguageModelV4` (`ai/test`), scripted to react to whatever the SDK
feeds back: if the last tool result is an error it re-issues the same call
(up to 3 attempts).

```
cd examples/ai-sdk && pnpm install --ignore-workspace
cd ../.. && npx vitest run --maxWorkers=1 --silent=false examples/ai-sdk
npx tsc --noEmit -p examples/ai-sdk
# real model (skipped without a key):
ANTHROPIC_API_KEY=... npx vitest run --maxWorkers=1 --silent=false examples/ai-sdk/real-model.test.ts
```

Files: `refund-agent.ts` (agent factory, app driver with checkpointing and
approvals, Shakedown scenario), `scripted-model.ts` (mock model),
`ai-sdk.test.ts`, `real-model.test.ts`.

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
// tool({ ..., execute: (input) => refund(input) })   // pass only input, not the SDK's options
```

Three variants (`mode`):

- `naive`: plain tool bodies.
- `ledger-only`: `idempotent()` ledger, no key sent downstream.
- `fixed`: ledger + the logical key (`refund:T-1`, `refund-email:T-1`) sent
  downstream as the Stripe / mail `Idempotency-Key`.

The ledger is a plain `new MemoryLedger()`, which is volatile: Shakedown wipes it
on a simulated crash or redelivery, as a real restart would. The fixed variant
does not need it to survive; the downstream key covers the window between the
side effect and the ledger write.

## How the AI SDK handles a thrown tool error

`execute` throws, and the SDK catches it, **every time and whatever the error is**
(`execute-tool-call.ts`). It becomes a `tool-error` content part, and the
model gets it on the next step as a `role: 'tool'` message with
`output: { type: 'error-text', value: String(err) }`, e.g.
`"TimeoutError: Request to refund timed out after 30000ms (no response received)"`.
`generate()` does not throw. The loop goes on and the model decides what to do.

That covers Shakedown's simulated crash too. Left alone, the SDK passes
`"ConnectionClosedError: Process exited unexpectedly while calling refund (connection closed)"`
to the model, which retries. shake() blocks those calls (recorded as `blocked`)
and the report flags `crashSwallowed`. The model concludes the refund failed and
never emails the customer.

A real crash gives the SDK no such chance, so the app driver (`processTicket`)
emulates process death with the core helpers:

- `crashSignal()` is passed as `abortSignal` to `agent.generate()`. The SDK
  checks it before every step after the first, so a crash mid-loop throws out
  of `generate()`.
- **The SDK does not check it before the first step**, which is where approved
  tool calls run. A crash in an approved call is shown to the model as an error,
  the model retries, the retry needs approval, and `generate()` returns
  normally with a fresh approval request. `processTicket` therefore also calls
  `crash.throwIfAborted()` after each `generate()`. Without it the app asks the
  human to approve a "retry" from a dead process (test: *a crash in an approved
  call does not stop generate()*).
- `ConversationStore.save` drops writes while `processIsDead()`, so nothing
  persisted after the crash survives.
- `crashSignal()` belongs to the Shakedown run, not to the process: in the
  resume phase it is the dead process's signal and already aborted.
  `processTicket` only uses it when it is not aborted yet; otherwise the resumed
  process would die at its second step.

## Recovery path (resume)

`ToolLoopAgent` keeps everything in memory. The SDK's own docs say "if the
process crashes, all progress is lost". The documented way to continue is to
persist `ModelMessage[]` and call `agent.generate({ messages })` again, which is
also how approve-and-continue works. The driver checkpoints after every step
(`onStepEnd`: the step's input messages from `onStepStart` plus
`step.response.messages`). Resume means a new process: a fresh agent and tools,
the checkpoint loaded, then `generate({ messages })`. The same resume runs for
`job-redelivery`. The durable option is `WorkflowAgent` (`@ai-sdk/workflow` +
Workflow DevKit). It needs the workflow compiler/runtime and is not tested here.

## What each fault does here

| Fault | What happens in the AI SDK |
|---|---|
| error-before-commit | No side effect. The model gets `error-text` and retries; the retry succeeds. Safe. |
| timeout-after-commit | The write commits, then the model gets a timeout `error-text` and retries, so the write commits a second time. |
| duplicate-delivery | The write runs twice inside one tool call. The model sees one success. |
| crash-after-commit | The write commits and the process "dies" (loop aborted, no further checkpoint). Resume replays from the last step checkpoint, and the model makes the call again. |
| job-redelivery | The finished job is delivered again. The resumed worker loads the stored, finished conversation; the scripted model answers again and calls no tool. |

## Observed results (`ai` 7.0.162, scripted model, core v2)

| Fault | naive | ledger-only | fixed | naive + toolApproval | fixed + toolApproval |
|---|---|---|---|---|---|
| baseline | pass | pass | pass | pass | pass |
| error-before-commit on refund | pass | pass | pass | pass | pass |
| timeout-after-commit on refund | FAIL (2 refunds) | FAIL | pass (Stripe dedupe) | FAIL (2 refunds, human approved twice) | pass |
| duplicate-delivery on refund | FAIL (2 refunds) | FAIL | pass | FAIL (2 refunds) | pass |
| crash-after-commit on refund | FAIL (2 refunds) | FAIL | pass | FAIL (2 refunds, approval replayed without asking) | pass |
| error-before-commit on send_email | pass | pass | pass | pass | pass |
| timeout-after-commit on send_email | FAIL (2 emails) | FAIL | pass | FAIL (2 emails) | pass |
| duplicate-delivery on send_email | FAIL (2 emails) | FAIL | pass | FAIL (2 emails) | pass |
| crash-after-commit on send_email | FAIL (2 emails) | FAIL | pass | FAIL (2 emails **and 2 refunds**) | pass |
| job-redelivery | pass\* | pass\* | pass | pass\* | pass |

A ledger alone fails exactly like naive tools: it is written only after the call
returns, so a timeout, duplicate delivery or crash at the side-effect boundary
never reaches it, and a crash also wipes it.

\* **job-redelivery passes for naive tools only because of how this app
resumes**: the conversation is stored per ticket, so the redelivered job resumes
a finished conversation and the scripted model makes no tool call. A real model
might act differently. A worker that starts the ticket over
(`resume = run`, tests under *job redelivery*) refunds and emails twice with
naive tools; the fixed variant passes because Stripe and the mailer replay the
keyed requests, even though the in-memory ledger was wiped.

### Tool approval (`toolApproval: { refund: 'user-approval' }`)

Approval does not stop duplicates:

- **timeout-after-commit**: the approved refund commits, then the model sees a
  timeout and asks for the refund again. A human who sees a "failed" refund
  approves the retry. 2 approval prompts, 2 refunds.
- **crash-after-commit**: the approval response is stored in the conversation
  history. On resume the SDK sees an approved call with no result and runs it
  again, without asking the human. 1 approval prompt, 2 refunds.
- **A crash in a different tool also double-refunds.** Approved calls execute at
  the start of `generate()`, before the first step and outside any step. Their
  results are in no step's `response.messages`, so `onStepEnd` checkpointing
  saves nothing until the first step of the continuation ends. A crash anywhere
  in that step (here `send_email`; equally a provider 500 that kills the worker)
  replays the approval. Checkpointing in `onStepStart` too
  (`checkpointBeforeEachStep: true`) closes this hole. It does not fix the
  other duplicates; the downstream key does. With the fixed tools the replayed
  approval still re-executes the refund on resume, and Stripe dedupes it.
