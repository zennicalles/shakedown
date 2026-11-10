# Changelog

## 0.2.0 (2026-11-10)

- **Write-ahead intent** in `idempotent()`: `onPending: 'retry' | 'skip' | reconcile`, `notCommitted`, `PossiblyCommittedError`, and an optional atomic `LedgerStore.claim()` for concurrent workers. Measured in docs/results/write-ahead-2026-11-10.md.
- `FakeMailer`: `ref` on sends and `findByRef()` for reconciling with providers that have no idempotency key.
- Fixed: two concurrent calls with the same key could both run (the key is now claimed synchronously).
- Fixed: ledger entries without an explicit `pending` status are treated as done (fail closed), never re-executed.
- Verdicts: a resume counts as exercised only if it re-called, or its write-ahead guard fired on, the faulted tool (or every committed write tool, for a redelivery). Guards reached through the context-loss fallback don't count.
- `scripts/summarize-reports.mjs`: counts UNTESTED rows, reads the safety/completion markers, keeps full fault labels.

## 0.1.0 (2026-11-05)

- First release.
