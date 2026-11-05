# Shakedown example: OpenAI Agents SDK (`@openai/agents` 0.21)

A refund agent built with the SDK's real loop (`Agent`, `tool()`, `run()`), crash-tested with Shakedown core v2.
No API key needed: `mock-model.ts` implements the SDK's `Model` interface. It is a reactive scripted model that reads the conversation the SDK sends it. If the last result for a tool looks like an error, it calls the tool again (3 attempts at most).

```
cd examples/openai-agents && pnpm install --ignore-workspace
cd ../..
npx vitest run --maxWorkers=1 --silent=false examples/openai-agents   # --silent=false prints the reports
npx tsc --noEmit -p examples/openai-agents
```

`real-model.test.ts` runs the same scenarios against a real model. It only runs when `OPENAI_API_KEY` is set (default OpenAI provider) or `ANTHROPIC_API_KEY` is set (Claude via `@openai/agents-extensions/ai-sdk`, default `claude-opus-5-5`).

## Files

| File | What |
|---|---|
| `refund-agent.ts` | `createRefundAgent({ fixed })`. The tools are `lookup_charge` (read), `refund` and `send_email` (write). `shake()` wraps the raw `stripe.refunds.create` / `mailer.send` call (the side-effect boundary). With `fixed: true`, `idempotent()` wraps that from the OUTSIDE, keyed on `refund:<ticket>` and `refund-email:<ticket> (never the model-written subject: a model that rewords the email on retry would get a new key)`, and the shaken body passes `currentIdempotencyKey()` downstream as `{ idempotencyKey }`. |
| `mock-model.ts` | The reactive `Model` implementation. |
| `harness.ts` | The two scenarios, a durable Session, a RunState store, and `jobSignal()` (Shakedown's `crashSignal()` as the run's AbortSignal). |

## The fix: ledger + key sent downstream

```ts
let refundFn = shake('refund', async (a) =>
  stripe.refunds.create({ charge: a.charge, amount: a.amount }, keyOpts()))  // keyOpts() = { idempotencyKey: currentIdempotencyKey() }
if (fixed) refundFn = idempotent(refundFn, { key: (a) => `refund:${a.ticket}` })
```

The ledger is the default **volatile** `MemoryLedger`: a simulated crash or redelivery wipes it, as a real restart would. The fixed variant still passes every default fault, because the retry, the resumed run or the redelivered job reaches Stripe/the mailer with the same logical key and gets the first result back (the report counts these as `deduped`). The ledger alone does not cover the commit-then-timeout or commit-then-crash window; the downstream key does.

## How the SDK handles a thrown tool error

The SDK does not pass the error to the model. A tool without an output schema has a default `errorFunction`, and that function replaces every thrown error with the same fixed string:
`"An error occurred while running the tool. Please try again."`
The run keeps going. The model cannot tell a timeout (the refund may have gone through) from a connection reset (it did not) or from `No such charge` (a retry can never succeed). The message itself asks the model to retry. The SDK never retries a tool on its own.

A thrown `SimulatedCrash` is swallowed the same way: without a signal, `run()` resolves normally, the model retries, Shakedown blocks and records the retries (`blocked: true`) and flags the result `crashSwallowed`. The harness passes `crashSignal()` as `run(..., { signal })`. Shakedown aborts that signal at the crash, the SDK checks it after the tool call, and `run()` rejects with the crash itself (`isSimulatedCrash(e)` is true). The durable stores (Session, RunState row) drop writes made while `processIsDead()`: on abort the SDK tries to write a checkpoint to the Session, which a dead process could not do.

The resume phase shares the run's context, so `crashSignal()` is already aborted there; `jobSignal()` passes no signal in that case (a new process has a live one).

## How the job resumes after a crash or redelivery

Both resumes build a fresh `Agent` and tools (`world.newWorker()`), as a new process would. Shakedown has already wiped the volatile ledger and in-flight maps.

1. **Scenario 1: `run(agent, task, { session })`.** If a run was not interrupted, the SDK has no checkpoint to resume from, so recovery means running the job again on the same Session. A non-streaming `run()` writes nothing to the Session until the run ends. After a crash the Session is empty, and the retry starts over from `lookup_charge`.
2. **Scenario 2: refund with `needsApproval: true`.** At the interruption the job saves `result.state.toString()`. A human approves (`RunState.fromString` and then `state.approve`), that decision is saved, and the job calls `run(agent, state)`. After a crash the worker reloads the last saved RunState and continues from it. This is the SDK's documented resume path.

## Faults in this framework

| Fault | What the agent experiences |
|---|---|
| `error-before-commit` | Nothing is committed. The model gets the generic error and retries. Safe. |
| `timeout-after-commit` | The write is committed, then the model gets the generic error and retries, which writes a second time. With approvals on, the retry is a new tool call, so the human is asked again and approves the duplicate. |
| `duplicate-delivery` | The body runs twice, and the model sees one success. |
| `crash-after-commit` | The write is committed, then the run is aborted. Scenario 1 starts again from scratch. Scenario 2 reloads the approved RunState and **runs the approved refund again without asking the human again**. A crash in `send_email` also repeats the refund, because no checkpoint is saved between the approved refund and the email. |
| `job-redelivery` | The finished job is delivered again to a fresh worker. Scenario 1: the Session holds the whole finished run, the model sees every step done and answers without calling a tool. Scenario 2: the last saved RunState is the final one, and `run(agent, state)` throws `UserError: Accepted final output cannot be resumed directly from serialized terminal state. Start a new run from persisted session history.` |

## Observed results

Both scenarios gave the same verdict for every fault (P = pass, F = fail). "fixed" = ledger + downstream key, volatile ledger.

| Fault | refund, naive | refund, fixed | send_email, naive | send_email, fixed |
|---|---|---|---|---|
| baseline | P | P | P | P |
| error-before-commit | P | P | P | P |
| timeout-after-commit | F (2 refunds) | P (1 deduped) | F (2 emails) | P (1 deduped) |
| duplicate-delivery | F (2 refunds) | P (1 deduped) | F (2 emails) | P (1 deduped) |
| crash-after-commit | F (2 refunds) | P (1 deduped) | F (2 refunds, 2 emails) | P (2 deduped) |

| Fault | naive | fixed |
|---|---|---|
| job-redelivery | P | P |

Naive tools pass `job-redelivery` here, for different reasons:
- Scenario 1 depends on the model: the mock reads the Session history and stops. A model that redoes the task anyway would duplicate the refund.
- Scenario 2 is pure SDK behaviour: a terminal RunState cannot be resumed, so the redelivered job throws before any tool runs. The report shows this as an agent error on a passing result.

Other results:
- **A worker that follows the SDK's hint** ("Start a new run from persisted session history") on a redelivered approval job has no Session to start from, so it starts from the task: the human is asked to approve the refund a second time and naive tools refund and email twice. With the fix, both writes are replayed by the downstream key.
- **The same approved RunState resumed by two workers** (for example a job queue delivers the job again, outside `runScenario`): naive tools refund and email twice. With the fix, each worker has its own fresh in-memory ledger, and the downstream key still makes it happen once.
- **Approvals do not stop duplicates.** With the fix, a timeout still makes the human approve the refund twice. The second approval is harmless, but the human still sees it.
- **`sentExactly`** replaces "at most one email": without `crashSignal()` the swallowed crash ends the job before the email, and `sentExactly('ada@example.com', 1)` reports `found 0`.
