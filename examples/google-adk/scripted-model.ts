/**
 * A scripted stand-in for an LLM, built on ADK's own model interface
 * (`BaseLlm` from `@google/adk`). It is stateless like a real model: every
 * decision is derived from the `LlmRequest.contents` ADK actually builds from
 * the session, so it reacts to whatever the framework feeds back after a tool
 * call (result, `{ error }` payload, the abort seal, a reflect-and-retry note).
 *
 * Plan: lookup_charge -> refund -> send_email -> final answer.
 * If the latest tool result is an error it re-issues the same call with the same
 * args (max 3 attempts per tool), which is what real models typically do.
 */
import { BaseLlm, REFLECT_AND_RETRY_RESPONSE_TYPE, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk'

// genai types, derived from ADK's own request type so no extra dependency is needed.
type Content = LlmRequest['contents'][number]

const MAX_ATTEMPTS = 3

const PLAN: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'lookup_charge', args: { charge: 'ch_1' } },
  { name: 'refund', args: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    name: 'send_email',
    args: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund for T-1', body: 'Your £50 refund on charge ch_1 is on its way.' },
  },
]

/** What the model saw as the result of a tool call, exactly as ADK put it in the request. */
export interface ObservedToolResult {
  toolName: string
  response: Record<string, unknown>
}

interface ToolEvent {
  toolName: string
  args: unknown
  response: Record<string, unknown>
}

export function isErrorResponse(r: Record<string, unknown>): boolean {
  return 'error' in r || r['response_type'] === REFLECT_AND_RETRY_RESPONSE_TYPE
}

/** Pair every functionResponse with its functionCall (by id, else the latest call of that name). */
export function readToolEvents(contents: Content[]): { events: ToolEvent[]; toolCalls: number; danglingCalls: string[] } {
  const calls = new Map<string, { name: string; args: unknown }>()
  const byName = new Map<string, unknown>()
  const answered = new Set<string>()
  const order: Array<{ id: string | undefined; name: string }> = []
  const events: ToolEvent[] = []
  for (const c of contents) {
    for (const part of c.parts ?? []) {
      const fc = part.functionCall
      if (fc?.name) {
        if (fc.id) calls.set(fc.id, { name: fc.name, args: fc.args })
        byName.set(fc.name, fc.args)
        order.push({ id: fc.id, name: fc.name })
      }
      const fr = part.functionResponse
      if (fr?.name) {
        if (fr.id) answered.add(fr.id)
        events.push({
          toolName: fr.name,
          args: (fr.id ? calls.get(fr.id)?.args : undefined) ?? byName.get(fr.name),
          response: (fr.response ?? {}) as Record<string, unknown>,
        })
      }
    }
  }
  const danglingCalls = order.filter((o) => o.id && !answered.has(o.id)).map((o) => o.name)
  return { events, toolCalls: order.length, danglingCalls }
}

function callTool(name: string, args: unknown, toolCalls: number): LlmResponse {
  return {
    content: {
      role: 'model',
      // Ids derived from the request, so a resumed process continues the sequence instead of reusing ids.
      parts: [{ functionCall: { id: `call_${toolCalls + 1}`, name, args: structuredClone(args) as Record<string, unknown> } }],
    },
    turnComplete: true,
  }
}

function answer(text: string): LlmResponse {
  return { content: { role: 'model', parts: [{ text }] }, turnComplete: true }
}

export function decide(contents: Content[]): LlmResponse {
  const { events, toolCalls } = readToolEvents(contents)
  const last = events.at(-1)
  if (!last) return callTool(PLAN[0]!.name, PLAN[0]!.args, toolCalls)

  if (isErrorResponse(last.response)) {
    if (String(last.response['error'] ?? '').includes('rejected')) return answer(`The ${last.toolName} was not approved, so I stopped.`)
    let attempts = 0
    for (let i = events.length - 1; i >= 0 && events[i]!.toolName === last.toolName && isErrorResponse(events[i]!.response); i--) attempts++
    if (attempts < MAX_ATTEMPTS) return callTool(last.toolName, last.args, toolCalls)
    return answer(`I could not complete ${last.toolName} after ${attempts} attempts: ${JSON.stringify(last.response)}`)
  }

  const idx = PLAN.findIndex((p) => p.name === last.toolName)
  const next = PLAN[idx + 1]
  if (next) return callTool(next.name, next.args, toolCalls)
  return answer('Refunded £50 on ch_1 for ticket T-1 and emailed ada@example.com.')
}

export interface ScriptOptions {
  /** Every tool result the model saw last, per model call. */
  observed?: ObservedToolResult[]
  /** Every request's contents, as ADK built them. */
  requests?: Content[][]
}

export class ScriptedRefundModel extends BaseLlm {
  constructor(private readonly opts: ScriptOptions = {}) {
    super({ model: 'shakedown-refund-script' })
  }

  async *generateContentAsync(llmRequest: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const contents = structuredClone(llmRequest.contents)
    this.opts.requests?.push(contents)
    const last = readToolEvents(contents).events.at(-1)
    if (last && this.opts.observed) this.opts.observed.push({ toolName: last.toolName, response: last.response })
    yield decide(contents)
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedRefundModel does not support live mode')
  }
}

export function scriptedRefundModel(opts?: ScriptOptions): ScriptedRefundModel {
  return new ScriptedRefundModel(opts)
}
