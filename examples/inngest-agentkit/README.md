# Shakedown example: Inngest AgentKit (`@inngest/agent-kit` 0.13.2, `inngest` 4.26.2)

A refund agent built with AgentKit's own pieces (`createAgent`, `createTool`,
`createNetwork` with a code router, `maxIter: 12`), crash-tested with Shakedown
core v2 in two runtimes:

- **plain**: `network.run()` in-process, the way AgentKit runs outside Inngest.
  AgentKit's only persistence there is a History adapter (`history: { get,
  appendResults }`), which this example uses as the recovery path.
- **inngest**: `network.run()` inside an Inngest function, which is how
  AgentKit is meant to be deployed. Inference turns into `step.ai.infer`, and
  durability comes from the server's memoized step state.

The model is scripted to react to whatever AgentKit feeds back: if the last
tool result is an error, it re-issues the same call (up to 3 attempts).

```
cd examples/inngest-agentkit && pnpm install --ignore-workspace
cd ../.. && npx vitest run --maxWorkers=1 --silent=false examples/inngest-agentkit
npx tsc --noEmit -p examples/inngest-agentkit
# real model (skipped without a key):
ANTHROPIC_API_KEY=... npx vitest run --maxWorkers=1 --silent=false examples/inngest-agentkit/real-model.test.ts
```

Files:

- `refund-agent.ts`: the agent, network and Inngest function, both runtimes, and the Shakedown scenario.
- `local-inngest.ts`: the Inngest server stand-in, described below.
- `scripted-model.ts`: the mock model.
- `inngest-agentkit.test.ts`, `real-model.test.ts`.

## Running without the dev server

AgentKit has no pluggable model interface. An agent's `model` is an
`@inngest/ai` adapter (a URL and a wire format). Outside Inngest, AgentKit calls
`fetch()` on that URL itself. Inside Inngest, it emits a `step.ai.infer` op, and
the Inngest **server** makes the request. So the scripted model speaks the
OpenAI chat format behind a fake host (`scripted-model.invalid`):

- outside Inngest, `installScriptedFetch()` answers `fetch()` calls to that host;
- inside Inngest, LocalInngest's AI gateway answers.

Nothing leaves the process.

Durable execution normally needs the Inngest server (dev server or cloud): it
stores step results, re-invokes the function, retries, and runs
`step.ai.infer`. `LocalInngest` does the server's part in-process, but it drives
the SDK's **real** execution engine (`fn.createExecution(...).start()`, the
same call the SDK's HTTP handler makes for each request). It provides:

- memoized step state that survives a simulated crash;
- step retries: a `StepError` is retried with `attempt + 1` until the engine
  itself marks it `StepFailed` (`retries: 3`, the default);
- function-level retries for errors thrown outside steps;
- `step.ai.infer` (AIGateway op) and `step.waitForEvent`, answered by the "server";
- **v4 async checkpointing**, which is on by default. The client gets a custom
  `fetch` and `baseUrl`, so the engine's `POST /v1/checkpoint/<run>/async` calls
  land in LocalInngest. With `checkpointing: false` it runs classic replay mode.

On a simulated crash, the request's outcome is thrown away: the server never got
a response, just as when a worker dies. `resume` is then the server retrying
that request: same run, same memoized steps, new process.

What is **not** emulated: event-ID deduplication, the function-level
`idempotency` key, concurrency limits, `step.invoke`, sync (Durable Endpoint)
mode, and the real network timing between server and worker. A redelivered event
is modelled as what Inngest does without dedupe configured: a new run.

## Wiring

`shake()` wraps the raw side effect. The fix, `idempotent()`, goes outside it, and
in the Inngest runtime `step.run` goes outside that:

```ts
let refund = shake('refund', (a) =>
  stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } },
    { idempotencyKey: currentIdempotencyKey() }))
refund = idempotent(refund, { key: (a) => `refund:${a.ticket}`, store: ledger })
createTool({ name: 'refund', /* ... */ handler: (input, { step }) => step.run('refund', () => refund(input)) })
```

Modes:

- `naive`: plain tool handlers, as in the AgentKit quick start.
- `step-run`: the side effect inside `step.run(...)`, Inngest's durability primitive. No key.
- `fixed`: `step.run` + `idempotent()` ledger + the logical key (`refund:T-1`,
  `refund-email:T-1`) sent downstream as the Stripe / mail idempotency key.
- `key-only`: `fixed` without `step.run`.

The ledger is a volatile `MemoryLedger`, which Shakedown wipes on a crash or
redelivery.

**Crash emulation.** AgentKit has no abort signal. The router runs after every
agent call, and it checks `crashSignal()?.throwIfAborted()` so that a dead
process cannot take another step. Without that check, AgentKit swallows the
crash (see the findings below).

## What AgentKit and Inngest actually do

1. **AgentKit never wraps a tool in a step.** `invokeTools` calls
   `handler(input, { agent, network, step })` directly. Only MCP tools and
   Inngest-function tools get a step (`step.run` / `step.invoke`). Inside an
   Inngest function, every request replays the handler from the top. Inference
   results are memoized, so the model's tool calls replay too, and **every tool
   handler that is not in `step.run` runs again on every later request**.
   - With checkpointing (the v4 default), `step.run` steps run inside the
     request. `step.ai.infer` cannot, so every inference ends a request. With 4
     inferences there are 5 requests, and the no-fault baseline refunds twice
     and emails twice. A third refund fails only because the charge was used up.
   - With `checkpointing: false`, every step ends a request: 10 requests and 3
     emails.

   *Tests:* naive tools: even the no-fault baseline refunds twice; naive tools
   with checkpointing off.
2. **A thrown tool error goes to the model as JSON with a stack trace.** The
   handler's error is caught and becomes `{ error: serializeError(err) }`, which
   is `{ name, message, stack, __serialized: true }`. The model gets that,
   stringified, as the tool message. The loop goes on. AgentKit itself never
   retries a tool: one throw gives one tool result, and the model decides.
3. **Inngest retries `step.run` on its own, and the model never knows.** A
   timeout after commit in a `step.run` tool is a `StepError`. The server
   re-runs the step (attempt 1), and the refund commits twice. The model sees one
   success. If the step keeps failing, it runs 4 times (3 retries) and only then
   gives the model the original error (not a `StepError` wrapper). The model's
   own retry is a new step (`refund:1`) with 4 more attempts: 3 model attempts
   mean 12 Stripe calls.
4. **Memoization covers completed steps, not the step that crashed.** With
   `step.run`, a crash in `send_email` does not repeat the refund. The crashed
   step never reported back, though, so the retried request runs it again.
5. **A redelivered event is a new run** with empty step state, so everything
   runs again (approval included). Inngest's event `id` dedupe and the
   `idempotency` option would stop this on the server side; they are not
   emulated here.
6. **Plain runtime: `History.appendResults` runs once, when `network.run`
   finishes.** A crash mid-run persists nothing, so resume starts the ticket
   over, and a crash in `send_email` repeats the refund too. When the thread is
   already finished, the code router gets the stored final answer as
   `lastResult` and stops before any model call. `network.run` then returns
   before `saveThreadToStorage`.
7. **Without a crash check, AgentKit swallows a crash.** The model gets
   `ConnectionClosedError` as a tool error and retries twice. Shakedown blocks
   those calls. The model concludes the refund failed and never emails.
8. **`agent.run(input, { maxIter })` on its own never shows the model its tool
   results.** Between iterations the history becomes `[...inference.output]`,
   which is the tool call without its result (and without earlier turns), so the
   model is asked the same thing again. With the scripted model, `lookup_charge`
   runs 3 times and the refund never happens. Use a network: it appends each
   result to state.
9. **HITL (`step.waitForEvent` in the tool) is memoized, so it is asked once,
   and the approved code after it replays.** With naive tools, the human
   approves once and the refund runs on every later replay. With `step.run`, a
   timed-out or crashed approved refund is retried without asking again. A
   redelivery asks the human a second time.

## Observed results (scripted model, core v2)

Plain runtime (`network.run()` + History adapter):

| Fault | naive | fixed |
|---|---|---|
| baseline | pass | pass |
| error-before-commit on refund | pass | pass |
| timeout-after-commit on refund | FAIL (2 refunds) | pass (Stripe dedupe) |
| duplicate-delivery on refund | FAIL (2 refunds) | pass |
| crash-after-commit on refund | FAIL (2 refunds) | pass |
| error-before-commit on send_email | pass | pass |
| timeout-after-commit on send_email | FAIL (2 emails) | pass |
| duplicate-delivery on send_email | FAIL (2 emails) | pass |
| crash-after-commit on send_email | FAIL (2 emails **and 2 refunds**: nothing was saved) | pass |
| job-redelivery | pass\* | pass |

\* The stored thread is finished, so the router stops before calling the model.

Inside an Inngest function (LocalInngest, checkpointing on):

| Fault | naive | step-run | fixed | naive + approval | step-run + approval | fixed + approval |
|---|---|---|---|---|---|---|
| baseline | **FAIL (2 refunds, 2 emails)** | pass | pass | **FAIL** (approved once, refunded twice) | pass | pass |
| error-before-commit on refund | FAIL | pass (Inngest step retry) | pass | FAIL | pass | pass |
| timeout-after-commit on refund | FAIL | FAIL (2 refunds, Inngest's own retry) | pass | FAIL | FAIL (retried without asking again) | pass |
| duplicate-delivery on refund | FAIL | FAIL (2 refunds) | pass | FAIL | FAIL | pass |
| crash-after-commit on refund | FAIL | FAIL (2 refunds) | pass | FAIL | FAIL (approval not asked again) | pass |
| error-before-commit on send_email | FAIL | pass | pass | FAIL | pass | pass |
| timeout-after-commit on send_email | FAIL | FAIL (2 emails) | pass | FAIL | FAIL | pass |
| duplicate-delivery on send_email | FAIL | FAIL (2 emails) | pass | FAIL | FAIL | pass |
| crash-after-commit on send_email | FAIL | FAIL (2 emails; refund memoized) | pass | FAIL | FAIL | pass |
| job-redelivery | FAIL | FAIL (new run: 2 of each) | pass | FAIL | FAIL (human asked twice) | pass (human asked twice) |

`key-only` (ledger + key, no `step.run`) passes the baseline. The handlers
still run again on replay, but the in-process ledger absorbs the 3 repeats, so
none of them reaches Stripe. Only the downstream key covers repeats after a
crash, when the ledger is gone.

Every naive Inngest row fails, because the baseline already duplicates. Treat
`step.run` around every side-effecting tool as required when AgentKit runs
inside Inngest. It is still not enough: Inngest's step retries and
crash-retries turn every after-commit fault into a duplicate. The downstream key
is what fixes those.
