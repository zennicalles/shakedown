/**
 * A scripted stand-in for an LLM, built on the AI SDK's own MockLanguageModelV3
 * (`ai/test` in ai 6.x, the major VoltAgent 2.x builds on). It is stateless like
 * a real model: every decision is derived from the prompt VoltAgent actually
 * sends, so it reacts to whatever the framework feeds back after a tool call.
 *
 * Plan: lookup_charge -> refund -> send_email -> final answer.
 * If the latest tool result is an error it re-issues the same call with the same
 * input (max 3 attempts per tool), which is what real models typically do.
 *
 * VoltAgent detail: a tool that throws does NOT reach the model as an AI SDK
 * `error-text` result. VoltAgent catches the error and returns it as the tool's
 * normal output, `{ error: true, name, message, stack, ... }`, so the model sees
 * `output.type === 'json'`. The script treats that object as an error, the way a
 * model reading `"error": true` would.
 */
import { MockLanguageModelV3 } from 'ai/test'

type CallOptions = Parameters<MockLanguageModelV3['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>
type Content = GenerateResult['content'][number]

const MAX_ATTEMPTS = 3

const PLAN: Array<{ toolName: string; input: Record<string, unknown> }> = [
  { toolName: 'lookup_charge', input: { charge: 'ch_1' } },
  { toolName: 'refund', input: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    toolName: 'send_email',
    input: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund for T-1', body: 'Your £50 refund on charge ch_1 is on its way.' },
  },
]

/** What the model saw as the result of a tool call, exactly as VoltAgent put it in the prompt. */
export interface ObservedToolResult {
  toolName: string
  outputType: string
  value: unknown
}

interface Event {
  toolName: string
  input: unknown
  outputType: string
  value: unknown
  isError: boolean
}

/** VoltAgent's shape for a thrown tool error (buildToolErrorResult). */
export function isVoltAgentToolError(v: unknown): v is { error: true; name: string; message: string } {
  return typeof v === 'object' && v !== null && (v as { error?: unknown }).error === true
}

function readEvents(prompt: CallOptions['prompt']): { events: Event[]; toolCalls: number } {
  const inputs = new Map<string, unknown>()
  const events: Event[] = []
  for (const msg of prompt) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) if (part.type === 'tool-call') inputs.set(part.toolCallId, part.input)
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const out = part.output as { type: string; value?: unknown; reason?: unknown }
        const value = out.type === 'execution-denied' ? out.reason : out.value
        events.push({
          toolName: part.toolName,
          input: inputs.get(part.toolCallId),
          outputType: out.type,
          value,
          isError: out.type === 'error-text' || out.type === 'error-json' || isVoltAgentToolError(value),
        })
      }
    }
  }
  return { events, toolCalls: inputs.size }
}

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}

function callTool(toolName: string, input: unknown, toolCalls: number): GenerateResult {
  const content: Content[] = [
    // Ids derived from the prompt, so a resumed process continues the sequence instead of reusing ids.
    { type: 'tool-call', toolCallId: `call_${toolCalls + 1}`, toolName, input: typeof input === 'string' ? input : JSON.stringify(input) },
  ]
  return { content, finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] }
}

function answer(text: string): GenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] }
}

function errorText(v: unknown): string {
  return isVoltAgentToolError(v) ? `${v.name}: ${v.message}` : String(v)
}

export function decide(prompt: CallOptions['prompt']): GenerateResult {
  const { events, toolCalls } = readEvents(prompt)
  const last = events.at(-1)
  if (!last) return callTool(PLAN[0]!.toolName, PLAN[0]!.input, toolCalls)

  if (last.outputType === 'execution-denied') return answer(`The ${last.toolName} was not approved, so I stopped.`)

  if (last.isError) {
    let attempts = 0
    for (let i = events.length - 1; i >= 0 && events[i]!.toolName === last.toolName; i--) attempts++
    if (attempts < MAX_ATTEMPTS) return callTool(last.toolName, last.input, toolCalls)
    return answer(`I could not complete ${last.toolName} after ${attempts} attempts: ${errorText(last.value)}`)
  }

  const idx = PLAN.findIndex((p) => p.toolName === last.toolName)
  const next = PLAN[idx + 1]
  if (next) return callTool(next.toolName, next.input, toolCalls)
  return answer('Refunded £50 on ch_1 for ticket T-1 and emailed ada@example.com.')
}

export interface ScriptOptions {
  /** Records what the model saw as the latest tool result on every call. */
  observed?: ObservedToolResult[]
  /**
   * Throw this error from the model call right after the Nth successful refund
   * result appears in the prompt (default: never). Simulates a provider 500 /
   * overloaded error mid-loop, AFTER a side effect committed.
   */
  failAfterRefund?: { error: () => Error; times: number }
  /** Every prompt the model received (for assertions on what VoltAgent sends). */
  prompts?: CallOptions['prompt'][]
  /**
   * Simulated network latency per model call, in ms. Default 1. A real provider
   * call yields to the event loop; VoltAgent's memory writes the user's input on
   * a setTimeout(0) background queue, so a model that answers without yielding
   * (latencyMs: 0) reorders and clobbers memory in ways production rarely sees.
   * See the 'memory race' tests.
   */
  latencyMs?: number
}

export function scriptedRefundModel(opts: ScriptOptions = {}): MockLanguageModelV3 {
  let failuresLeft = opts.failAfterRefund?.times ?? 0
  const latencyMs = opts.latencyMs ?? 1
  return new MockLanguageModelV3({
    provider: 'shakedown-scripted',
    modelId: 'refund-script',
    doGenerate: async (options) => {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs))
      opts.prompts?.push(structuredClone(options.prompt))
      const { events } = readEvents(options.prompt)
      const last = events.at(-1)
      if (last && opts.observed) opts.observed.push({ toolName: last.toolName, outputType: last.outputType, value: last.value })
      if (failuresLeft > 0 && last?.toolName === 'refund' && !last.isError) {
        failuresLeft--
        throw opts.failAfterRefund!.error()
      }
      return decide(options.prompt)
    },
  })
}
