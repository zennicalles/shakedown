# Shakedown example: VoltAgent (`@voltagent/core` 2.x)

A refund agent built on VoltAgent's own agent loop (`Agent` + `createTool` +
`memory: new Memory({ storage })`, `agent.generateText()`), crash-tested with
Shakedown core v2. VoltAgent 2.11 drives the Vercel AI SDK 6 `generateText`
underneath, so the model is the SDK's `MockLanguageModelV3` (`ai/test`), scripted
to react to whatever VoltAgent feeds back: if the last tool result is an error
it re-issues the same call (up to 3 attempts). It runs fully offline.

Versions: `@voltagent/core` 2.11.1, `@voltagent/logger` 2.0.2, `ai` 6.0.326
(VoltAgent's peer range is `ai@^6`), `zod` 4.6.7.

```
cd examples/voltagent && pnpm install --ignore-workspace
cd ../.. && npx vitest run --maxWorkers=1 --silent=false examples/voltagent
npx tsc --noEmit -p examples/voltagent
# real model (skipped without a key):
ANTHROPIC_API_KEY=... npx vitest run --maxWorkers=1 --silent=false examples/voltagent/real-model.test.ts
```

Files: `refund-agent.ts` (agent factory, durable storage, app driver with
approvals, Shakedown scenario), `scripted-model.ts` (mock model),
`voltagent.test.ts`, `real-model.test.ts`.

## Wiring

`shake()` wraps the raw side effect (`stripe.refunds.create`, `mailer.send`).
The fix, `idempotent()`, goes outside it:

```ts
const refund = idempotent(
  shake('refund', (a) =>
    stripe.refunds.create(
      { charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } },
      { idempotencyKey: currentIdempotencyKey() },
    )),
  { key: (a) => `refund:${a.ticket}`, store: ledger },
)
// createTool({ ..., execute: (input) => refund(input) })   // pass only input: arg 2 is the whole OperationContext
```

Three variants (`mode`): `naive` (plain tool bodies), `ledger-only`
(`idempotent()` ledger, no key downstream), `fixed` (ledger + the logical key
`refund:T-1` / `refund-email:T-1` sent downstream as the Stripe / mail
`Idempotency-Key`). The ledger is a volatile `MemoryLedger`, which Shakedown
wipes on a crash or redelivery.

## Crash and recovery path

VoltAgent's `Agent` has no checkpoint/resume API. Its durable state is
**conversation memory**: with the default `conversationPersistence.mode: 'step'`
it checkpoints after each step and flushes at once when a step has tool
results. To continue a conversation you call
`generateText(input, { memory: { userId, conversationId } })` again: VoltAgent
loads the history and appends the input.

- **Crash**: `processTicket` passes `crashSignal()` as `abortSignal`. VoltAgent
  links it to the operation's `AbortController`, the AI SDK stops before the
  next step, and `generateText()` **rejects** with VoltAgent's `AbortError`
  (`"Operation aborted: <reason>"`). Unlike Mastra (which resolves with
  `finishReason: 'aborted'`), nothing extra is needed to make the crash propagate.
- **Dead process persists nothing**: `DurableStorage` is VoltAgent's
  `InMemoryStorageAdapter` with every write dropped once `processIsDead()`.
  That is needed because VoltAgent flushes the in-flight step to memory even on
  an abort (see the findings).
- **Resume** means a new process: a fresh `Agent` and tools with the same
  storage. It redelivers the request it was handling (the job message, or the
  human's approval response, kept in `RequestLog`) to the same conversation.
  That is what a queue redelivery or an HTTP client retry does. `job-redelivery`
  delivers the job message again to the stored conversation.

## How VoltAgent handles a thrown tool error

VoltAgent catches every error thrown by `execute` (`createToolExecutionFactory`)
and **returns it as the tool's normal output** (`buildToolErrorResult`):

```json
{ "error": true, "name": "TimeoutError", "message": "Request to refund timed out ...",
  "stack": "TimeoutError: ...\n    at wrapped (C:/.../src/shake.ts:98:21) ...",
  "toolCallId": "call_2", "toolName": "refund", "code": "ETIMEDOUT" }
```

The AI SDK therefore sees a successful tool call, and the model gets
`output: { type: 'json', value: {...} }`, not `error-text`. Memory stores the
call as `output-available`. The stack trace (absolute source paths) and **every
own enumerable property** of the error go into the prompt. Whatever an SDK error carries (response bodies, headers, request ids) goes to
the model; for Shakedown's crash it is `shakedownCrash: true` (tested). `generateText()` does not throw, and VoltAgent never
retries a tool itself. `hooks.onToolError` can replace the payload.

## Observed results (`@voltagent/core` 2.11.1, scripted model, core v2)

| Fault | naive | ledger-only | fixed | naive + needsApproval | fixed + needsApproval |
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

The needsApproval columns use the `repairApprovals` workaround (see finding 6).
Without it, the same `error-before-commit` and `job-redelivery` rows end in
`AI_TypeValidationError`.

\* job-redelivery passes for naive tools only because the job is redelivered
to the stored, finished conversation, and the scripted model just answers. A
worker that opens a new conversation per delivery refunds and emails twice; the
fixed variant still passes (tests under *job redelivery*).

## Findings

1. **Tool errors are tool outputs.** A thrown error reaches the model as a
   successful `json` result with `error: true`, the stack and every own error
   property. VoltAgent does not retry tools. (*a thrown tool error reaches the
   model as a successful JSON result...*)
2. **Without `abortSignal` a crash is swallowed.** The model sees the crash as
   an error, retries twice (blocked by `shake()`) and gives up: one refund, no
   email. (*without an abort signal VoltAgent swallows a crash*)
3. **With `abortSignal`, `generateText()` rejects** with `AbortError`. (*with
   crashSignal() as abortSignal...*)
4. **On abort VoltAgent still writes the in-flight step to memory**
   (`flushPendingMessagesOnError`). After a cancel or request timeout that
   lands after Stripe committed, the conversation says the refund *failed*, and
   the next turn refunds again. A hard kill writes nothing; resume then replays
   from the last flushed step, which here is the lookup. (*on abort VoltAgent
   still flushes...*, *crash resume: memory holds the steps before the crashed
   one*)
5. **A model error mid-loop re-runs every tool before it.** VoltAgent calls
   the AI SDK with `maxRetries: 0` and retries the **whole** `generateText`
   itself (agent `maxRetries`, default 3, 1 s/2 s/4 s backoff), using the
   messages it prepared before step 1. One 529 from the provider after the
   refund step produces a second refund with naive tools, with no tool fault
   at all. The downstream key covers it. `maxRetries: 0` swaps the duplicate
   for a job that stops after the refund. An output-middleware
   `abort(..., { retry: true })` re-runs the loop as well, but it reloads
   memory first, so the model can see what already ran. (*VoltAgent retries the
   whole loop, not the step*)
6. **An approved tool call bricks the conversation (bug).** After an approved
   tool runs, memory stores its part as `output-available` with
   `approval: { id }`, and `approved: true` is gone. The AI SDK's UIMessage
   schema rejects that part, so every later `generateText` on the conversation
   throws `AI_TypeValidationError`. That covers a follow-up question, a
   redelivery, and a second approval in the same job (after a failed approved
   refund the model asks again). `repairApprovals()` (an `onPrepareMessages`
   hook plus a fix to the approval message built from memory) works around it.
   (*without the repairApprovals workaround...*)
7. **The approval is replayed without asking.** Approved calls run before the
   first step, so their result is not in any step and is not flushed. A crash
   anywhere in the continuation (here `send_email`) leaves memory at
   `approval-responded`. Redelivering the approval refunds again, without a
   second prompt. A timeout makes the model ask again, and the human approves
   the "retry". (*the approved refund ran before any step...*, *counts how
   many approval prompts the human saw*)
8. **A tool's own `hooks.onEnd` runs twice on every failure** (the call is
   duplicated in `handleToolError`). The agent's `onToolError` runs once.
   Don't count failures or write audit records from `onEnd`. (*a failing tool
   runs the tool's own hooks.onEnd twice*)
9. **Memory race with in-process models.** The user's input is saved on a
   fire-and-forget `setTimeout(0)` queue. A model that answers without
   yielding (`latencyMs: 0`) gets the first user message stored *after* the
   reply. It also lets the late input save overwrite an approve-and-continue's
   merged assistant message, which loses the refund result and the email
   record. Real providers yield first, so the scripted model waits 1 ms by
   default. (*memory race with a model that answers without yielding*)
