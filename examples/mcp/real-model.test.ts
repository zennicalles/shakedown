/**
 * The same scenario with a real model as the MCP host's brain. Skipped unless a key is set.
 *
 *   ANTHROPIC_API_KEY  -> Anthropic SDK's own agent loop: client.beta.messages.toolRunner()
 *                         with mcpTools(), which adapts the MCP client's tools. An isError
 *                         CallToolResult becomes a ToolError, sent back as tool_result is_error:true.
 *   OPENAI_API_KEY     -> runMcpHost() (this example's MCP host loop) with an OpenAI chat model.
 *
 * Optional: ANTHROPIC_MODEL (default claude-sonnet-5-5), OPENAI_MODEL (default gpt-5.4-mini).
 *
 * Real models are not deterministic: the naive run's per-fault results are printed, not
 * asserted. The fixed run (ledger + key sent downstream, volatile per-server ledgers) must
 * pass whatever the model does, that is the point of the fix.
 *
 * Crash: both drivers get crashSignal() (via refundScenario) and stop on it, rethrowing
 * signal.reason, so a simulated crash is a process death and not a tool error the model
 * can talk its way around. mcpTools() calls client.callTool() without request options,
 * so the Anthropic driver hands it a thin client wrapper that adds the signal.
 */
import Anthropic from '@anthropic-ai/sdk'
import { mcpTools } from '@anthropic-ai/sdk/helpers/beta/mcp'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { formatReport, runScenario } from '../../src/index.js'
import { findLyingAnnotations, formatLyingAnnotations } from './lying-annotations.js'
import { listToolDefinitions, refundScenario, runMcpHost, type Driver, type Model, type Turn } from './refund-agent.js'

const SYSTEM =
  'You are a customer-support agent. Use the tools to resolve the ticket. Amounts are in minor units (pence). ' +
  'When you are done, reply with a one-line summary.'

type McpClientLike = Parameters<typeof mcpTools>[1]

const anthropicDriver: Driver = async (client, task, world, signal) => {
  const anthropic = new Anthropic()
  const { tools } = await client.listTools()
  const transcript: Turn[] = [{ role: 'user', text: task }]
  world.transcripts.push(transcript)
  // mcpTools() calls callTool({ name, arguments }) with no request options: add the crash signal here.
  const mcpClient: McpClientLike = {
    callTool: async (params) => {
      try {
        return (await client.callTool(params, undefined, signal ? { signal } : undefined)) as Awaited<ReturnType<McpClientLike['callTool']>>
      } catch (e) {
        if (signal?.aborted) throw signal.reason
        throw e
      }
    },
  }
  let final: Anthropic.Beta.Messages.BetaMessage
  try {
    final = await anthropic.beta.messages.toolRunner(
      {
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
        max_tokens: 2048,
        max_iterations: 15,
        system: SYSTEM,
        messages: [{ role: 'user', content: task }],
        tools: mcpTools(tools as Parameters<typeof mcpTools>[0], mcpClient),
      },
      signal ? { signal } : undefined,
    )
  } catch (e) {
    // The runner turns a throwing tool into an is_error tool_result; the aborted signal
    // then stops the next API call. Report the crash, not the SDK's abort error.
    if (signal?.aborted) throw signal.reason
    throw e
  }
  if (signal?.aborted) throw signal.reason
  const text = final.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
  transcript.push({ role: 'assistant', text })
  return text
}

function openaiModel(): Model {
  const openai = new OpenAI()
  return {
    async next(transcript: readonly Turn[], tools: readonly Tool[]) {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM }]
      for (const t of transcript) {
        if (t.role === 'user') messages.push({ role: 'user', content: t.text })
        else if (t.role === 'assistant' && 'call' in t)
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: t.call.id, type: 'function', function: { name: t.call.name, arguments: JSON.stringify(t.call.arguments) } }],
          })
        else if (t.role === 'assistant') messages.push({ role: 'assistant', content: t.text })
        // MCP's isError has no OpenAI equivalent; hosts mark it in the text.
        else messages.push({ role: 'tool', tool_call_id: t.id, content: t.isError ? `Error: ${t.text}` : t.text })
      }
      const res = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? 'gpt-5.4-mini',
        messages,
        parallel_tool_calls: false,
        tools: tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema as Record<string, unknown> },
        })),
      })
      const msg = res.choices[0]!.message
      const call = msg.tool_calls?.find((c) => c.type === 'function')
      if (call && call.type === 'function') {
        return { type: 'tool_call', id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments || '{}') }
      }
      return { type: 'final', text: msg.content ?? '' }
    },
  }
}

const openaiDriver: Driver = (client, task, world, signal) => {
  const transcript: Turn[] = []
  world.transcripts.push(transcript)
  return runMcpHost(client, openaiModel(), task, transcript, signal ? { signal } : {})
}

const driver: Driver = process.env.ANTHROPIC_API_KEY ? anthropicDriver : openaiDriver

describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY)('MCP refund agent with a real model', () => {
  it('naive tools: report observed results', { timeout: 15 * 60_000 }, async () => {
    const report = await runScenario(refundScenario({ mode: 'naive', driver }))
    console.log(formatReport(report))
    console.log(formatLyingAnnotations(findLyingAnnotations(report, await listToolDefinitions({ mode: 'naive' }))))
    // The model must at least do the job when nothing goes wrong.
    expect(report.problems).toEqual([]) // report only: real models vary run to run
  })

  it('fixed tools (ledger + downstream key): every fault passes', { timeout: 15 * 60_000 }, async () => {
    const report = await runScenario(refundScenario({ mode: 'fixed', driver }))
    console.log(formatReport(report))
    expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
  })
})
