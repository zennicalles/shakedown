/**
 * A reactive scripted model that implements the Agents SDK `Model` interface, so
 * the SDK's real run loop (tool dispatch, error handling, approvals, RunState)
 * drives it exactly like it would drive gpt-x.
 *
 * It is NOT a fixed script. On every turn it reads the conversation the SDK
 * actually sends it and decides the next step from that:
 *  - walk the plan (lookup_charge -> refund -> send_email -> final answer)
 *  - a step is done when the history holds a tool result for it that does not
 *    look like an error
 *  - if the latest result for the current step looks like an error, re-issue the
 *    same call (up to MAX_ATTEMPTS calls in total), which is what real models do
 *    with "An error occurred... Please try again."
 *  - after MAX_ATTEMPTS failures, give up with a final answer
 *
 * Whatever the SDK feeds back (error text, a generic message, a rejection) is what
 * the model reacts to; nothing about faults is known here.
 */
import { Usage, type AgentInputItem, type Model, type ModelRequest, type ModelResponse, type protocol, type StreamEvent } from '@openai/agents'
import { assistantMessage, functionCall } from '@openai/agents/testing'

export const TASK = 'Ticket T-1: refund £50 of charge ch_1 and email ada@example.com'
export const MAX_ATTEMPTS = 3

export interface PlanStep {
  name: string
  args: Record<string, unknown>
}

export const REFUND_PLAN: PlanStep[] = [
  { name: 'lookup_charge', args: { charge: 'ch_1' } },
  { name: 'refund', args: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    name: 'send_email',
    args: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund for T-1', body: 'We have refunded £50 to your card.' },
  },
]

/** What a model would read as "that tool call failed". */
export function looksLikeError(output: string): boolean {
  return /\berror\b|timed out|timeout|failed|reset|hang up|connection closed|exited unexpectedly|not approved|rejected|denied/i.test(output)
}

export interface ToolEvent {
  name: string
  callId: string
  arguments: string
  output?: string
}

export class ReactiveRefundModel implements Model {
  /** Every request the SDK sent, for assertions and for recording what the model saw. */
  readonly requests: ModelRequest[] = []
  /** The tool-result texts the model observed, in order (deduplicated by callId). */
  readonly observedResults = new Map<string, { name: string; output: string }>()

  constructor(private readonly plan: PlanStep[] = REFUND_PLAN) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const output = this.decide(request)
    return { usage: new Usage({ requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }), output, responseId: `resp_${this.requests.length}` }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const r = await this.getResponse(request)
    yield { type: 'response_started' }
    yield {
      type: 'response_done',
      response: {
        id: r.responseId ?? `resp_${this.requests.length}`,
        usage: { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        // AgentOutputItem and the stream-event item schema are structurally the same items, typed separately.
        output: r.output as protocol.StreamEventResponseCompleted['response']['output'],
      },
    }
  }

  private decide(request: ModelRequest): ModelResponse['output'] {
    const events = toolEvents(request.input)
    for (const e of events) if (e.output !== undefined) this.observedResults.set(e.callId, { name: e.name, output: e.output })
    const nextCallId = `call_${events.length + 1}`

    for (const step of this.plan) {
      const mine = events.filter((e) => e.name === step.name)
      if (mine.some((e) => e.output !== undefined && !looksLikeError(e.output))) continue // step done

      if (mine.length >= MAX_ATTEMPTS) {
        return [assistantMessage(`I could not complete ${step.name} after ${mine.length} attempts. Escalating ticket T-1 to a human.`)]
      }
      return [functionCall(step.name, step.args, { callId: nextCallId })]
    }
    return [assistantMessage('Done: refunded £50 on ch_1 for ticket T-1 and emailed ada@example.com.')]
  }
}

/** Pair function calls with their results from the model-visible input. */
export function toolEvents(input: string | AgentInputItem[]): ToolEvent[] {
  if (typeof input === 'string') return []
  const byId = new Map<string, ToolEvent>()
  const order: ToolEvent[] = []
  for (const item of input) {
    if (item.type === 'function_call') {
      const e: ToolEvent = { name: item.name, callId: item.callId, arguments: item.arguments }
      byId.set(item.callId, e)
      order.push(e)
    } else if (item.type === 'function_call_result') {
      const e = byId.get(item.callId)
      if (e) e.output = outputText(item.output)
    }
  }
  return order
}

function outputText(o: unknown): string {
  if (typeof o === 'string') return o
  if (Array.isArray(o)) return o.map(outputText).join('\n')
  if (o && typeof o === 'object') {
    const r = o as { type?: string; text?: string }
    if ((r.type === 'text' || r.type === 'input_text') && typeof r.text === 'string') return r.text
    return JSON.stringify(o)
  }
  return String(o)
}
