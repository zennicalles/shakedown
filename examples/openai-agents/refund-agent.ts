/**
 * A customer-support refund agent built with the OpenAI Agents SDK's real agent
 * loop: Agent + tool() + run().
 *
 * Shakedown's shake() wraps the SIDE-EFFECT BOUNDARY (the raw Stripe / mailer
 * call), because that is where real timeouts and crashes happen.
 *
 *   fixed: false -> plain tool bodies (what most people ship)
 *   fixed: true  -> idempotent() OUTSIDE shake(), keyed on LOGICAL identity
 *                   (refund:<ticket>, refund-email:<ticket>), and the same key
 *                   sent DOWNSTREAM as the Stripe / mailer Idempotency-Key. The
 *                   ledger replays finished operations; the downstream key covers
 *                   the window where the side effect happened but the ledger was
 *                   never written (timeout, crash, a fresh worker).
 */
import { Agent, tool, type Model } from '@openai/agents'
import { z } from 'zod'
import { currentIdempotencyKey, FakeMailer, FakeStripe, idempotent, MemoryLedger, shake, type LedgerStore } from '../../src/index.js'

export interface RefundAgentOptions {
  fixed: boolean
  stripe: FakeStripe
  mailer: FakeMailer
  /** A Model instance (the scripted mock in tests, or a real provider model). */
  model: Model | string
  /** Gate the refund tool behind human approval (needsApproval: true). */
  approveRefunds?: boolean
  /**
   * Pass the real thrown error to the model (custom errorFunction) instead of the SDK's
   * default fixed text "An error occurred while running the tool. Please try again."
   */
  errorPassthrough?: boolean
  /**
   * Where idempotent() records completed operations. Default: a VOLATILE
   * MemoryLedger (a simulated crash or redelivery wipes it, like a real restart).
   * In production use a durable store; the downstream key is what makes the
   * commit-then-crash window safe either way.
   */
  ledger?: LedgerStore
}

export interface RefundArgs {
  ticket: string
  charge: string
  amount: number
}
export interface EmailArgs {
  ticket: string
  to: string
  subject: string
  body: string
}

export const INSTRUCTIONS = [
  'You are a customer-support refund agent.',
  'For a refund ticket: first call lookup_charge for the charge, then call refund with the ticket id, charge id and amount in minor units (pence),',
  'then call send_email to the customer confirming the refund (subject "Your refund for <ticket>").',
  'If a tool call fails, you may retry it. Finish with a one-line summary.',
].join(' ')

/** The downstream Idempotency-Key: only set inside an idempotent() call (fixed mode). */
function keyOpts(): { idempotencyKey?: string } {
  const k = currentIdempotencyKey()
  return k ? { idempotencyKey: k } : {}
}

export function createRefundAgent(opts: RefundAgentOptions): Agent {
  const { stripe, mailer, fixed } = opts
  const ledger = opts.ledger ?? new MemoryLedger()

  // shake() sits at the side-effect boundary: the raw Stripe / mailer call.
  const lookupFn = shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' })
  let refundFn = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, keyOpts()),
  )
  let emailFn = shake('send_email', async (a: EmailArgs) => mailer.send({ to: a.to, subject: a.subject, body: a.body }, keyOpts()))
  if (fixed) {
    // idempotent() goes OUTSIDE shake(): the fault hits the raw call; ledger + key wrap it.
    refundFn = idempotent(refundFn, { key: (a) => `refund:${a.ticket}`, store: ledger })
    emailFn = idempotent(emailFn, { key: (a) => `refund-email:${a.ticket}`, store: ledger })
  }

  // The SDK calls execute(input, runContext, details); pass only the input on.
  const errorFunction = opts.errorPassthrough
    ? (_ctx: unknown, error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    : undefined
  const lookupCharge = tool({
    name: 'lookup_charge',
    description: 'Look up a Stripe charge by id. Returns amount, currency and how much is already refunded.',
    parameters: z.object({ charge: z.string() }),
    execute: (input) => lookupFn(input),
    ...(errorFunction ? { errorFunction } : {}),
  })
  const refund = tool({
    name: 'refund',
    description: 'Refund part or all of a Stripe charge. amount is in minor units (pence).',
    parameters: z.object({ ticket: z.string(), charge: z.string(), amount: z.number().describe('Amount in minor units (pence), a whole number') }),
    execute: (input) => refundFn(input),
    needsApproval: opts.approveRefunds ?? false,
    ...(errorFunction ? { errorFunction } : {}),
  })
  const sendEmail = tool({
    name: 'send_email',
    description: 'Send an email to a customer.',
    parameters: z.object({ ticket: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
    execute: (input) => emailFn(input),
    ...(errorFunction ? { errorFunction } : {}),
  })

  return new Agent({
    name: 'Refund agent',
    instructions: INSTRUCTIONS,
    model: opts.model,
    tools: [lookupCharge, refund, sendEmail],
  })
}
