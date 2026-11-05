/**
 * The refund scenario in two Mastra execution modes.
 *
 *  1. `agentScenario`   - a plain `Agent.generate()`. A plain Agent has no crash
 *     recovery, so after a crash or a redelivery Shakedown's default applies:
 *     the job is run again from the start in a new process (what a queue worker
 *     retrying a job does).
 *
 *  2. `durableScenario` - the same Agent wrapped with `createDurableAgent()`,
 *     Mastra's documented crash-recovery path. The loop runs as a workflow that
 *     checkpoints a `running` snapshot to storage at each step boundary. On a
 *     crash the process is shut down mid tool call; a NEW process (fresh Agent,
 *     fresh model, fresh Mastra, same storage) finds the orphaned run with
 *     `listActiveRuns()` and re-drives it with `recover(runId)`. On a job
 *     redelivery nothing is orphaned, so the new worker handles the job message
 *     again: `generate()` with the same runId.
 *
 * Variants:
 *   naive        plain tools
 *   ledger-only  idempotent() ledger, no key sent downstream (shows why that is not enough)
 *   fixed        idempotent() ledger + the logical key sent downstream as Idempotency-Key
 * Every ledger here is a VOLATILE MemoryLedger: a crash or redelivery wipes it.
 */
import { Mastra } from '@mastra/core'
import { createDurableAgent, type DurableAgent } from '@mastra/core/agent/durable'
import type { MastraModelConfig } from '@mastra/core/llm'
import { InMemoryStore } from '@mastra/core/storage'
import {
  FakeMailer,
  FakeStripe,
  MemoryLedger,
  crashSignal,
  mailerInvariants,
  stripeInvariants,
  type LedgerStore,
  type Scenario,
} from '../../src/index.js'
import { createRefundAgent, type RefundAgentOptions } from './refund-agent.js'
import { TASK } from './scripted-model.js'

export { TASK }

export const MAX_STEPS = 12
export const RUN_ID = 'run-T-1'

export type Variant = 'naive' | 'ledger-only' | 'fixed'

export interface World {
  stripe: FakeStripe
  mailer: FakeMailer
  /**
   * Idempotency ledger. A VOLATILE MemoryLedger: Shakedown wipes it on a crash
   * or redelivery, as a process restart would. The fix must not depend on it
   * surviving; the downstream idempotency key is what holds.
   */
  ledger: LedgerStore
  /** Mastra workflow storage shared by the crashed process and the recovering one (a DB in production). */
  storage: InMemoryStore
  /** Final text of every completed generate()/recover(), in order. */
  outputs: string[]
  /** Run ids recovered by the durable resume path. */
  recovered: string[]
  /** Run ids the durable resume path started again with generate() because nothing was orphaned. */
  redelivered: string[]
}

export type ModelFactory = () => MastraModelConfig

export function newWorld(): World {
  const stripe = new FakeStripe()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  return {
    stripe,
    mailer: new FakeMailer(),
    ledger: new MemoryLedger(),
    storage: new InMemoryStore(),
    outputs: [],
    recovered: [],
    redelivered: [],
  }
}

export const invariants = [
  { name: 'refunded exactly £50', check: stripeInvariants.refundedExactly('ch_1', 5_000) },
  { name: 'at most one refund', check: stripeInvariants.refundCountAtMost('ch_1', 1) },
  { name: 'exactly one email', check: mailerInvariants.sentExactly('ada@example.com', 1) },
]

function toolOptions(v: Variant): Pick<RefundAgentOptions, 'fixed' | 'downstreamKey'> {
  return { fixed: v !== 'naive', downstreamKey: v === 'fixed' }
}

const LABEL: Record<Variant, string> = {
  naive: 'naive tools',
  'ledger-only': 'idempotent() ledger only',
  fixed: 'ledger + downstream idempotency key',
}

/**
 * crashSignal() for this run phase, or undefined once it has fired. The resume
 * phase shares the run's context, so crashSignal() there returns the signal the
 * crash already aborted; passing that to the new process would abort it at once.
 */
export function liveCrashSignal(): AbortSignal | undefined {
  const s = crashSignal()
  return s && !s.aborted ? s : undefined
}

export interface AgentScenarioOptions {
  /**
   * Pass Shakedown's crashSignal() as `generate({ abortSignal })` so a simulated
   * crash stops the Mastra loop, as a real process death would. Default true.
   * With false, Mastra swallows the crash (see the finding in mastra.test.ts).
   */
  abortOnCrash?: boolean
}

export function agentScenario(variant: Variant, model: ModelFactory, o: AgentScenarioOptions = {}): Scenario<World> {
  const abortOnCrash = o.abortOnCrash ?? true
  return {
    name: `mastra Agent.generate, ${LABEL[variant]}`,
    setup: newWorld,
    // Each run builds a fresh Agent: a re-run after a crash is a new process, so
    // nothing in-memory survives except the external world (stripe, mailer).
    run: async (w) => {
      const agent = createRefundAgent({ ...toolOptions(variant), stripe: w.stripe, mailer: w.mailer, ledger: w.ledger, model: model() })
      const signal = abortOnCrash ? liveCrashSignal() : undefined
      const r = await agent.generate(TASK, { maxSteps: MAX_STEPS, ...(signal ? { abortSignal: signal } : {}) })
      // On abort Mastra stops the loop but RESOLVES generate() (empty text) instead
      // of rejecting. A dead process never gets past this line: surface the crash.
      if (signal?.aborted) throw signal.reason
      w.outputs.push(r.text)
      return r
    },
    // No `resume`: a plain Agent has no recovery, so Shakedown's default re-runs the job.
    invariants,
  }
}

/** One "process": an Agent wrapped as a DurableAgent and registered on its own Mastra instance. */
export function startProcess(w: World, variant: Variant, model: ModelFactory) {
  const agent = createRefundAgent({
    ...toolOptions(variant),
    stripe: w.stripe,
    mailer: w.mailer,
    ledger: w.ledger,
    model: model(),
    hangOnCrash: true,
  })
  const durable = createDurableAgent({
    agent,
    maxSteps: MAX_STEPS,
    cleanupTimeoutMs: 0,
    // Persist `running` checkpoints at every step boundary so a crashed run is
    // recoverable. Equivalent to `new Mastra({ recovery: { durableAgents: 'auto' } })`
    // without also turning on boot-time auto recovery.
    shouldPersistSnapshot: ({ workflowStatus }) => ['pending', 'paused', 'suspended', 'running'].includes(workflowStatus),
  })
  const mastra = new Mastra({ agents: { refundAgent: durable }, storage: w.storage, logger: false })
  return { durable, mastra }
}

/** Resolves with the crash when Shakedown simulates one in this run phase. */
function onCrash(signal: AbortSignal | undefined): Promise<unknown> {
  return new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve(signal.reason)
    else signal.addEventListener('abort', () => resolve(signal.reason), { once: true })
  })
}

/**
 * generate() resolves before the run's `running` snapshots are cleared from
 * storage (see the finding in mastra.test.ts). The job is not finished until
 * they are, so a clean worker waits for that before it acks the job.
 */
export async function waitUntilSettled(durable: DurableAgent, runId: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while ((await durable.listActiveRuns()).runs.some((r) => r.runId === runId)) {
    if (performance.now() > deadline) throw new Error(`run ${runId} still listed as running ${timeoutMs}ms after generate() resolved`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

export interface DurableScenarioOptions {
  /** Wait for the completed run to leave storage before the worker finishes. Default true. */
  waitForSettle?: boolean
}

export function durableScenario(variant: Variant, model: ModelFactory, o: DurableScenarioOptions = {}): Scenario<World> {
  const waitForSettle = o.waitForSettle ?? true
  return {
    name: `mastra DurableAgent + recover(), ${LABEL[variant]}`,
    setup: newWorld,
    run: async (w) => {
      const p = startProcess(w, variant, model)
      const gen = p.durable.generate(TASK, { runId: RUN_ID, maxSteps: MAX_STEPS })
      gen.catch(() => {}) // a killed run's promise may settle late; it belongs to the dead process
      const outcome = await Promise.race([
        gen.then((r) => ({ crashed: false as const, r })),
        onCrash(crashSignal()).then((e) => ({ crashed: true as const, e })),
      ])
      if (outcome.crashed) {
        // Kill the process: drain for 50 ms, then stop the run and release its
        // claim. Its last `running` checkpoint stays in storage.
        await p.mastra.shutdown({ drainTimeout: 50 })
        throw outcome.e
      }
      w.outputs.push(outcome.r.text)
      if (waitForSettle) await waitUntilSettled(p.durable, RUN_ID)
      await p.mastra.shutdown()
      return outcome.r
    },
    // A new worker boots against the same storage. It re-drives orphaned runs
    // (Mastra's recovery path); if the job's run is not orphaned, the job
    // message itself was delivered again and the worker handles it as usual.
    resume: async (w) => {
      const p = startProcess(w, variant, model)
      try {
        const { runs } = await p.durable.listActiveRuns()
        for (const run of runs) {
          const rec = await p.durable.recover(run.runId)
          w.outputs.push(await rec.output.text)
          w.recovered.push(run.runId)
          rec.cleanup()
        }
        if (!runs.some((r) => r.runId === RUN_ID)) {
          const r = await p.durable.generate(TASK, { runId: RUN_ID, maxSteps: MAX_STEPS })
          w.outputs.push(r.text)
          w.redelivered.push(RUN_ID)
          await waitUntilSettled(p.durable, RUN_ID)
        }
      } finally {
        await p.mastra.shutdown()
      }
    },
    invariants,
  }
}
