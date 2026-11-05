/**
 * Shakedown example: a refund agent whose tools live behind a real MCP server.
 *
 *   MCP host (agent loop + model)  --JSON-RPC over InMemoryTransport-->  McpServer (tools wrapped with shake())
 *
 * MCP itself is a protocol, not an agent framework: the server exposes tools,
 * the host (Claude Desktop, an IDE, your own loop) owns the model loop. So this
 * file contains:
 *   - createRefundServer(): a real @modelcontextprotocol/sdk McpServer with three
 *     tools, zod input schemas and tool annotations
 *   - runMcpHost(): the host side, a minimal MCP host loop that lists tools over
 *     the protocol, asks a Model what to do next and calls tools with client.callTool()
 *   - scriptedModel(): a deterministic, reactive stand-in for an LLM
 *   - refundScenario(): the Shakedown scenario (setup / run / resume / invariants)
 *
 * Wiring (Shakedown core v2): shake() sits at the side-effect boundary, around
 * the raw stripe.refunds.create / mailer.send call, because that is where real
 * timeouts happen. idempotent() goes OUTSIDE shake(), and the fixed tools send
 * its logical key downstream (currentIdempotencyKey() -> { idempotencyKey }).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  FakeMailer,
  FakeStripe,
  MemoryLedger,
  crashSignal,
  currentIdempotencyKey,
  idempotent,
  mailerInvariants,
  shake,
  stripeInvariants,
  type Scenario,
} from '../../src/index.js'

export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'

// ---------------------------------------------------------------------------
// World: what survives a crash. The fake backends, plus (only for
// ledger: 'durable') ledgers standing in for Redis/Postgres.
// ---------------------------------------------------------------------------

export interface World {
  stripe: FakeStripe
  mailer: FakeMailer
  /**
   * Ledgers marked durable, stand-ins for a real database. Only used with
   * ledger: 'durable'. The default ('per-server') is idempotent()'s volatile
   * MemoryLedger, which a simulated crash or redelivery wipes.
   */
  ledgers: { refund: MemoryLedger; email: MemoryLedger }
  /** One transcript per host run (run, then resume after a crash or redelivery). For inspection in tests. */
  transcripts: Turn[][]
}

export function createWorld(): World {
  const stripe = new FakeStripe()
  const mailer = new FakeMailer()
  stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }) // ch_1, £100
  return {
    stripe,
    mailer,
    ledgers: { refund: new MemoryLedger({ durable: true }), email: new MemoryLedger({ durable: true }) },
    transcripts: [],
  }
}

/**
 *  - naive:       plain tools
 *  - ledger-only: idempotent() ledger outside shake(), no key sent downstream
 *  - fixed:       ledger + the logical key sent downstream (Stripe / mailer idempotency key)
 */
export type Mode = 'naive' | 'ledger-only' | 'fixed'

export interface RefundAgentOptions {
  mode: Mode
  /**
   * Where idempotent()'s ledger lives (ledger-only / fixed).
   *  - 'per-server' (default): idempotent()'s default, VOLATILE MemoryLedger,
   *    created with each MCP server process. A crash or redelivery wipes it.
   *  - 'durable': World.ledgers, MemoryLedger({ durable: true }), a stand-in for
   *    a real database. Used to show that durability alone does not close the
   *    commit-to-ledger window.
   */
  ledger?: 'per-server' | 'durable'
  /**
   * Model a host process death on a simulated crash (default true): the host
   * passes crashSignal() to client.callTool() and stops when it aborts. With
   * false the host keeps going, which is what MCP does on its own: McpServer
   * turns the crash into an isError tool result like any other error.
   */
  abortOnCrash?: boolean
  /** Who drives the MCP client. Default: runMcpHost with scriptedModel(). */
  driver?: Driver
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/**
 * MCP tool annotations (hints, per the spec, not guarantees). The naive server
 * declares refund idempotentHint:true because "it is keyed by ticket", which is
 * exactly the kind of claim nobody tests. The ledger-only server claims both
 * tools are idempotent because "they have a ledger". findLyingAnnotations()
 * catches both.
 */
export function toolAnnotations(mode: Mode): Record<'lookup_charge' | 'refund' | 'send_email', ToolAnnotations> {
  return {
    lookup_charge: { title: 'Look up a charge', readOnlyHint: true, openWorldHint: true },
    refund: { title: 'Refund a charge', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    send_email: {
      title: 'Email the customer',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: mode !== 'naive',
      openWorldHint: true,
    },
  }
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

/** Descriptions + zod input shapes, shared by the McpServer and the Claude Agent SDK variant. */
export const TOOL_SPECS = {
  lookup_charge: {
    description: 'Retrieve a Stripe charge by id (amount and amount_refunded are in minor units, e.g. pence).',
    inputSchema: { charge: z.string().describe('Charge id, e.g. ch_1') },
  },
  refund: {
    description: 'Refund part or all of a charge for a support ticket. amount is in minor units (5000 = £50.00).',
    inputSchema: {
      ticket: z.string().describe('Support ticket id, e.g. T-1'),
      charge: z.string().describe('Charge id'),
      amount: z.number().int().positive().describe('Amount in minor units'),
    },
  },
  send_email: {
    description: 'Send an email to the customer about their ticket.',
    inputSchema: {
      ticket: z.string(),
      to: z.string().describe('Recipient address'),
      subject: z.string(),
      body: z.string(),
    },
  },
}

/**
 * The three tool bodies. shake() wraps the raw backend call (the side-effect
 * boundary, where real timeouts and crashes happen). idempotent() goes OUTSIDE
 * shake(), keyed on the logical operation (ticket id, email intent). In 'fixed'
 * mode the same key is sent downstream as Stripe's Idempotency-Key / the
 * mailer's idempotency key: that covers the window where the side effect
 * committed but the ledger was never written (timeout, crash, redelivery).
 *
 * Called once per MCP server process, so 'per-server' ledgers and idempotent()'s
 * in-flight maps live and die with the server.
 */
export function createToolBodies(world: World, opts: Pick<RefundAgentOptions, 'mode' | 'ledger'>) {
  const downstream = opts.mode === 'fixed'
  const keyOpt = (): { idempotencyKey?: string } => {
    const key = downstream ? currentIdempotencyKey() : undefined
    return key ? { idempotencyKey: key } : {}
  }

  const rawRefund = shake('refund', async (a: RefundArgs) =>
    world.stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, keyOpt()),
  )
  const rawEmail = shake('send_email', async (a: EmailArgs) => world.mailer.send({ to: a.to, subject: a.subject, body: a.body }, keyOpt()))

  let refund = rawRefund
  let send_email = rawEmail
  if (opts.mode !== 'naive') {
    const durable = opts.ledger === 'durable'
    refund = idempotent(rawRefund, { key: (a) => `refund:${a.ticket}`, ...(durable ? { store: world.ledgers.refund } : {}) })
    send_email = idempotent(rawEmail, { key: (a) => `refund-email:${a.ticket}`, ...(durable ? { store: world.ledgers.email } : {}) })
  }

  return {
    lookup_charge: shake('lookup_charge', async (a: { charge: string }) => world.stripe.charges.retrieve(a.charge), { effect: 'read' }),
    refund,
    send_email,
  }
}

export function createRefundServer(world: World, opts: Pick<RefundAgentOptions, 'mode' | 'ledger'>): McpServer {
  const server = new McpServer({ name: 'shakedown-refunds', version: '0.0.1' })
  const annotations = toolAnnotations(opts.mode)
  const tools = createToolBodies(world, opts)

  server.registerTool(
    'lookup_charge',
    { ...TOOL_SPECS.lookup_charge, annotations: annotations.lookup_charge },
    async (args) => json(await tools.lookup_charge(args)),
  )
  server.registerTool('refund', { ...TOOL_SPECS.refund, annotations: annotations.refund }, async (args) =>
    json(await tools.refund(args)),
  )
  server.registerTool('send_email', { ...TOOL_SPECS.send_email, annotations: annotations.send_email }, async (args) =>
    json(await tools.send_email(args)),
  )
  // NOTE: no try/catch above. A thrown error (Stripe error, Shakedown fault,
  // even SimulatedCrash) is caught by McpServer's CallTool handler and returned
  // as a normal result { content: [{ type: 'text', text: err.message }], isError: true }.
  // That is why the host watches crashSignal() (see runMcpHost).
  return server
}

export function json(v: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(v) }] }
}

/** Start a fresh server + client pair over the SDK's in-memory transport. */
export async function connect(
  world: World,
  opts: Pick<RefundAgentOptions, 'mode' | 'ledger'>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createRefundServer(world, opts)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'shakedown-refund-host', version: '0.0.1' })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** The tool list exactly as an MCP host sees it over the protocol (with annotations). */
export async function listToolDefinitions(opts: Pick<RefundAgentOptions, 'mode'>): Promise<Tool[]> {
  const { client, close } = await connect(createWorld(), opts)
  try {
    return (await client.listTools()).tools
  } finally {
    await close()
  }
}

// ---------------------------------------------------------------------------
// MCP host loop + model interface
// ---------------------------------------------------------------------------

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | { role: 'assistant'; text: string }
  | {
      role: 'tool'
      id: string
      name: string
      isError: boolean
      text: string
      /** 'result': CallToolResult (isError set or not). 'jsonrpc-error': client.callTool() rejected. */
      via: 'result' | 'jsonrpc-error'
    }

export type ModelAction =
  /** id: the provider's tool-call id, when it has one (OpenAI needs it echoed back as tool_call_id). */
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown>; id?: string }
  | { type: 'final'; text: string }

export interface Model {
  next(transcript: readonly Turn[], tools: readonly Tool[]): Promise<ModelAction>
}

/**
 * Drives the MCP client for one process lifetime. `signal` is crashSignal() when
 * the scenario models host death on a crash: pass it to every tool call and stop
 * (rethrow `signal.reason`) once it aborts.
 */
export type Driver = (client: Client, task: string, world: World, signal?: AbortSignal) => Promise<string>

/**
 * A minimal MCP host: what Claude Desktop / an IDE / your own agent does with
 * an MCP client. Lists tools over the protocol, loops model -> tools/call -> model.
 * Tool failures are fed back to the model as error tool results, never thrown,
 * which is how MCP hosts behave.
 *
 * `signal` (pass crashSignal()) models the host process dying: it goes to
 * client.callTool(), and once it aborts the host stops and rethrows
 * `signal.reason`. The reason has to be read from the signal: the SDK rejects an
 * aborted request with McpError(-32001 "Request timed out") wrapping
 * String(reason), so the original error's identity is lost.
 */
export async function runMcpHost(
  client: Client,
  model: Model,
  task: string,
  transcript: Turn[],
  opts: { signal?: AbortSignal; maxTurns?: number } = {},
): Promise<string> {
  const { signal, maxTurns = 20 } = opts
  const requestOpts = signal ? { signal } : undefined
  const stopIfDead = () => {
    if (signal?.aborted) throw signal.reason
  }
  const { tools } = await client.listTools(undefined, requestOpts)
  transcript.push({ role: 'user', text: task })
  for (let turn = 0; turn < maxTurns; turn++) {
    stopIfDead()
    const action = await model.next(transcript, tools)
    if (action.type === 'final') {
      transcript.push({ role: 'assistant', text: action.text })
      return action.text
    }
    const id = action.id ?? `call_${turn + 1}`
    transcript.push({ role: 'assistant', call: { id, name: action.name, arguments: action.arguments } })
    let turnResult: Extract<Turn, { role: 'tool' }>
    try {
      const result = (await client.callTool({ name: action.name, arguments: action.arguments }, undefined, requestOpts)) as CallToolResult
      turnResult = { role: 'tool', id, name: action.name, isError: result.isError === true, text: textOf(result), via: 'result' }
    } catch (e) {
      // Protocol-level failure (JSON-RPC error, closed transport, request timeout, abort).
      turnResult = { role: 'tool', id, name: action.name, isError: true, text: e instanceof Error ? e.message : String(e), via: 'jsonrpc-error' }
    }
    stopIfDead() // a dead host records nothing more
    transcript.push(turnResult)
  }
  throw new Error(`agent did not finish within ${maxTurns} turns`)
}

function textOf(r: CallToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
}

/**
 * Scripted stand-in for an LLM. It follows the plan for TASK, and it is
 * REACTIVE to what the host feeds back: when the last tool result is an error
 * it re-issues the same call (up to maxAttempts total), the way models usually
 * do with "timed out" / "connection reset" errors. After maxAttempts it gives
 * up with a final answer, like a model that tells the user it could not finish.
 * It does not read Shakedown internals; it only sees the transcript.
 */
export function scriptedModel(maxAttempts = 3): Model {
  const plan: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: 'lookup_charge', arguments: { charge: 'ch_1' } },
    { name: 'refund', arguments: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
    {
      name: 'send_email',
      arguments: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund for T-1', body: 'Hi Ada, £50.00 is on its way to your card.' },
    },
  ]
  return {
    async next(transcript) {
      const results = transcript.filter((t): t is Extract<Turn, { role: 'tool' }> => t.role === 'tool')
      const last = results.at(-1)
      if (last?.isError) {
        const attempts = results.filter((r) => r.name === last.name).length
        if (attempts >= maxAttempts) {
          return { type: 'final', text: `Sorry, I could not complete ticket T-1: ${last.name} kept failing (${last.text}).` }
        }
        const step = plan.find((s) => s.name === last.name)!
        return { type: 'tool_call', ...step } // same tool, same arguments
      }
      const succeeded = new Set(results.filter((r) => !r.isError).map((r) => r.name))
      const nextStep = plan.find((s) => !succeeded.has(s.name))
      if (nextStep) return { type: 'tool_call', ...nextStep }
      return { type: 'final', text: 'Done: refunded £50.00 of ch_1 for T-1 and emailed ada@example.com.' }
    },
  }
}

export function scriptedDriver(model: Model = scriptedModel()): Driver {
  return (client, task, world, signal) => {
    const transcript: Turn[] = []
    world.transcripts.push(transcript)
    return runMcpHost(client, model, task, transcript, signal ? { signal } : {})
  }
}

// ---------------------------------------------------------------------------
// The factory + Shakedown scenario
// ---------------------------------------------------------------------------

export function createRefundAgent(opts: RefundAgentOptions) {
  const driver = opts.driver ?? scriptedDriver()
  /** One "process lifetime": start server + host, run the job, shut down. */
  const run = async (world: World): Promise<string> => {
    const { client, close } = await connect(world, opts)
    // crashSignal() is per run, not per phase: in the resume phase after a crash it
    // is the SAME, already-aborted signal. The new process must not inherit it.
    const sig = opts.abortOnCrash === false ? undefined : crashSignal()
    const signal = sig?.aborted ? undefined : sig
    try {
      return await driver(client, TASK, world, signal)
    } finally {
      await close()
    }
  }
  return {
    setup: createWorld,
    run,
    /**
     * MCP has no agent-run checkpoint/resume: the protocol has no notion of
     * "where the agent was". The idiomatic recovery is what a supervisor (or a
     * job queue redelivering the job) does: start a new host + server (a stdio
     * server is a child of the host and dies with it), reconnect, and re-run the
     * job from the task. Only the World survives; Shakedown wipes volatile state
     * (per-server ledgers, idempotent() in-flight maps) before this runs.
     */
    resume: run,
  }
}

export function scenarioName(opts: Pick<RefundAgentOptions, 'mode' | 'ledger'>): string {
  const what = opts.mode === 'naive' ? 'naive tools' : `${opts.mode}, ${opts.ledger ?? 'per-server'} ledger`
  return `mcp refund agent (${what})`
}

export function refundScenario(opts: RefundAgentOptions, name?: string): Scenario<World> {
  const agent = createRefundAgent(opts)
  return {
    name: name ?? scenarioName(opts),
    setup: agent.setup,
    run: agent.run,
    resume: agent.resume,
    invariants: [
      { name: 'refunded exactly £50', check: stripeInvariants.refundedExactly('ch_1', 5_000) },
      { name: 'one refund', check: stripeInvariants.refundCountAtMost('ch_1', 1) },
      // Exactly one: catches duplicates AND a job that silently stopped before emailing.
      { name: 'exactly one email', check: mailerInvariants.sentExactly('ada@example.com', 1) },
    ],
  }
}
