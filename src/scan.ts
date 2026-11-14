import { spawn } from 'node:child_process'

/**
 * `agent-shakedown scan`: list an MCP server's tools and flag the ones that can do their side effect twice
 * when an agent retries after a timeout, because they give the caller no idempotency key to send.
 *
 * It is a static check on names, input schemas and annotations: it never calls a tool. Findings are leads
 * to confirm with a crash test, not proof.
 */

export interface McpTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string }
}

interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  additionalProperties?: boolean | JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
}

export type Verdict =
  | 'unkeyed' //        a write with no way to pass an idempotency key
  | 'key-no-guidance' // takes a key, but nothing tells the model to reuse it when retrying
  | 'generic' //        a pass-through API tool: which calls write, and with what key, is up to the model
  | 'keyed' //          takes a key and says to reuse it on retry
  | 'declared-idempotent' // annotations.idempotentHint === true
  | 'repeat-safe' //    update/delete/cancel style: repeating it lands in the same state (usually)
  | 'read'

export interface ToolFinding {
  name: string
  verdict: Verdict
  /** high: moves money or sends a message; medium: creates or changes something else; info: not counted */
  severity: 'high' | 'medium' | 'info'
  why: string
  keyParam?: string
}

export interface ScanResult {
  server: string
  tools: ToolFinding[]
  /** Tools that can repeat a side effect on retry (unkeyed, key-no-guidance, generic). */
  atRisk: number
  high: number
}

const READ_VERBS = new Set(
  'get list search show find fetch read retrieve describe lookup query count check verify validate preview estimate calculate download export view inspect explain summarize summarise browse resolve whoami ping health status'.split(' '),
)
const REPEAT_SAFE_VERBS = new Set(
  'update set put patch edit modify rename replace upsert delete remove cancel void archive unarchive disable enable close reopen revoke deactivate activate unsubscribe mark pause resume toggle'.split(' '),
)
// Name tokens for side effects that cost money or reach a person when repeated.
const HIGH_TOKENS =
  /^(refund|refunds|pay|payment|payments|payout|payouts|charge|charges|capture|transfer|transfers|withdraw|withdrawal|send|email|emails|sms|message|messages|invoice|invoices|order|orders|purchase|buy|sell|swap|trade|mint|wire|disburse|tip|donate|book|booking|reply|post|publish|tweet|notify|notification|call|dial|subscription|subscriptions)$/
const KEY_PARAM = /idempot|^request_?id$|^requestid$|dedup|unique_?key|client_?(reference_?id|request_?id|token)|^nonce$/i
const RETRY_GUIDANCE = /(same|reuse|re-use|identical)[^.]{0,80}(retr|again|resend|repeat)|(retr|resend|repeat)[^.]{0,80}(same|reuse|re-use|identical)/i
const GENERIC_SELECTOR = /^(method|endpoint|path|operation|operation_?id|api|action|route|url|tool|tool_?name)$/i
const GENERIC_BODY = /^(request|body|params|parameters|payload|data|args|arguments|input)$/i

/** Split snake_case, kebab-case, dotted and camelCase names into lower-case tokens. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

/** Every property in an input schema, depth-first, with its dotted path. Bounded so a cyclic schema can't hang it. */
function properties(schema: JsonSchema | undefined, prefix = '', depth = 0, out: Array<{ path: string; name: string; schema: JsonSchema }> = []) {
  if (!schema || typeof schema !== 'object' || depth > 4 || out.length > 500) return out
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name
    out.push({ path, name, schema: sub ?? {} })
    properties(sub, path, depth + 1, out)
  }
  if (schema.items) properties(schema.items, `${prefix}[]`, depth + 1, out)
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) for (const s of schema[k] ?? []) properties(s, prefix, depth + 1, out)
  return out
}

function isOpenObject(s: JsonSchema): boolean {
  const types = Array.isArray(s.type) ? s.type : [s.type]
  return types.includes('object') && (!s.properties || Object.keys(s.properties).length === 0 || s.additionalProperties === true || typeof s.additionalProperties === 'object')
}

export function classifyTool(tool: McpTool): ToolFinding {
  const tokens = nameTokens(tool.name)
  const verb = tokens[0] ?? ''
  const ann = tool.annotations ?? {}
  const props = properties(tool.inputSchema)
  const top = props.filter((p) => !p.path.includes('.') && !p.path.includes('['))
  const isHigh = tokens.some((t) => HIGH_TOKENS.test(t))
  const severity = isHigh ? 'high' : 'medium'

  if (ann.readOnlyHint === true) return { name: tool.name, verdict: 'read', severity: 'info', why: 'annotated read-only' }

  const generic = top.some((p) => GENERIC_SELECTOR.test(p.name)) && top.some((p) => GENERIC_BODY.test(p.name) && isOpenObject(p.schema))
  if (generic) {
    const reachesMoney = /refund|payment|charge|transfer|payout|invoice|email|sms|message/i.test(tool.description ?? '')
    return {
      name: tool.name,
      verdict: 'generic',
      severity: reachesMoney ? 'high' : 'medium',
      why: 'pass-through API tool: whether a call writes, and whether it carries an idempotency key, is left to the model',
    }
  }

  if (ann.readOnlyHint !== false && READ_VERBS.has(verb)) return { name: tool.name, verdict: 'read', severity: 'info', why: `read-only by name (${verb})` }
  if (ann.idempotentHint === true) return { name: tool.name, verdict: 'declared-idempotent', severity: 'info', why: 'annotated idempotentHint: repeating it has no extra effect' }

  const key = props.find((p) => KEY_PARAM.test(p.name))
  if (key) {
    const text = `${key.schema.description ?? ''} ${tool.description ?? ''}`
    if (RETRY_GUIDANCE.test(text)) return { name: tool.name, verdict: 'keyed', severity: 'info', why: `takes '${key.path}' and says to reuse it on retry`, keyParam: key.path }
    return {
      name: tool.name,
      verdict: 'key-no-guidance',
      severity,
      why: `takes '${key.path}', but nothing tells the model to reuse it when retrying; a fresh key on retry repeats the action`,
      keyParam: key.path,
    }
  }

  if (REPEAT_SAFE_VERBS.has(verb)) return { name: tool.name, verdict: 'repeat-safe', severity: 'info', why: `${verb}: repeating it usually lands in the same state` }

  return {
    name: tool.name,
    verdict: 'unkeyed',
    severity,
    why: isHigh ? 'moves money or reaches a person; no idempotency key parameter' : 'creates or changes something; no idempotency key parameter',
  }
}

const AT_RISK: Verdict[] = ['unkeyed', 'key-no-guidance', 'generic']

export function analyzeTools(server: string, tools: McpTool[]): ScanResult {
  const findings = tools.map(classifyTool)
  const risky = findings.filter((f) => AT_RISK.includes(f.verdict))
  return { server, tools: findings, atRisk: risky.length, high: risky.filter((f) => f.severity === 'high').length }
}

// ---------------------------------------------------------------------------------------------------------
// Talking to a server: just enough MCP (initialize, initialized, tools/list) over stdio or streamable HTTP.

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'agent-shakedown-scan', version: '1' }

interface RpcResponse { id?: number | string; result?: any; error?: { code: number; message: string } }

function quoteWin(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/** Start a stdio MCP server, list its tools, stop it. */
export async function listToolsStdio(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ serverName: string; tools: McpTool[] }> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  // Windows can only start npx/.cmd shims through a shell, so pass one quoted command line; a real .exe runs directly.
  const win = process.platform === 'win32'
  const child = win && !/\.exe$/i.test(command)
    ? spawn([command, ...args].map(quoteWin).join(' '), { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, cwd: opts.cwd, windowsHide: true })
    : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, cwd: opts.cwd })

  let stderr = ''
  child.stderr!.on('data', (d) => {
    if (stderr.length < 4000) stderr += String(d)
  })
  const pending = new Map<number, (r: RpcResponse) => void>()
  let buf = ''
  child.stdout!.on('data', (d) => {
    buf += String(d)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue // servers that log to stdout
      let msg: RpcResponse
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      }
    }
  })

  let exited: string | undefined
  const exitWaiters: Array<() => void> = []
  child.on('exit', (code, signal) => {
    exited = `exited (${signal ?? code})`
    for (const w of exitWaiters) w()
  })
  child.on('error', (e) => {
    exited = `failed to start: ${e.message}`
    for (const w of exitWaiters) w()
  })

  let nextId = 1
  const send = (msg: object) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      const fail = () => reject(new Error(`server ${exited} before answering ${method}${stderr ? `\n--- server stderr ---\n${stderr.trim()}` : ''}`))
      if (exited) return fail()
      exitWaiters.push(fail)
      pending.set(id, (r) => (r.error ? reject(new Error(`${method}: ${r.error.message}`)) : resolve(r.result)))
      send({ id, method, params })
    })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s${stderr ? `\n--- server stderr ---\n${stderr.trim()}` : ''}`)), timeoutMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })
        send({ method: 'notifications/initialized' })
        const tools: McpTool[] = []
        let cursor: string | undefined
        for (let page = 0; page < 50; page++) {
          const res = await request('tools/list', cursor ? { cursor } : {})
          tools.push(...(res?.tools ?? []))
          cursor = res?.nextCursor
          if (!cursor) break
        }
        return { serverName: String(init?.serverInfo?.name ?? command), tools }
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
    child.stdin!.end()
    if (!exited) {
      if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      else child.kill()
    }
  }
}

/** List the tools of a streamable-HTTP MCP server. */
export async function listToolsHttp(url: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<{ serverName: string; tools: McpTool[] }> {
  let session: string | undefined
  let nextId = 1
  const post = async (msg: { method: string; params?: object }): Promise<RpcResponse | undefined> => {
    const id = msg.method.startsWith('notifications/') ? undefined : nextId++
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(session ? { 'mcp-session-id': session } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), ...msg }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    session = res.headers.get('mcp-session-id') ?? session
    if (id === undefined) return undefined
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${(await res.text()).slice(0, 300)}`)
    const text = await res.text()
    const type = res.headers.get('content-type') ?? ''
    const messages: RpcResponse[] = type.includes('text/event-stream')
      ? text
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => {
            try {
              return JSON.parse(l.slice(5).trim())
            } catch {
              return {}
            }
          })
      : [JSON.parse(text)]
    const reply = messages.find((m) => m.id === id)
    if (!reply) throw new Error(`no JSON-RPC reply to request ${id} from ${url}`)
    if (reply.error) throw new Error(reply.error.message)
    return reply
  }
  const init = await post({ method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } })
  await post({ method: 'notifications/initialized' })
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = await post({ method: 'tools/list', params: cursor ? { cursor } : {} })
    tools.push(...(res?.result?.tools ?? []))
    cursor = res?.result?.nextCursor
    if (!cursor) break
  }
  return { serverName: String(init?.result?.serverInfo?.name ?? new URL(url).host), tools }
}

// ---------------------------------------------------------------------------------------------------------
// Output

export function formatScan(r: ScanResult, color = false): string {
  const c = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s)
  const width = Math.min(40, Math.max(12, ...r.tools.map((t) => t.name.length)))
  const row = (f: ToolFinding) => `    ${f.severity === 'high' ? c('31', 'HIGH') : c('33', 'MED ')}  ${f.name.padEnd(width)}  ${f.why}`
  const group = (title: string, v: Verdict) => {
    const fs = r.tools.filter((f) => f.verdict === v).sort((a, b) => (a.severity === b.severity ? a.name.localeCompare(b.name) : a.severity === 'high' ? -1 : 1))
    return fs.length ? ['', `  ${c('1', title)} (${fs.length})`, ...fs.map(row)] : []
  }
  const count = (v: Verdict) => r.tools.filter((f) => f.verdict === v).length
  const verdict = r.atRisk === 0 ? c('32', 'no retry risks found') : `${c(r.high ? '31' : '33', `${r.atRisk} tool(s) can repeat a side effect on retry`)}${r.high ? `, ${r.high} of them move money or reach a person` : ''}`
  const lines = [
    `shakedown scan: ${r.server}  (${r.tools.length} tools)  ${verdict}`,
    ...group('No idempotency key: a retry after a timeout runs it again', 'unkeyed'),
    ...group('Takes a key, but the model is never told to reuse it on retry', 'key-no-guidance'),
    ...group('Pass-through API tools: retry safety is left to the model', 'generic'),
    '',
    `  ok: ${count('keyed')} keyed with retry guidance, ${count('declared-idempotent')} annotated idempotent, ${count('repeat-safe')} update/delete-style, ${count('read')} read-only`,
  ]
  if (r.atRisk > 0) {
    lines.push(
      '',
      `${c('1', 'Why it matters:')} when a call times out after the provider has acted, the agent or framework retries and the`,
      '  action happens twice. Models retried a timed-out email in 25 of 28 runs in our tests.',
      `${c('1', 'Fix:')} accept an idempotency key, send it as the provider's idempotency header, and say in the description`,
      '  "reuse the same key when retrying this request". See https://github.com/zennicalles/shakedown#the-fix-it-points-to',
      `${c('1', 'Note:')} this is a static check of names, schemas and annotations; confirm with a crash test.`,
    )
  }
  return `${lines.join('\n')}\n`
}

export const SCAN_USAGE = `Usage:
  npx agent-shakedown scan -- <command> [args...]    start a stdio MCP server and check its tools
  npx agent-shakedown scan --url <url> [--header "Name: value"]   check a streamable-HTTP MCP server
  npx agent-shakedown scan --file tools.json          check a saved tools/list result

Options:
  --json         print the findings as JSON
  --timeout <s>  seconds to wait for the server (default 30)

Exit code 1 when a tool that moves money or reaches a person can repeat on retry.
Examples:
  npx agent-shakedown scan -- npx -y @paypal/mcp --tools=all
  npx agent-shakedown scan -- node build/index.js
`
