import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { markDeduped, markGuarded, processIsDead, registerVolatile, shakeToolOf, withAttemptSlot } from '../context.js'

/**
 * The fix Shakedown points to: make a side-effecting tool safe to call twice.
 *
 * Layers, and you usually want more than one:
 *  1. A ledger: once the operation is known to be done, replay its result.
 *  2. The same key sent DOWNSTREAM (Stripe `Idempotency-Key`, an email API's
 *     idempotency key, a unique constraint): this covers the window where the side
 *     effect happened but the ledger was never written (timeout, crash). Read it
 *     inside your tool with currentIdempotencyKey().
 *  3. Write-ahead intent (`onPending`): record 'pending' BEFORE the side effect, so a
 *     retry knows the last attempt may have happened even when the downstream can't
 *     deduplicate (plain SMTP, an API without idempotency keys). Then decide: retry,
 *     skip, or reconcile against the system of record.
 *
 * Key the operation on its LOGICAL identity (ticket id, order id), never on text the
 * model wrote: after an error the model often re-plans and rewords its arguments.
 */

export interface LedgerStore {
  get(key: string): Promise<LedgerEntry | undefined> | LedgerEntry | undefined
  set(key: string, entry: LedgerEntry): Promise<void> | void
  /** Optional. Needed only for `notCommitted`, to clear a pending record. */
  delete?(key: string): Promise<void> | void
  /**
   * Optional atomic insert-if-absent (SQL INSERT ... ON CONFLICT DO NOTHING, Redis SET NX,
   * DynamoDB attribute_not_exists). Returns false if the key already exists. With
   * `onPending`, this is what stops two concurrent WORKERS (separate processes) from both
   * sending; without it, write-ahead only protects attempts that run one after another.
   */
  claim?(key: string, entry: LedgerEntry): Promise<boolean> | boolean
}

export type LedgerEntry =
  | { status: 'done'; result: unknown; at: number; tool?: string }
  /** Written before the side effect when `onPending` is set: the attempt may or may not have happened. */
  | { status: 'pending'; at: number; attempt?: string; tool?: string }

/**
 * In-memory ledger. By default it is VOLATILE under Shakedown: a simulated crash
 * or job redelivery wipes it, exactly as a real process restart would. Pass
 * `{ durable: true }` only when it stands in for a real database in your tests.
 */
export class MemoryLedger implements LedgerStore {
  private m = new Map<string, LedgerEntry>()
  private readonly durable: boolean
  private readonly reset = () => this.m.clear()
  constructor(opts: { durable?: boolean } = {}) {
    this.durable = opts.durable ?? false
  }
  get(key: string) {
    if (!this.durable) registerVolatile(this.reset)
    return this.m.get(key)
  }
  // A crashed process can't write anything: writes from the dead run phase are dropped.
  set(key: string, e: LedgerEntry) {
    if (processIsDead()) return
    if (!this.durable) registerVolatile(this.reset)
    this.m.set(key, e)
  }
  delete(key: string) {
    if (processIsDead()) return
    if (!this.durable) registerVolatile(this.reset)
    this.m.delete(key)
  }
  claim(key: string, e: LedgerEntry): boolean {
    if (processIsDead()) return false
    if (!this.durable) registerVolatile(this.reset)
    if (this.m.has(key)) return false
    this.m.set(key, e)
    return true
  }
}

/** What a reconcile function found in the system of record. */
export type Reconciled<R> = { found: true; result: R } | { found: false }

export type PendingPolicy<A extends unknown[], R> =
  /** Run it again with the same key. Safe only if the downstream deduplicates on that key. */
  | 'retry'
  /**
   * Never run it again: throw PossiblyCommittedError. At-most-once. No duplicates, but an
   * attempt that failed BEFORE committing is never retried, so the job can end incomplete
   * (unless `notCommitted` recognises that error and clears the pending record).
   */
  | 'skip'
  /** Ask the system of record (e.g. list Stripe refunds by metadata, look up the email by ref). */
  | ((ctx: { key: string; args: A; pendingSince: number }) => Promise<Reconciled<R>> | Reconciled<R>)

export interface IdempotentOptions<A extends unknown[], R = unknown> {
  /** Derive the logical operation key. Return undefined to skip dedupe for this call. */
  key: (...args: A) => string | undefined
  /** Where operations are recorded. Default: a volatile MemoryLedger (use a durable store in production). */
  store?: LedgerStore
  /** Called when a duplicate is suppressed. */
  onDuplicate?: (key: string) => void
  /**
   * Enable write-ahead intent: a 'pending' record is written before the side effect,
   * and this policy decides what a later call does when it finds one. Off by default.
   */
  onPending?: PendingPolicy<A, R>
  /**
   * The shake() tool this protects, for Shakedown's verdicts. Usually found automatically;
   * set it when adapters sit between idempotent() and the shake()-wrapped call.
   */
  tool?: string
  /**
   * With `onPending`: return true for errors you know happened BEFORE anything was
   * committed (connection refused, a 4xx validation error). The pending record is then
   * cleared so a retry runs normally. Requires `store.delete`.
   */
  notCommitted?: (error: unknown) => boolean
}

/** Thrown by onPending: 'skip' when a previous attempt may already have happened. */
export class PossiblyCommittedError extends Error {
  readonly code = 'POSSIBLY_COMMITTED'
  constructor(readonly key: string) {
    super(
      `Operation ${key} was already attempted and may have completed; not retrying it. Check the system of record before doing it again.`,
    )
    this.name = 'PossiblyCommittedError'
  }
}

const keyStore = new AsyncLocalStorage<string>()

/** The logical idempotency key of the enclosing idempotent() call, to pass downstream. */
export function currentIdempotencyKey(): string | undefined {
  return keyStore.getStore()
}

export function idempotent<A extends unknown[], R>(
  execute: (...args: A) => R | Promise<R>,
  opts: IdempotentOptions<A, R>,
): (...args: A) => Promise<R> {
  const store = opts.store ?? new MemoryLedger()
  const inflight = new Map<string, Promise<R>>()
  const resetInflight = () => inflight.clear()
  const writeAhead = opts.onPending !== undefined
  if (opts.notCommitted && !writeAhead) {
    throw new Error('idempotent(): notCommitted only applies together with onPending')
  }
  if (opts.notCommitted && !store.delete) {
    throw new Error('idempotent(): notCommitted requires a store with delete()')
  }

  const tag = shakeToolOf(execute)
  /** The write tool this wrapper protects: explicit, then learned at runtime, then the shake() tag. */
  let learnedTool: string | undefined = opts.tool ?? (tag && tag.effect === 'write' ? tag.tool : undefined)
  const toolFor = (entry?: LedgerEntry) => entry?.tool ?? learnedTool
  const replay = (key: string) => {
    markDeduped()
    opts.onDuplicate?.(key)
  }
  /** Writes from a crashed process never happen. */
  const write = async (key: string, entry: LedgerEntry) => {
    if (!processIsDead()) await store.set(key, entry)
  }
  const reconcileOrRefuse = async (key: string, args: A, entry: LedgerEntry | undefined, allowRetry: boolean): Promise<{ result: R } | 'run'> => {
    const policy = opts.onPending!
    if (typeof policy === 'function') {
      const found = await policy({ key, args, pendingSince: entry?.at ?? Date.now() })
      if (found.found) {
        await write(key, { status: 'done', result: found.result, at: Date.now(), ...(toolFor(entry) ? { tool: toolFor(entry)! } : {}) })
        markGuarded(toolFor(entry))
        replay(key)
        return { result: found.result }
      }
      if (allowRetry) return 'run'
    }
    if (policy === 'retry' && allowRetry) return 'run'
    markGuarded(toolFor(entry))
    throw new PossiblyCommittedError(key)
  }

  /** The whole decision, from ledger read to done-write, for one key. */
  const attempt = async (key: string, args: A): Promise<R> => {
    const entry = await store.get(key)

    // Fail closed: anything that is not an explicit 'pending' record counts as done (a store
    // that dropped or renamed the status field must never cause a silent re-execution).
    if (entry && entry.status !== 'pending') {
      markGuarded(toolFor(entry))
      replay(key)
      return (entry as { result?: unknown }).result as R
    }

    if (entry && writeAhead) {
      // A pending record from an earlier attempt: retry (only if the policy says so), reconcile, or refuse.
      const decision = await reconcileOrRefuse(key, args, entry, true)
      if (decision !== 'run') return decision.result
    }

    const myAttempt = randomUUID()
    if (writeAhead && !processIsDead()) {
      const pending: LedgerEntry = { status: 'pending', at: Date.now(), attempt: myAttempt, ...(learnedTool ? { tool: learnedTool } : {}) }
      if (!entry && store.claim) {
        // Atomic claim. Losing it means another worker owns a LIVE attempt right now: retrying
        // would race it, so refuse unless reconcile proves the effect already happened.
        if (!(await store.claim(key, pending))) {
          const now = await store.get(key)
          if (now && now.status !== 'pending') {
            markGuarded(toolFor(now))
            replay(key)
            return (now as { result?: unknown }).result as R
          }
          const decision = await reconcileOrRefuse(key, args, now, false)
          if (decision !== 'run') return decision.result
        }
      } else {
        await store.set(key, pending)
      }
    }

    const slot = { tools: new Set<string>() }
    let result: R
    try {
      result = await withAttemptSlot(slot, async () => await keyStore.run(key, async () => await execute(...args)))
    } catch (e) {
      if (!learnedTool && slot.tools.size === 1) learnedTool = [...slot.tools][0]
      if (writeAhead && opts.notCommitted?.(e) && !processIsDead()) {
        // Only clear OUR pending record: another attempt may have taken over the key.
        try {
          const current = await store.get(key)
          if (current?.status === 'pending' && current.attempt === myAttempt) await store.delete!(key)
        } catch {
          /* never mask the original error */
        }
      } else if (writeAhead && learnedTool) {
        // Keep the pending record, now labelled with the tool it protects.
        try {
          const current = await store.get(key)
          if (current?.status === 'pending' && current.attempt === myAttempt && !current.tool) await write(key, { ...current, tool: learnedTool })
        } catch {
          /* never mask the original error */
        }
      }
      throw e
    }
    if (!learnedTool && slot.tools.size === 1) learnedTool = [...slot.tools][0]
    await write(key, { status: 'done', result, at: Date.now(), ...(learnedTool ? { tool: learnedTool } : {}) })
    return result
  }

  return async (...args: A): Promise<R> => {
    const key = opts.key(...args)
    if (key === undefined) return await execute(...args)
    if (key === '') {
      throw new Error('idempotent(): key() returned an empty string; return undefined to skip dedupe, or a non-empty logical key')
    }
    registerVolatile(resetInflight)

    // Claim the key in-process SYNCHRONOUSLY, before any await, so two concurrent calls with
    // the same key can never both reach the side effect.
    const running = inflight.get(key)
    if (running) {
      replay(key)
      return await running
    }
    const p = attempt(key, args)
    inflight.set(key, p)
    try {
      return await p
    } finally {
      if (inflight.get(key) === p) inflight.delete(key)
    }
  }
}
