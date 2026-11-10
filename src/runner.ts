import { beginScenario, endScenario, newRunContext, withPhase, type CallRecord, type RunContext } from './context.js'
import { safeString } from './util.js'
import { TOOL_FAULT_KINDS, describeFault, isSimulatedCrash, validateFault, type FaultKind, type FaultSpec } from './faults.js'

/**
 * What went wrong, by kind:
 *  - 'safety': something happened that must not (a second refund, a second email). What Shakedown exists to catch.
 *  - 'completion': the job stopped short (no refund, no email). A real problem, but not a duplicate.
 */
export type ViolationKind = 'safety' | 'completion'
export interface Violation {
  kind: ViolationKind
  message: string
}

/**
 * An invariant passes only when it returns exactly `true`. Returning a
 * Violation reports that kind; returning false, a string (used as the message),
 * anything else, or throwing is a violation of the invariant's declared kind
 * (default 'safety').
 */
export type InvariantResult = boolean | string | Violation
export type Invariant<W> = (world: W) => InvariantResult | Promise<InvariantResult>

export function isViolation(v: unknown): v is Violation {
  return (
    typeof v === 'object' &&
    v !== null &&
    ((v as Violation).kind === 'safety' || (v as Violation).kind === 'completion') &&
    typeof (v as Violation).message === 'string'
  )
}

export interface Scenario<W> {
  name: string
  /**
   * Build a fresh world for every run: the DURABLE things (fake backends, durable
   * ledgers/stores) plus whatever wiring your agent needs.
   */
  setup: () => W | Promise<W>
  /** Run the agent once against the world. */
  run: (world: W) => Promise<unknown>
  /**
   * How the job is picked up again after a crash or a redelivery: a NEW process.
   * Defaults to calling `run` again on the same world, which is what a naive
   * "retry the job" worker does. Framework adapters override this with the
   * framework's real resume path (checkpointer, RunState, recover()...). Build
   * agent/tool instances fresh here; volatile in-process state registered with
   * Shakedown (default MemoryLedger, idempotent() in-flight maps) is wiped first.
   */
  resume?: (world: W) => Promise<unknown>
  invariants: Array<Invariant<W> | { name: string; check: Invariant<W>; kind?: ViolationKind }>
  /**
   * Explicit fault list. Default: every tool fault kind against every write tool
   * the baseline run called, plus one 'job-redelivery'.
   */
  faults?: FaultSpec[]
  /** Treat an agent error in the baseline as acceptable (default: the baseline fails). */
  allowBaselineError?: boolean
  /** Do not fail the report when a fault never triggered (default: untriggered faults fail). */
  allowUntriggered?: boolean
}

export interface FaultResult<W = unknown> {
  fault: FaultSpec | null
  label: string
  passed: boolean
  /** The requested fault never triggered (tool not called, or called fewer than onCall times). */
  faultNotTriggered: boolean
  /** Why it did not trigger, when known. */
  notTriggeredReason?: string
  /** The framework caught the simulated crash and carried on instead of stopping. */
  crashSwallowed: boolean
  /** Safety violations: something happened that must not. */
  violations: string[]
  /** Completion violations: the job stopped short. */
  incomplete: string[]
  agentError?: string
  calls: CallRecord[]
  /** Replayed results (ledger hits, idempotency-key replays) seen during the run. */
  dedupes: number
  /** Write calls made by the resumed/redelivered job, or null when there was no resume phase. */
  resumeWrites: number | null
  /**
   * The fault's real question (is the resumed or redelivered job idempotent?) was never
   * exercised: the resume made no write calls AND either errored or left the job
   * incomplete. Counts against both `passed` and `safe`.
   */
  untested: boolean
  untestedReason?: string
  /**
   * The row passed, but the resumed/redelivered job never re-attempted the operation at risk
   * (no write call, no guard): the pass comes from the resume path, not from idempotency.
   * Still safe (nothing happened twice), but it proves nothing about the tools.
   */
  hollow: boolean
  /** Things worth knowing that do not change the verdict. */
  notes: string[]
  durationMs: number
  /** The world after the run, for custom assertions. */
  world: W
}

export interface Report<W = unknown> {
  scenario: string
  results: Array<FaultResult<W>>
  /** Everything held: no safety or completion violations, baseline fine, every fault triggered (unless allowed). */
  passed: boolean
  /**
   * No safety violations anywhere, and the run was meaningful: no report-level problems,
   * every fault triggered (unless allowed), and the baseline passed completely.
   * Jobs that stop short under a fault do not make a report unsafe.
   */
  safe: boolean
  /** Report-level problems (nothing tested, invalid faults). */
  problems: string[]
  /** Rows that passed without exercising the operation at risk (see FaultResult.hollow). */
  hollowRows: number
}

export async function runScenario<W>(scenario: Scenario<W>): Promise<Report<W>> {
  beginScenario()
  try {
    return await runScenarioInner(scenario)
  } finally {
    endScenario()
  }
}

async function runScenarioInner<W>(scenario: Scenario<W>): Promise<Report<W>> {
  const problems: string[] = []
  const baseline = await runOnce(scenario, null)
  const results: Array<FaultResult<W>> = [baseline]

  const faults = scenario.faults ?? defaultFaults(baseline.calls)
  if (faults.length === 0) {
    problems.push(
      scenario.faults
        ? 'no faults listed: nothing was tested'
        : 'baseline made no write calls, so there was nothing to fault (is the agent wired to shake()-wrapped tools?)',
    )
  }
  for (const f of faults) {
    const invalid = validateFault(f)
    if (invalid) {
      problems.push(invalid)
      continue
    }
    results.push(await runOnce(scenario, f))
  }

  const faultRows = results.slice(1)
  if (faultRows.length > 0 && faultRows.every((r) => r.faultNotTriggered)) {
    problems.push('no fault triggered: nothing was tested')
  }
  const triggeredOk = (r: FaultResult<W>) => !r.faultNotTriggered || !!scenario.allowUntriggered
  const clean = (r: FaultResult<W>) => r.violations.length === 0 && !r.untested
  const passed = problems.length === 0 && results.every((r) => triggeredOk(r) && clean(r) && r.incomplete.length === 0)
  const safe = problems.length === 0 && baseline.passed && results.every((r) => triggeredOk(r) && clean(r))
  return { scenario: scenario.name, results, passed, safe, problems, hollowRows: results.filter((r) => r.hollow).length }
}

/** Every tool fault kind on every distinct write tool seen in the baseline run, plus one job redelivery. */
export function defaultFaults(baselineCalls: CallRecord[], kinds: readonly FaultKind[] = TOOL_FAULT_KINDS): FaultSpec[] {
  const tools = [...new Set(baselineCalls.filter((c) => c.effect === 'write').map((c) => c.tool))]
  if (tools.length === 0) return []
  return [...tools.flatMap((tool) => kinds.map((kind) => ({ kind, tool, onCall: 1 }))), { kind: 'job-redelivery' as const }]
}

async function runOnce<W>(scenario: Scenario<W>, fault: FaultSpec | null): Promise<FaultResult<W>> {
  const started = performance.now()
  const world = await scenario.setup()
  const ctx = newRunContext(fault)
  let agentError: string | undefined
  let resumeError: string | undefined
  let threwCrash = false

  await withPhase(ctx, 'run', async () => {
    try {
      await scenario.run(world)
    } catch (e) {
      // After the crash the process is dead: whatever error the framework raises next
      // (AbortError, McpError, its own wrapper) is a consequence of the crash.
      if (isSimulatedCrash(e) || ctx.crashed) threwCrash = true
      else agentError = message(e)
    }
  })

  const redeliver = fault?.kind === 'job-redelivery'
  // A redelivery only tests something if the first delivery committed a write.
  if (redeliver) ctx.faultFired = ctx.calls.some((c) => c.phase === 'run' && c.effect === 'write' && c.committed)
  if (ctx.crashed || (redeliver && ctx.faultFired)) {
    // A new process picks the job up: in-process state is gone.
    for (const reset of ctx.volatile) reset()
    ctx.volatile.clear()
    await withPhase(ctx, 'resume', async () => {
      try {
        await (scenario.resume ?? scenario.run)(world)
      } catch (e) {
        resumeError = message(e)
        agentError = `${agentError ? `${agentError}; ` : ''}after ${redeliver ? 'redelivery' : 'resume'}: ${resumeError}`
      }
    })
  }

  const violations: string[] = []
  const incomplete: string[] = []
  const add = (kind: ViolationKind, msg: string) => (kind === 'completion' ? incomplete : violations).push(msg)
  for (const [i, inv] of scenario.invariants.entries()) {
    const check = typeof inv === 'function' ? inv : inv.check
    const name = typeof inv === 'function' ? inv.name || `invariant #${i + 1}` : inv.name
    const declared: ViolationKind = typeof inv === 'function' ? 'safety' : (inv.kind ?? 'safety')
    try {
      const r = await check(world)
      if (r === true) continue
      // A returned Violation picks its kind, except that an invariant declared 'safety' stays safety.
      if (isViolation(r)) add(declared === 'safety' && typeof inv !== 'function' && inv.kind === 'safety' ? 'safety' : r.kind, r.message || `${name} failed`)
      else if (typeof r === 'string' && r.length > 0) add(declared, r)
      else add(declared, `${name} returned ${JSON.stringify(r) ?? String(r)}`)
    } catch (e) {
      add(declared, `${name} threw: ${message(e)}`)
    }
  }
  if (fault === null && agentError !== undefined && !scenario.allowBaselineError) {
    violations.push(`baseline agent error: ${agentError}`)
  }

  const faultNotTriggered = fault !== null && !ctx.faultFired
  const resumed = ctx.crashed || (redeliver && ctx.faultFired)
  const resumeWrites = resumed ? ctx.calls.filter((c) => c.phase === 'resume' && c.effect === 'write' && !c.blocked).length : null
  // Did the resumed job actually exercise idempotency for the operation at risk?
  // A tool is exercised if the resume called it again or its own write-ahead guard fired.
  // For a tool fault that's the faulted tool; for a redelivery, every write tool the run committed.
  const resumedWriteTools = new Set(ctx.calls.filter((c) => c.phase === 'resume' && c.effect === 'write' && !c.blocked).map((c) => c.tool))
  const exercised = (tool: string) => resumedWriteTools.has(tool) || ctx.resumeGuardTools.has(tool)
  const atRisk = redeliver
    ? [...new Set(ctx.calls.filter((c) => c.phase === 'run' && c.effect === 'write' && c.committed).map((c) => c.tool))]
    : [fault?.tool ?? ctx.calls.find((c) => c.fault)?.tool].filter((t): t is string => !!t)
  const resumeExercised = atRisk.length > 0 && atRisk.every(exercised)
  const guardedOnly = resumeWrites === 0 && resumeExercised
  // Untested: the resume never exercised the operation at risk, and then errored or left the job incomplete.
  const untested =
    resumed && !resumeExercised && violations.length === 0 && !faultNotTriggered && (incomplete.length > 0 || resumeError !== undefined)
  const untestedReason = untested
    ? `the ${redeliver ? 'redelivered' : 'resumed'} job made no write calls and ${resumeError !== undefined ? `errored (${resumeError})` : 'left the job incomplete'}, so whether a retry would duplicate was never tested`
    : undefined
  const notes: string[] = []
  if (guardedOnly && violations.length === 0 && !faultNotTriggered) {
    notes.push(
      `the ${redeliver ? 'redelivered' : 'resumed'} job made no write calls; it passed because the write-ahead guard on ${atRisk.join(', ')} refused or reconciled the repeat`,
    )
  }
  const hollow = resumed && resumeWrites === 0 && !resumeExercised && violations.length === 0 && incomplete.length === 0 && !faultNotTriggered && !untested
  if (hollow) {
    notes.push(
      `the ${redeliver ? 'redelivered' : 'resumed'} job made no write calls, so this pass comes from the resume path (it found the work done or refused to run), not from idempotent tools`,
    )
  }
  if (agentError !== undefined && violations.length === 0 && incomplete.length === 0 && !untested) notes.push(`agent error: ${agentError}`)
  return {
    fault,
    label: describeFault(fault),
    passed: violations.length === 0 && incomplete.length === 0 && !faultNotTriggered && !untested,
    faultNotTriggered,
    ...(faultNotTriggered ? { notTriggeredReason: notTriggeredReason(ctx, fault!) } : {}),
    crashSwallowed: ctx.crashed && !threwCrash,
    violations,
    incomplete,
    ...(agentError !== undefined ? { agentError } : {}),
    calls: ctx.calls,
    dedupes: ctx.dedupes,
    resumeWrites,
    untested,
    ...(untestedReason ? { untestedReason } : {}),
    hollow,
    notes,
    durationMs: Math.round(performance.now() - started),
    world,
  }
}

function notTriggeredReason(ctx: RunContext, f: FaultSpec): string {
  if (f.kind === 'job-redelivery') return 'the job made no committed write calls before the redelivery'
  const n = f.onCall ?? 1
  if (ctx.faultRetarget) {
    return `every targeted call${f.tool ? ` to ${f.tool}` : ''} failed with a real error before the fault could be injected`
  }
  if (f.tool) {
    const calls = ctx.counters.get(f.tool) ?? 0
    return calls === 0 ? `${f.tool} was never called` : `${f.tool} was called ${calls} time(s), fewer than onCall=${n}`
  }
  return `only ${ctx.writeCount} write call(s) happened, fewer than onCall=${n}`
}

function message(e: unknown): string {
  return safeString(e)
}
