# Changelog

## 0.4.1 (2026-11-14)

`scan` fixes from an adversarial review, each with a regression test:
- No false passes from wording: retry guidance must be an instruction about the key ("reuse the same key when retrying"), not any sentence containing "same" and "retr"; negated text ("never reuse a key") no longer counts.
- No false passes from names: get_or_create_charge, verify_and_pay, check_out, preview_and_send_email, cancel_and_refund_order and similar are writes, whatever their first word. Vendor prefixes (acme_pay_order, slack_get_users) are skipped when finding the action. Fewer false alarms: charge_status, email_lookup and text_to_speech aren't high risk.
- A server request or JSON log line that reuses the id being waited on no longer ends the scan with 0 tools; server pings are answered. A server that lists no tools exits 2 instead of passing; malformed tools are skipped and counted.
- Streamable HTTP: SSE is read event by event and the scan stops at the reply, even if the server leaves the stream open.
- Windows: commands resolve through PATH/PATHEXT; .cmd shims (npx) get arguments escaped for cmd.exe, so quotes, spaces, `%VAR%`, `&` and trailing backslashes arrive unchanged.
- `--timeout` is validated; `--flag=value` works.

## 0.4.0 (2026-11-14)

- **`npx agent-shakedown demo`**: see it work with no API key and no setup. A built-in scripted refund agent (it retries a failed call up to 3 times, as models do) runs under every fault twice: with naive tools, printing the real `formatReport` output (`expected exactly 5000 refunded on ch_1, found 10000`), then with the fix (`idempotent()` + the key sent downstream via `currentIdempotencyKey()`), printing PASS.
- New `agent-shakedown` bin (`dist/cli.js`): `demo`, `--help`, `--version`; unknown commands exit 1. Colour only on a TTY (`NO_COLOR` and `FORCE_COLOR` respected).
- README opens with an animated terminal demo, `docs/demo.svg`, rendered from the real demo output: `scripts/make-demo-cast.mjs` writes `docs/demo.cast` and svg-term-cli renders it (`npm run demo:svg`).
- **`npx agent-shakedown scan`**: point it at any MCP server (`-- <command>` for stdio, `--url` for streamable HTTP, `--file` for a saved `tools/list`) and it flags tools that can repeat a side effect on retry: writes with no idempotency key, keys the model is never told to reuse, and pass-through API tools. Static (names, schemas, annotations); never calls a tool. `--json`; exit 1 when a money or messaging tool is at risk, so it can gate CI. No new dependencies.
- `docs/audits/2026-11-14-payment-agent-servers.md`: the official PayPal, Adyen, Square, Coinbase AgentKit, Razorpay and Resend agent servers, read for idempotency-key handling, with source links.

## 0.3.0 (2026-11-10)

Fixes from a bug hunt (three independent finders, every finding reproduced first, each with a regression test in test/hunt-regressions.test.ts):

- Verdicts: a job-redelivery counts as triggered only if the first delivery committed a write; a resume that never re-attempts the operation at risk is flagged `hollow` (new `FaultResult.hollow`, `Report.hollowRows`); a retargeted fault is claimed synchronously, so parallel calls can't all take it; the context-loss fallback is used only when a single scenario is running.
- `idempotent()`: guards are attributed to the tool learned at runtime (works behind adapters; optional `tool` option); done-ledger replays in a resume count as exercising the tool; a worker that loses `claim()` never sends (any policy) unless reconcile finds the effect; writes from a crashed process are dropped; an empty key is rejected.
- Robustness: thrown values and arguments that `String()`/`structuredClone` can't handle no longer crash a run or skip the tool.
- Fakes: `FakeStripe` rejects a missing `charge` before the idempotency layer (a corrected retry succeeds, as in Stripe); prototype-named keys and ids (`__proto__`, `constructor`) work.
- `reportToMarkdown` includes the report verdict and problems; `summarize-reports.mjs` decides the log format per file and never counts harness errors as duplicates.
- Docs: code samples compile under strict TypeScript.

## 0.2.0 (2026-11-10)

- **Write-ahead intent** in `idempotent()`: `onPending: 'retry' | 'skip' | reconcile`, `notCommitted`, `PossiblyCommittedError`, and an optional atomic `LedgerStore.claim()` for concurrent workers. Measured in docs/results/write-ahead-2026-11-10.md.
- `FakeMailer`: `ref` on sends and `findByRef()` for reconciling with providers that have no idempotency key.
- Fixed: two concurrent calls with the same key could both run (the key is now claimed synchronously).
- Fixed: ledger entries without an explicit `pending` status are treated as done (fail closed), never re-executed.
- Verdicts: a resume counts as exercised only if it re-called, or its write-ahead guard fired on, the faulted tool (or every committed write tool, for a redelivery). Guards reached through the context-loss fallback don't count.
- `scripts/summarize-reports.mjs`: counts UNTESTED rows, reads the safety/completion markers, keeps full fault labels.

## 0.1.0 (2026-11-05)

- First release.
