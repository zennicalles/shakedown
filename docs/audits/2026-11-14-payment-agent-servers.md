# Can an official payment agent server refund twice? (checked 2026-11-14)

Agents call these servers' tools to refund, charge, transfer and email. When the provider has acted but the reply is lost, the agent or its framework retries. The only thing that stops the retry from acting a second time is an idempotency key: the provider sees the same key and returns the first result instead.

Every provider below supports such a key in its API. The question is whether the official agent server lets the key reach the provider, and whether it tells the model to reuse the key when retrying. I read each server's source at the commit linked.

| Server | Money / message tools | Key reaches the provider? | Model told to reuse it on retry? |
|---|---|---|---|
| [Razorpay MCP](https://github.com/razorpay/razorpay-mcp-server/blob/7cbda461e670d7d2466b4ddd7156153f9ee6e233/pkg/razorpay/refunds.go#L48-L54) | `create_refund` | yes, `idempotency_key` → `X-Refund-Idempotency` | **yes** |
| [Resend MCP](https://github.com/resend/mcp-send-email/blob/0280790d0694b5000726dfa41d1ebd1316374a5e/src/tools/emails.ts#L125-L132) | `send-email`, batch send | yes, `idempotencyKey` → `Idempotency-Key` | **yes** |
| [Square MCP](https://github.com/square/square-mcp-server/blob/b276734fe2f1e6d4990fd99c2189c5d8d280a8b8/utils/type-map.ts#L35218-L35222) | `make_api_request` (payments, refunds, ...) | yes: the model writes `idempotency_key` itself | **no**: the schema says it "must be unique for every `RefundPayment` request" |
| [PayPal agent toolkit / `@paypal/mcp`](https://github.com/paypal/agent-toolkit/blob/a3aa963960caf32912691a759879a8ce7a6018b2/typescript/src/shared/parameters.ts#L799-L807) | `create_refund`, `create_order`, `pay_order`, `send_invoice`, `create_subscription`, ... | **no** per-call key ([createRefund](https://github.com/paypal/agent-toolkit/blob/a3aa963960caf32912691a759879a8ce7a6018b2/typescript/src/shared/functions.ts#L1413-L1437)) | n/a |
| [Adyen MCP](https://github.com/Adyen/adyen-mcp/blob/5a547944019d8461fff021367e31befd8efcb9a5/typescript/src/tools/checkout/modifications/index.ts#L39-L44) | `refund_payment`, `cancel_payment`, `create_payment_links`, `create_payment_session` | **no**: `refundCapturedPayment()` is called without `requestOptions.idempotencyKey`, which the Adyen library accepts | n/a |
| [Coinbase AgentKit](https://github.com/coinbase/agentkit/blob/f2f3e8c11a91d56a17979a229a172ba6e61a85c2/typescript/agentkit/src/wallet-providers/cdpEvmWalletProvider.ts#L195-L206) | `native_transfer`, ERC-20 `transfer` | **no**: `cdp.evm.sendTransaction()` is called without the `idempotencyKey` the CDP SDK accepts | n/a |
| Stripe (`mcp.stripe.com`) | refunds, payment links, invoices | can't tell: the server is hosted and closed; the open-source toolkit is retired | |

## What goes wrong, per server

**PayPal.** No write tool takes a request id, so a retried partial refund is a second partial refund. There is one way to set `PayPal-Request-Id`: the toolkit's `context.request_id`. But it is a single fixed value [added to every request](https://github.com/paypal/agent-toolkit/blob/a3aa963960caf32912691a759879a8ce7a6018b2/typescript/src/shared/client.ts#L121-L124) the toolkit makes. PayPal's [idempotency guide](https://developer.paypal.com/reference/guidelines/idempotency/) says a repeated id makes PayPal return "the status of the earlier request instead of running it again", and that the value "must be unique for both each request and an API call type". So with `request_id` set, by PayPal's own rules the second refund or capture in a session is treated as a repeat of the first: the agent gets the first one's result back and the second never happens. (This follows from the guide; we haven't run it against the sandbox.)

**Adyen.** A timed-out `refund_payment` retried by the agent is a second refund: Adyen allows several partial refunds on one payment, and without an `Idempotency-Key` it can't tell a retry from a new refund. Errors are also returned to the model as a successful string ("Failed to refund payment. Error: ..."), so a client sees no `isError`.

**Square.** Square's API requires an idempotency key on payments and refunds, and the MCP server passes whatever the model writes. That works only if the model reuses the same key when it retries. The only guidance the model gets is the API reference text: the key "must be unique for every `CreatePayment` request". Square's own docs say the opposite for a retry of the same request (reuse the key), and the API even has `CancelPaymentByIdempotencyKey` for exactly this case. The model is never told.

**Coinbase AgentKit.** `native_transfer` and ERC-20 `transfer` go through `sendTransaction()`, which doesn't pass an idempotency key, so a retried transfer broadcasts a second transaction with the next nonce. On-chain, there is no refund.

**Razorpay and Resend** do it right: an optional key, sent as the provider's header, with a description that says to reuse it when retrying ("Reuse the same key when retrying a refund request so that a timeout retry does not create a duplicate refund"). That is the pattern to copy.

**Providers with no key at all** (plain SMTP, Twilio SMS, Mailgun): no server can make a retry safe by forwarding a key. The best available is write-ahead plus reconcile: record the intent, and before retrying, look the send up by a reference you attached. See [write-ahead results](../results/write-ahead-2026-11-10.md).

## Check your own server

```sh
npx agent-shakedown scan -- <the command that starts your MCP server>
```

It lists the server's tools and flags write tools with no idempotency key, keys with no retry guidance, and pass-through API tools. It reads names, schemas and annotations only and never calls a tool, so treat its output as a list of leads, then confirm them with a crash test ([how](../../README.md#how-it-works)).

## Why a model-written key isn't enough on its own

In our [Haiku](../results/haiku-5-5-2026-11-05.md) and [Sonnet](../results/sonnet-5-5-2026-11-05.md) runs, a model that saw an email time out sent it again in 25 of 28 and 14 of 14 runs, and a reworded retry changed any key built from the text it wrote. A key parameter with "reuse it on retry" guidance is the minimum. The safer design is for the application to set the key from the operation it is doing (the ticket, the order), not from text the model writes.
