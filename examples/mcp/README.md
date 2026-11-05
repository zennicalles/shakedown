# Shakedown example: MCP (Model Context Protocol)

A refund agent whose tools live behind a real `@modelcontextprotocol/sdk` `McpServer` (1.32), driven by
an MCP host over the SDK's `InMemoryTransport.createLinkedPair()`. The three tools (`lookup_charge`,
`refund`, `send_email`) have zod input schemas and MCP tool annotations, and talk to `FakeStripe` /
`FakeMailer`.

MCP is a protocol, not an agent framework. The server owns the tools and the host owns the model loop, so
`refund-agent.ts` contains both halves: `createRefundServer()` and `runMcpHost()`, a minimal host loop
(`listTools` -> model -> `callTool` -> model). The default "model" is `scriptedModel()`. It follows the
task and reacts to what the host feeds back: after an error result it re-issues the same call (3
attempts at most), then gives up with a final answer.

## Run

```sh
cd examples/mcp && pnpm install --ignore-workspace     # once
cd ../.. && npx vitest run --maxWorkers=1 examples/mcp  # from the repo root
npx tsc --noEmit -p examples/mcp
```

- `mcp.test.ts`: the scripted host. Needs no keys.
- `real-model.test.ts`: the same scenario with a real model. With `ANTHROPIC_API_KEY` it uses the Anthropic
  SDK's `beta.messages.toolRunner()` + `mcpTools(tools, client)`. With `OPENAI_API_KEY` it uses
  `runMcpHost()` with an OpenAI chat model. It is skipped when neither key is set.
- `claude-agent-sdk.test.ts`: the same tools on `createSdkMcpServer()` + `tool()`, driven by
  `query()`, with session `resume` as the recovery path. It is skipped without `ANTHROPIC_API_KEY`.

## Wiring

`createToolBodies()` builds three variants (`mode`):

| mode | what it is |
|---|---|
| `naive` | `shake()` around the raw `stripe.refunds.create` / `mailer.send` call, nothing else |
| `ledger-only` | `idempotent()` outside `shake()`, keyed on the ticket, no key sent downstream |
| `fixed` | the same ledger, plus its key sent downstream as the Stripe / mailer idempotency key |

```ts
const rawRefund = shake('refund', async (a) => {
  const key = currentIdempotencyKey() // 'refund:T-1', set by idempotent() below
  return stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, key ? { idempotencyKey: key } : {})
})
const refund = idempotent(rawRefund, { key: (a) => `refund:${a.ticket}` })
```

`shake()` sits at the side-effect boundary because that is where real timeouts and crashes happen.
The v1 version of this example wrapped `shake(idempotent(...))`. With that wiring every fault was
injected outside the ledger, so the ledger absorbed it and the "durable ledger" column below passed
every fault. That was a false pass.

The ledger is `idempotent()`'s default `MemoryLedger`, created with each MCP server process
(`ledger: 'per-server'`, the default). It is volatile: a simulated crash or job redelivery wipes it, as
a real restart would. `ledger: 'durable'` uses `MemoryLedger({ durable: true })` stand-ins in the World.
It is only there to show that durability alone does not close the gap. The fixed variant passes with the
volatile ledger.

## How MCP surfaces a thrown tool error

`McpServer`'s `tools/call` handler catches **every** error a tool callback throws and returns a normal
result, `{ content: [{ type: 'text', text: err.message }], isError: true }`. Even bad arguments
(`MCP error -32602: Input validation error…`) and unknown tools come back this way. Only
`UrlElicitationRequired` is re-thrown as a JSON-RPC error. The client never rejects for a tool failure.
`Client.callTool()` resolves, so the model sees the error message as tool-result text and decides what
to do next.

This also applies to Shakedown's `SimulatedCrash`. Left alone, the host never crashes. The model reads
`Process exited unexpectedly while calling refund (connection closed)`, retries, and `shake()` blocks
the retries (recorded as `blocked` calls) because the process is dead. The model gives up, `run`
returns normally, and the report flags `crashSwallowed`. The test with `abortOnCrash: false` pins this
behaviour.

To model a real host death, `createRefundAgent()` passes `crashSignal()` to the host. `runMcpHost()` passes
it to `client.callTool(params, undefined, { signal })`, and once it aborts the host stops and rethrows
`signal.reason`. Two SDK details matter here, and both have tests:

- An aborted request rejects with `McpError` code `-32001` (`RequestTimeout`) whose message is
  `String(reason)`. The original error object is lost, so `isSimulatedCrash()` is false on the
  rejection. Read `signal.reason` instead.
- `crashSignal()` is per run, not per phase. In the resume phase it returns the same signal, already
  aborted. A host that passes it through dies on its first `listTools()`, so the adapter only passes a
  signal that is not yet aborted.

## Resume

MCP has no agent-run checkpoint or resume. Streamable HTTP resumability (`Last-Event-ID` with an
`EventStore`) re-delivers server messages lost when a connection drops. It does not recover an agent
process that died. So `resume` does what a supervisor or a redelivering job queue does: it starts a
**new** server and a new host (a stdio server is the host's child process and dies with it), reconnects
and re-runs the job from the task. Only the World survives (the fakes, plus durable ledgers if used).
Before `resume` runs, Shakedown wipes volatile state: per-server ledgers and `idempotent()` in-flight
maps. The same path handles `job-redelivery`, where the job finished and is delivered again.

## What each fault does here

| Fault | What happens through MCP |
|---|---|
| error-before-commit | The handler throws before the side effect, and the model gets an `isError` result "Connection reset…". It retries and the retry succeeds. |
| timeout-after-commit | The refund or email is committed, then the model gets an `isError` result "Request to X timed out…". It retries with the same arguments. |
| duplicate-delivery | The side effect runs twice with identical arguments (an at-least-once transport). The model sees one success. |
| crash-after-commit | The side effect is committed, then the process dies: `crashSignal()` aborts and the host stops. A new server and host re-run the job. |
| job-redelivery | The whole job completes, then a new server and host run it again from the task. |

## Observed results (scripted host)

| Fault | naive | ledger-only, per-server | ledger-only, durable | fixed (ledger + downstream key), per-server |
|---|---|---|---|---|
| baseline | pass | pass | pass | pass |
| error-before-commit on refund | pass | pass | pass | pass |
| timeout-after-commit on refund | **FAIL** (£100, 2 refunds) | **FAIL** | **FAIL** | pass (1 deduped) |
| duplicate-delivery on refund | **FAIL** (£100, 2 refunds) | **FAIL** | **FAIL** | pass (1 deduped) |
| crash-after-commit on refund | **FAIL** (£100, 2 refunds) | **FAIL** | **FAIL** | pass (1 deduped) |
| error-before-commit on send_email | pass | pass | pass | pass |
| timeout-after-commit on send_email | **FAIL** (2 emails) | **FAIL** | **FAIL** | pass (1 deduped) |
| duplicate-delivery on send_email | **FAIL** (2 emails) | **FAIL** | **FAIL** | pass (1 deduped) |
| crash-after-commit on send_email | **FAIL** (2 refunds + 2 emails) | **FAIL** | **FAIL** (2 emails) | pass (2 deduped) |
| job-redelivery | **FAIL** (2 refunds + 2 emails) | **FAIL** | pass | pass (2 deduped) |

The invariants are `refundedExactly('ch_1', 5000)`, `refundCountAtMost('ch_1', 1)` and
`sentExactly('ada@example.com', 1)`. `sentExactly` also catches a job that stops before it sends the
email.

- **ledger-only, per-server** has the same results as naive. A timeout or crash at the boundary
  means the ledger was never written. The retry or the re-run job then goes straight to Stripe again.
- **ledger-only, durable** catches only what reached the ledger. A job redelivery passes. A crash on
  `send_email` re-sends the email but not the refund. This is the configuration the v1 README
  reported as "pass" on every fault.
- **fixed** passes every fault with volatile ledgers. After a crash or redelivery the new server's
  ledger is empty, and Stripe and the mailer replay the first result from the idempotency key. It also
  passes when the host swallows the crash (`abortOnCrash: false`).

Fixed variant, as printed by `formatReport`:

```
shakedown: mcp refund agent (fixed, per-server ledger)  PASS
  [pass] baseline (no fault)  (2 writes committed, 3ms)
  [pass] error-before-commit on refund  (2 writes committed, 2ms)
  [pass] timeout-after-commit on refund  (2 writes committed, 1 deduped, 2ms)
  [pass] duplicate-delivery on refund  (2 writes committed, 1 deduped, 2ms)
  [pass] crash-after-commit on refund  (2 writes committed, 1 deduped, 3ms)
  [pass] error-before-commit on send_email  (2 writes committed, 2ms)
  [pass] timeout-after-commit on send_email  (2 writes committed, 1 deduped, 3ms)
  [pass] duplicate-delivery on send_email  (2 writes committed, 1 deduped, 2ms)
  [pass] crash-after-commit on send_email  (2 writes committed, 2 deduped, 4ms)
  [pass] job-redelivery  (2 writes committed, 2 deduped, 3ms)
```

## Lying-annotation detector

`lying-annotations.ts` reads the tool list over the protocol (`client.listTools()`, annotations included)
and flags any tool that declares `idempotentHint: true` but fails a `duplicate-delivery` fault. Hosts may
use that hint to decide that auto-retrying is safe, and nothing in MCP verifies it.

- The naive server claims `refund` is idempotent ("it has a ticket id"). The detector flags `refund`.
  `send_email` fails as well, but it declares `idempotentHint: false`, so it is not flagged.
- The ledger-only server claims both tools are idempotent ("they have a ledger"). The detector flags both:

  ```
  annotations: LYING idempotentHint
    refund declares idempotentHint: true but failed "duplicate-delivery on refund": expected exactly 5000 refunded on ch_1, found 10000; expected at most 1 refund(s) on ch_1, found 2
    send_email declares idempotentHint: true but failed "duplicate-delivery on send_email": expected exactly 1 email(s) to ada@example.com, found 2
  ```

  With the v1 wiring (`shake(idempotent(...))`) the ledger absorbed the duplicate before it reached the
  backend, and the detector cleared these claims.
- The fixed server declares both tools idempotent, and the detector flags neither.

`untestedIdempotentClaims()` lists claims that no duplicate-delivery fault exercised.
