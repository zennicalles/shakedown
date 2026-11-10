import { markDeduped } from '../context.js'
import { hasOwn, setOwn } from '../util.js'
import type { Violation } from '../runner.js'

/**
 * Stateful in-memory fake of the slice of Stripe that refund/charge agents touch.
 *
 * Mirrors the real behaviours that matter for side-effect testing:
 *  - partial refunds accumulate on the charge; refunding more than remains is rejected
 *  - Idempotency-Key semantics: same key + same params replays the stored response
 *    (success or execution error), same key + different params or a different
 *    endpoint is rejected (Stripe's `idempotency_error`); parameter-validation
 *    failures are not stored, so a corrected retry with the same key succeeds
 *  - deterministic ids (ch_1, re_1...) so snapshots and reports are stable
 */

export interface Charge {
  id: string
  amount: number
  currency: string
  customer: string | null
  amount_refunded: number
  refunded: boolean
}

export interface Refund {
  id: string
  charge: string
  amount: number
  currency: string
  reason: string | null
  metadata: Record<string, string>
  status: 'succeeded'
}

export interface CreateRefundParams {
  charge: string
  /** Minor units. Defaults to the remaining refundable amount. */
  amount?: number
  reason?: string | null
  metadata?: Record<string, string>
}

export interface RequestOptions {
  idempotencyKey?: string
}

export class StripeError extends Error {
  constructor(
    readonly type: 'invalid_request_error' | 'idempotency_error',
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'StripeError'
  }
}

interface State {
  seq: { ch: number; re: number }
  charges: Record<string, Charge>
  refunds: Refund[]
  idempotency: Record<
    string,
    { endpoint: string; params: string; response: unknown; error?: { type: StripeError['type']; code: string; message: string } }
  >
}

export class FakeStripe {
  private s: State = { seq: { ch: 0, re: 0 }, charges: {}, refunds: [], idempotency: {} }

  /** Stripe-SDK-shaped namespaces so agent code can be written like real Stripe code. */
  readonly charges = {
    create: (p: { amount: number; currency?: string; customer?: string }, o?: RequestOptions) => this.createCharge(p, o),
    retrieve: (id: string) => this.retrieveCharge(id),
  }
  readonly refunds = {
    create: (p: CreateRefundParams, o?: RequestOptions) => this.createRefund(p, o),
    list: (p: { charge?: string } = {}) => ({ data: this.listRefunds(p.charge) }),
  }

  createCharge(p: { amount: number; currency?: string; customer?: string }, o: RequestOptions = {}): Charge {
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      throw new StripeError('invalid_request_error', 'parameter_invalid_integer', 'amount must be a positive integer')
    }
    return this.idempotent('POST /v1/charges', o.idempotencyKey, p, () => this.insertCharge(p))
  }

  private insertCharge(p: { amount: number; currency?: string; customer?: string }): Charge {
    const id = `ch_${++this.s.seq.ch}`
    const charge: Charge = {
      id,
      amount: p.amount,
      currency: p.currency ?? 'gbp',
      customer: p.customer ?? null,
      amount_refunded: 0,
      refunded: false,
    }
    this.s.charges[id] = charge
    return clone(charge)
  }

  retrieveCharge(id: string): Charge {
    const c = hasOwn(this.s.charges, id) ? this.s.charges[id] : undefined
    if (!c) throw new StripeError('invalid_request_error', 'resource_missing', `No such charge: '${id}'`)
    return clone(c)
  }

  createRefund(p: CreateRefundParams, o: RequestOptions = {}): Refund {
    // Parameter validation happens before the idempotency layer, as in Stripe.
    if (typeof p.charge !== 'string' || p.charge === '') {
      throw new StripeError('invalid_request_error', 'parameter_missing', 'Missing required param: charge.')
    }
    if (p.amount !== undefined && (!Number.isInteger(p.amount) || p.amount <= 0)) {
      throw new StripeError('invalid_request_error', 'parameter_invalid_integer', 'amount must be a positive integer')
    }
    return this.idempotent('POST /v1/refunds', o.idempotencyKey, p, () => {
      const c = hasOwn(this.s.charges, p.charge) ? this.s.charges[p.charge] : undefined
      if (!c) throw new StripeError('invalid_request_error', 'resource_missing', `No such charge: '${p.charge}'`)
      const remaining = c.amount - c.amount_refunded
      if (remaining === 0) {
        throw new StripeError('invalid_request_error', 'charge_already_refunded', `Charge ${c.id} has already been refunded.`)
      }
      const amount = p.amount ?? remaining
      if (amount > remaining) {
        throw new StripeError(
          'invalid_request_error',
          'amount_too_large',
          `Refund amount (${amount}) is greater than unrefunded amount on charge (${remaining})`,
        )
      }
      c.amount_refunded += amount
      c.refunded = c.amount_refunded === c.amount
      const refund: Refund = {
        id: `re_${++this.s.seq.re}`,
        charge: c.id,
        amount,
        currency: c.currency,
        reason: p.reason ?? null,
        metadata: { ...(p.metadata ?? {}) },
        status: 'succeeded',
      }
      this.s.refunds.push(refund)
      return clone(refund)
    })
  }

  listRefunds(charge?: string): Refund[] {
    return clone(this.s.refunds.filter((r) => !charge || r.charge === charge))
  }

  /** Total refunded on a charge, in minor units. */
  refundedTotal(charge: string): number {
    return this.s.refunds.filter((r) => r.charge === charge).reduce((n, r) => n + r.amount, 0)
  }

  snapshot(): string {
    return JSON.stringify(this.s)
  }

  restore(snapshot: string): void {
    this.s = JSON.parse(snapshot) as State
  }

  private idempotent<T>(endpoint: string, key: string | undefined, params: unknown, fn: () => T): T {
    if (!key) return fn()
    const p = stableStringify(params)
    const hit = hasOwn(this.s.idempotency, key) ? this.s.idempotency[key] : undefined
    if (hit) {
      if (hit.endpoint !== endpoint) {
        throw new StripeError(
          'idempotency_error',
          'idempotency_key_in_use',
          `Keys for idempotent requests can only be used for the same endpoint they were first used for ('${hit.endpoint}').`,
        )
      }
      if (hit.params !== p) {
        throw new StripeError(
          'idempotency_error',
          'idempotency_key_in_use',
          `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
        )
      }
      markDeduped()
      if (hit.error) throw new StripeError(hit.error.type, hit.error.code, hit.error.message)
      return clone(hit.response) as T
    }
    // Like real Stripe, the first result is stored whether it succeeded or failed.
    try {
      const response = fn()
      setOwn(this.s.idempotency, key, { endpoint, params: p, response: clone(response) })
      return response
    } catch (e) {
      if (e instanceof StripeError) {
        setOwn(this.s.idempotency, key, { endpoint, params: p, response: null, error: { type: e.type, code: e.code, message: e.message } })
      }
      throw e
    }
  }
}

export const stripeInvariants = {
  /** No more than `max` refunds exist for the charge. */
  refundCountAtMost(charge: string, max: number) {
    return (w: { stripe: FakeStripe }) => {
      const n = w.stripe.listRefunds(charge).length
      return n <= max || `expected at most ${max} refund(s) on ${charge}, found ${n}`
    }
  },
  /** Total refunded on the charge does not exceed `amount` (minor units). */
  refundedAtMost(charge: string, amount: number) {
    return (w: { stripe: FakeStripe }) => {
      const t = w.stripe.refundedTotal(charge)
      return t <= amount || `expected at most ${amount} refunded on ${charge}, found ${t} (${t - amount} over)`
    }
  },
  /** Total refunded equals `amount` exactly. Over is a safety violation (duplicate); under is a completion violation. */
  refundedExactly(charge: string, amount: number) {
    return (w: { stripe: FakeStripe }): true | Violation => {
      const t = w.stripe.refundedTotal(charge)
      if (t === amount) return true
      return { kind: t > amount ? 'safety' : 'completion', message: `expected exactly ${amount} refunded on ${charge}, found ${t}` }
    }
  },
  /** At least `amount` refunded on the charge (the job got done). A completion invariant. */
  refundedAtLeast(charge: string, amount: number) {
    return (w: { stripe: FakeStripe }): true | Violation => {
      const t = w.stripe.refundedTotal(charge)
      return t >= amount || { kind: 'completion', message: `expected at least ${amount} refunded on ${charge}, found ${t}` }
    }
  },
}

function clone<T>(v: T): T {
  return structuredClone(v)
}

export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}
