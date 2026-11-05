/**
 * The same three shake()-wrapped tools, served in-process by the Claude Agent SDK
 * (createSdkMcpServer + tool), driven by Claude Code's own agent loop via query().
 * Skipped unless ANTHROPIC_API_KEY is set. Not run in CI here.
 *
 * Error surfacing: createSdkMcpServer() builds a real McpServer and registerTool()s each
 * handler, so a thrown handler error becomes { content: [{ type: 'text', text }], isError: true },
 * exactly as in mcp.test.ts, and Claude sees it as an error tool_result.
 *
 * Resume: the Agent SDK's documented recovery is session resume. query() persists the
 * session transcript; after a crash we call query({ options: { resume: sessionId } }) to
 * continue the same conversation, so the model sees what it already did. Shakedown checks
 * whether that is enough to avoid redoing the refund (with naive tools it usually is not:
 * the committed call never returned a result before the process died). Shakedown also
 * calls resume for 'job-redelivery', so a finished session is resumed once more.
 *
 * Crash: the SDK's MCP server catches SimulatedCrash like any other error, so Claude
 * would see it as a tool error and carry on. To model a process death, the run phase
 * links crashSignal() to query()'s abortController and rethrows signal.reason.
 *
 * Wiring (core v2): createToolBodies() puts shake() at the Stripe/mailer call and
 * idempotent() outside it; the fixed variant sends the logical key downstream.
 *
 * The SDK MCP server runs in this process, but tool calls arrive from the Claude Code
 * subprocess over its control channel, so AsyncLocalStorage context may not survive;
 * Shakedown's fallback (used only while exactly one run phase is live, as here) covers that.
 */
import { createSdkMcpServer, query, tool, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { crashSignal, formatReport, mailerInvariants, runScenario, stripeInvariants, type Scenario } from '../../src/index.js'
import { TASK, TOOL_SPECS, createToolBodies, createWorld, json, toolAnnotations, type Mode, type World } from './refund-agent.js'

const SERVER = 'refunds'
const ALLOWED = ['lookup_charge', 'refund', 'send_email'].map((t) => `mcp__${SERVER}__${t}`)
const sessions = new WeakMap<World, string>()

function sdkServer(world: World, mode: Mode) {
  // Per-server (volatile) ledgers: the fix must not depend on a durable ledger.
  const bodies = createToolBodies(world, { mode })
  const ann = toolAnnotations(mode)
  return createSdkMcpServer({
    name: SERVER,
    version: '0.0.1',
    tools: [
      tool('lookup_charge', TOOL_SPECS.lookup_charge.description, TOOL_SPECS.lookup_charge.inputSchema, async (a) => json(await bodies.lookup_charge(a)), {
        annotations: ann.lookup_charge,
      }),
      tool('refund', TOOL_SPECS.refund.description, TOOL_SPECS.refund.inputSchema, async (a) => json(await bodies.refund(a)), {
        annotations: ann.refund,
      }),
      tool('send_email', TOOL_SPECS.send_email.description, TOOL_SPECS.send_email.inputSchema, async (a) => json(await bodies.send_email(a)), {
        annotations: ann.send_email,
      }),
    ],
  })
}

async function runQuery(world: World, mode: Mode, prompt: string, resume?: string): Promise<string> {
  // crashSignal() is per run: in the resume phase it is already aborted, so only link it while live.
  const crash = crashSignal()
  const live = crash && !crash.aborted ? crash : undefined
  const abortController = new AbortController()
  live?.addEventListener('abort', () => abortController.abort(live.reason), { once: true })
  const options: Options = {
    // A fresh in-process server per query (one "process lifetime"); the World is the durable state.
    mcpServers: { [SERVER]: sdkServer(world, mode) },
    abortController,
    tools: [], // no built-in Claude Code tools, only ours
    allowedTools: ALLOWED,
    settingSources: [], // isolation: ignore ~/.claude settings and CLAUDE.md
    systemPrompt: 'You are a customer-support agent. Use the tools to resolve the ticket. Amounts are in minor units (pence).',
    maxTurns: 15,
    ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
    ...(resume ? { resume } : {}),
  }
  let result: SDKResultMessage | undefined
  try {
    for await (const m of query({ prompt, options })) {
      if ('session_id' in m && typeof m.session_id === 'string') sessions.set(world, m.session_id)
      if (m.type === 'result') result = m
    }
  } catch (e) {
    if (live?.aborted) throw live.reason // the simulated crash, not the SDK's AbortError
    throw e
  }
  if (live?.aborted) throw live.reason
  if (!result) throw new Error('query ended without a result message')
  if (result.subtype !== 'success') throw new Error(`agent ended with ${result.subtype}`)
  return result.result
}

function scenario(mode: Mode): Scenario<World> {
  return {
    name: `claude-agent-sdk refund agent (${mode} tools)`,
    setup: createWorld,
    run: (w) => runQuery(w, mode, TASK),
    resume: (w) => {
      const id = sessions.get(w)
      // No session yet (crashed before init): nothing to resume, re-run the job.
      return id
        ? runQuery(w, mode, 'The previous run was interrupted by a process restart. Continue with the ticket.', id)
        : runQuery(w, mode, TASK)
    },
    invariants: [
      stripeInvariants.refundedExactly('ch_1', 5_000),
      stripeInvariants.refundCountAtMost('ch_1', 1),
      mailerInvariants.sentExactly('ada@example.com', 1),
    ],
  }
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Claude Agent SDK in-process MCP server', () => {
  it('naive tools: report observed results', { timeout: 20 * 60_000 }, async () => {
    const report = await runScenario(scenario('naive'))
    console.log(formatReport(report))
    expect(report.problems).toEqual([]) // report only: real models vary run to run
  })

  it('fixed tools (ledger + downstream key): every fault passes', { timeout: 20 * 60_000 }, async () => {
    const report = await runScenario(scenario('fixed'))
    console.log(formatReport(report))
    expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
  })
})
