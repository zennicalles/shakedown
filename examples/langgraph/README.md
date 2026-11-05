# Shakedown example: LangGraph

A customer-support refund agent built on LangGraph's prebuilt agent loop (`createAgent` from `langchain` 1.6, which compiles to a `@langchain/langgraph` 1.7 StateGraph with a model node and a `ToolNode`) and a checkpointer. It is crash-tested with Shakedown core v2.

- `refund-agent.ts`: the agent, a scripted tool-calling mock model, the scenarios, and a human-in-the-loop (`interrupt()`) graph.
- `langgraph.test.ts`: runs the scenarios with the mock model (no API key needed).
- `real-model.test.ts`: the same scenario on Claude or OpenAI. It is skipped unless `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set. You can override the model with `ANTHROPIC_MODEL` or `OPENAI_MODEL`.

## Run

```sh
cd examples/langgraph && pnpm install --ignore-workspace   # once
cd ../.. && npx vitest run --maxWorkers=1 examples/langgraph
npx tsc --noEmit -p examples/langgraph
```

## Wiring

```ts
// shake() at the side-effect boundary; the key of the enclosing idempotent() goes downstream.
const rawRefund = shake('refund', async (a) =>
  stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, downstreamKey()))
// fixed variant only: idempotent() OUTSIDE shake(), keyed on the logical operation, default (volatile) MemoryLedger
const refund = idempotent(rawRefund, { key: (a) => `refund:${a.ticket}`, store: ledger })
```

`downstreamKey()` returns `{ idempotencyKey: currentIdempotencyKey() }` when there is one. The naive tools are the same `shake()`-wrapped functions without `idempotent()`, so they send no key. The ledger is the default volatile `MemoryLedger`: a simulated crash or a job redelivery wipes it, so in those cases it is the Stripe and mailer idempotency key that prevents the duplicate. Nothing is marked durable to make a test pass.

## How the pieces map to LangGraph

| Piece | LangGraph mechanism |
|---|---|
| Tools | `tool(fn, { name, schema })` from `langchain`; each `fn` calls the wrapped function above |
| Agent loop | `createAgent({ model, tools, checkpointer, middleware })` |
| Mock model | `BaseChatModel` subclass: `bindTools()` is a no-op, `_generate()` picks the next call from the message history alone, so it works on a replayed thread. If the latest `ToolMessage` has `status: "error"`, it re-issues the same call, up to 3 attempts, then gives up. Once every step has a successful result in the history it answers "Done" and calls nothing. |
| Tool error -> model | `ToolNode` catches the thrown error and returns `ToolMessage({ status: "error", content: "<Name>: <message>\n Please fix your mistakes." })`. The run continues. |
| Crash (default) | `crashSignal()` is passed as the `signal` of `agent.invoke()`. The ToolNode re-throws a tool error when the run's signal is aborted, so `invoke()` rejects with the crash itself. No custom error handling. |
| Crash (alternative) | `toolErrorMiddleware({ onError })`: `onError` returns `undefined` when `isSimulatedCrash(error)`, so the error propagates, and returns the default handler's text for anything else. Same verdicts as the signal. |
| Checkpointer | `DurableMemorySaver`, a `MemorySaver` standing in for a Postgres/SQLite saver. It drops `put`/`putWrites` while `processIsDead()` is true, because a dead process cannot persist anything. |
| Worker / resume | Each delivery (the first run, a crash recovery, a redelivery) builds a new agent against the same checkpointer. If `graph.getState()` shows pending tasks, the worker calls `agent.invoke(null, { configurable: { thread_id } })`, which is LangGraph's real recovery path: it re-runs the tools task that never completed. Otherwise it sends the job message. On a finished thread that means a new turn. |
| Thread | `thread_id = ticket-T-1` by default. `thread: 'per-delivery'` uses a new thread per delivery, like many request/response servers, so the checkpointer never helps recovery. |

## What each fault does here

| Fault | What happens in LangGraph |
|---|---|
| error-before-commit | The tool throws before the side effect. The model gets an error `ToolMessage`, retries, and the retry succeeds. This is the safe control case. |
| timeout-after-commit | The side effect commits, then a `TimeoutError` comes back as an error `ToolMessage`. The model retries, which makes a second refund or a second email. |
| duplicate-delivery | The tool body runs twice with the same arguments. Nothing in LangGraph deduplicates it. |
| crash-after-commit | The side effect commits, then the crash aborts the run and `invoke()` rejects. The new worker finds `next: ['tools']` and resumes with `invoke(null)`. LangGraph re-runs the whole tools task, so the committed call runs again. |
| job-redelivery | The job finished, and then it is delivered again to a fresh worker, with the volatile state wiped. On the per-ticket thread this becomes a new turn on the finished conversation. |

## Observed results (mock model)

Default wiring: crash signal, thread per ticket, volatile ledger.

| Fault | naive | ledger + downstream key |
|---|---|---|
| baseline | pass | pass |
| error-before-commit on refund | pass | pass |
| timeout-after-commit on refund | **FAIL**: 10000 refunded, 2 refunds | pass (1 deduped by Stripe key) |
| duplicate-delivery on refund | **FAIL**: 10000 refunded, 2 refunds | pass (1 deduped) |
| crash-after-commit on refund | **FAIL**: 10000 refunded, 2 refunds (resume re-runs the refund) | pass (ledger wiped, Stripe key dedupes) |
| error-before-commit on send_email | pass | pass |
| timeout-after-commit on send_email | **FAIL**: 2 emails | pass |
| duplicate-delivery on send_email | **FAIL**: 2 emails | pass |
| crash-after-commit on send_email | **FAIL**: 2 emails (resume re-sends) | pass |
| job-redelivery | pass, but only because of the mock model (see below) | pass (0 deduped: the mock calls no tools; see thread per delivery for the key doing the work) |

**Job redelivery on a per-ticket thread depends on the model.** The redelivered job is appended to the finished thread. The mock model reads the earlier successful tool results, answers "Done", and calls no tools, so even the naive tools pass. A real model might re-do the refund. Do not read this pass as a safety guarantee.

**Thread per delivery** (`thread: 'per-delivery'`): every crash or redelivery starts the job over on a new thread. The naive tools then fail crash-after-commit on send_email (2 refunds and 2 emails) and job-redelivery (2 refunds and 2 emails). The fixed tools pass every fault, and on redelivery every replay comes from the downstream key, because the ledger was wiped.

### Default tool-error handling swallows the crash

Without the crash signal and without the middleware (`crashMode: 'framework-default'`), `createAgent`'s ToolNode catches the crash like any other tool error and passes it to the model as `"ConnectionClosedError: Process exited unexpectedly while calling refund (connection closed)\n Please fix your mistakes."`. In the dead process:

1. The model retries twice, and `shake()` blocks and records both calls (`blocked: true`).
2. The model gives up ("could not complete refund after 3 attempts") and the graph reaches END.
3. Shakedown flags the run with `crashSwallowed`, and the report prints a note.

Every checkpoint the dead process tried to write after the crash was dropped (12 writes), so the restarted worker resumes from the last durable checkpoint and re-runs the refund. The verdicts are the same as with a propagated crash: the naive tools double-refund, and the fixed tools pass.

This changed from the v1 example. That version reported "resume is a no-op and the email is never sent", but only because the plain `MemorySaver` persisted the dead process's END checkpoint. With the checkpointer modelled honestly, that finding no longer reproduces.

### Human in the loop: refund, then `interrupt()`, then `Command({ resume: 'approve' })`

LangGraph re-executes the interrupted node from the top on resume, so its body runs twice even without a fault. The graph uses a node `retryPolicy` (`maxAttempts: 3`), as a production graph would. Each invoke gets the live `crashSignal()`, which also stops LangGraph's retry loop after a crash.

| | naive | ledger + downstream key |
|---|---|---|
| baseline refunds issued | **2** (re_1 shown to the approver, re_2 stored in state) | 1 (the second call is answered by the ledger) |
| baseline | **FAIL**, with no fault injected | pass |
| every default fault | **FAIL** (inherits the baseline double refund) | pass (10/10) |

- **Crash before the interrupt.** The worker resumes with `invoke(null)` and the node re-runs. The wiped ledger misses, and Stripe dedupes on `refund:T-1`.
- **Job redelivery.** The finished thread is restarted from START, so the human is asked to approve the same refund (re_1) a second time. The fixed tools dedupe both effects, but the duplicate approval request is real.

Any side effect placed before `interrupt()` in the same node runs again on resume. Either move it into its own node after the interrupt, or make it idempotent and send the key downstream. `humanInTheLoopMiddleware` interrupts before the tool runs, both in `afterModel` and in `per_call` `wrapToolCall` mode, so it does not have this problem. That was checked by reading `middleware/hitl.js`, not by a test here.

### Notes for adapter authors

- `crashSignal()` stays aborted after the crash, including during the resume phase. Passing it to the resumed `invoke()` would abort the new process immediately, so `liveCrashSignal()` passes it only while it is not yet aborted.
- Detect the crash with `isSimulatedCrash()`, never by its message.
