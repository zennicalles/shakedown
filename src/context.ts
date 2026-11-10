import { AsyncLocalStorage } from 'node:async_hooks'
import type { FaultKind, FaultSpec } from './faults.js'

export type Effect = 'read' | 'write'
export type Phase = 'run' | 'resume'

export interface CallRecord {
  tool: string
  effect: Effect
  args: unknown
  /** 1-based index of this call among calls to the same tool in this run (all phases). */
  callIndex: number
  phase: Phase
  outcome: 'ok' | 'error'
  /** Set when Shakedown injected a fault on this call. */
  fault?: FaultKind
  /** For duplicate-delivery: which delivery this record describes. */
  delivery?: 1 | 2
  /** True when a side effect actually happened (false for failed, blocked or deduplicated calls). */
  committed: boolean
  /** True when the call returned a replayed result (idempotent() ledger hit or a fake's idempotency-key replay). */
  deduped?: boolean
  /** True when the call was refused because the "process" had already crashed. */
  blocked?: boolean
  error?: string
}

export interface RunContext {
  fault: FaultSpec | null
  faultFired: boolean
  /** A real error stopped the targeted call before the fault could be injected; retarget the next matching call. */
  faultRetarget: boolean
  /** Set synchronously when a call matches the fault, so parallel calls can't all take it. */
  faultClaimed: boolean
  crashed: boolean
  calls: CallRecord[]
  counters: Map<string, number>
  writeCount: number
  /** Number of replayed (deduplicated) results seen in this run. */
  dedupes: number
  /**
   * Write tools whose idempotency guard (a refused possibly-duplicate call, or a reconcile
   * that found the earlier effect) fired in the resumed/redelivered job. Only guards that
   * ran inside the run's own async context are counted.
   */
  resumeGuardTools: Set<string>
  /** Reset hooks for in-process state that a real crash or redelivery to a new worker would lose. */
  volatile: Set<() => void>
}

export function newRunContext(fault: FaultSpec | null): RunContext {
  return {
    fault,
    faultFired: false,
    faultRetarget: false,
    faultClaimed: false,
    crashed: false,
    calls: [],
    counters: new Map(),
    writeCount: 0,
    dedupes: 0,
    resumeGuardTools: new Set(),
    volatile: new Set(),
  }
}

/** Per-call slot so fakes and idempotent() can mark the enclosing shake() call as deduplicated. */
export interface CallSlot {
  deduped: boolean
}

interface Store {
  ctx: RunContext
  phase: Phase
  /** Per phase: the crashed run's signal aborts, the resumed process gets a fresh, live one. */
  crash: AbortController
  call?: CallSlot
}

const als = new AsyncLocalStorage<Store>()
/**
 * Fallback for frameworks that lose AsyncLocalStorage context (worker pools,
 * subprocess bridges). Only used when exactly one run phase is live, so
 * concurrent runs can never leak into each other.
 */
const live = new Set<Store>()

/** Number of runScenario() calls in flight. The fallback is only safe when exactly one is. */
let activeScenarios = 0
export function beginScenario(): void {
  activeScenarios++
}
export function endScenario(): void {
  activeScenarios = Math.max(0, activeScenarios - 1)
}

export function currentStore(): Store | null {
  const s = als.getStore()
  if (s) return s
  if (activeScenarios === 1 && live.size === 1) return live.values().next().value ?? null
  return null
}

/** The store only if it came from AsyncLocalStorage (never the single-live-run fallback). */
function alsStore(): Store | null {
  return als.getStore() ?? null
}

export function currentRun(): RunContext | null {
  return currentStore()?.ctx ?? null
}

export async function withPhase<T>(ctx: RunContext, phase: Phase, fn: () => Promise<T>): Promise<T> {
  const store: Store = { ctx, phase, crash: new AbortController() }
  live.add(store)
  try {
    return await als.run(store, fn)
  } finally {
    live.delete(store)
  }
}

export async function withCallSlot<T>(slot: CallSlot, fn: () => Promise<T>): Promise<T> {
  const s = currentStore()
  if (!s) return await fn()
  return await als.run({ ...s, call: slot }, fn)
}

/** Called by fakes and idempotent() when they return a replayed result instead of performing the effect. */
export function markDeduped(): void {
  const s = currentStore()
  if (!s) return
  s.ctx.dedupes++
  if (s.call) s.call.deduped = true
}

/**
 * Called by idempotent() when its write-ahead guard handles an attempt that may already have
 * happened (refused it, or reconciled it against the system of record). `tool` is the shake()
 * tool it protects; guards without a known write tool, outside the resume phase, or reached
 * through the context-loss fallback are not counted.
 */
export function markGuarded(tool: string | undefined): void {
  const s = alsStore()
  if (s && s.phase === 'resume' && tool) s.ctx.resumeGuardTools.add(tool)
}

/**
 * Per-attempt slot: idempotent() opens one around its execute(), and every write tool
 * shake()-d inside it is noted, so a guard can be attributed to the tool it protects even
 * when adapters sit between idempotent() and shake().
 */
export interface AttemptSlot {
  tools: Set<string>
}
const attemptAls = new AsyncLocalStorage<AttemptSlot>()
export async function withAttemptSlot<T>(slot: AttemptSlot, fn: () => Promise<T>): Promise<T> {
  return await attemptAls.run(slot, fn)
}
export function noteAttemptTool(tool: string): void {
  attemptAls.getStore()?.tools.add(tool)
}

/** Tag shake() puts on the function it returns, so idempotent() knows which tool it protects. */
export const SHAKE_TOOL: unique symbol = Symbol.for('shakedown.tool')
export interface ShakeToolTag {
  tool: string
  effect: Effect
}
export function shakeToolOf(fn: unknown): ShakeToolTag | undefined {
  return typeof fn === 'function' ? (fn as unknown as Record<symbol, ShakeToolTag | undefined>)[SHAKE_TOOL] : undefined
}

/** True inside the crashed run phase: the "process" is dead and must not perform or persist anything. */
export function processIsDead(): boolean {
  const s = currentStore()
  return !!s && s.ctx.crashed && s.phase === 'run'
}

/**
 * AbortSignal that fires on a simulated crash. Pass it as the framework's abort signal.
 * It belongs to the current phase: in the resume phase (a new process) it is a fresh,
 * live signal, so passing it to the resumed run is always safe.
 */
export function crashSignal(): AbortSignal | undefined {
  return currentStore()?.crash.signal
}

/** 'run', 'resume' (after a crash or redelivery: a new process), or null outside Shakedown. */
export function currentPhase(): Phase | null {
  return currentStore()?.phase ?? null
}

/**
 * Wrap a write to a durable store (checkpointer, session, conversation DB) so that it
 * does nothing once the "process" has crashed: a dead process cannot persist anything.
 *
 *   saver.put = unlessDead(saver.put.bind(saver))
 */
export function unlessDead<A extends unknown[], R>(fn: (...args: A) => R, fallback?: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => (processIsDead() ? fallback?.(...args) : fn(...args))
}

/**
 * Register in-process state that a real crash (or a redelivery to a fresh worker)
 * would lose. The runner calls `reset` before resuming. Registration is per run
 * and idempotent per reset function.
 */
export function registerVolatile(reset: () => void): void {
  currentRun()?.volatile.add(reset)
}
