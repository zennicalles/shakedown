/**
 * A customer-support refund agent built on VoltAgent's own agent loop
 * (`Agent` + `createTool` from @voltagent/core 2.x, which drives the Vercel AI
 * SDK 6 `generateText` underneath), wired for Shakedown (core v2).
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
 * simulated crash or job redelivery, as a real restart would.
 *
 * Recovery path. VoltAgent's Agent has no checkpoint/resume API of its own: its
 * durable state is conversation MEMORY (`memory: new Memory({ storage })`),
 * which by default (`conversationPersistence.mode: 'step'`) checkpoints after
 * every step and flushes immediately when a step has tool results. Continuing a
 * conversation means calling `generateText(input, { memory: { userId,
 * conversationId } })` again: VoltAgent loads the stored history and appends
 * the input. So resume = a new "process" (fresh Agent + tools, same storage)
 * that redelivers the request it was handling (the job message, or the
 * human's approval response) to the same conversation. That is exactly what a
 * queue redelivery or an HTTP client retry does.
 */
import { Agent, InMemoryStorageAdapter, Memory, createTool } from '@voltagent/core'
import { createPinoLogger } from '@voltagent/logger'
import type { LanguageModel, UIMessage } from 'ai'
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

export const USER_ID = 'support'
export const CONVERSATION_ID = 'ticket-T-1'

/**
 * VoltAgent's own InMemoryStorageAdapter, standing in for a real database
 * (Postgres/LibSQL adapter): it survives a simulated crash. A dead process
 * persists nothing, so every write attempted after the simulated crash is
 * dropped. That matters here: on an abort VoltAgent flushes the in-flight
 * step to memory (`flushPendingMessagesOnError`), which a SIGKILLed process
 * could never do.
 */
export class DurableStorage extends InMemoryStorageAdapter {
  override async addMessage(...a: Parameters<InMemoryStorageAdapter['addMessage']>) {
    if (processIsDead()) return
    return super.addMessage(...a)
  }
  override async addMessages(...a: Parameters<InMemoryStorageAdapter['addMessages']>) {
    if (processIsDead()) return
    return super.addMessages(...a)
  }
  override async saveConversationSteps(...a: Parameters<InMemoryStorageAdapter['saveConversationSteps']>) {
    if (processIsDead()) return
    return super.saveConversationSteps(...a)
  }
  override async deleteMessages(...a: Parameters<InMemoryStorageAdapter['deleteMessages']>) {
    if (processIsDead()) return
    return super.deleteMessages(...a)
  }
  override async clearMessages(...a: Parameters<InMemoryStorageAdapter['clearMessages']>) {
    if (processIsDead()) return
    return super.clearMessages(...a)
  }
}

/**
 * The request a worker is handling (the job message, or the human's approval
 * response), as a queue or an HTTP client would redeliver it. Durable; a dead
 * process cannot acknowledge (clear) it.
 */
export class RequestLog {
  private pending: string | UIMessage[] | undefined
  start(input: string | UIMessage[]): void {
    if (processIsDead()) return
    this.pending = structuredClone(input)
  }
  done(): void {
    if (processIsDead()) return
    this.pending = undefined
  }
  inflight(): string | UIMessage[] | undefined {
    return structuredClone(this.pending)
  }
}

/** The app's backends and stores. */
export interface Backends {
  stripe: FakeStripe
  mailer: FakeMailer
  /** Idempotency ledger. VOLATILE here (Shakedown wipes it); Redis/DB in production. */
  ledger: LedgerStore
  /** VoltAgent memory storage (the app's DB). */
  storage: DurableStorage
  requests: RequestLog
}

export type Mode = 'naive' | 'ledger-only' | 'fixed'

export interface RefundAgentOptions {
  mode: Mode
  backends: Backends
  model: LanguageModel
  /** VoltAgent `needsApproval: true` on the refund tool (human in the loop). */
  refundNeedsApproval?: boolean
  /** Agent-level `maxRetries` (VoltAgent default: 3). */
  maxRetries?: number
  /** Agent-level hooks (onToolError, onRetry, ...). */
  hooks?: ConstructorParameters<typeof Agent>[0]['hooks']
  /** Agent-level output middlewares. */
  outputMiddlewares?: ConstructorParameters<typeof Agent>[0]['outputMiddlewares']
  maxMiddlewareRetries?: number
  /** Tool-level hooks on `refund` (createTool({ hooks })). */
  refundToolHooks?: Parameters<typeof createTool>[0]['hooks']
  /** Work around VoltAgent dropping `approval.approved` from memory (see repairApprovals). Default false here; the scenario turns it on. */
  repairApprovals?: boolean
}

/**
 * Workaround for a VoltAgent 2.11.1 memory bug. After an approved tool runs,
 * the stored tool part is `state: 'output-available'` with
 * `approval: { id }` and no `approved: true`. The AI SDK's UIMessage schema
 * rejects that, so every later generateText on the conversation throws
 * AI_TypeValidationError (test: 'an approved tool call bricks the
 * conversation'). A part that has an output was approved, so put the flag back.
 */
export function repairApprovals<M extends UIMessage>(messages: M[]): M[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      const part = p as Record<string, unknown>
      const approval = part.approval as { id: string; approved?: boolean } | undefined
      const ran = part.state === 'output-available' || part.state === 'output-error'
      return ran && approval && approval.approved === undefined ? ({ ...part, approval: { ...approval, approved: true } } as typeof p) : p
    }),
  }))
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

const silent = createPinoLogger({ level: 'silent' })

export function createRefundAgent(o: RefundAgentOptions): Agent {
  const { mode, backends } = o
  const { stripe, mailer, ledger } = backends
  // Only the fixed variant forwards the logical key downstream.
  const requestOptions = () => {
    const key = mode === 'fixed' ? currentIdempotencyKey() : undefined
    return key ? { idempotencyKey: key } : {}
  }

  // shake() at the side-effect boundary. Each tool execute passes only the
  // tool input: VoltAgent calls execute(args, options) where options is the
  // whole OperationContext, which would pollute Shakedown's call log.
  const lookup = shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' })
  let refund = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, requestOptions()),
  )
  let sendEmail = shake('send_email', async (a: EmailArgs) => mailer.send({ to: a.to, subject: a.subject, body: a.body }, requestOptions()))
  if (mode !== 'naive') {
    // Logical identity, never model-written text (the subject gets reworded on retries).
    refund = idempotent(refund, { key: (a) => `refund:${a.ticket}`, store: ledger })
    sendEmail = idempotent(sendEmail, { key: (a) => `refund-email:${a.ticket}`, store: ledger })
  }

  return new Agent({
    name: 'refund-agent',
    instructions: INSTRUCTIONS,
    model: o.model,
    logger: silent,
    maxSteps: 12,
    memory: new Memory({ storage: backends.storage }),
    ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {}),
    ...(o.hooks || o.repairApprovals
      ? {
          hooks: {
            ...o.hooks,
            ...(o.repairApprovals ? { onPrepareMessages: ({ messages }: { messages: UIMessage[] }) => ({ messages: repairApprovals(messages) }) } : {}),
          },
        }
      : {}),
    ...(o.outputMiddlewares ? { outputMiddlewares: o.outputMiddlewares } : {}),
    ...(o.maxMiddlewareRetries !== undefined ? { maxMiddlewareRetries: o.maxMiddlewareRetries } : {}),
    tools: [
      createTool({
        name: 'lookup_charge',
        description: 'Look up a Stripe charge by id.',
        parameters: z.object({ charge: z.string() }),
        execute: (input) => lookup(input),
      }),
      createTool({
        name: 'refund',
        description: 'Refund part or all of a Stripe charge. amount is in minor units (pence).',
        parameters: z.object({ ticket: z.string(), charge: z.string(), amount: z.number().int().positive() }),
        needsApproval: o.refundNeedsApproval ?? false,
        ...(o.refundToolHooks ? { hooks: o.refundToolHooks } : {}),
        execute: (input) => refund(input),
      }),
      createTool({
        name: 'send_email',
        description: 'Send an email to the customer.',
        parameters: z.object({ ticket: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
        execute: (input) => sendEmail(input),
      }),
    ],
  })
}

/** Who answers approval requests. Default: approve everything (a human clicking Approve). */
export type Approver = (req: { toolName: string; input: unknown }) => boolean

export interface ProcessOptions {
  approve?: Approver
  conversationId?: string
  /** Repair the approval message built from memory (see repairApprovals). */
  repairApprovals?: boolean
}

/** crashSignal() only while it has not fired (in the resume phase it is the dead process's signal). */
function liveCrashSignal(): AbortSignal | undefined {
  const s = crashSignal()
  return s && !s.aborted ? s : undefined
}

/**
 * The human's answer, sent back the way VoltAgent's useChat integration does
 * it: the stored assistant message with the tool part moved from
 * `approval-requested` to `approval-responded`. VoltAgent keeps that part for
 * the model only when it is in the LAST message (filterIncompleteToolCallsForModel),
 * so the message is sent as the input.
 */
async function approvalResponse(
  storage: DurableStorage,
  conversationId: string,
  approve: Approver,
  repair: boolean,
): Promise<UIMessage[] | null> {
  const raw = (await storage.getMessages(USER_ID, conversationId)) as UIMessage[]
  const stored = repair ? repairApprovals(raw) : raw
  const last = stored.filter((m) => m.role === 'assistant').at(-1)
  if (!last) return null
  const msg = structuredClone(last) as UIMessage
  let answered = false
  for (const part of msg.parts as Array<Record<string, unknown>>) {
    if (part.state !== 'approval-requested') continue
    const approval = part.approval as { id: string }
    const toolName = String(part.type).replace(/^tool-/, '')
    part.state = 'approval-responded'
    part.approval = { id: approval.id, approved: approve({ toolName, input: part.input }) }
    answered = true
  }
  return answered ? [msg] : null
}

/**
 * One "process" handling a request for the ticket's conversation.
 *
 * Crash handling. VoltAgent catches every error a tool throws and hands it to
 * the model as the tool's OUTPUT, so a simulated crash would be fed to the
 * model and the loop would carry on. A real crash gives it no such chance. So
 * the process passes Shakedown's crashSignal() as `abortSignal`; VoltAgent
 * links it to the operation's AbortController, the AI SDK stops before the
 * next step, and generateText() rejects with VoltAgent's AbortError. Memory
 * writes after that point are dropped by DurableStorage.
 */
export async function processTicket(
  agent: Agent,
  w: Backends,
  input: string | UIMessage[],
  { approve = () => true, conversationId = CONVERSATION_ID, repairApprovals: repair = false }: ProcessOptions = {},
): Promise<string> {
  const crash = liveCrashSignal()
  for (let turn = 0; turn < 6; turn++) {
    w.requests.start(input)
    const result = await agent.generateText(input, {
      memory: { userId: USER_ID, conversationId },
      ...(crash ? { abortSignal: crash } : {}),
    })
    crash?.throwIfAborted()
    const pending = result.content.some((p) => p.type === 'tool-approval-request')
    if (!pending) {
      w.requests.done()
      return result.text
    }
    const response = await approvalResponse(w.storage, conversationId, approve, repair)
    if (!response) throw new Error('approval requested, but the request is not in memory')
    input = response
  }
  throw new Error('approval loop did not settle after 6 turns')
}

// ---------------------------------------------------------------------------
// Shakedown scenario

export interface World extends Backends {
  mode: Mode
  refundNeedsApproval: boolean
  repairApprovals: boolean
  makeModel: () => LanguageModel
}

export interface ScenarioOptions {
  mode: Mode
  refundNeedsApproval?: boolean
  /** Called once per agent process (initial run and every resume). */
  makeModel: () => LanguageModel
  process?: ProcessOptions
  /** Apply the repairApprovals workaround (default true; false reproduces the VoltAgent bug). */
  repairApprovals?: boolean
}

export function newWorld(o: ScenarioOptions): World {
  const stripe = new FakeStripe()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  return {
    stripe,
    mailer: new FakeMailer(),
    ledger: new MemoryLedger(), // volatile on purpose
    storage: new DurableStorage(),
    requests: new RequestLog(),
    mode: o.mode,
    refundNeedsApproval: o.refundNeedsApproval ?? false,
    repairApprovals: o.repairApprovals ?? true,
    makeModel: o.makeModel,
  }
}

export function bootAgent(w: World, extra: Partial<RefundAgentOptions> = {}): Agent {
  return createRefundAgent({
    mode: w.mode,
    backends: w,
    model: w.makeModel(),
    refundNeedsApproval: w.refundNeedsApproval,
    repairApprovals: w.repairApprovals,
    ...extra,
  })
}

/** The job got done exactly once: £50 refunded in one refund, one email. */
export const refundInvariants: Scenario<World>['invariants'] = [
  stripeInvariants.refundedExactly('ch_1', 5_000),
  stripeInvariants.refundCountAtMost('ch_1', 1),
  mailerInvariants.sentExactly('ada@example.com', 1),
]

export function refundScenario(o: ScenarioOptions): Scenario<World> {
  return {
    name: `voltagent Agent.generateText refund${o.refundNeedsApproval ? ' + needsApproval' : ''} (${o.mode})`,
    setup: () => newWorld(o),
    run: (w) => processTicket(bootAgent(w), w, TASK, { repairApprovals: w.repairApprovals, ...o.process }),
    // New process: fresh Agent and tools, same storage, the in-flight request
    // redelivered to the same conversation (a finished job: the job message again).
    resume: (w) => processTicket(bootAgent(w), w, w.requests.inflight() ?? TASK, { repairApprovals: w.repairApprovals, ...o.process }),
    invariants: refundInvariants,
  }
}
