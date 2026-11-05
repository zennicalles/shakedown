/**
 * A scripted, REACTIVE stand-in for an LLM, speaking the AI SDK LanguageModelV4
 * spec (ai@7 `MockLanguageModelV4`), which is what @mastra/core 1.82 accepts.
 *
 * It holds no state of its own: every decision is derived from the prompt that
 * Mastra sends it, so a fresh instance in a "new process" (DurableAgent
 * recovery) behaves exactly like the original would given the same history.
 *
 * Policy, matching what real models typically do:
 *  - work through the plan lookup_charge -> refund -> send_email -> final answer
 *  - a step is done once the framework fed back a successful tool result for it
 *  - if the LAST result for the current step is an error, re-issue the same call,
 *    up to 3 attempts in total, then give up and answer with the failure
 */
import { MockLanguageModelV4 } from 'ai/test'

export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'

export const PLAN = [
  { toolName: 'lookup_charge', input: { charge: 'ch_1' } },
  { toolName: 'refund', input: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    toolName: 'send_email',
    input: {
      ticket: 'T-1',
      to: 'ada@example.com',
      subject: 'Your refund for T-1',
      body: 'Hi Ada, we have refunded £50 to your card. It should arrive in 5-10 days.',
    },
  },
] as const

export const MAX_ATTEMPTS = 3

type MockOpts = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>
type DoGenerate = Extract<NonNullable<MockOpts['doGenerate']>, (...a: any[]) => any>
type CallOptions = Parameters<DoGenerate>[0]
type GenerateResult = Awaited<ReturnType<DoGenerate>>
type Prompt = CallOptions['prompt']
type Content = GenerateResult['content'][number]

/** What the model saw fed back for one tool result, as Mastra serialised it. */
export interface ObservedToolResult {
  toolName: string
  outputType: string
  value: unknown
}

export type Decision =
  | { kind: 'tool-call'; toolName: string; input: unknown; attempt: number }
  | { kind: 'final'; text: string }

function toolResults(prompt: Prompt): ObservedToolResult[] {
  const out: ObservedToolResult[] = []
  for (const m of prompt) {
    if (m.role !== 'tool' && m.role !== 'assistant') continue
    for (const part of m.content) {
      if (part.type !== 'tool-result') continue
      out.push({ toolName: part.toolName, outputType: part.output.type, value: 'value' in part.output ? part.output.value : undefined })
    }
  }
  return out
}

function isError(r: ObservedToolResult): boolean {
  return r.outputType === 'error-text' || r.outputType === 'error-json'
}

export function decide(prompt: Prompt): Decision {
  const results = toolResults(prompt)
  const done: string[] = []
  for (const step of PLAN) {
    const mine = results.filter((r) => r.toolName === step.toolName)
    if (mine.some((r) => !isError(r))) {
      done.push(step.toolName)
      continue
    }
    if (mine.length >= MAX_ATTEMPTS) {
      const last = mine[mine.length - 1]!
      return { kind: 'final', text: `I could not complete ${step.toolName} after ${mine.length} attempts: ${String(last.value)}` }
    }
    // Either never tried, or the last attempt came back as an error: (re)issue the same call.
    return { kind: 'tool-call', toolName: step.toolName, input: step.input, attempt: mine.length + 1 }
  }
  return { kind: 'final', text: `Done: looked up ch_1, refunded £50 on ticket T-1 and emailed ada@example.com.` }
}

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

export interface ScriptedModel extends MockLanguageModelV4 {
  /** Every tool result the model was shown, per model call, in order. */
  seen: ObservedToolResult[][]
}

export function createScriptedModel(): ScriptedModel {
  const seen: ObservedToolResult[][] = []
  const respond = (opts: CallOptions): GenerateResult => {
    seen.push(toolResults(opts.prompt))
    const d = decide(opts.prompt)
    if (d.kind === 'final') {
      return { content: [{ type: 'text', text: d.text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] }
    }
    // Unique across the conversation, and stable when recovery replays the same history.
    const n = opts.prompt.reduce((k, m) => k + (m.role === 'assistant' ? m.content.filter((p) => p.type === 'tool-call').length : 0), 0)
    const call: Content = {
      type: 'tool-call',
      toolCallId: `call_${n + 1}_${d.toolName}_${d.attempt}`,
      toolName: d.toolName,
      input: JSON.stringify(d.input),
    }
    return { content: [call], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, warnings: [] }
  }
  const model = new MockLanguageModelV4({
    provider: 'shakedown',
    modelId: 'scripted-refund-model',
    doGenerate: async (opts) => respond(opts),
    doStream: async (opts) => {
      const r = respond(opts)
      const parts: any[] = [{ type: 'stream-start', warnings: [] }]
      for (const c of r.content) {
        if (c.type === 'text') parts.push({ type: 'text-start', id: 't0' }, { type: 'text-delta', id: 't0', delta: c.text }, { type: 'text-end', id: 't0' })
        else parts.push(c)
      }
      parts.push({ type: 'finish', usage: r.usage, finishReason: r.finishReason })
      return {
        stream: new ReadableStream({
          start(ctrl) {
            for (const p of parts) ctrl.enqueue(p)
            ctrl.close()
          },
        }),
      }
    },
  }) as ScriptedModel
  model.seen = seen
  return model
}
