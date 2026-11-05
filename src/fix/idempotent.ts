import { AsyncLocalStorage } from 'node:async_hooks'
import { markDeduped, registerVolatile } from '../context.js'

/**
 * The fix Shakedown points to: make a side-effecting tool safe to call twice.
 *
 * Two layers, and you usually want both:
 *  1. A ledger: once the operation is known to be done, replay its result.
 *  2. The same key sent DOWNSTREAM (Stripe `Idempotency-Key`, a unique constraint,
 *     a message-id): this covers the window where the side effect happened but the
 *     ledger was never written (timeout, crash). Read it inside your tool with
 *     currentIdempotencyKey().
 *
 * Key the operation on its LOGICAL identity (ticket id, order id, message intent),
 * not on raw arguments: after an error the model often re-plans with slightly
 * different arguments, and an argument hash would miss the duplicate.
 */

export interface LedgerStore {
  get(key: string): Promise<LedgerEntry | undefined> | LedgerEntry | undefined
  set(key: string, entry: LedgerEntry): Promise<void> | void
}

export type LedgerEntry = { status: 'done'; result: unknown; at: number }

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
  set(key: string, e: LedgerEntry) {
    if (!this.durable) registerVolatile(this.reset)
    this.m.set(key, e)
  }
}

export interface IdempotentOptions<A extends unknown[]> {
  /** Derive the logical operation key. Return undefined to skip dedupe for this call. */
  key: (...args: A) => string | undefined
  /** Where completed operations are recorded. Default: a volatile MemoryLedger (use a durable store in production). */
  store?: LedgerStore
  /** Called when a duplicate is suppressed. */
  onDuplicate?: (key: string) => void
}

const keyStore = new AsyncLocalStorage<string>()

/** The logical idempotency key of the enclosing idempotent() call, to pass downstream. */
export function currentIdempotencyKey(): string | undefined {
  return keyStore.getStore()
}

export function idempotent<A extends unknown[], R>(
  execute: (...args: A) => R | Promise<R>,
  opts: IdempotentOptions<A>,
): (...args: A) => Promise<R> {
  const store = opts.store ?? new MemoryLedger()
  const inflight = new Map<string, Promise<R>>()
  const resetInflight = () => inflight.clear()
  return async (...args: A): Promise<R> => {
    const key = opts.key(...args)
    if (key === undefined) return await execute(...args)
    registerVolatile(resetInflight)

    const done = await store.get(key)
    if (done) {
      markDeduped()
      opts.onDuplicate?.(key)
      return done.result as R
    }
    const running = inflight.get(key)
    if (running) {
      markDeduped()
      opts.onDuplicate?.(key)
      return await running
    }
    const p = keyStore.run(key, async () => {
      const result = await execute(...args)
      await store.set(key, { status: 'done', result, at: Date.now() })
      return result
    })
    inflight.set(key, p)
    try {
      return await p
    } finally {
      if (inflight.get(key) === p) inflight.delete(key)
    }
  }
}
