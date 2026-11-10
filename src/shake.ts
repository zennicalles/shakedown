import { SHAKE_TOOL, currentStore, noteAttemptTool, withCallSlot, type CallRecord, type CallSlot, type Effect, type RunContext } from './context.js'
import { safeClone, safeString } from './util.js'
import { SimulatedCrash, SimulatedTimeoutError, SimulatedTransientError, type FaultSpec } from './faults.js'

export interface ShakeOptions {
  /** 'write' tools are fault targets by default; 'read' tools are only targeted when named explicitly. Default 'write'. */
  effect?: Effect
  /**
   * What to store as the call's arguments in the report. Default: the first argument.
   * Frameworks call execute(input, options/context), and the second argument is not data.
   */
  recordArgs?: (...args: unknown[]) => unknown
}

/**
 * Wrap a side-effecting call so Shakedown can observe it and inject faults.
 *
 * Wrap at the side-effect boundary: the function that actually talks to Stripe,
 * the mailer, the database. That is where real timeouts happen, so that is where
 * faults must be injected for the verdict to mean anything. If you use
 * idempotent(), put it OUTSIDE shake():
 *
 *   const refund = idempotent(
 *     shake('refund', (a) => stripe.refunds.create(a, { idempotencyKey: currentIdempotencyKey() })),
 *     { key: (a) => `refund:${a.ticket}` },
 *   )
 *
 * Outside a Shakedown run the wrapper is a transparent pass-through.
 */
export function shake<A extends unknown[], R>(
  tool: string,
  execute: (...args: A) => R | Promise<R>,
  opts: ShakeOptions = {},
): (...args: A) => Promise<R> {
  const effect: Effect = opts.effect ?? 'write'
  const wrapped = async (...args: A): Promise<R> => {
    if (effect === 'write') noteAttemptTool(tool)
    const store = currentStore()
    if (!store) return await execute(...args)
    const run = store.ctx
    const recordedArgs = safeClone(opts.recordArgs ? opts.recordArgs(...args) : args[0])
    const callIndex = (run.counters.get(tool) ?? 0) + 1
    const base = { tool, effect, args: recordedArgs, callIndex, phase: store.phase }
    const push = (r: Omit<CallRecord, keyof typeof base>) => run.calls.push({ ...base, ...r })

    // After a simulated crash the "process" is dead: nothing that started in the
    // crashed phase may execute, even if a framework swallowed the crash and kept going.
    if (run.crashed && store.phase === 'run') {
      push({ outcome: 'error', committed: false, blocked: true, error: 'blocked: process already crashed' })
      throw new SimulatedCrash(tool)
    }

    run.counters.set(tool, callIndex)
    const writeIndex = effect === 'write' ? ++run.writeCount : 0
    const fault = matchFault(run, tool, effect, callIndex, writeIndex)
    // Claim the fault synchronously so parallel calls in the same step can't all take it.
    if (fault) run.faultClaimed = true

    /** Execute once, reporting whether the result was a replay rather than a new side effect. */
    const once = async (): Promise<{ out: R; deduped: boolean }> => {
      const slot: CallSlot = { deduped: false }
      const out = await withCallSlot(slot, async () => await execute(...args))
      return { out, deduped: slot.deduped }
    }
    const fail = (e: unknown, extra: Partial<CallRecord> = {}): never => {
      push({ outcome: 'error', committed: false, error: errorMessage(e), ...extra })
      throw e
    }

    if (!fault) {
      let r: { out: R; deduped: boolean }
      try {
        r = await once()
      } catch (e) {
        return fail(e)
      }
      push({ outcome: 'ok', committed: !r.deduped, ...(r.deduped ? { deduped: true } : {}) })
      return r.out
    }

    // A real error before injection means the fault did not happen on this call:
    // record it truthfully and let the fault retarget the next matching call.
    const attempt = async () => {
      try {
        return await once()
      } catch (e) {
        run.faultRetarget = true
        run.faultClaimed = false
        return fail(e)
      }
    }

    switch (fault.kind) {
      case 'error-before-commit': {
        run.faultFired = true
        const err = new SimulatedTransientError(tool)
        push({ outcome: 'error', committed: false, fault: fault.kind, error: err.message })
        throw err
      }
      case 'timeout-after-commit': {
        const r = await attempt()
        run.faultFired = true
        const err = new SimulatedTimeoutError(tool)
        push({ outcome: 'error', committed: !r.deduped, ...(r.deduped ? { deduped: true } : {}), fault: fault.kind, error: err.message })
        throw err
      }
      case 'crash-after-commit': {
        const r = await attempt()
        run.faultFired = true
        run.crashed = true
        const err = new SimulatedCrash(tool)
        push({ outcome: 'error', committed: !r.deduped, ...(r.deduped ? { deduped: true } : {}), fault: fault.kind, error: err.message })
        store.crash.abort(err)
        throw err
      }
      case 'duplicate-delivery': {
        const first = await attempt()
        run.faultFired = true
        push({
          outcome: 'ok',
          committed: !first.deduped,
          ...(first.deduped ? { deduped: true } : {}),
          fault: fault.kind,
          delivery: 1,
          error: 'response lost (first delivery)',
        })
        let second: { out: R; deduped: boolean }
        try {
          second = await once()
        } catch (e) {
          return fail(e, { fault: fault.kind, delivery: 2 })
        }
        push({ outcome: 'ok', committed: !second.deduped, ...(second.deduped ? { deduped: true } : {}), fault: fault.kind, delivery: 2 })
        return second.out
      }
      case 'job-redelivery':
        return await execute(...args) // never matched; handled by the runner
      default:
        throw new Error(`[shakedown] unknown fault kind: ${String((fault as { kind: unknown }).kind)}`)
    }
  }
  Object.defineProperty(wrapped, SHAKE_TOOL, { value: { tool, effect } })
  return wrapped
}

function matchFault(run: RunContext, tool: string, effect: Effect, callIndex: number, writeIndex: number): FaultSpec | null {
  const f = run.fault
  if (!f || run.faultFired || run.faultClaimed || f.kind === 'job-redelivery') return null
  const n = f.onCall ?? 1
  if (f.tool) {
    if (f.tool !== tool) return null
    return callIndex === n || (run.faultRetarget && callIndex > n) ? f : null
  }
  if (effect !== 'write') return null
  return writeIndex === n || (run.faultRetarget && writeIndex > n) ? f : null
}

function errorMessage(e: unknown): string {
  return safeString(e)
}
