/**
 * A scripted stand-in for an LLM, speaking the OpenAI chat-completions wire
 * format that AgentKit's `openai()` adapter sends. It is stateless like a real
 * model: every decision is derived from the request body AgentKit actually
 * built, so it reacts to whatever the framework feeds back after a tool call.
 *
 * Plan: lookup_charge -> refund -> send_email -> final answer.
 * If the latest tool result is an error it re-issues the same call with the same
 * input (max 3 attempts per tool), which is what real models typically do.
 *
 * How it is reached. AgentKit has no pluggable model interface: an agent's
 * `model` is an `@inngest/ai` adapter (a URL + format), and AgentKit either
 * `fetch()`es that URL itself (outside Inngest) or hands the request to Inngest
 * as a `step.ai.infer` op that the Inngest SERVER executes (inside an Inngest
 * function). So the scripted model lives behind a fake URL:
 *  - outside Inngest, installScriptedFetch() answers fetch() calls to that host;
 *  - inside Inngest, the LocalInngest executor (local-inngest.ts) plays the
 *    server's AI gateway and calls callScriptedModel() with the op's body.
 * Nothing leaves the process.
 */
import { openai } from '@inngest/agent-kit'

export const SCRIPTED_HOST = 'scripted-model.invalid'
const MAX_ATTEMPTS = 3

const PLAN: Array<{ toolName: string; input: Record<string, unknown> }> = [
  { toolName: 'lookup_charge', input: { charge: 'ch_1' } },
  { toolName: 'refund', input: { ticket: 'T-1', charge: 'ch_1', amount: 5000 } },
  {
    toolName: 'send_email',
    input: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund for T-1', body: 'Your £50 refund on charge ch_1 is on its way.' },
  },
]

/** OpenAI chat request, as much of it as the script reads. */
export interface ChatRequest {
  model?: string
  messages: Array<
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
    | { role: 'tool'; tool_call_id: string; content: string }
  >
  tools?: Array<{ function: { name: string } }>
}

/** What the model saw as the result of a tool call, exactly as AgentKit put it in the prompt. */
export interface ObservedToolResult {
  toolName: string
  /** 'error' when AgentKit sent `{ error: ... }`, 'data' for `{ data: ... }`. */
  kind: 'data' | 'error'
  /** The parsed tool message content. */
  content: unknown
}

interface Event {
  toolName: string
  input: unknown
  kind: 'data' | 'error'
  content: unknown
}

function readEvents(req: ChatRequest): { events: Event[]; toolCalls: number } {
  const calls = new Map<string, { name: string; input: unknown }>()
  const events: Event[] = []
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      for (const c of m.tool_calls ?? []) calls.set(c.id, { name: c.function.name, input: JSON.parse(c.function.arguments) })
    } else if (m.role === 'tool') {
      const call = calls.get(m.tool_call_id)
      let content: unknown = m.content
      try {
        content = JSON.parse(m.content)
      } catch {
        /* plain string result */
      }
      const isError = typeof content === 'object' && content !== null && 'error' in content
      events.push({ toolName: call?.name ?? '?', input: call?.input, kind: isError ? 'error' : 'data', content })
    }
  }
  return { events, toolCalls: calls.size }
}

function completion(message: Record<string, unknown>, finish: 'tool_calls' | 'stop') {
  return {
    id: 'chatcmpl-scripted',
    object: 'chat.completion',
    created: 0,
    model: 'refund-script',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }
}

function callTool(toolName: string, input: unknown, toolCalls: number) {
  // Ids derived from the prompt, so a resumed process continues the sequence instead of reusing ids.
  const id = `call_${toolCalls + 1}`
  return completion({ content: null, tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: JSON.stringify(input) } }] }, 'tool_calls')
}

function answer(text: string) {
  return completion({ content: text }, 'stop')
}

function errorText(content: unknown): string {
  const e = (content as { error?: { name?: string; message?: string } }).error
  return e ? `${e.name ?? 'Error'}: ${e.message ?? ''}` : String(content)
}

export function decide(req: ChatRequest) {
  const { events, toolCalls } = readEvents(req)
  const last = events.at(-1)
  if (!last) return callTool(PLAN[0]!.toolName, PLAN[0]!.input, toolCalls)

  if (last.kind === 'error') {
    let attempts = 0
    for (let i = events.length - 1; i >= 0 && events[i]!.toolName === last.toolName; i--) attempts++
    if (attempts < MAX_ATTEMPTS) return callTool(last.toolName, last.input, toolCalls)
    return answer(`I could not complete ${last.toolName} after ${attempts} attempts: ${errorText(last.content)}`)
  }

  const idx = PLAN.findIndex((p) => p.toolName === last.toolName)
  const next = PLAN[idx + 1]
  if (next) return callTool(next.toolName, next.input, toolCalls)
  return answer('Refunded £50 on ch_1 for ticket T-1 and emailed ada@example.com.')
}

// ---------------------------------------------------------------------------
// Routing requests to the script

interface Registered {
  observed?: ObservedToolResult[]
  requests: ChatRequest[]
}
const registry = new Map<string, Registered>()
let nextId = 0

/** Answer one chat request sent to a scripted URL. Used by the fetch stub and by LocalInngest's AI gateway. */
export function callScriptedModel(url: string, body: ChatRequest): ReturnType<typeof decide> {
  const u = new URL(url)
  if (u.hostname !== SCRIPTED_HOST) throw new Error(`not a scripted model URL: ${url}`)
  const reg = registry.get(u.pathname.split('/')[1] ?? '')
  if (!reg) throw new Error(`unknown scripted model: ${url}`)
  reg.requests.push(structuredClone(body))
  const last = readEvents(body).events.at(-1)
  if (last && reg.observed) reg.observed.push({ toolName: last.toolName, kind: last.kind, content: last.content })
  return decide(body)
}

/**
 * An AgentKit model adapter backed by the script. `observed` collects the tool
 * result the model saw on every call; `requests` (returned) every request body.
 */
export function scriptedRefundModel(observed?: ObservedToolResult[]) {
  const id = `m${++nextId}`
  const reg: Registered = { requests: [], ...(observed ? { observed } : {}) }
  registry.set(id, reg)
  const adapter = openai({ model: 'refund-script', apiKey: 'scripted', baseUrl: `http://${SCRIPTED_HOST}/${id}/v1/` })
  return Object.assign(adapter, { scriptedRequests: reg.requests })
}

let installed = false
/**
 * Make fetch() calls to the scripted host answer from the script. Other URLs
 * go to the real fetch. Idempotent. Needed only for AgentKit outside Inngest,
 * where AgentKit fetch()es the model URL itself.
 */
export function installScriptedFetch(): void {
  if (installed) return
  installed = true
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).hostname !== SCRIPTED_HOST) return realFetch(input, init)
    const body = JSON.parse(String(init?.body ?? '{}')) as ChatRequest
    return new Response(JSON.stringify(callScriptedModel(url, body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
