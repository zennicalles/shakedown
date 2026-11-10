/**
 * A customer-support refund agent built on Inngest AgentKit (`@inngest/agent-kit`
 * 0.13): createAgent + createTool + createNetwork with a code router, wired for
 * Shakedown (core v2). It runs two ways ("runtime"):
 *
 *  - 'plain':   `network.run()` in-process, the way AgentKit runs outside an
 *    Inngest function. State is in memory; the only persistence AgentKit offers
 *    is a History adapter (`history: { get, appendResults }`), used here.
 *  - 'inngest': `network.run()` inside an Inngest function (the way AgentKit is
 *    meant to be deployed), driven by LocalInngest, an in-process stand-in for
 *    the Inngest server that runs the SDK's real execution engine (see
 *    local-inngest.ts). Inference becomes `step.ai.infer`; durability is the
 *    server's memoized step state.
 *
 * Wiring. shake() sits at the SIDE-EFFECT BOUNDARY, around the raw
 * stripe.refunds.create / mailer.send call. The fix, idempotent(), goes OUTSIDE
 * shake():
 *
 *   tool handler -> [step.run] -> idempotent(ledger) -> shake() -> stripe/mailer (with Idempotency-Key)
 *
 * - mode 'naive':    plain tool handlers (what the AgentKit quick start shows).
 * - mode 'step-run': the side effect wrapped in `step.run(...)` (Inngest's
 *   durability primitive; a no-op outside Inngest). No key.
 * - mode 'fixed':    step.run + idempotent() ledger + the logical key sent
 *   DOWNSTREAM (currentIdempotencyKey() as Stripe / mailer idempotencyKey).
 * - mode 'key-only': the fixed tools without step.run (ledger + downstream key).
 *
 * The ledger is a VOLATILE MemoryLedger: Shakedown wipes it on a simulated
 * crash or redelivery, as a real restart would.
 *
 * Crash. AgentKit has no abort signal: a tool handler's thrown error is caught
 * and handed to the model, and the loop goes on. The router (called after every
 * agent call) checks crashSignal() and throws, which is the closest thing to a
 * process dying between steps. Inside Inngest, LocalInngest also discards the
 * whole request once the process is dead.
 */
import { createAgent, createNetwork, createState, createTool, type AgentResult, type HistoryConfig, type Tool } from '@inngest/agent-kit'
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
import { LocalInngest, gatewayFetch, localInngestClient, type LocalRun } from './local-inngest.js'
import { callScriptedModel, installScriptedFetch, SCRIPTED_HOST } from './scripted-model.js'

export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'
export const SYSTEM = [
  'You are a customer-support refund agent.',
  'For a refund ticket: first call lookup_charge, then call refund exactly once with the ticket id, charge id and amount in minor units (pence), then call send_email to tell the customer.',
  'Use the subject "Your refund for <ticket>". When done, reply with a one-line summary and call no more tools.',
].join(' ')
export const EVENT = { name: 'support/refund.requested', data: { ticket: 'T-1', task: TASK } }
export const APPROVAL_EVENT = 'support/refund.approved'

type Model = Parameters<typeof createAgent>[0]['model'] & {}

/**
 * Stands in for the app's database behind AgentKit's History adapter. Survives
 * a simulated crash; a dead process persists nothing.
 */
export class ThreadStore {
  private threads = new Map<string, AgentResult[]>()
  readonly appends: number[] = []
  history(): HistoryConfig<Record<string, unknown>> {
    return {
      get: async ({ threadId }) => structuredClone(this.threads.get(threadId ?? '') ?? []),
      appendResults: async ({ threadId, newResults }) => {
        if (processIsDead()) return
        this.appends.push(newResults.length)
        const id = threadId ?? ''
        this.threads.set(id, [...(this.threads.get(id) ?? []), ...structuredClone(newResults)])
      },
    }
  }
  results(threadId = 'T-1'): AgentResult[] {
    return this.threads.get(threadId) ?? []
  }
}

export interface Backends {
  stripe: FakeStripe
  mailer: FakeMailer
  /** Idempotency ledger. VOLATILE here (Shakedown wipes it); Redis/DB in production. */
  ledger: LedgerStore
}

export type Mode = 'naive' | 'step-run' | 'fixed' | 'key-only'
export type Runtime = 'plain' | 'inngest'

export interface RefundAgentOptions {
  mode: Mode
  backends: Backends
  model: Model
  /** Inngest runtime only: the refund tool waits for a human approval event (`step.waitForEvent`) first. */
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

type StepTools = NonNullable<Tool.Options<Record<string, unknown>>['step']>

export function createRefundAgent({ mode, backends, model, refundNeedsApproval = false }: RefundAgentOptions) {
  const { stripe, mailer, ledger } = backends
  const keyed = mode === 'fixed' || mode === 'key-only'
  const requestOptions = () => {
    const key = keyed ? currentIdempotencyKey() : undefined
    return key ? { idempotencyKey: key } : {}
  }

  // shake() at the side-effect boundary; only the tool input is recorded.
  const lookup = shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' })
  let refund = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, requestOptions()),
  )
  let sendEmail = shake('send_email', async (a: EmailArgs) => mailer.send({ to: a.to, subject: a.subject, body: a.body }, requestOptions()))
  if (keyed) {
    // Logical identity, never model-written text.
    refund = idempotent(refund, { key: (a) => `refund:${a.ticket}`, store: ledger })
    sendEmail = idempotent(sendEmail, { key: (a) => `refund-email:${a.ticket}`, store: ledger })
  }

  /** step.run inside Inngest (modes step-run / fixed); a plain call otherwise. */
  const durably = async <T>(step: StepTools | undefined, id: string, fn: () => Promise<T>): Promise<unknown> =>
    step && (mode === 'step-run' || mode === 'fixed') ? await step.run(id, fn) : await fn()

  return createAgent({
    name: 'refund-agent',
    description: 'Handles refund tickets.',
    system: SYSTEM,
    model,
    tools: [
      createTool({
        name: 'lookup_charge',
        description: 'Look up a Stripe charge by id.',
        parameters: z.object({ charge: z.string() }),
        handler: (input) => lookup(input),
      }),
      createTool({
        name: 'refund',
        description: 'Refund part or all of a Stripe charge. amount is in minor units (pence).',
        parameters: z.object({ ticket: z.string(), charge: z.string(), amount: z.number().int().positive() }),
        handler: async (input, { step }) => {
          if (refundNeedsApproval && step) {
            // AgentKit's human-in-the-loop pattern: wait for an approval event.
            const approval = await step.waitForEvent('refund-approval', {
              event: APPROVAL_EVENT,
              timeout: '1h',
              if: `async.data.ticket == '${input.ticket}'`,
            })
            if (!approval) return { approved: false, message: 'Refund was not approved. Do not retry.' }
          }
          return durably(step, 'refund', () => refund(input))
        },
      }),
      createTool({
        name: 'send_email',
        description: 'Send an email to the customer.',
        parameters: z.object({ ticket: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
        handler: (input, { step }) => durably(step, 'send_email', () => sendEmail(input)),
      }),
    ],
  })
}

export function createRefundNetwork(o: RefundAgentOptions & { history?: HistoryConfig<Record<string, unknown>> }) {
  const agent = createRefundAgent(o)
  return createNetwork({
    name: 'refund-network',
    agents: [agent],
    defaultModel: o.model,
    maxIter: 12,
    ...(o.history ? { history: o.history } : {}),
    // Code router: keep calling the agent while it is calling tools.
    router: ({ lastResult }) => {
      // AgentKit has no abort signal; a dead process must not take another step.
      crashSignal()?.throwIfAborted()
      if (!lastResult) return agent
      return lastResult.toolCalls.length > 0 ? agent : undefined
    },
  })
}

/** The final assistant text of a network run. */
export function finalText(results: AgentResult[]): string {
  for (const r of [...results].reverse()) {
    for (const m of [...r.output].reverse()) if (m.type === 'text' && typeof m.content === 'string') return m.content
  }
  return ''
}

// ---------------------------------------------------------------------------
// The Inngest function (runtime 'inngest')

export function createRefundFunction(
  build: () => ReturnType<typeof createRefundNetwork>,
  { checkpointing = true, server }: { checkpointing?: boolean; server: () => LocalInngest | undefined },
) {
  const inngest = localInngestClient('shakedown-refunds', server)
  return inngest.createFunction(
    // retries: 3 is Inngest's default, spelled out. checkpointing: true is the
    // v4 default; false is classic replay mode.
    { id: 'refund-ticket', triggers: [{ event: EVENT.name }], retries: 3, checkpointing },
    async ({ event }) => {
      const run = await build().run(String(event.data.task))
      return { text: finalText(run.state.results) }
    },
  )
}

// ---------------------------------------------------------------------------
// Shakedown scenario

export interface World extends Backends {
  mode: Mode
  runtime: Runtime
  refundNeedsApproval: boolean
  makeModel: () => Model
  /** The model of the current "process". */
  model?: Model
  /** Durable thread store behind AgentKit's History adapter (plain runtime). */
  threads: ThreadStore
  /** The Inngest server stand-in (inngest runtime). Its run state is durable. */
  server: LocalInngest
  /** How many times the approval wait was answered (a human was asked). */
  approvalsAsked: number
}

export interface ScenarioOptions {
  mode: Mode
  runtime: Runtime
  refundNeedsApproval?: boolean
  /** Inngest runtime: the function's `checkpointing` option (v4 default true). */
  checkpointing?: boolean
  /** Called once per process (initial run and every resume). */
  makeModel: () => Model
}

/** The server's AI gateway: scripted models answer in-process, real ones get a real request. */
async function aiGateway(opts: { url: string; body: unknown; format?: string; auth_key?: string }): Promise<unknown> {
  if (new URL(opts.url).hostname === SCRIPTED_HOST) return callScriptedModel(opts.url, opts.body as never)
  return gatewayFetch(opts)
}

export function newWorld(o: ScenarioOptions): World {
  installScriptedFetch()
  const stripe = new FakeStripe()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  const w = {
    stripe,
    mailer: new FakeMailer(),
    ledger: new MemoryLedger(), // volatile on purpose
    mode: o.mode,
    runtime: o.runtime,
    refundNeedsApproval: o.refundNeedsApproval ?? false,
    makeModel: o.makeModel,
    threads: new ThreadStore(),
    approvalsAsked: 0,
  } as Omit<World, 'server'> as World
  const fn = createRefundFunction(
    () => createRefundNetwork({ mode: w.mode, backends: w, model: w.model!, refundNeedsApproval: w.refundNeedsApproval }),
    { checkpointing: o.checkpointing ?? true, server: () => w.server },
  )
  w.server = new LocalInngest({
    fn,
    ai: aiGateway,
    // A human approves the refund (once per wait the server is asked to resolve).
    onWaitForEvent: () => {
      w.approvalsAsked++
      return { name: APPROVAL_EVENT, data: { ticket: 'T-1', approved: true }, ts: 0 }
    },
  })
  return w
}

/** One "process" handling the ticket. */
export async function processTicket(w: World): Promise<string> {
  w.model = w.makeModel()
  if (w.runtime === 'inngest') {
    const run = await w.server.send(EVENT)
    return (run.output as { text?: string } | undefined)?.text ?? ''
  }
  const network = createRefundNetwork({ mode: w.mode, backends: w, model: w.model, history: w.threads.history() })
  const run = await network.run(TASK, { state: createState({}, { threadId: 'T-1' }) })
  return finalText(run.state.results)
}

/**
 * A new process picks the job up after a crash. Inngest: the server retries the
 * interrupted request (same run, memoized steps). Plain: AgentKit's only
 * recovery is the History adapter, so the ticket's thread is loaded and the
 * network runs again.
 */
export async function resumeTicket(w: World): Promise<string> {
  w.model = w.makeModel()
  if (w.runtime === 'inngest') {
    const last = w.server.runs.at(-1)
    const run: LocalRun = last && last.status === 'running' ? await w.server.resume(last) : await w.server.send(EVENT)
    return (run.output as { text?: string } | undefined)?.text ?? ''
  }
  return processTicket(w)
}

/** The job got done exactly once: £50 refunded in one refund, one email. */
export const refundInvariants: Scenario<World>['invariants'] = [
  stripeInvariants.refundedExactly('ch_1', 5_000),
  stripeInvariants.refundCountAtMost('ch_1', 1),
  mailerInvariants.sentExactly('ada@example.com', 1),
]

export function refundScenario(o: ScenarioOptions): Scenario<World> {
  return {
    name: `AgentKit network refund, ${o.runtime}${o.runtime === 'inngest' && o.checkpointing === false ? ' (checkpointing off)' : ''}${o.refundNeedsApproval ? ' + waitForEvent approval' : ''} (${o.mode})`,
    setup: () => newWorld(o),
    run: (w) => processTicket(w),
    // After a crash: resume the interrupted run. After a redelivery (the run
    // completed): the event arrives again, which Inngest treats as a new run.
    resume: (w) => resumeTicket(w),
    invariants: refundInvariants,
  }
}
