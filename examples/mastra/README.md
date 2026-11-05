# Shakedown + Mastra

A refund agent built on Mastra's real agent loop (`Agent`, `createTool`, `agent.generate()`), crash-tested by Shakedown (core v2) in two execution modes:

| Mode | What happens after a crash or a job redelivery |
|---|---|
| `Agent.generate()` | Mastra has no recovery here. Shakedown's default applies: the job runs again from the start in a new process. |
| `createDurableAgent()` | Mastra's documented crash recovery. The loop runs as a workflow that writes a `running` checkpoint to storage at each step. The crashed process is shut down in the middle of the tool call. A **new** process (new Agent, model and Mastra, same storage) finds the orphaned run with `listActiveRuns()` and continues it with `recover(runId)`. On a redelivery nothing is orphaned, so the new worker handles the job message again with `generate()` and the same runId. |

Versions: `@mastra/core` 1.82.0, `ai` 7.0.162 (its `ai/test` `MockLanguageModelV4`, which matches the AI SDK v4 spec Mastra 1.82 accepts), `zod` 4.6.7.

## Run

```sh
cd examples/mastra && pnpm install --ignore-workspace   # once
cd ../.. && npx vitest run --maxWorkers=1 examples/mastra
npx tsc --noEmit -p examples/mastra
```

`real-model.test.ts` runs the same scenarios against a real model when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set. The defaults are `anthropic/claude-haiku-5-5` and `openai/gpt-5.4-mini`. To use another model, set `SHAKEDOWN_MODEL=provider/model`.

## Wiring

```ts
// refund-agent.ts: shake() at the side-effect boundary, idempotent() outside it,
// and the logical key sent downstream.
let refund = shake('refund', async (a) =>
  stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } },
    { idempotencyKey: currentIdempotencyKey() }))      // fixed only
refund = idempotent(refund, { key: (a) => `refund:${a.ticket}`, store: ledger })
createTool({ id: 'refund', inputSchema, execute: async (input) => refund(input) })
```

- `shake()` wraps the raw Stripe or mailer call, because that is where real timeouts and crashes happen. Mastra's tool `execute` calls the wrapped function.
- `idempotent()` goes **outside** `shake()`. Its keys are logical: `refund:<ticket>` and `refund-email:<ticket> (never the model-written subject: a model that rewords the email on retry would get a new key)`. Inside the shaken body, `currentIdempotencyKey()` reads the key, and the body sends it as Stripe's / the mailer's `idempotencyKey`. That downstream key is the actual fix. The ledger is written only after the side effect returns, so a fault at the boundary leaves it empty.
- Every ledger here is the default, **volatile** `MemoryLedger`. A crash or redelivery wipes it, just as a process restart would. No ledger is marked durable.
- The core v1 wiring was `shake(idempotent(body))`, with no downstream key. It reported false passes and has been removed. The `ledger-only` variant shows what the ledger does without the downstream key: it fails every after-commit fault.

## Files

- `refund-agent.ts`: `createRefundAgent({ fixed, downstreamKey, stripe, mailer, ledger, model, hangOnCrash })`. The tools are `lookup_charge` (read), `refund` and `send_email` (writes). `hangOnCrash` is used only in the durable scenario: on a simulated crash the tool call never returns, until Mastra cancels it through the tool's `abortSignal`.
- `scripted-model.ts`: a stateless, reactive mock model. It decides each turn from the prompt Mastra sends: lookup, then refund, then email, then the final answer. If the last result for the current step is an error, it issues the same call again, up to 3 attempts.
- `scenarios.ts`: `agentScenario(variant, model, { abortOnCrash })` and `durableScenario(variant, model, { waitForSettle })`, where `variant` is `'naive' | 'ledger-only' | 'fixed'`. The invariants are `refundedExactly(ch_1, 5000)`, `refundCountAtMost(ch_1, 1)` and `sentExactly(ada, 1)`. With `sentExactly`, a job that silently stops before the email also fails.

## How the adapter models a crash

- **Agent.generate()**: Mastra catches every error a tool throws, crashes included. To make a crash actually stop the loop, the adapter passes `crashSignal()` as `generate({ abortSignal })`. Mastra then stops at once, but `generate()` **resolves**, with `finishReason: 'aborted'` and empty text, instead of rejecting. A dead process never gets past that line, so the adapter rethrows `signal.reason`. The runner detects it with `isSimulatedCrash()`, and `crashSwallowed` stays false. The resume phase shares the run context, so there `crashSignal()` returns the signal that has already been aborted. `liveCrashSignal()` passes it only while it has not fired.
- **DurableAgent**: the adapter races `generate()` against `crashSignal()`. On a crash the tool call hangs, and the process's Mastra is shut down with `shutdown({ drainTimeout: 50 })`, which cancels the call and stops the run. A test instruments the workflows store with `processIsDead()`. It shows that the killed process writes **no** snapshot, step result or state after the crash, so recovery starts from the last checkpoint taken before the crashed step. The one thing that is not realistic: `shutdown()` claims run ownership and then releases it, and a SIGKILLed process would not do that (see "hard kill" below).
- After a successful `generate()`, the durable worker waits until `listActiveRuns()` no longer lists the run, and only then finishes (see the finding below).

## How Mastra feeds faults to the model

Mastra turns every error thrown by a tool's `execute` into a tool result `{ type: 'error-text', value: err.message }` and keeps the loop going. It does not retry the tool itself.

| Fault | What the model sees in Mastra |
|---|---|
| `error-before-commit` | `error-text: "Connection reset while calling refund (socket hang up)"`. The model retries. Nothing was committed, so the retry is safe. |
| `timeout-after-commit` | `error-text: "Request to refund timed out after 30000ms (no response received)"`, even though the refund already happened. The model retries. |
| `duplicate-delivery` | A normal success. The second delivery already ran underneath. |
| `crash-after-commit`, no abortSignal | Mastra swallows the crash. The model sees `error-text: "Process exited unexpectedly while calling refund (connection closed)"` and retries twice. `shake()` blocks both retries (`blocked: true`, not committed), because the "process" is dead. `generate()` resolves normally, and the report flags `crashSwallowed`. |
| `crash-after-commit`, `abortSignal: crashSignal()` | The loop stops after the crashed call, and the model is never called again. `generate()` resolves with `finishReason: 'aborted'`. |

## Observed results (scripted model, volatile ledgers)

The verdicts are the same in both modes. Only the damage differs:

| Fault | naive (Agent) | naive (Durable) | ledger-only (both) | ledger + downstream key (both) |
|---|---|---|---|---|
| baseline | pass | pass | pass | pass |
| error-before-commit on refund | pass | pass | pass | pass |
| timeout-after-commit on refund | **FAIL** 2 refunds, £100 | **FAIL** 2 refunds | **FAIL** | pass (1 deduped) |
| duplicate-delivery on refund | **FAIL** 2 refunds | **FAIL** 2 refunds | **FAIL** | pass (1 deduped) |
| crash-after-commit on refund | **FAIL** 2 refunds (re-run) | **FAIL** 2 refunds (`recover()` re-runs the in-flight refund) | **FAIL** | pass (1 deduped) |
| error-before-commit on send_email | pass | pass | pass | pass |
| timeout-after-commit on send_email | **FAIL** 2 emails | **FAIL** 2 emails | **FAIL** | pass (1 deduped) |
| duplicate-delivery on send_email | **FAIL** 2 emails | **FAIL** 2 emails | **FAIL** | pass (1 deduped) |
| crash-after-commit on send_email | **FAIL** 2 refunds **and** 2 emails (the re-run repeats everything) | **FAIL** 2 emails only (recovery resumes at the email step) | **FAIL** | pass (Agent: 2 deduped, Durable: 1) |
| job-redelivery | **FAIL** 2 refunds, 2 emails | **FAIL** 2 refunds, 2 emails (`generate()` with the completed runId runs the whole job again) | **FAIL** | pass (2 deduped) |

DurableAgent recovery limits a crash's damage to the step that was in flight, because earlier steps are not repeated. The in-flight tool call still runs again, as Mastra's docs warn ("recovery ... can re-execute tool calls. Make tools ... idempotent"). Recovery does nothing about a redelivered job. With a logical key sent downstream, every fault passes in both modes even though the ledger is wiped.

## Findings and gotchas

- **A crash cannot stop a Mastra run from inside a tool.** Any throw becomes `error-text`, including a crash. Pass an `abortSignal`, and note that an aborted `generate()` resolves with `finishReason: 'aborted'` instead of rejecting.
- **`DurableAgent.generate()` resolves while storage still lists the run as `running`.** `listActiveRuns()` still reports the finished run right after `generate()` returns, and clears a moment later. A redelivery handled in that window treats the finished run as orphaned. In this single-Node simulation, `recover()` then refuses it ("this process is still executing the run") because `ExecutionFence` keeps a module-level map. The invariants hold because nothing ran twice, so Shakedown reports **pass**, and only `agentError` shows that the redelivery never ran. The adapter waits for the run to settle (`waitUntilSettled`) before the worker finishes. A worker that exits immediately after `generate()` can leave a `running` snapshot behind.
- **A redelivered job reuses a completed runId, and Mastra starts it from scratch.** The fence prevents two concurrent executions, but nothing deduplicates a job once its first run has completed.
- **Hard kill: `recover()` refuses while the dead owner still holds its claim.** If the dead process's ownership writes are dropped, as with a SIGKILL, `recover()` fails with "Durable run run-T-1 is still being executed. Retry once it stops, or call recover(runId, { force: true })". `{ force: true }` takes the run over, and the fixed tools still pass.
- **`recover()` refuses a run this Node process is still executing**, even from a second `Mastra`/`DurableAgent` instance (module-level `ExecutionFence`). Shut down the "crashed" instance first.
- **Running checkpoints are off by default.** Without `recovery: { durableAgents: 'auto' }` or a `shouldPersistSnapshot` that includes `running`, a crashed run leaves nothing to recover. `listActiveRuns()` comes back empty and the run is silently lost.
- **`Agent.generate()` with an AI SDK v4 model calls `doGenerate`**, not `doStream`. The mock implements both.
- Set `MASTRA_TELEMETRY_DISABLED=1` (done in `no-telemetry.ts`). Otherwise Mastra sends anonymous feature telemetry.
