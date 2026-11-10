/**
 * LocalInngest: a minimal, in-process stand-in for the Inngest SERVER, driving
 * the SDK's REAL execution engine (`fn.createExecution(...).start()`, the same
 * call the SDK's HTTP handler makes for every request from Inngest).
 *
 * Why. Inngest's durability lives in the server: it stores each step's result,
 * re-invokes the function with that memoized state (each invocation replays the
 * handler from the top; memoized steps return their stored result, everything
 * else runs again), retries failed steps and failed requests, and executes
 * `step.ai.infer` itself. None of that runs without the dev server, so this
 * class does the server's part, faithfully enough to answer "what does a retry
 * or a crash re-execute?":
 *
 *  - memoized step state that survives a simulated crash (lives in the world);
 *  - step retries: a `StepError` op is retried (attempt + 1) until the engine
 *    itself marks it `StepFailed` (the function's `retries`, default 3);
 *  - function-level retries for errors thrown outside steps;
 *  - `step.ai.infer` (AIGateway op): executed here, against the scripted model;
 *  - `step.waitForEvent`: answered by an `onWaitForEvent` callback (a human
 *    approving, or `null` for a timeout).
 *
 * Execution mode, chosen the way the SDK's comm handler chooses it:
 *  - the v4 default, `checkpointing` on: `StepMode.AsyncCheckpointing`. The
 *    engine runs `step.run` steps inside the request and POSTs each result to
 *    the Inngest API (`/v1/checkpoint/<run>/async`); the client built by
 *    localInngestClient() routes that POST here. `step.ai.infer` cannot run in
 *    the worker, so it still ends the request: every inference is a replay
 *    boundary.
 *  - `checkpointing: false`: `StepMode.Async`, classic replay, where every new
 *    step ends the request.
 * The engine itself behaves like Async for any attempt > 0.
 *
 * Crash. If Shakedown's simulated crash fired during a request, the request's
 * outcome is discarded (the server never got a response, as when a worker
 * dies) and drive() throws. `resume()` is the server retrying that request:
 * same run, same memoized state, a new process.
 */
import { Inngest, type InngestFunction } from 'inngest'
import type { InngestExecution } from 'inngest/internals'
import { StepMode, StepOpCode, type OutgoingOp } from 'inngest/types'
import { crashSignal, processIsDead } from '../../src/index.js'

type ExecutionResult = InngestExecution.ExecutionResult

/** A memoized step, as the server sends it back in `steps`. */
export interface Memo {
  id: string
  data?: unknown
  error?: unknown
}

export interface StepLogEntry {
  /** Request number within the run (1-based, across processes). */
  request: number
  /** Human-readable step id (e.g. "refund", "refund-agent", "generate-agent-ids-0"); repeats keep the same name. */
  name: string
  /** Hashed step id: distinct for each repeat of the same name. */
  stepId: string
  op: string
  attempt: number
  error?: string
  /** Arrived through a checkpoint POST from inside the request (checkpointing mode). */
  checkpointed?: boolean
}

export interface LocalRun {
  runId: string
  event: { name: string; data: Record<string, unknown>; id?: string }
  /** Durable: the server's memoized step state. */
  steps: Record<string, Memo>
  completionOrder: string[]
  attempt: number
  status: 'running' | 'completed' | 'failed'
  output?: unknown
  error?: string
  requests: number
  /** Every step result the "server" received, in order. */
  log: StepLogEntry[]
}

/** The internal shape of an Inngest function we drive (what the SDK's comm handler calls). */
interface Executable {
  opts: { retries?: number; checkpointing?: unknown }
  createExecution(opts: { partialOptions: Record<string, unknown> }): { start(): Promise<ExecutionResult> }
}

export interface LocalInngestOptions {
  fn: InngestFunction.Any
  /** Executes `step.ai.infer` ops (the server's AI gateway). Receives the op's opts: url, body, format... */
  ai: (opts: { url: string; body: unknown; format?: string }) => unknown | Promise<unknown>
  /**
   * Answers `step.waitForEvent`. Return the matching event (e.g. an approval),
   * or null for a timeout. Called once per wait, like a human acting once.
   */
  onWaitForEvent?: (op: { name: string; opts: unknown }) => unknown | null
  /** Safety valve against runaway loops. */
  maxRequests?: number
}

let runCounter = 0
const API_BASE = 'http://local-inngest.invalid'
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * An Inngest client whose API calls (checkpoints) go to the given LocalInngest.
 * Late-bound, because the server needs the function and the function needs the client.
 */
export function localInngestClient(id: string, server: () => LocalInngest | undefined): Inngest {
  return new Inngest({
    id,
    isDev: true,
    baseUrl: API_BASE,
    logger: silentLogger,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const s = server()
      if (!s) throw new Error('LocalInngest not attached to this client')
      return s.api(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
    }) as typeof fetch,
  })
}

export class LocalInngest {
  readonly runs: LocalRun[] = []
  /** Checkpoint POSTs received from inside requests. */
  checkpoints = 0
  constructor(private readonly o: LocalInngestOptions) {}

  private get fn(): Executable {
    return this.o.fn as unknown as Executable
  }

  /** Same rule as InngestFunction.shouldAsyncCheckpoint: on unless the function or client turns it off. */
  get checkpointing(): boolean {
    return this.fn.opts.checkpointing !== false
  }

  /** The Inngest API, as far as the engine uses it: async checkpoints. */
  async api(url: string, init?: RequestInit): Promise<Response> {
    const m = /\/v1\/checkpoint\/([^/]+)\/async$/.exec(new URL(url).pathname)
    if (!m) return new Response(JSON.stringify({ error: `LocalInngest: unsupported API call ${url}` }), { status: 404 })
    // A dead process sends nothing.
    if (processIsDead()) return new Response('{}', { status: 503 })
    const run = this.runs.find((r) => r.runId === decodeURIComponent(m[1]!))
    if (!run) return new Response('{}', { status: 404 })
    const body = JSON.parse(String(init?.body ?? '{}')) as { steps: OutgoingOp[] }
    this.checkpoints++
    for (const op of body.steps) {
      const entry = { request: run.requests, name: op.displayName ?? op.name ?? op.id, stepId: op.id, op: op.op, attempt: run.attempt, checkpointed: true }
      if (op.op === StepOpCode.RunComplete) {
        run.status = 'completed'
        run.output = op.data
        continue
      }
      run.log.push(entry)
      if (op.op === StepOpCode.StepError) continue // retriable: the server retries it, nothing memoized
      if (op.op === StepOpCode.StepFailed) {
        run.steps[op.id] = { id: op.id, error: op.error }
      } else {
        run.steps[op.id] = { id: op.id, data: op.data ?? null }
      }
      run.completionOrder.push(op.id)
    }
    return new Response('{}', { status: 200 })
  }

  /** An event arrives: a NEW run is created (Inngest has no idea it is a repeat unless you configure dedupe). */
  async send(event: LocalRun['event']): Promise<LocalRun> {
    const run: LocalRun = {
      runId: `run_${++runCounter}`,
      event,
      steps: {},
      completionOrder: [],
      attempt: 0,
      status: 'running',
      requests: 0,
      log: [],
    }
    this.runs.push(run)
    return this.drive(run)
  }

  /** The worker died mid-request; the server retries the request for the same run. */
  async resume(run: LocalRun = this.runs.at(-1)!): Promise<LocalRun> {
    if (run.status !== 'running') return run
    return this.drive(run)
  }

  private async drive(run: LocalRun): Promise<LocalRun> {
    const maxAttempts = (this.fn.opts.retries ?? 3) + 1
    let requestedRunStep: string | undefined
    const limit = this.o.maxRequests ?? 400

    for (let i = 0; i < limit; i++) {
      run.requests++
      const request = run.requests
      const exec = this.fn.createExecution({
        partialOptions: {
          client: (this.o.fn as unknown as { client: unknown }).client,
          runId: run.runId,
          data: {
            runId: run.runId,
            attempt: run.attempt,
            maxAttempts,
            event: { ts: 0, ...run.event },
            events: [{ ts: 0, ...run.event }],
          },
          reqArgs: [],
          headers: {},
          stepCompletionOrder: [...run.completionOrder],
          stepState: structuredClone(run.steps),
          ...(requestedRunStep ? { requestedRunStep } : {}),
          ...(this.checkpointing && !requestedRunStep
            ? {
                stepMode: StepMode.AsyncCheckpointing,
                checkpointingConfig: { bufferedSteps: 1, maxInterval: 0, maxRuntime: 10_000 },
                internalFnId: 'fn_local',
                queueItemId: `qi_${run.runId}_${request}`,
              }
            : { stepMode: StepMode.Async }),
        },
      })
      const res = await exec.start()
      requestedRunStep = undefined
      // A checkpoint may have completed the run (RunComplete).
      if (run.status === 'completed' && !processIsDead()) return run

      // The process died during this request: the server never sees its result.
      if (processIsDead()) throw crashSignal()?.reason ?? new Error('process crashed')

      const memo = (m: Memo) => {
        run.steps[m.id] = m
        run.completionOrder.push(m.id)
      }
      const log = (op: OutgoingOp, extra: Partial<StepLogEntry> = {}) =>
        run.log.push({ request, name: op.displayName ?? op.name ?? op.id, stepId: op.id, op: op.op, attempt: run.attempt, ...extra })

      switch (res.type) {
        case 'function-resolved':
          run.status = 'completed'
          run.output = res.data
          return run

        case 'function-rejected': {
          const message = errorMessage(res.error)
          if (res.retriable !== false && run.attempt + 1 < maxAttempts) {
            run.attempt++
            continue
          }
          run.status = 'failed'
          run.error = message
          throw new Error(`Inngest run ${run.runId} failed: ${message}`)
        }

        case 'step-ran': {
          const op = res.step
          if (op.op === StepOpCode.StepError) {
            // Retriable step failure: the server retries this step.
            log(op, { error: errorMessage(op.error) })
            run.attempt++
            requestedRunStep = op.id
            continue
          }
          if (op.op === StepOpCode.StepFailed) {
            log(op, { error: errorMessage(op.error) })
            memo({ id: op.id, error: op.error })
          } else {
            log(op)
            memo({ id: op.id, data: op.data ?? null })
          }
          run.attempt = 0
          continue
        }

        case 'steps-found': {
          for (const op of res.steps) {
            switch (op.op) {
              case StepOpCode.AiGateway: {
                const opts = op.opts as { url: string; body: unknown; format?: string }
                log(op)
                memo({ id: op.id, data: await this.o.ai(opts) })
                break
              }
              case StepOpCode.WaitForEvent: {
                log(op)
                const ev = this.o.onWaitForEvent?.({ name: op.displayName ?? op.id, opts: op.opts }) ?? null
                memo({ id: op.id, data: ev })
                break
              }
              case StepOpCode.Sleep:
                log(op)
                memo({ id: op.id, data: null })
                break
              case StepOpCode.StepPlanned:
                requestedRunStep ??= op.id
                break
              case StepOpCode.RunComplete:
                run.status = 'completed'
                run.output = op.data
                return run
              default:
                throw new Error(`LocalInngest: unsupported op ${op.op} (${op.displayName ?? op.id})`)
            }
          }
          run.attempt = 0
          continue
        }

        case 'step-not-found':
          continue

        case 'change-mode':
          throw new Error('LocalInngest: change-mode is only used with checkpointing, which is not emulated')
      }
    }
    throw new Error(`LocalInngest: run ${run.runId} did not finish within ${limit} requests`)
  }
}

/**
 * What the Inngest server's AI gateway does for a real provider: POST the op's
 * body to its URL with the adapter's key. Used only by the key-gated real-model test.
 */
export async function gatewayFetch(opts: { url: string; body: unknown; format?: string; auth_key?: string }): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.format === 'anthropic') {
    headers['x-api-key'] = opts.auth_key ?? ''
    headers['anthropic-version'] = '2023-06-01'
  } else if (opts.auth_key) {
    headers['authorization'] = `Bearer ${opts.auth_key}`
  }
  const res = await fetch(opts.url, { method: 'POST', headers, body: JSON.stringify(opts.body) })
  return await res.json()
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}
