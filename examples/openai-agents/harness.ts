/**
 * Shakedown scenarios for the OpenAI Agents SDK refund agent.
 *
 * Two jobs, both driven by the SDK's real run loop:
 *
 *  1. refundScenario: run(agent, task, { session }) to completion. The Session is
 *     the durable state (think: a DB-backed Session keyed by ticket). After a
 *     crash or a redelivery a fresh worker runs the job again against the same
 *     Session; that is the only recovery the SDK offers for a run that was not
 *     interrupted.
 *
 *  2. approvalScenario: refund has needsApproval: true. The job persists
 *     result.state.toString() at the interruption, a human approves
 *     (RunState.fromString + state.approve), the decision is persisted, and the
 *     run continues with run(agent, state). After a crash or a redelivery a
 *     fresh worker reloads the LAST PERSISTED RunState and continues from it:
 *     the SDK's documented durable resume path.
 *
 * Simulating "the process died" needs two pieces of plumbing, neither of which
 * touches the agent's code:
 *  - the SDK turns every thrown tool error into a tool result and keeps going,
 *    so the run gets Shakedown's crashSignal() as its AbortSignal (the SDK's own
 *    cancellation mechanism);
 *  - durable stores (Session, RunState row) drop writes made while
 *    processIsDead(), because a dead process persists nothing.
 *
 * Volatile state (the default MemoryLedger, idempotent() in-flight maps) is
 * wiped by Shakedown before the resume; the resume also builds a fresh Agent and
 * tool instances, as a new process would.
 */
import { MemorySession, run, RunState, UserError, type Agent, type AgentInputItem, type Model, type RunResult, type Session } from '@openai/agents'
import {
  crashSignal,
  FakeMailer,
  FakeStripe,
  mailerInvariants,
  processIsDead,
  stripeInvariants,
  type Scenario,
} from '../../src/index.js'
import { ReactiveRefundModel, TASK } from './mock-model.js'
import { createRefundAgent } from './refund-agent.js'

export const MAX_TURNS = 20

/**
 * In-memory stand-in for a durable Session (SQLite/Redis/your DB). Writes made
 * after a simulated crash are dropped: the process that would have made them is gone.
 */
export class DurableSession implements Session {
  private readonly inner = new MemorySession({ sessionId: 'ticket-T-1' })
  droppedWrites = 0
  writes = 0
  getSessionId() {
    return this.inner.getSessionId()
  }
  getItems(limit?: number) {
    return this.inner.getItems(limit)
  }
  async addItems(items: AgentInputItem[]) {
    if (processIsDead()) {
      this.droppedWrites += items.length
      return
    }
    this.writes += items.length
    await this.inner.addItems(items)
  }
  popItem() {
    return this.inner.popItem()
  }
  clearSession() {
    return this.inner.clearSession()
  }
}

/** A single durable row holding a serialized RunState. Same crash semantics. */
export class StateStore {
  private value: string | undefined
  saves = 0
  droppedSaves = 0
  save(s: string) {
    if (processIsDead()) {
      this.droppedSaves++
      return
    }
    this.value = s
    this.saves++
  }
  load(): string | undefined {
    return this.value
  }
}

/**
 * The run's AbortSignal. Inside a Shakedown run this is crashSignal(), so a
 * simulated crash stops the SDK instead of being swallowed into a tool result.
 * The resume phase shares the run's context, whose crash signal is already
 * aborted after a crash; a new process starts with a live signal, so none is passed.
 */
export function jobSignal(): AbortSignal | undefined {
  const s = crashSignal()
  return s && !s.aborted ? s : undefined
}

export interface World {
  stripe: FakeStripe
  mailer: FakeMailer
  agent: Agent<any, any>
  model: Model | string
  session: DurableSession
  stateStore: StateStore
  /** Arguments of every refund call a human approved. */
  approvals: string[]
  /** How many workers ran the job (1 + resumes/redeliveries). */
  workers: number
  finalOutput?: string
  /** A new process: fresh Agent and tools (fresh volatile ledger), same durable backends and model. */
  newWorker: () => void
}

export interface WorldOptions {
  fixed: boolean
  approveRefunds?: boolean
  makeModel?: () => Model | string
  errorPassthrough?: boolean
}

export function makeWorld(o: WorldOptions): World {
  const stripe = new FakeStripe()
  const mailer = new FakeMailer()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  const model = (o.makeModel ?? (() => new ReactiveRefundModel()))()
  // No ledger passed: each agent gets its own VOLATILE MemoryLedger, wiped by a crash or redelivery.
  const build = () => createRefundAgent({ fixed: o.fixed, stripe, mailer, model, approveRefunds: o.approveRefunds, errorPassthrough: o.errorPassthrough })
  const w: World = {
    stripe,
    mailer,
    agent: build(),
    model,
    session: new DurableSession(),
    stateStore: new StateStore(),
    approvals: [],
    workers: 1,
    newWorker: () => {
      w.agent = build()
      w.workers++
    },
  }
  return w
}

const invariants = [
  stripeInvariants.refundedExactly('ch_1', 5_000),
  stripeInvariants.refundCountAtMost('ch_1', 1),
  // Exactly one: catches duplicate emails AND a job that silently stopped before emailing.
  mailerInvariants.sentExactly('ada@example.com', 1),
]

async function runToCompletion(w: World): Promise<void> {
  const r = await run(w.agent, TASK, { session: w.session, signal: jobSignal(), maxTurns: MAX_TURNS })
  w.finalOutput = String(r.finalOutput ?? '')
}

/** Scenario 1: run to completion with a durable Session; recovery = a fresh worker reruns the job on the same Session. */
export function refundScenario(o: WorldOptions & { onWorld?: (w: World) => void }): Scenario<World> {
  return {
    name: `openai-agents refund job, session retry (${o.fixed ? 'ledger + downstream key' : 'naive tools'})`,
    setup: () => {
      const w = makeWorld(o)
      o.onWorld?.(w)
      return w
    },
    run: runToCompletion,
    resume: async (w) => {
      w.newWorker()
      await runToCompletion(w)
    },
    invariants,
  }
}

/**
 * Drive a run through human-approval interruptions, persisting RunState at each
 * durable point, exactly as the SDK's human-in-the-loop docs describe.
 */
async function driveWithApprovals(w: World, input: string | RunState<any, Agent<any, any>>): Promise<void> {
  const signal = jobSignal()
  let result: RunResult<any, Agent<any, any>> = await run(w.agent, input, { signal, maxTurns: MAX_TURNS })
  while (result.interruptions.length > 0) {
    // 1. Persist the pending approval; the process may exit while a human decides.
    w.stateStore.save(result.state.toString())
    // 2. Later (any process): the human reviews and approves.
    const state = await RunState.fromString(w.agent, w.stateStore.load()!)
    for (const item of state.getInterruptions()) {
      w.approvals.push(item.arguments ?? '')
      state.approve(item)
    }
    // 3. Persist the decision, then continue the same run.
    w.stateStore.save(state.toString())
    result = await run(w.agent, state, { signal, maxTurns: MAX_TURNS })
  }
  w.stateStore.save(result.state.toString())
  w.finalOutput = String(result.finalOutput ?? '')
}

/** Scenario 2: refund needs human approval; recovery = a fresh worker reloads the last persisted RunState and continues. */
/** What @openai/agents throws when asked to resume a finished RunState. */
export const TERMINAL_STATE_ERROR = /Accepted final output cannot be resumed directly from serialized terminal state/

/**
 * redelivery:
 *  - 'follow-sdk-hint' (default): a worker that gets the SDK's "cannot be resumed ... Start a new
 *    run" error does what it says and starts a new run from the task (this job has no Session).
 *    That is what makes job-redelivery a real test of the tools.
 *  - 'raw': the worker gives up on that error. The redelivery then makes no writes and errors,
 *    which Shakedown reports as UNTESTED (it proves nothing about the tools).
 */
export function approvalScenario(
  o: WorldOptions & { onWorld?: (w: World) => void; redelivery?: 'follow-sdk-hint' | 'raw' },
): Scenario<World> {
  return {
    name: `openai-agents refund job, needsApproval + RunState resume (${o.fixed ? 'ledger + downstream key' : 'naive tools'})`,
    setup: () => {
      const w = makeWorld({ ...o, approveRefunds: true })
      o.onWorld?.(w)
      return w
    },
    run: (w) => driveWithApprovals(w, TASK),
    resume: async (w) => {
      w.newWorker()
      const saved = w.stateStore.load()
      // Nothing persisted yet means the crash came before the first interruption: start over.
      try {
        await driveWithApprovals(w, saved ? await RunState.fromString(w.agent, saved) : TASK)
      } catch (e) {
        const terminal = e instanceof UserError && TERMINAL_STATE_ERROR.test(e.message)
        if (!terminal || o.redelivery === 'raw') throw e
        await driveWithApprovals(w, TASK)
      }
    },
    invariants,
  }
}
