/**
 * A customer-support refund agent built on the Vercel AI SDK's own agent loop
 * (`ToolLoopAgent` from `ai` 7.x), wired for Shakedown (core v2).
 *
 * Wiring. shake() sits at the SIDE-EFFECT BOUNDARY, around the raw
 * stripe.refunds.create / mailer.send call, because that is where real
 * timeouts and crashes happen. The fix, idempotent(), goes OUTSIDE shake():
 *
 *   tool execute -> idempotent(ledger) -> shake() -> stripe/mailer (with Idempotency-Key)
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
 * Recovery path. ToolLoopAgent is in-memory ("if the process crashes, all
 * progress is lost", per the SDK's WorkflowAgent docs). The SDK's documented way
 * to continue a conversation is to persist `ModelMessage[]` and call
 * `agent.generate({ messages })` again; that is also how approve-and-continue
 * works. So the app below checkpoints the message history after every step into
 * a ConversationStore, and resume = a new "process" (fresh agent + tools) that
 * loads the checkpoint and calls `generate({ messages })`. The durable
 * alternative, `WorkflowAgent` from `@ai-sdk/workflow`, needs the Workflow
 * DevKit compiler/runtime and is not exercised here.
 */
import { ToolLoopAgent, isStepCount, tool, type LanguageModel, type ModelMessage, type ToolApprovalResponse } from 'ai'
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

export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'
export const INSTRUCTIONS = [
  'You are a customer-support refund agent.',
  'For a refund ticket: first call lookup_charge, then call refund exactly once with the ticket id, charge id and amount in minor units (pence), then call send_email to tell the customer.',
  'Use the subject "Your refund for <ticket>". When done, reply with a one-line summary.',
].join(' ')

/**
 * Stands in for the app's database: survives a simulated process crash. A dead
 * process persists nothing, so writes attempted after a simulated crash (in the
 * same doomed run) are dropped, as a real restart would lose them.
 */
export class ConversationStore {
  private saved: ModelMessage[] = []
  save(messages: ModelMessage[]): void {
    if (processIsDead()) return
    this.saved = structuredClone(messages)
  }
  load(): ModelMessage[] {
    return structuredClone(this.saved)
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
  /** Durable message history (the app's DB). */
  conversation: ConversationStore
}

export type Mode = 'naive' | 'ledger-only' | 'fixed'

export interface RefundAgentOptions {
  mode: Mode
  backends: Backends
  model: LanguageModel
  /** Require human approval (AI SDK `toolApproval: 'user-approval'`) before `refund` executes. */
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

export function createRefundAgent({ mode, backends, model, refundNeedsApproval = false }: RefundAgentOptions) {
  const { stripe, mailer, ledger } = backends
  // Only the fixed variant forwards the logical key downstream.
  const requestOptions = () => {
    const key = mode === 'fixed' ? currentIdempotencyKey() : undefined
    return key ? { idempotencyKey: key } : {}
  }

  // shake() at the side-effect boundary. Each tool execute passes only the tool
  // input: the AI SDK calls execute(input, options) and options holds an
  // AbortSignal + messages, which would pollute Shakedown's call log.
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

  return new ToolLoopAgent({
    model,
    instructions: INSTRUCTIONS,
    stopWhen: isStepCount(12),
    tools: {
      lookup_charge: tool({
        description: 'Look up a Stripe charge by id.',
        inputSchema: z.object({ charge: z.string() }),
        execute: (input) => lookup(input),
      }),
      refund: tool({
        description: 'Refund part or all of a Stripe charge. amount is in minor units (pence).',
        inputSchema: z.object({ ticket: z.string(), charge: z.string(), amount: z.number().int().positive() }),
        execute: (input) => refund(input),
      }),
      send_email: tool({
        description: 'Send an email to the customer.',
        inputSchema: z.object({ ticket: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
        execute: (input) => sendEmail(input),
      }),
    },
    ...(refundNeedsApproval ? { toolApproval: { refund: 'user-approval' as const } } : {}),
  })
}

export type RefundAgent = ReturnType<typeof createRefundAgent>

/** Who answers approval requests. Default: approve everything (a human clicking Approve). */
export type Approver = (req: { toolName: string; input: unknown }) => boolean

export interface ProcessOptions {
  /** Answers approval requests. Default: approve everything. */
  approve?: Approver
  /**
   * Also checkpoint in onStepStart, i.e. BEFORE each model call. Off by default
   * because the common pattern is to persist on step end. Turning it on closes
   * the approve-and-continue hole (see README): approved tool calls execute at
   * the start of generate(), outside any step, so onStepEnd alone never
   * persists their results before the first step of the continuation finishes.
   */
  checkpointBeforeEachStep?: boolean
}

/**
 * One "process" handling the ticket: run the agent, persist every step, and
 * service approval requests the way the SDK docs describe (push the response
 * messages, add a `tool-approval-response`, call generate again).
 *
 * Crash handling. The AI SDK catches every error thrown by a tool's execute and
 * turns it into a `tool-error` part, so a simulated crash would be fed to the
 * model as text and the loop would carry on. A real crash (OOM, SIGKILL,
 * deploy) gives the SDK no such chance. So the process passes Shakedown's
 * crashSignal() as the SDK's abortSignal (undefined outside a Shakedown run),
 * and the ConversationStore drops writes once processIsDead(). What was
 * persisted before the crash is exactly what a real restart would see.
 */
export async function processTicket(
  agent: RefundAgent,
  store: ConversationStore,
  messages: ModelMessage[],
  { approve = () => true, checkpointBeforeEachStep = false }: ProcessOptions = {},
): Promise<string> {
  // crashSignal() is per Shakedown run, not per process: in the resume phase it
  // is the previous (dead) process's signal and already aborted. A process that
  // starts with an aborted signal is the NEW process, so it must not inherit it.
  const signal = crashSignal()
  const crash = signal && !signal.aborted ? signal : undefined
  let stepInput: ModelMessage[] = messages
  store.save(messages)

  for (let turn = 0; turn < 6; turn++) {
    const result = await agent.generate({
      messages,
      ...(crash ? { abortSignal: crash } : {}),
      onStepStart: ({ messages: m }) => {
        stepInput = m
        if (checkpointBeforeEachStep) store.save(m)
      },
      onStepEnd: (step) => store.save([...stepInput, ...step.response.messages]),
    })
    // The SDK checks the abort signal only before steps 2..n. A crash in an
    // approved call (run before step 1) whose follow-up step pauses for
    // approval, or a crash in the final step, lets generate() return normally.
    crash?.throwIfAborted()

    messages = [...messages, ...result.responseMessages]
    const approvals: ToolApprovalResponse[] = []
    for (const part of result.content) {
      if (part.type === 'tool-approval-request' && !part.isAutomatic) {
        approvals.push({
          type: 'tool-approval-response',
          approvalId: part.approvalId,
          approved: approve({ toolName: part.toolCall.toolName, input: part.toolCall.input }),
        })
      }
    }
    if (approvals.length === 0) {
      store.save(messages)
      return result.text
    }
    // The approval decision is persisted before the agent continues, as an app
    // receiving it from useChat/an approval queue would.
    messages = [...messages, { role: 'tool', content: approvals }]
    store.save(messages)
  }
  throw new Error('approval loop did not settle after 6 turns')
}

// ---------------------------------------------------------------------------
// Shakedown scenario

export interface World extends Backends {
  mode: Mode
  refundNeedsApproval: boolean
  makeModel: () => LanguageModel
}

export interface ScenarioOptions {
  mode: Mode
  refundNeedsApproval?: boolean
  /** Called once per agent process (initial run and every resume). */
  makeModel: () => LanguageModel
  process?: ProcessOptions
}

export function newWorld(o: ScenarioOptions): World {
  const stripe = new FakeStripe()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  return {
    stripe,
    mailer: new FakeMailer(),
    ledger: new MemoryLedger(), // volatile on purpose
    conversation: new ConversationStore(),
    mode: o.mode,
    refundNeedsApproval: o.refundNeedsApproval ?? false,
    makeModel: o.makeModel,
  }
}

export function bootAgent(w: World): RefundAgent {
  return createRefundAgent({ mode: w.mode, backends: w, model: w.makeModel(), refundNeedsApproval: w.refundNeedsApproval })
}

/** The job got done exactly once: £50 refunded in one refund, one email. */
export const refundInvariants: Scenario<World>['invariants'] = [
  stripeInvariants.refundedExactly('ch_1', 5_000),
  stripeInvariants.refundCountAtMost('ch_1', 1),
  mailerInvariants.sentExactly('ada@example.com', 1),
]

/**
 * What a worker sends when it picks the job up again. Mid-run (last message is a
 * tool result or the task) the conversation continues as stored. If the stored
 * conversation already finished (last message is the assistant's), the job
 * message itself is delivered again as a new user turn: a real API rejects a
 * conversation that ends with an assistant message, so replaying it verbatim
 * would make redelivery "pass" by crashing.
 */
export function resumeMessages(stored: ModelMessage[]): ModelMessage[] {
  if (stored.length === 0) return [{ role: 'user', content: TASK }]
  return stored.at(-1)!.role === 'assistant' ? [...stored, { role: 'user', content: TASK }] : stored
}

export function refundScenario(o: ScenarioOptions): Scenario<World> {
  return {
    name: `ai-sdk ToolLoopAgent refund${o.refundNeedsApproval ? ' + toolApproval' : ''} (${o.mode})`,
    setup: () => newWorld(o),
    run: (w) => processTicket(bootAgent(w), w.conversation, [{ role: 'user', content: TASK }], o.process),
    // New process (after a crash or a redelivery): fresh agent and tools,
    // conversation loaded from the store, generate({ messages }) again.
    resume: (w) => processTicket(bootAgent(w), w.conversation, resumeMessages(w.conversation.load()), o.process),
    invariants: refundInvariants,
  }
}
