/**
 * A customer-support refund agent built on LangGraph's prebuilt agent loop
 * (`createAgent` from `langchain`, which compiles to a LangGraph StateGraph with
 * a model node and a ToolNode) plus a checkpointer.
 *
 * Wiring (Shakedown core v2):
 *  - shake() wraps the RAW side-effect call (stripe.refunds.create, mailer.send).
 *    That is the boundary where real timeouts and crashes happen.
 *  - fixed=true puts idempotent() OUTSIDE shake(), keyed on the logical operation
 *    (refund:<ticket>, refund-email:<ticket>), and the shaken body sends that
 *    same key DOWNSTREAM as { idempotencyKey } via currentIdempotencyKey(). The
 *    ledger is a default (volatile) MemoryLedger: a simulated crash or a job
 *    redelivery wipes it, so the downstream key is what actually prevents the
 *    duplicate in those cases.
 *  - The checkpointer is LangGraph's MemorySaver standing in for a durable saver
 *    (Postgres/SQLite). It drops every write attempted after the simulated
 *    process death (processIsDead()), because a dead process cannot persist.
 */
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base'
import type { AIMessageChunk } from '@langchain/core/messages'
import type { Runnable } from '@langchain/core/runnables'
import type { ChatResult } from '@langchain/core/outputs'
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, type RetryPolicy } from '@langchain/langgraph'
import {
  AIMessage,
  HumanMessage,
  ToolInvocationError,
  ToolMessage,
  createAgent,
  tool,
  toolErrorMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod'
import {
  FakeMailer,
  FakeStripe,
  MemoryLedger,
  crashSignal,
  currentIdempotencyKey,
  idempotent,
  isSimulatedCrash,
  mailerInvariants,
  processIsDead,
  shake,
  stripeInvariants,
  type Invariant,
  type Scenario,
} from '../../src/index.js'

export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'
export const CUSTOMER = 'ada@example.com'

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

/** What the model was shown after each tool call: exactly what LangGraph fed back. */
export interface ToolResultSeen {
  tool: string
  status: string | undefined
  content: string
}

/**
 * How a SimulatedCrash is turned into a process death inside the agent.
 *
 *  - 'crash-signal' (default): Shakedown's crashSignal() is passed as the
 *    invoke `signal`. The ToolNode re-throws a tool error when the run's signal
 *    is aborted, so `agent.invoke()` rejects with the crash itself. No custom
 *    error handling is needed.
 *  - 'middleware': LangGraph's documented `toolErrorMiddleware` lets the crash
 *    propagate (onError returns undefined for isSimulatedCrash(error)) and
 *    converts every other error exactly the way the ToolNode's default handler
 *    does. Equivalent verdicts; kept to show the alternative.
 *  - 'framework-default': neither. createAgent's ToolNode catches EVERY thrown
 *    tool error, the crash included, and feeds it to the model as an error
 *    ToolMessage. Used to document that behaviour.
 */
export type CrashMode = 'crash-signal' | 'middleware' | 'framework-default'

/**
 * crashSignal() for a new invoke. After a crash the signal stays aborted, also
 * in the resume phase, so a resumed process gets no signal instead of one that
 * would abort it immediately.
 */
export function liveCrashSignal(): AbortSignal | undefined {
  const s = crashSignal()
  return s && !s.aborted ? s : undefined
}

/**
 * Which thread a job delivery runs on.
 *  - 'per-ticket' (default): thread_id = ticket id, so a restarted worker finds
 *    the checkpoint and resumes it (LangGraph's recovery path).
 *  - 'per-delivery': a new thread per delivery (common in request/response
 *    servers). The checkpointer never helps recovery; every delivery starts over.
 */
export type ThreadMode = 'per-ticket' | 'per-delivery'

export interface RefundAgentOptions {
  fixed: boolean
  /** Model factory; called once per "process" (initial run and each resume). Default: the scripted mock. */
  model?: (seen: ToolResultSeen[]) => BaseChatModel
  crashMode?: CrashMode
  thread?: ThreadMode
}

export interface Delivery {
  threadId: string
  /** True when the thread had pending tasks and was resumed with invoke(null). */
  resumed: boolean
  /** Last message of the thread when invoke() returned (absent if it rejected). */
  finalMessage?: string
  /** ToolMessages in the whole thread when invoke() returned. */
  toolCalls?: number
}

export interface RefundWorld {
  fixed: boolean
  stripe: FakeStripe
  mailer: FakeMailer
  /** Durable: the checkpointer a restarted worker reconnects to. */
  checkpointer: DurableMemorySaver
  /** VOLATILE idempotency ledger: wiped by a simulated crash or redelivery. */
  ledger: MemoryLedger
  chargeId: string
  /** Tool results as delivered to the model, across every delivery. */
  seen: ToolResultSeen[]
  /** Number of agent "processes" started (1 = no resume happened). */
  processes: number
  /** One entry per job delivery (fresh worker process), in order. */
  deliveries: Delivery[]
  lastResult?: { messages: BaseMessage[] }
  /** One job delivery handled by a fresh worker process (see deliver()). */
  run(): Promise<{ messages: BaseMessage[] }>
  /** A fresh worker picks the job up again after a crash or redelivery. Same code path as run(). */
  resume(): Promise<{ messages: BaseMessage[] }>
  /** Build a new agent instance (what a restarted worker would do). */
  buildAgent(): ReturnType<typeof buildAgent>
}

/**
 * MemorySaver standing in for a durable checkpointer. Writes attempted after the
 * simulated process death are dropped: a real dead process never reaches the DB,
 * even if a framework caught the crash and kept stepping.
 */
export class DurableMemorySaver extends MemorySaver {
  droppedWrites = 0
  override async put(...args: Parameters<MemorySaver['put']>): ReturnType<MemorySaver['put']> {
    const [config, checkpoint] = args
    if (processIsDead()) {
      this.droppedWrites++
      return {
        configurable: {
          thread_id: config.configurable?.thread_id,
          checkpoint_ns: config.configurable?.checkpoint_ns ?? '',
          checkpoint_id: checkpoint.id,
        },
      }
    }
    return super.put(...args)
  }
  override async putWrites(...args: Parameters<MemorySaver['putWrites']>): ReturnType<MemorySaver['putWrites']> {
    if (processIsDead()) {
      this.droppedWrites++
      return
    }
    return super.putWrites(...args)
  }
}

/** Mirrors the ToolNode's defaultHandleToolErrors so the model sees identical text. */
function defaultErrorContent(error: unknown): string {
  if (ToolInvocationError.isInstance(error)) return (error as Error).message
  return `${error}\n Please fix your mistakes.`
}

export const crashIsProcessDeath = toolErrorMiddleware({
  onError: (error) => (isSimulatedCrash(error) ? undefined : defaultErrorContent(error)),
})

/** The key of the enclosing idempotent() call, as Stripe/mailer request options. Empty for naive tools. */
function downstreamKey(): { idempotencyKey?: string } {
  const key = currentIdempotencyKey()
  return key ? { idempotencyKey: key } : {}
}

/**
 * Side-effect boundary + (fixed only) the idempotent() layer outside it.
 * Shared by the createAgent tools and the HITL graph.
 */
function makeEffects(world: { fixed: boolean; stripe: FakeStripe; mailer: FakeMailer; ledger: MemoryLedger }) {
  const { stripe, mailer, ledger } = world
  const rawRefund = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, downstreamKey()),
  )
  const rawEmail = shake('send_email', async (a: EmailArgs) =>
    mailer.send({ to: a.to, subject: a.subject, body: a.body }, downstreamKey()),
  )
  if (!world.fixed) return { refund: rawRefund, email: rawEmail }
  return {
    refund: idempotent(rawRefund, { key: (a) => `refund:${a.ticket}`, store: ledger }),
    email: idempotent(rawEmail, { key: (a) => `refund-email:${a.ticket}`, store: ledger }),
  }
}

function makeTools(world: RefundWorld) {
  const { refund, email } = makeEffects(world)
  const lookup = shake('lookup_charge', async (a: { charge: string }) => world.stripe.charges.retrieve(a.charge), {
    effect: 'read',
  })

  // Pass only the parsed input to the wrapped function (tool() also passes a config arg).
  return [
    tool((input) => lookup(input), {
      name: 'lookup_charge',
      description: 'Look up a Stripe charge by id.',
      schema: z.object({ charge: z.string().describe('Charge id, e.g. ch_1') }),
    }),
    tool((input) => refund(input), {
      name: 'refund',
      description: 'Refund part or all of a charge. Amount is in minor units (pence).',
      schema: z.object({
        ticket: z.string().describe('Support ticket id'),
        charge: z.string(),
        amount: z.number().int().positive(),
      }),
    }),
    tool((input) => email(input), {
      name: 'send_email',
      description: 'Send an email to the customer.',
      schema: z.object({ ticket: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
    }),
  ]
}

function buildAgent(world: RefundWorld, opts: RefundAgentOptions) {
  const model = (opts.model ?? ((seen) => new ScriptedRefundModel(seen)))(world.seen)
  return createAgent({
    model,
    tools: makeTools(world),
    systemPrompt:
      'You are a customer-support agent. Use the tools to look up the charge, refund it, and email the customer. ' +
      'Amounts are in minor units (pence): £50 is 5000. Always pass the ticket id.',
    checkpointer: world.checkpointer,
    middleware: opts.crashMode === 'middleware' ? [crashIsProcessDeath] : [],
  })
}

export function createRefundAgent(opts: RefundAgentOptions): RefundWorld {
  const stripe = new FakeStripe()
  const charge = stripe.charges.create({ amount: 10_000, customer: 'cus_ada' })
  const threadMode = opts.thread ?? 'per-ticket'

  /**
   * One job delivery, handled by a FRESH worker process: a new agent (new graph,
   * new tool instances, new model) wired to the same durable checkpointer.
   * If the thread has pending tasks (the previous process died mid-step),
   * invoke(null) resumes it from the last checkpoint: LangGraph's recovery path.
   * Otherwise the job message is processed: a new thread, or a new turn on a
   * finished one when the same job is delivered again.
   */
  async function deliver(): Promise<{ messages: BaseMessage[] }> {
    world.processes++
    const threadId = threadMode === 'per-ticket' ? 'ticket-T-1' : `ticket-T-1-delivery-${world.processes}`
    const agent = world.buildAgent()
    const signal = (opts.crashMode ?? 'crash-signal') === 'crash-signal' ? liveCrashSignal() : undefined
    const config = { configurable: { thread_id: threadId }, recursionLimit: 40, ...(signal ? { signal } : {}) }
    const pending = (await agent.graph.getState(config)).next.length > 0
    const delivery: Delivery = { threadId, resumed: pending }
    world.deliveries.push(delivery)
    const out = await agent.invoke(pending ? null : { messages: [new HumanMessage(TASK)] }, config)
    delivery.finalMessage = String(out.messages.at(-1)?.content ?? '')
    delivery.toolCalls = out.messages.filter((m) => ToolMessage.isInstance(m)).length
    world.lastResult = out
    return out
  }

  const world: RefundWorld = {
    fixed: opts.fixed,
    stripe,
    mailer: new FakeMailer(),
    checkpointer: new DurableMemorySaver(),
    ledger: new MemoryLedger(),
    chargeId: charge.id,
    seen: [],
    processes: 0,
    deliveries: [],
    buildAgent: () => buildAgent(world, opts),
    run: deliver,
    resume: deliver,
  }
  return world
}

// ---------------------------------------------------------------------------
// Scripted mock model
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS = 3

interface PlannedCall {
  name: string
  args: Record<string, unknown>
}

const PLAN: PlannedCall[] = [
  { name: 'lookup_charge', args: { charge: 'ch_1' } },
  { name: 'refund', args: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    name: 'send_email',
    args: {
      ticket: 'T-1',
      to: CUSTOMER,
      subject: 'Your refund for T-1',
      body: 'Hi Ada, we have refunded £50 to your card. It should arrive in 5-10 working days.',
    },
  },
]

function text(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

/**
 * Decide the next AI message purely from the conversation history, the way an
 * LLM does. It is stateless, so it behaves correctly when a restarted process
 * replays the checkpointed thread.
 *
 * Reactive rule: if the latest tool result for the current step is an error
 * (ToolMessage.status === 'error', which is what LangGraph sets when it turns a
 * thrown error into a tool result), re-issue the same call, up to MAX_ATTEMPTS
 * attempts; then give up and tell the user. Once every planned step has a
 * successful result in the history it answers "Done" and calls nothing.
 */
export function decideNext(messages: BaseMessage[], seen?: ToolResultSeen[]): AIMessage {
  const toolMsgs = messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m))
  const last = messages.at(-1)
  if (seen && last && ToolMessage.isInstance(last)) {
    seen.push({ tool: last.name ?? '?', status: last.status, content: text(last) })
  }

  let step = 0
  let attempts = 0
  for (const m of toolMsgs) {
    attempts++
    if (m.status !== 'error') {
      step++
      attempts = 0
    } else if (attempts >= MAX_ATTEMPTS) {
      return new AIMessage(
        `I could not complete ${PLAN[step]!.name} after ${MAX_ATTEMPTS} attempts (last error: ${text(m)}). Escalating to a human.`,
      )
    }
  }
  if (step >= PLAN.length) {
    return new AIMessage('Done: refunded £50 of ch_1 for ticket T-1 and emailed ada@example.com.')
  }
  const next = PLAN[step]!
  return new AIMessage({
    content: '',
    tool_calls: [{ id: `call_${toolMsgs.length + 1}`, name: next.name, args: next.args, type: 'tool_call' }],
  })
}

/** Minimal tool-calling chat model: bindTools is a no-op, _generate runs decideNext(). */
export class ScriptedRefundModel extends BaseChatModel {
  constructor(private readonly seen?: ToolResultSeen[]) {
    super({})
  }
  _llmType(): string {
    return 'shakedown-scripted-refund-model'
  }
  override bindTools(): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = decideNext(messages, this.seen)
    return { generations: [{ text: text(message), message }] }
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export function refundInvariants(): Array<Invariant<RefundWorld> | { name: string; check: Invariant<RefundWorld> }> {
  return [
    stripeInvariants.refundedExactly('ch_1', 5_000),
    stripeInvariants.refundCountAtMost('ch_1', 1),
    // Exactly one: catches duplicates AND a job that silently stopped before emailing.
    mailerInvariants.sentExactly(CUSTOMER, 1),
  ]
}

export function refundScenario(opts: RefundAgentOptions): Scenario<RefundWorld> {
  const extras = [
    opts.crashMode && opts.crashMode !== 'crash-signal' ? `crash mode ${opts.crashMode}` : '',
    opts.thread === 'per-delivery' ? 'thread per delivery' : '',
  ].filter(Boolean)
  return {
    name: `langgraph createAgent refund agent (${opts.fixed ? 'ledger + downstream key' : 'naive tools'}${
      extras.length ? `, ${extras.join(', ')}` : ''
    })`,
    setup: () => createRefundAgent(opts),
    run: (w) => w.run(),
    resume: (w) => w.resume(),
    invariants: refundInvariants(),
  }
}

// ---------------------------------------------------------------------------
// Human-in-the-loop: commit a refund, then interrupt() for approval
// ---------------------------------------------------------------------------

export interface HitlWorld {
  fixed: boolean
  stripe: FakeStripe
  mailer: FakeMailer
  checkpointer: DurableMemorySaver
  /** VOLATILE ledger (fixed variant). */
  ledger: MemoryLedger
  /** How many times the approval node body started executing. */
  nodeExecutions: number
  /** Every approval request shown to the human, in order. */
  approvalsShown: unknown[]
  final?: { refundId?: string; decision?: string; emailId?: string }
}

const HitlState = Annotation.Root({
  ticket: Annotation<string>,
  refundId: Annotation<string | undefined>,
  decision: Annotation<string | undefined>,
  emailId: Annotation<string | undefined>,
})

/**
 * LangGraph's own node retry, as a production graph would configure it (default
 * retryOn). Without it a raw StateGraph fails the whole invoke on the first tool
 * error. The crash does not get retried because driveHitl() passes crashSignal():
 * LangGraph's retry loop stops once the run's signal is aborted.
 */
export const HITL_RETRY: RetryPolicy = { maxAttempts: 3, initialInterval: 1, jitter: false, logWarning: false }

export function createHitlGraph(world: HitlWorld) {
  const { refund, email } = makeEffects(world)

  return new StateGraph(HitlState)
    .addNode(
      'refund_then_approve',
      async (s) => {
        world.nodeExecutions++
        // Side effect BEFORE the interrupt. On resume LangGraph re-runs this node
        // from the top, so this line executes again.
        const r = await refund({ ticket: s.ticket, charge: 'ch_1', amount: 5000 })
        const decision = interrupt<{ question: string; refundId: string }, string>({
          question: `Refund ${r.id} (£50) issued for ${s.ticket}. Email the customer?`,
          refundId: r.id,
        })
        return { refundId: r.id, decision }
      },
      { retryPolicy: HITL_RETRY },
    )
    .addNode(
      'notify',
      async (s) => {
        if (s.decision !== 'approve') return {}
        const m = await email({
          ticket: s.ticket,
          to: CUSTOMER,
          subject: 'Your refund for T-1',
          body: 'Hi Ada, we have refunded £50 to your card.',
        })
        return { emailId: m.id }
      },
      { retryPolicy: HITL_RETRY },
    )
    .addEdge(START, 'refund_then_approve')
    .addEdge('refund_then_approve', 'notify')
    .addEdge('notify', END)
    .compile({ checkpointer: world.checkpointer })
}

/**
 * One delivery of the HITL job to a fresh worker: start the thread (or start it
 * again if it already finished), then drive it to the end, answering each
 * pending interrupt() with the human's approval and resuming any task a dead
 * process left pending with invoke(null).
 */
export async function driveHitl(w: HitlWorld): Promise<void> {
  const thread = { configurable: { thread_id: 'hitl-T-1' } }
  /** Each invoke gets the live crash signal, so a crash stops the graph (and its retries) at once. */
  const config = () => {
    const signal = liveCrashSignal()
    return signal ? { ...thread, signal } : thread
  }
  const graph = createHitlGraph(w)
  if ((await graph.getState(thread)).next.length === 0) await graph.invoke({ ticket: 'T-1' }, config())
  for (let guard = 0; guard < 10; guard++) {
    const state = await graph.getState(thread)
    if (state.next.length === 0) {
      const v = state.values as { refundId?: string; decision?: string; emailId?: string }
      w.final = { refundId: v.refundId, decision: v.decision, emailId: v.emailId }
      return
    }
    const pendingInterrupt = state.tasks.flatMap((t) => t.interrupts)[0]
    if (pendingInterrupt) {
      w.approvalsShown.push(pendingInterrupt.value)
      // The human approves; a NEW graph instance resumes the thread with Command({ resume }).
      await createHitlGraph(w).invoke(new Command({ resume: 'approve' }), config())
    } else {
      await createHitlGraph(w).invoke(null, config())
    }
  }
  throw new Error('HITL thread did not finish after 10 steps')
}

export function hitlScenario(fixed: boolean): Scenario<HitlWorld> {
  return {
    name: `langgraph interrupt() approval after a committed refund (${fixed ? 'ledger + downstream key' : 'naive tools'})`,
    setup: () => {
      const stripe = new FakeStripe()
      stripe.charges.create({ amount: 10_000, customer: 'cus_ada' })
      return {
        fixed,
        stripe,
        mailer: new FakeMailer(),
        checkpointer: new DurableMemorySaver(),
        ledger: new MemoryLedger(),
        nodeExecutions: 0,
        approvalsShown: [],
      }
    },
    run: driveHitl,
    resume: driveHitl,
    invariants: [
      stripeInvariants.refundedExactly('ch_1', 5_000),
      stripeInvariants.refundCountAtMost('ch_1', 1),
      mailerInvariants.sentExactly(CUSTOMER, 1),
    ],
  }
}
