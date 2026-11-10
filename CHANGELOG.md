# Changelog

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
