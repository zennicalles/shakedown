/**
 * A customer-support refund agent built on Google's Agent Development Kit for
 * TypeScript (`@google/adk` 2.x): `LlmAgent` + `FunctionTool` + `Runner` with a
 * session service, wired for Shakedown (core v2).
 *
 * Wiring. shake() sits at the SIDE-EFFECT BOUNDARY, around the raw
 * stripe.refunds.create / mailer.send call, because that is where real
 * timeouts and crashes happen. The fix, idempotent(), goes OUTSIDE shake():
 *
 *   FunctionTool execute -> idempotent(ledger) -> shake() -> stripe/mailer (with Idempotency-Key)
 *
 * - mode 'naive':       plain tool bodies (what most people ship).
 * - mode 'ledger-only': idempotent() ledger, no key sent downstream.
 * - mode 'fixed':       ledger + the logical key sent DOWNSTREAM: inside the
 *   shaken body, currentIdempotencyKey() is passed as { idempotencyKey } to
 *   Stripe / the mailer, which covers the commit-to-ledger window (timeout,
 *   crash) that a ledger alone cannot.
 *
 * The ledger is a VOLATILE in-memory MemoryLedger: Shakedown wipes it on a
 * simulated crash or job redelivery, as a real restart would. The fix does not
 * rely on it surviving; the downstream key does the real work.
 *
 * Recovery path. ADK persists every non-partial event to the session service
 * as it happens (Runner.processAndAppendEvent), so the session IS the
 * checkpoint. The TS Runner has no "continue this invocation" call:
 * `runAsync` only runs the agent when it is given a `newMessage`. So the
 * recovery path is the one ADK supports: a new process (fresh agent, tools and
 * Runner) calls `runAsync` with the SAME session id on the same (durable)
 * session service and the message the crashed job was processing, i.e. an
 * at-least-once queue redelivering the job. For a plain ticket that message is
 * the task; for approve-and-continue it is the human's
 * `adk_request_confirmation` response.
 */
import {
  BaseSessionService,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Runner,
  getFunctionCalls,
  isFinalResponse,
  type AppendEventRequest,
  type BaseLlm,
  type BasePlugin,
  type Event,
} from '@google/adk'
import { z } from 'zod'
import {
  FakeMailer,
  FakeStripe,
  MemoryLedger,
  crashSignal,
  currentIdempotencyKey,
  idempotent,
  mailerInvariants,
  processIsDead,
  shake,
  stripeInvariants,
  type LedgerStore,
  type Scenario,
} from '../../src/index.js'

type Content = NonNullable<Event['content']>

export const APP = 'refund_app'
export const USER = 'support'
/** The session is keyed by ticket, so every delivery of T-1 lands in the same conversation. */
export const SESSION = 'ticket-T-1'
export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'
export const INSTRUCTIONS = [
  'You are a customer-support refund agent.',
  'For a refund ticket: first call lookup_charge, then call refund exactly once with the ticket id, charge id and amount in minor units (pence), then call send_email to tell the customer.',
  'Use the subject "Your refund for <ticket>". When done, reply with a one-line summary.',
].join(' ')

export const taskMessage = (): Content => ({ role: 'user', parts: [{ text: TASK }] })

/**
 * Stands in for the app's database-backed session service (DatabaseSessionService
 * in production): it survives a simulated process crash. A dead process persists
 * nothing, so events ADK tries to append after a simulated crash (in the same
 * doomed run) are dropped, as a real restart would lose them. That includes the
 * "Invocation was aborted by client." seal the Runner writes on abort; set
 * `persistAfterCrash` to model a graceful shutdown where that seal is written.
 */
export class DurableSessionService extends InMemorySessionService {
  constructor(private readonly persistAfterCrash = false) {
    super()
  }
  override async appendEvent(req: AppendEventRequest): Promise<Event> {
    // The dead process's own in-memory copy of the session still updates (that is
    // ordinary process memory); only the durable write is lost.
    if (processIsDead() && !this.persistAfterCrash) return await BaseSessionService.prototype.appendEvent.call(this, req)
    return await super.appendEvent(req)
  }
}

/** The queue's view of the job in flight: the message being processed. Durable. */
export class JobStore {
  private current: Content = taskMessage()
  deliver(m: Content): void {
    if (processIsDead()) return
    this.current = structuredClone(m)
  }
  inFlight(): Content {
    return structuredClone(this.current)
  }
}

/** The app's backends and stores. */
export interface Backends {
  stripe: FakeStripe
  mailer: FakeMailer
  /**
   * Idempotency ledger. Here a VOLATILE MemoryLedger (lost on crash/redelivery;
   * Shakedown wipes it); in production Redis/DB. Correctness must not depend on it.
   */
  ledger: LedgerStore
  /** Durable ADK session storage (the app's DB). */
  sessions: DurableSessionService
  /** Durable job queue state. */
  jobs: JobStore
}

export type Mode = 'naive' | 'ledger-only' | 'fixed'

export interface RefundAgentOptions {
  mode: Mode
  backends: Backends
  model: BaseLlm
  /** Gate `refund` on human approval (ADK `FunctionTool({ requireConfirmation: true })`). */
  refundNeedsApproval?: boolean
}

interface RefundArgs {
  ticket: string
  charge: string
  amount: number
}
interface EmailArgs {
  ticket: string
  to: string
  subject: string
  body: string
}

export function createRefundAgent({ mode, backends, model, refundNeedsApproval = false }: RefundAgentOptions): LlmAgent {
  const { stripe, mailer, ledger } = backends
  // Only the fixed variant forwards the logical key downstream.
  const requestOptions = () => {
    const key = mode === 'fixed' ? currentIdempotencyKey() : undefined
    return key ? { idempotencyKey: key } : {}
  }

  // shake() at the side-effect boundary. Each execute passes only the parsed
  // args: ADK calls execute(args, toolContext) and the Context would pollute
  // Shakedown's call log.
  const lookup = shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' })
  let refund = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, requestOptions()),
  )
  let sendEmail = shake('send_email', async (a: EmailArgs) =>
    mailer.send({ to: a.to, subject: a.subject, body: a.body }, requestOptions()),
  )
  if (mode !== 'naive') {
    // idempotent() OUTSIDE shake(), keyed on logical identity (not an argument
    // hash): one refund and one confirmation email per ticket. The subject is
    // left out on purpose, since a model that retries often re-words it.
    refund = idempotent(refund, { key: (a) => `refund:${a.ticket}`, store: ledger })
    sendEmail = idempotent(sendEmail, { key: (a) => `refund-email:${a.ticket}`, store: ledger })
  }

  return new LlmAgent({
    name: 'refund_agent',
    description: 'Handles refund tickets.',
    model,
    instruction: INSTRUCTIONS,
    tools: [
      new FunctionTool({
        name: 'lookup_charge',
        description: 'Look up a Stripe charge by id.',
        parameters: z.object({ charge: z.string() }),
        execute: (args) => lookup(args),
      }),
      new FunctionTool({
        name: 'refund',
        description: 'Refund part or all of a Stripe charge. amount is in minor units (pence).',
        parameters: z.object({ ticket: z.string(), charge: z.string(), amount: z.number().int().positive() }),
        execute: (args) => refund(args),
        ...(refundNeedsApproval ? { requireConfirmation: true } : {}),
      }),
      new FunctionTool({
        name: 'send_email',
        description: 'Send an email to the customer.',
        parameters: z.object({ ticket: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
        execute: (args) => sendEmail(args),
      }),
    ],
  })
}

export function createRunner(agent: LlmAgent, sessions: DurableSessionService, plugins?: BasePlugin[]): Runner {
  return new Runner({ appName: APP, agent, sessionService: sessions, ...(plugins ? { plugins } : {}) })
}

/** Who answers approval requests. Default: approve everything (a human clicking Approve). */
export type Approver = (req: { toolName: string; args: unknown }) => boolean

export interface ProcessOptions {
  approve?: Approver
}

/** The final text of a run, if any. */
function textOf(ev: Event): string {
  return (ev.content?.parts ?? []).map((p) => p.text ?? '').join('')
}

/**
 * One "process" handling the ticket: deliver the message to the ticket's
 * session with runner.runAsync and service approval requests the way the ADK
 * docs describe (answer the `adk_request_confirmation` function call with a
 * function response `{ confirmed }` as the next message).
 *
 * Crash handling. ADK catches every error thrown by a tool and turns it into a
 * `{ error: message }` function response, so a simulated crash would be fed to
 * the model and the loop would carry on. A real crash (OOM, SIGKILL, deploy)
 * gives ADK no such chance. So the process passes Shakedown's crashSignal() as
 * the Runner's abortSignal (undefined outside a Shakedown run), and the
 * session service drops writes once processIsDead(). ADK's abort ends
 * runAsync SILENTLY (the generator returns, nothing is thrown), so the driver
 * re-raises it with throwIfAborted(); otherwise the run would look finished.
 */
export async function processTicket(runner: Runner, jobs: JobStore, message: Content, { approve = () => true }: ProcessOptions = {}): Promise<string> {
  // crashSignal() is per Shakedown run, not per process: in the resume phase it
  // is the previous (dead) process's signal and already aborted. A process that
  // starts with an aborted signal is the NEW process, so it must not inherit it.
  const signal = crashSignal()
  const crash = signal && !signal.aborted ? signal : undefined
  let next: Content | undefined = message
  let finalText = ''

  for (let turn = 0; turn < 6 && next; turn++) {
    jobs.deliver(next) // the queue records which message is in flight
    const confirmations: Array<{ id: string; name: string; args: unknown }> = []
    for await (const ev of runner.runAsync({ userId: USER, sessionId: SESSION, newMessage: next, ...(crash ? { abortSignal: crash } : {}) })) {
      for (const fc of getFunctionCalls(ev)) {
        if (fc.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME || !fc.id) continue
        const original = (fc.args as { originalFunctionCall?: { name?: string; args?: unknown } }).originalFunctionCall
        confirmations.push({ id: fc.id, name: original?.name ?? '', args: original?.args })
      }
      if (isFinalResponse(ev) && textOf(ev)) finalText = textOf(ev)
    }
    crash?.throwIfAborted()
    // Each approval decision is a new job for the same session, as an app
    // receiving it from a UI or approval queue would deliver it.
    next = confirmations.length
      ? {
          role: 'user',
          parts: confirmations.map((c) => ({
            functionResponse: {
              id: c.id,
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: { confirmed: approve({ toolName: c.name, args: c.args }) },
            },
          })),
        }
      : undefined
  }
  if (next) throw new Error('approval loop did not settle after 6 turns')
  return finalText
}

// ---------------------------------------------------------------------------
// Shakedown scenario

export interface World extends Backends {
  mode: Mode
  refundNeedsApproval: boolean
  makeModel: () => BaseLlm
}

export interface ScenarioOptions {
  mode: Mode
  refundNeedsApproval?: boolean
  /** Called once per agent process (initial run and every resume). */
  makeModel: () => BaseLlm
  process?: ProcessOptions
  /** Let the dead process still write to the session (graceful shutdown: the abort seal is persisted). */
  persistAfterCrash?: boolean
}

export async function newWorld(o: ScenarioOptions): Promise<World> {
  const stripe = new FakeStripe()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  const sessions = new DurableSessionService(o.persistAfterCrash ?? false)
  await sessions.createSession({ appName: APP, userId: USER, sessionId: SESSION })
  return {
    stripe,
    mailer: new FakeMailer(),
    ledger: new MemoryLedger(), // volatile on purpose
    sessions,
    jobs: new JobStore(),
    mode: o.mode,
    refundNeedsApproval: o.refundNeedsApproval ?? false,
    makeModel: o.makeModel,
  }
}

/** A new process: fresh model, agent, tools and Runner over the durable session service. */
export function bootRunner(w: World, plugins?: BasePlugin[]): Runner {
  const agent = createRefundAgent({ mode: w.mode, backends: w, model: w.makeModel(), refundNeedsApproval: w.refundNeedsApproval })
  return createRunner(agent, w.sessions, plugins)
}

/** The job got done exactly once: £50 refunded in one refund, one email. */
export const refundInvariants: Scenario<World>['invariants'] = [
  stripeInvariants.refundedExactly('ch_1', 5_000),
  stripeInvariants.refundCountAtMost('ch_1', 1),
  mailerInvariants.sentExactly('ada@example.com', 1),
]

export function refundScenario(o: ScenarioOptions): Scenario<World> {
  return {
    name: `google-adk LlmAgent refund${o.refundNeedsApproval ? ' + requireConfirmation' : ''} (${o.mode})`,
    setup: () => newWorld(o),
    run: (w) => processTicket(bootRunner(w), w.jobs, taskMessage(), o.process),
    // New process (after a crash or a redelivery): fresh agent, tools and Runner,
    // same session id on the durable session service, the in-flight job redelivered.
    resume: (w) => processTicket(bootRunner(w), w.jobs, w.jobs.inFlight(), o.process),
    invariants: refundInvariants,
  }
}
