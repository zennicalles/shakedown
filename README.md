# Shakedown

**Crash-test your AI agent's tool calls before they touch real money.**

Agents now refund customers, send emails and edit records. When a network call times out *after* the side effect has happened, the agent (or the framework, or the HTTP client) retries, and the customer gets refunded twice. Shakedown finds these bugs in CI.

It runs your real agent against **stateful fake backends** (Stripe, email, ...), **injects the failures that cause duplicates** (lost responses, double delivery, crash-and-resume), and **checks invariants on the resulting state**: "exactly one £50 refund", "at most one email to the customer".

```sh
npm install -D agent-shakedown
```

**What we measured with a real model.** Claude Haiku 5.5 drove five frameworks with deliberately naive (non-idempotent) tools, in 7 scenarios with 4 runs each, 28 runs per fault ([full results and method](docs/results/haiku-5-5-2026-11-05.md)):
- **A crash, then a resumed job, refunded twice in 22 of 28 runs.** Most of the rest lost the job. A duplicate delivery of the same call refunded twice in 28 of 28, which is expected for any non-idempotent tool.
- **After an email timed out, the model re-sent it in 25 of 28 runs.** It had no way to check whether the first one went out.
- **After a refund timed out, it refunded again in 0 of 20 runs where it saw the real error, but in 8 of 8 with the OpenAI Agents SDK.** By default, that SDK replaces thrown tool errors with *"An error occurred while running the tool. Please try again."* In a same-framework test with a custom `errorFunction` passing the real error through, the result went from 6 of 6 duplicates to 0 of 6. With the real error, the model looked up the charge, saw it was refunded, and moved on.
- **With the fix below, no framework produced a duplicate under any fault on Haiku** (one run per scenario; 2 of 80 runs stopped short without duplicating).

**On Claude Sonnet 5.5** (2 runs per fault, [results](docs/results/sonnet-5-5-2026-11-05.md)), the model checked before retrying a timed-out refund in every framework, OpenAI Agents included: 0 of 14 duplicates. So the effect of the "Please try again" text depends on the model. Email timeouts (14 of 14) and crash-and-resume (12 of 14) duplicated just as with Haiku. One fixed-tool run sent two emails. It traced to our examples keying the email on its model-written subject line, which a reworded retry changes. The examples now key on the ticket. **Lesson: never build an idempotency key from text the model writes.**

```
shakedown: refund agent (naive tools)  FAIL
  [pass] baseline (no fault)  (2 writes committed)
  [pass] error-before-commit on refund  (2 writes committed)
  [FAIL] timeout-after-commit on refund  (3 writes committed)
         - expected exactly 5000 refunded on ch_1, found 10000
  [FAIL] duplicate-delivery on refund  (3 writes committed)
         - expected exactly 5000 refunded on ch_1, found 10000
  [FAIL] crash-after-commit on refund  (3 writes committed)
         - expected exactly 5000 refunded on ch_1, found 10000
  [pass] error-before-commit on send_email  (2 writes committed)
  [FAIL] timeout-after-commit on send_email  (3 writes committed)
         - expected exactly 1 email(s) to ada@example.com, found 2
  ...
  [FAIL] job-redelivery  (4 writes committed)
         - expected exactly 5000 refunded on ch_1, found 10000
         - expected exactly 1 email(s) to ada@example.com, found 2
```

## How it works

1. **Wrap your side effects** with `shake()`, at the boundary where the real call happens (the Stripe call, the mailer call). That is where real timeouts and crashes happen, so that is where faults are injected. Outside a test it is a transparent pass-through, and it works with any framework because every framework ultimately calls a function.

   ```ts
   import { shake } from 'agent-shakedown'

   const refund = shake('refund', async ({ charge, amount, ticket }) =>
     stripe.refunds.create({ charge, amount, metadata: { ticket } }))
   const lookup = shake('lookup_charge', async ({ charge }) => stripe.charges.retrieve(charge), { effect: 'read' })
   ```

2. **Describe a scenario**: a fresh world per run, how to run the agent, and what must stay true.

   ```ts
   import { runScenario, assertSafe, FakeStripe, stripeInvariants, mailerInvariants } from 'agent-shakedown'

   const report = await runScenario({
     name: 'refund agent',
     setup: () => makeWorld(),               // new FakeStripe/FakeMailer + your agent wired to them
     run: (w) => w.agent.run('Ticket T-1: refund £50 of ch_1 and email the customer'),
     resume: (w) => w.resumeFromCheckpoint(), // optional: your framework's real recovery path
     invariants: [
       stripeInvariants.refundedExactly('ch_1', 5_000),
       mailerInvariants.sentExactly('ada@example.com', 1),
     ],
   })
   assertSafe(report) // throws with a readable report, failing the test
   ```

   Two verdicts, because they are different bugs:
   - **safety**: something happened that must not, like a second refund or a second email. `assertSafe(report)` fails on these.
   - **completion**: the job stopped short, like a refund with no email. Reported as `INCOMPLETE`; `assertPassed(report)` fails on these too.

   `refundedExactly` and `sentExactly` classify themselves: over is safety, under is completion. Your own invariants return `true`, a message (safety by default), or `{ kind: 'completion', message }`.

3. Shakedown runs a **baseline**, discovers which write tools were called, then re-runs the scenario once per fault:

   | Fault | What happens | Retry safe? |
   |---|---|---|
   | `error-before-commit` | connection reset before the side effect | yes (control case) |
   | `timeout-after-commit` | side effect happens, caller sees a timeout | only if idempotent |
   | `duplicate-delivery` | same call delivered twice with identical args | only if idempotent |
   | `crash-after-commit` | side effect happens, the process dies (in-memory state is lost), the job is resumed | only if idempotent *and* durable |
   | `job-redelivery` | the whole job finishes, then is delivered again to a fresh worker | only if idempotent *and* durable |

**Honest verdicts.** A fault that never triggers fails the report (it tested nothing). So does a baseline where the agent throws or makes no write calls, and so does an invariant that returns anything other than `true`. When a framework swallows the simulated crash and keeps going, the report says so, and further side effects are blocked as they would be in a dead process. Pass `crashSignal()` as the framework's abort signal to stop it cleanly.

## The fix it points to

```ts
import { idempotent, shake, currentIdempotencyKey } from 'agent-shakedown'

const refund = idempotent(
  shake('refund', async ({ charge, amount, ticket }) =>
    stripe.refunds.create(
      { charge, amount, metadata: { ticket } },
      { idempotencyKey: currentIdempotencyKey() },   // the same key, sent downstream
    )),
  { key: ({ ticket }) => `refund:${ticket}`, store: postgresLedger },  // logical identity, not an argument hash
)
```

You need **both** layers, and Shakedown's tests show why:

- A ledger alone misses the window where the refund happened but the response was lost (timeout, crash): nothing was recorded, so the retry refunds again.
- The key sent downstream (Stripe `Idempotency-Key`, an email API's idempotency key, a database unique constraint) closes that window.
- Key on the **logical operation** (ticket id, order id), not on raw arguments. After an error, models often re-plan with slightly different arguments, and an argument hash misses the duplicate.
- The default `MemoryLedger` is wiped by a simulated crash, as a real restart would wipe it. Use a durable store in production; `new MemoryLedger({ durable: true })` stands in for one in tests.

## Fakes

- `FakeStripe`: charges and refunds with Stripe's real rules: partial refunds accumulate, over-refunds are rejected, `Idempotency-Key` replays the first result (including execution errors), rejects reuse with different parameters or on a different endpoint, and does not store parameter-validation failures. Deterministic ids, `snapshot()`/`restore()`.
- `FakeMailer`: outbox with an optional idempotency key, `sentExactly(to, n)` and `sentAtMost(to, n)`.

More fakes (CRM, Postgres, Shopify, filesystem) are on the roadmap.

## Framework examples

See [`examples/`](examples): Vercel AI SDK, OpenAI Agents SDK, LangGraph.js, Mastra and MCP, each using the framework's real agent loop with a scripted mock model, plus a real-model test that runs when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set.

## Running the tests and examples

```sh
pnpm install                       # repo root, once
pnpm test                          # core tests
cd examples/ai-sdk && pnpm install --ignore-workspace && cd ../..
npx vitest run --maxWorkers=1 examples/ai-sdk     # mock model, no API key needed
```

Every example also has a `real-model.test.ts`, which is skipped unless `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set. See [docs/results](docs/results) for the exact commands behind the published numbers.

## Status

0.1.0: early, API may change. Issues and PRs welcome. MIT licensed.
