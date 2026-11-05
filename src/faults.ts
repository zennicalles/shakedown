/**
 * Fault kinds Shakedown can inject.
 *
 * The interesting ones are the faults where the side effect has ALREADY
 * happened but the caller cannot tell: that is where retries turn into
 * duplicate refunds, duplicate emails and duplicate records.
 */
export type FaultKind =
  /** Transient failure BEFORE the side effect runs. Retrying is safe. Control case. */
  | 'error-before-commit'
  /** Side effect runs, then the caller sees a timeout (the response was lost). */
  | 'timeout-after-commit'
  /** The same call is delivered twice with identical arguments (at-least-once transport). */
  | 'duplicate-delivery'
  /** Side effect runs, then the process dies before anything else happens; in-process state is lost and the run is resumed. */
  | 'crash-after-commit'
  /** Not tool-targeted: the whole job completes, then is delivered again to a fresh worker (queue redelivery, double-click, two workers). */
  | 'job-redelivery'

/** Faults applied per write tool by default. */
export const TOOL_FAULT_KINDS: readonly FaultKind[] = [
  'error-before-commit',
  'timeout-after-commit',
  'duplicate-delivery',
  'crash-after-commit',
]
/** @deprecated use TOOL_FAULT_KINDS */
export const ALL_FAULT_KINDS = TOOL_FAULT_KINDS

export interface FaultSpec {
  kind: FaultKind
  /** Tool to target. Omit to target write calls of any tool. Ignored for 'job-redelivery'. */
  tool?: string
  /**
   * Which call to hit, 1-based. Default 1. With `tool`, the Nth call of that tool;
   * without `tool`, the Nth write call of any tool.
   */
  onCall?: number
}

export function describeFault(f: FaultSpec | null): string {
  if (!f) return 'baseline (no fault)'
  if (f.kind === 'job-redelivery') return 'job-redelivery'
  const n = f.onCall ?? 1
  if (!f.tool) return `${f.kind} on write call #${n}`
  return `${f.kind} on ${f.tool}${n !== 1 ? ` (call #${n})` : ''}`
}

const KNOWN_KINDS: readonly string[] = [...TOOL_FAULT_KINDS, 'job-redelivery']

export function validateFault(f: FaultSpec): string | null {
  if (!KNOWN_KINDS.includes(f.kind)) {
    return `invalid fault ${JSON.stringify(f)}: unknown kind (expected one of ${KNOWN_KINDS.join(', ')})`
  }
  if (f.onCall !== undefined && (!Number.isInteger(f.onCall) || f.onCall < 1)) {
    return `invalid fault ${JSON.stringify(f)}: onCall must be an integer >= 1`
  }
  return null
}

/** Error thrown to the agent for 'timeout-after-commit'. Looks like a real client timeout. */
export class SimulatedTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'
  constructor(tool: string) {
    super(`Request to ${tool} timed out after 30000ms (no response received)`)
    this.name = 'TimeoutError'
  }
}

/** Error thrown to the agent for 'error-before-commit'. */
export class SimulatedTransientError extends Error {
  readonly code = 'ECONNRESET'
  constructor(tool: string) {
    super(`Connection reset while calling ${tool} (socket hang up)`)
    this.name = 'TransientError'
  }
}

/**
 * Thrown for 'crash-after-commit'. The runner catches it and resumes the run.
 * Many frameworks catch every tool error and show it to the model; Shakedown
 * still treats the process as dead (further calls are blocked) and also aborts
 * `crashSignal()` so adapters can stop the framework. The message is neutral so
 * a model that sees it reacts as it would to a real dropped connection.
 */
export class SimulatedCrash extends Error {
  readonly shakedownCrash = true
  constructor(tool: string) {
    super(`Process exited unexpectedly while calling ${tool} (connection closed)`)
    this.name = 'ConnectionClosedError'
  }
}

export function isSimulatedCrash(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { shakedownCrash?: unknown }).shakedownCrash === true
}
