/**
 * A scripted stand-in for an LLM, built on the AI SDK's own MockLanguageModelV4
 * (`ai/test`). It is stateless like a real model: every decision is derived from
 * the prompt the SDK actually sends, so it reacts to whatever the framework feeds
 * back after a tool call (result, error text, denial).
 *
 * Plan: lookup_charge -> refund -> send_email -> final answer.
 * If the latest tool result is an error it re-issues the same call with the same
 * input (max 3 attempts per tool), which is what real models typically do.
 */
import { MockLanguageModelV4 } from 'ai/test'

// Provider-spec types, derived from the mock so no extra dependency is needed.
type LanguageModelV4CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]
type LanguageModelV4GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>
type LanguageModelV4Content = LanguageModelV4GenerateResult['content'][number]

const MAX_ATTEMPTS = 3

const PLAN: Array<{ toolName: string; input: Record<string, unknown> }> = [
  { toolName: 'lookup_charge', input: { charge: 'ch_1' } },
  { toolName: 'refund', input: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    toolName: 'send_email',
    input: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund for T-1', body: 'Your £50 refund on charge ch_1 is on its way.' },
  },
]

/** What the model saw as the result of a tool call, exactly as the SDK put it in the prompt. */
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
}

function readEvents(prompt: LanguageModelV4CallOptions['prompt']): { events: Event[]; toolCalls: number } {
  const inputs = new Map<string, unknown>()
  const events: Event[] = []
  for (const msg of prompt) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) if (part.type === 'tool-call') inputs.set(part.toolCallId, part.input)
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue
        const out = part.output as { type: string; value?: unknown; reason?: unknown }
        events.push({
          toolName: part.toolName,
          input: inputs.get(part.toolCallId),
          outputType: out.type,
          value: out.type === 'execution-denied' ? out.reason : out.value,
        })
      }
    }
  }
  return { events, toolCalls: inputs.size }
}

const usage: LanguageModelV4GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}

function callTool(toolName: string, input: unknown, toolCalls: number): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [
    // Ids derived from the prompt, so a resumed process continues the sequence instead of reusing ids.
    { type: 'tool-call', toolCallId: `call_${toolCalls + 1}`, toolName, input: JSON.stringify(input) },
  ]
  return { content, finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] }
}

function answer(text: string): LanguageModelV4GenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] }
}

export function decide(prompt: LanguageModelV4CallOptions['prompt']): LanguageModelV4GenerateResult {
  const { events, toolCalls } = readEvents(prompt)
  const last = events.at(-1)
  if (!last) return callTool(PLAN[0]!.toolName, PLAN[0]!.input, toolCalls)

  if (last.outputType === 'execution-denied') return answer(`The ${last.toolName} was not approved, so I stopped.`)

  if (last.outputType === 'error-text' || last.outputType === 'error-json') {
    let attempts = 0
    for (let i = events.length - 1; i >= 0 && events[i]!.toolName === last.toolName; i--) attempts++
    if (attempts < MAX_ATTEMPTS) return callTool(last.toolName, last.input, toolCalls)
    return answer(`I could not complete ${last.toolName} after ${attempts} attempts: ${String(last.value)}`)
  }

  const idx = PLAN.findIndex((p) => p.toolName === last.toolName)
  const next = PLAN[idx + 1]
  if (next) return callTool(next.toolName, next.input, toolCalls)
  return answer('Refunded £50 on ch_1 for ticket T-1 and emailed ada@example.com.')
}

export function scriptedRefundModel(observed?: ObservedToolResult[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'shakedown-scripted',
    modelId: 'refund-script',
    doGenerate: async (options) => {
      const last = readEvents(options.prompt).events.at(-1)
      if (last && observed) observed.push({ toolName: last.toolName, outputType: last.outputType, value: last.value })
      return decide(options.prompt)
    },
  })
}
