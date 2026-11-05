import { markDeduped } from '../context.js'
import type { Violation } from '../runner.js'

/**
 * Stateful fake email sender. Duplicate customer emails are the most common
 * visible agent retry bug. Supports an idempotency key like modern email APIs
 * (e.g. Resend's Idempotency-Key header): a repeated key returns the first send.
 */

export class MailerError extends Error {
  readonly code = 'invalid_idempotent_request'
  constructor(message: string) {
    super(message)
    this.name = 'MailerError'
  }
}

export interface Email {
  id: string
  to: string
  subject: string
  body: string
}

export class FakeMailer {
  private sent: Email[] = []
  private seq = 0
  private keys: Record<string, { id: string; payload: string }> = {}

  send(m: { to: string; subject: string; body: string }, o: { idempotencyKey?: string } = {}): { id: string } {
    const payload = JSON.stringify([m.to, m.subject, m.body])
    if (o.idempotencyKey) {
      const hit = this.keys[o.idempotencyKey]
      if (hit) {
        // Like real email APIs (e.g. Resend), a key reused with a different payload is rejected.
        if (hit.payload !== payload) {
          throw new MailerError(`Idempotency key '${o.idempotencyKey}' was already used with a different payload`)
        }
        markDeduped()
        return { id: hit.id }
      }
    }
    const email: Email = { id: `msg_${++this.seq}`, to: m.to, subject: m.subject, body: m.body }
    this.sent.push(email)
    if (o.idempotencyKey) this.keys[o.idempotencyKey] = { id: email.id, payload }
    return { id: email.id }
  }

  outbox(to?: string): Email[] {
    return structuredClone(this.sent.filter((e) => !to || e.to === to))
  }

  snapshot(): string {
    return JSON.stringify({ sent: this.sent, seq: this.seq, keys: this.keys })
  }

  restore(s: string): void {
    const p = JSON.parse(s) as { sent: Email[]; seq: number; keys?: Record<string, { id: string; payload: string }> }
    this.sent = p.sent
    this.seq = p.seq
    this.keys = p.keys ?? {}
  }
}

export const mailerInvariants = {
  /** Exactly n emails to the recipient. More is a safety violation (duplicate); fewer is a completion violation. */
  sentExactly(to: string, n: number) {
    return (w: { mailer: FakeMailer }): true | Violation => {
      const k = w.mailer.outbox(to).length
      if (k === n) return true
      return { kind: k > n ? 'safety' : 'completion', message: `expected exactly ${n} email(s) to ${to}, found ${k}` }
    }
  },
  /** At least n emails to the recipient (the job got done). A completion invariant. */
  sentAtLeast(to: string, n: number) {
    return (w: { mailer: FakeMailer }): true | Violation => {
      const k = w.mailer.outbox(to).length
      return k >= n || { kind: 'completion', message: `expected at least ${n} email(s) to ${to}, found ${k}` }
    }
  },
  sentAtMost(to: string, max: number) {
    return (w: { mailer: FakeMailer }) => {
      const n = w.mailer.outbox(to).length
      return n <= max || `expected at most ${max} email(s) to ${to}, found ${n}`
    }
  },
}
