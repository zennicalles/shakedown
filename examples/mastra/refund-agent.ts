/**
 * A customer-support refund agent built on Mastra's real agent loop
 * (`Agent` + `createTool` + `agent.generate()`).
 *
 * shake() sits at the SIDE-EFFECT BOUNDARY: around the raw Stripe / mailer call,
 * where real timeouts and crashes happen. Mastra's tool `execute` calls it.
 *
 *   fixed: false  -> plain tool bodies (what most people ship)
 *   fixed: true   -> idempotent() OUTSIDE shake(), keyed on LOGICAL identity
 *                    (refund:<ticket>, refund-email:<ticket>), and the same key
 *                    sent DOWNSTREAM as Stripe's / the mailer's Idempotency-Key.
 *
 * The ledger alone is not the fix: it is written only after the side effect
 * returns, so a timeout or crash between "Stripe committed" and "ledger written"
 * slips past it, and an in-process ledger is lost with the process. The
 * downstream key closes that window, because Stripe itself remembers it.
 */
import { Agent } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  FakeMailer,
  FakeStripe,
  currentIdempotencyKey,
  idempotent,
  isSimulatedCrash,
  shake,
  type LedgerStore,
} from '../../src/index.js'

export const INSTRUCTIONS = [
  'You are a customer-support refund agent.',
  'For a refund ticket: first call lookup_charge to check the charge, then call refund once with the ticket id,',
  'the charge id and the amount in minor units (pence; £50 = 5000), then call send_email to tell the customer.',
  'Always pass the ticket id to refund and send_email. Finish with a one-sentence summary.',
].join(' ')

const refundInput = z.object({
  ticket: z.string().describe('Support ticket id, e.g. T-1'),
  charge: z.string().describe('Stripe charge id, e.g. ch_1'),
  amount: z.number().int().positive().describe('Amount to refund in minor units (pence)'),
})
const emailInput = z.object({
  ticket: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
})
type RefundArgs = z.infer<typeof refundInput>
type EmailArgs = z.infer<typeof emailInput>

export interface RefundAgentOptions {
  fixed: boolean
  /**
   * With fixed=true, send the logical key downstream as the Idempotency-Key.
   * Default true. false = "ledger only", kept to show why the ledger alone fails.
   */
  downstreamKey?: boolean
  stripe: FakeStripe
  mailer: FakeMailer
  /**
   * Ledger for idempotent() (fixed=true). Default: a volatile in-memory ledger
   * per process. In production this is a database table; the downstream key
   * is what makes the fix hold even when the ledger is lost.
   */
  ledger?: LedgerStore
  model: MastraModelConfig
  /**
   * DurableAgent scenario only. Mastra turns every thrown tool error into an
   * `error-text` tool result and keeps the loop going, and a durable run would
   * then checkpoint that result. A real dead process returns nothing, so when
   * this is set a simulated crash makes the tool call hang until Mastra cancels
   * it through the tool's abortSignal (on `mastra.shutdown()`).
   */
  hangOnCrash?: boolean
}

export function createRefundTools(opts: Omit<RefundAgentOptions, 'model'>) {
  const { fixed, stripe, mailer } = opts
  const sendKey = fixed && (opts.downstreamKey ?? true)
  /** Request options carrying the enclosing idempotent() call's logical key (fixed only). */
  const downstream = () => {
    const key = sendKey ? currentIdempotencyKey() : undefined
    return key ? { idempotencyKey: key } : {}
  }

  // The side-effect boundary: this is where faults are injected.
  const lookup = shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' })
  let refund = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, downstream()),
  )
  let email = shake('send_email', async (a: EmailArgs) => mailer.send({ to: a.to, subject: a.subject, body: a.body }, downstream()))
  if (fixed) {
    refund = idempotent(refund, { key: (a) => `refund:${a.ticket}`, store: opts.ledger })
    email = idempotent(email, { key: (a) => `refund-email:${a.ticket}`, store: opts.ledger })
  }

  const guard = async <T>(call: () => Promise<T>, abortSignal: AbortSignal | undefined): Promise<T> => {
    try {
      return await call()
    } catch (e) {
      if (opts.hangOnCrash && isSimulatedCrash(e)) return await neverReturn(abortSignal)
      throw e
    }
  }

  return {
    lookup_charge: createTool({
      id: 'lookup_charge',
      description: 'Look up a Stripe charge by id. Read-only.',
      inputSchema: z.object({ charge: z.string() }),
      execute: async (input, ctx) => guard(() => lookup(input), ctx?.abortSignal),
    }),
    refund: createTool({
      id: 'refund',
      description: 'Refund part or all of a Stripe charge for a support ticket. Moves real money.',
      inputSchema: refundInput,
      execute: async (input, ctx) => guard(() => refund(input), ctx?.abortSignal),
    }),
    send_email: createTool({
      id: 'send_email',
      description: 'Send an email to the customer.',
      inputSchema: emailInput,
      execute: async (input, ctx) => guard(() => email(input), ctx?.abortSignal),
    }),
  }
}

/** The process is dead: this call never returns a result. It rejects only when Mastra cancels it. */
function neverReturn(abortSignal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    const stop = () => reject(abortSignal?.reason ?? new Error('process killed'))
    if (abortSignal?.aborted) stop()
    else abortSignal?.addEventListener('abort', stop, { once: true })
  })
}

export function createRefundAgent(opts: RefundAgentOptions) {
  return new Agent({
    id: 'refund-agent',
    name: 'refund-agent',
    instructions: INSTRUCTIONS,
    model: opts.model,
    tools: createRefundTools(opts),
  })
}
