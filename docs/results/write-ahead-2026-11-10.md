# Write-ahead intent: what works when the provider can't deduplicate (2026-11-10)

A question from a reader of the launch post: *if you write a "pending" row before sending the email, does that fix the duplicates?* This measures it.

**Setup.** An agent sends one email through a provider with **no idempotency key**, like plain SMTP or an API without one. The agent retries an errored call up to 3 times (scripted, so the results are deterministic, not a model). The ledger is a durable store (it survives a crash). Each strategy runs against every default fault. Test: [`test/write-ahead.test.ts`](../../test/write-ahead.test.ts).

| Strategy | no fault | error before send | timeout after send | same send delivered twice | crash after send, resumed | job delivered again |
|---|---|---|---|---|---|---|
| naive | ok | ok | DUPLICATE | DUPLICATE | DUPLICATE | DUPLICATE |
| ledger written after the send | ok | ok | DUPLICATE | DUPLICATE | DUPLICATE | ok |
| pending row first, then **retry** | ok | ok | DUPLICATE | DUPLICATE | DUPLICATE | ok |
| pending row first, then **skip** | ok | *incomplete* | ok | DUPLICATE | ok | ok |
| skip + clear pending on errors known to be pre-send | ok | ok | ok | DUPLICATE | ok | ok |
| pending row first, then **reconcile** (look the send up by our own ref) | ok | ok | ok | DUPLICATE | ok | ok |
| *for reference:* provider deduplicates on the key | ok | ok | ok | ok | ok | ok |

**What this says**
- **A pending row on its own doesn't stop the duplicate.** It tells you an attempt *started*, not whether it finished. If you then retry, you send again.
- **Skip (at-most-once)** stops the duplicate but trades it for the opposite bug: when the send failed *before* going out, the email is never sent (the *incomplete* cell). Clearing the pending row on errors you *know* happened before sending (connection refused, a 4xx) fixes that case.
- **Reconcile is the best you can do without provider support**: on finding a pending row, look the send up in the system of record (here by a reference we attach to every message, like Resend tags or SendGrid custom args) and only send if it isn't there.
- **Nothing at the application level fixes the same request being delivered twice** to a provider that can't deduplicate. That duplicate happens *below* your ledger. Only the provider deduplicating on a key (Stripe's `Idempotency-Key`, an email API's idempotency key) closes it.

**In code**

```ts
const sendEmail = idempotent(
  shake('send_email', (a) => mailer.send({ ...a, ref: currentIdempotencyKey() })),
  {
    key: (a) => `refund-email:${a.ticket}`,   // the operation, never model-written text
    store: durableLedger,                     // must survive a crash
    onPending: ({ key }) => {                 // 'retry' | 'skip' | reconcile
      const sent = mailer.findByRef(key)[0]
      return sent ? { found: true, result: { id: sent.id } } : { found: false }
    },
  },
)
```

**Concurrent workers.** Write-ahead only protects attempts that run one after another, unless the store does an atomic insert-if-absent (`claim()`: SQL `INSERT ... ON CONFLICT DO NOTHING`, Redis `SET NX`). With `claim()`, two workers racing on the same key send once and the second gets `PossiblyCommittedError` (tested in `test/write-ahead.test.ts`).

Caveats: one scripted agent, one tool, deterministic faults; a real model's retries vary (see the [Haiku](haiku-5-5-2026-11-05.md) and [Sonnet](sonnet-5-5-2026-11-05.md) results). A pending row that is never resolved (skip with no reconcile) stays pending until something clears it; that's the price of at-most-once.
