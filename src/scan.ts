import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

/**
 * `agent-shakedown scan`: list an MCP server's tools and flag the ones that can do their side effect twice
 * when an agent retries after a timeout, because they give the caller no idempotency key to send.
 *
 * It is a static check on names, input schemas and annotations: it never calls a tool. Findings are leads
 * to confirm with a crash test, not proof. When unsure, it errs towards flagging: a false "no risks" is the
 * worst thing it can print.
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
  required?: string[]
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
  /** tools/list entries that weren't objects with a string name, so couldn't be judged. */
  skipped: number
}

// ---------------------------------------------------------------------------------------------------------
// Words. A tool name is split into words (create_refund, sendEmail, acme.pay-order). The action is the first
// word that is a known verb, so a vendor prefix (slack_, acme_) is skipped.

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))
const READ_VERBS = words(`get list search show find fetch read retrieve describe lookup query count check verify validate
  preview estimate calculate download export view inspect explain summarize summarise browse whoami ping health
  parse format convert extract translate compare diff analyze analyse lint scan render`)
// Nouns that make a name a read when no unambiguous write verb is present: charge_status, trade_history, swap_quote.
// Not "report" or "log": email_report and post_log send things.
const READ_NOUNS = words(`status history quote quotes details detail info balance balances rate rates price prices lookup
  stats metrics estimate preview`)
const REPEAT_SAFE_VERBS = words(`update set put patch edit modify rename replace upsert delete remove cancel void archive
  unarchive disable enable close reopen revoke deactivate activate unsubscribe mark pause resume`)
const CREATE_VERBS = words(`create add make new insert issue submit execute run start generate record register enroll
  invite schedule upload import place initiate trigger apply accept approve reject resolve duplicate copy clone
  assign reassign attach link connect test open fork deploy provision allocate grant`)
// Verbs whose repeat moves money or reaches a person. The ambiguous ones are also common nouns (email_lookup,
// text_to_speech, charge_status) and only count as the action under the conditions in isHighAction().
const HIGH_VERBS = words(`pay send notify reply publish purchase buy sell mint wire donate dial withdraw disburse checkout
  tweet broadcast sms text email message call post refund charge capture transfer trade swap tip book payout`)
const AMBIGUOUS_HIGH = words('text email message call post charge transfer trade swap refund capture tip book payout sms')
const UNAMBIGUOUS_WRITE = new Set([...CREATE_VERBS, ...[...HIGH_VERBS].filter((w) => !AMBIGUOUS_HIGH.has(w))])
const MONEY_NOUNS = words(`refund refunds payout payouts transfer transfers charge charges capture captures withdrawal
  withdrawals disbursement disbursements`)
// Things whose creation is itself the side effect: create_payment, create_message.
const SENT_THINGS = words('payment payments message messages email emails sms notification notifications tweet')
const MESSAGING = words('send notify reply text email message call dial sms tweet broadcast post publish')
const RECIPIENT_WORDS = words('user users customer customers contact contacts phone number recipient recipients team channel member members')
const RECIPIENT_PARAM = /^(to|cc|bcc|recipients?|phone(_?number)?|email(_?address)?|number|channel(_?id)?|chat_?id|user_?id|contact_?id|address|destination|webhook_?url)$/i

const KEY_PARAM = /idempot|^request_?id$|^requestid$|dedup|unique_?key|client_?(reference_?id|request_?id|token)|^nonce$/i
const GENERIC_SELECTOR = /^(method|http_?method|endpoint|path|operation|operation_?id|api|action|route|url|tool|tool_?name)$/i
const GENERIC_METHOD = /^(method|http_?method)$/i
const GENERIC_BODY = /^(request|body|params|parameters|payload|data|args|arguments|input)$/i
const ID_PARAM = /(^|_)id$|[a-z]Id$/
// Inputs that make a call carry new content or money, rather than just point at an existing record.
const PAYLOAD_PARAM = /amount|value|price|quantity|total|currency|recipient|^to$|^to_|^cc$|^bcc$|email|phone|destination|subject|body|text|html|content|message|payload|items|note|data|params|input|request|args/i
// A required id that names the message itself: send-broadcast(broadcastId), send_invoice(invoice_id).
const MESSAGE_ID = /broadcast|campaign|invoice|draft|message|email|newsletter/i

/** Split snake_case, kebab-case, dotted and camelCase names into lower-case words. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

/** Every property in an input schema, depth-first, with its dotted path. Bounded so a cyclic schema can't hang it. */
function properties(schema: unknown, prefix = '', depth = 0, out: Array<{ path: string; name: string; schema: JsonSchema }> = []) {
  if (!schema || typeof schema !== 'object' || depth > 4 || out.length > 500) return out
  const s = schema as JsonSchema
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {}
  for (const [name, sub] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name
    out.push({ path, name, schema: sub && typeof sub === 'object' ? sub : {} })
    properties(sub, path, depth + 1, out)
  }
  if (s.items) properties(s.items, `${prefix}[]`, depth + 1, out)
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = s[k]
    if (Array.isArray(list)) for (const sub of list) properties(sub, prefix, depth + 1, out)
  }
  return out
}

function isOpenObject(s: JsonSchema): boolean {
  const types = Array.isArray(s.type) ? s.type : [s.type]
  return types.includes('object') && (!s.properties || Object.keys(s.properties).length === 0 || s.additionalProperties === true || typeof s.additionalProperties === 'object')
}

/**
 * True when a sentence tells the model to send the same key again when it retries. It must be a positive
 * instruction ("reuse the key", "retry with the same idempotency_key"), in a sentence that is about retrying and
 * about the key, and not negated ("never reuse a key"). `ownDescription`: the text is the key's own description,
 * so "reuse it when retrying" counts without naming the key.
 */
export function hasRetryGuidance(text: string, keyName?: string, ownDescription = false): boolean {
  const keyWords = `key|idempoten\\w*|request[_ -]?id${keyName ? `|${keyName.replace(/[^A-Za-z0-9_]/g, '')}` : ''}`
  const sameKey = new RegExp(`\\b(same|identical)\\b[^.;]{0,20}?\\b(${keyWords})\\b`, 'i')
  const aboutKey = new RegExp(`\\b(${keyWords})\\b`, 'i')
  const retry = /\b(retry|retries|retrying|retried|resend|resending|resent|repeat|repeating|repeated|again)\b/i
  const reuse = /\b(reuse|re-use)\b/i
  const negated = /\b(not|never|don't|do not|must not|mustn't|cannot|can't|no)\b\W+(?:[\w'-]+\W+){0,3}?(reuse|re-use|use the same|send the same|same)\b/i
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((s) => retry.test(s) && !negated.test(s) && (sameKey.test(s) || (reuse.test(s) && (ownDescription || aboutKey.test(s)))))
}

interface Shape {
  tokens: string[]
  /** The action word: the first word that is a known verb (skipping a vendor prefix), else the first word. */
  act: string
  /** A word that makes the tool a write whatever else its name says: create, pay, send, "and refund", check-out. */
  writeWord: string | undefined
}

function shape(name: string): Shape {
  const tokens = nameTokens(name)
  const known = (t: string) => READ_VERBS.has(t) || REPEAT_SAFE_VERBS.has(t) || CREATE_VERBS.has(t) || HIGH_VERBS.has(t)
  const act = tokens.find(known) ?? tokens[0] ?? ''
  let writeWord = tokens.find((t) => UNAMBIGUOUS_WRITE.has(t))
  for (let i = 0; i < tokens.length && !writeWord; i++) {
    const t = tokens[i]!
    const next = tokens[i + 1] ?? ''
    // get_or_create_x, verify_and_pay, cancel_and_refund_order: whatever follows "and"/"or" is an action too.
    if ((t === 'and' || t === 'or') && (HIGH_VERBS.has(next) || CREATE_VERBS.has(next) || MONEY_NOUNS.has(next))) writeWord = next
    if (t === 'check' && next === 'out') writeWord = 'check out'
  }
  return { tokens, act, writeWord }
}

function isHighAction(sh: Shape, props: Array<{ name: string }>): boolean {
  const { tokens, act } = sh
  if (tokens.some((t) => MONEY_NOUNS.has(t))) return true
  if (tokens.includes('checkout') || sh.writeWord === 'check out') return true
  if (sh.writeWord && HIGH_VERBS.has(sh.writeWord) && !AMBIGUOUS_HIGH.has(sh.writeWord)) return true
  if (HIGH_VERBS.has(act)) {
    if (!AMBIGUOUS_HIGH.has(act)) return true
    // email_customer, text_user, message_team, or a recipient parameter: a messaging verb. text_to_speech: not.
    if (MESSAGING.has(act)) {
      const after = tokens.slice(tokens.indexOf(act) + 1)
      return RECIPIENT_WORDS.has(after[0] ?? '') || after.some((t) => SENT_THINGS.has(t)) || props.some((p) => RECIPIENT_PARAM.test(p.name))
    }
    return true // refund_payment, charge_customer, transfer_funds, book_flight
  }
  // create_payment, find_or_create_message: creating the thing is the side effect.
  const last = tokens[tokens.length - 1] ?? ''
  return SENT_THINGS.has(last) && (CREATE_VERBS.has(act) || (sh.writeWord !== undefined && CREATE_VERBS.has(sh.writeWord)))
}

export function classifyTool(tool: McpTool): ToolFinding {
  const name = tool.name
  const sh = shape(name)
  const ann = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {}
  const props = properties(tool.inputSchema)
  const top = props.filter((p) => !p.path.includes('.') && !p.path.includes('['))
  const desc = typeof tool.description === 'string' ? tool.description : ''
  const isHigh = isHighAction(sh, props)
  const severity = isHigh ? 'high' : 'medium'
  const readByName = !sh.writeWord && (READ_VERBS.has(sh.act) || (!REPEAT_SAFE_VERBS.has(sh.act) && !CREATE_VERBS.has(sh.act) && sh.tokens.some((t) => READ_NOUNS.has(t))))

  if (ann.readOnlyHint === true) return { name, verdict: 'read', severity: 'info', why: 'annotated read-only' }

  // A pass-through tool (a selector plus an open request object). A read-named one counts only if the caller
  // picks the HTTP method: get_resource(path, params) is a read, api_request(method, path, body) is not.
  const generic =
    top.some((p) => GENERIC_SELECTOR.test(p.name)) &&
    top.some((p) => GENERIC_BODY.test(p.name) && isOpenObject(p.schema)) &&
    (!readByName || top.some((p) => GENERIC_METHOD.test(p.name)))
  if (generic) {
    if (hasRetryGuidance(desc)) return { name, verdict: 'keyed', severity: 'info', why: 'pass-through API tool whose description tells the model to reuse the idempotency key on retry' }
    const reachesMoney = /refund|payment|charge|transfer|payout|invoice|email|sms|message/i.test(desc) || isHigh
    return {
      name,
      verdict: 'generic',
      severity: reachesMoney ? 'high' : 'medium',
      why: 'pass-through API tool: whether a call writes, and whether it carries an idempotency key, is left to the model',
    }
  }

  if (ann.readOnlyHint !== false && readByName) return { name, verdict: 'read', severity: 'info', why: `read-only by name (${READ_VERBS.has(sh.act) ? sh.act : sh.tokens.find((t) => READ_NOUNS.has(t))})` }
  if (ann.idempotentHint === true) return { name, verdict: 'declared-idempotent', severity: 'info', why: 'annotated idempotentHint: repeating it has no extra effect' }

  const key = props.find((p) => KEY_PARAM.test(p.name))
  if (key) {
    const guided = hasRetryGuidance(key.schema.description ?? '', key.name, true) || hasRetryGuidance(desc, key.name)
    if (guided) return { name, verdict: 'keyed', severity: 'info', why: `takes '${key.path}' and says to reuse it on retry`, keyParam: key.path }
    return {
      name,
      verdict: 'key-no-guidance',
      severity,
      why: `takes '${key.path}', but nothing tells the model to reuse it when retrying; a fresh key on retry repeats the action`,
      keyParam: key.path,
    }
  }

  if (REPEAT_SAFE_VERBS.has(sh.act) && !sh.writeWord) return { name, verdict: 'repeat-safe', severity: 'info', why: `${sh.act}: repeating it usually lands in the same state` }

  // pay_order(id), send-broadcast(broadcastId): a repeat targets the same record, which providers often refuse
  // (already captured, already sent). Still a lead, but not the same risk as a refund with an amount. A send
  // whose id names a person or a template (send_sms(contact_id, template_id)) really does send again.
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema!.required!.filter((r) => typeof r === 'string') : []
  const onlyIds = required.length > 0 && required.every((n) => ID_PARAM.test(n)) && !props.some((p) => PAYLOAD_PARAM.test(p.name) && !ID_PARAM.test(p.name))
  const messaging = MESSAGING.has(sh.act) || (sh.writeWord !== undefined && MESSAGING.has(sh.writeWord))
  if (isHigh && onlyIds && (!messaging || required.some((n) => MESSAGE_ID.test(n)))) {
    return {
      name,
      verdict: 'unkeyed',
      severity: 'medium',
      why: `no idempotency key, but it only targets an existing record (${required.join(', ')}); check whether the provider rejects a repeat (already captured, already sent)`,
    }
  }

  return {
    name,
    verdict: 'unkeyed',
    severity,
    why: isHigh ? 'moves money or reaches a person; no idempotency key parameter' : 'creates or changes something; no idempotency key parameter',
  }
}

const AT_RISK: Verdict[] = ['unkeyed', 'key-no-guidance', 'generic']

/** Tools that aren't objects with a string name can't be judged; they are counted in `skipped`. */
export function isTool(t: unknown): t is McpTool {
  return !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' && (t as { name: string }).name.length > 0
}

export function analyzeTools(server: string, tools: unknown[]): ScanResult {
  const valid = tools.filter(isTool)
  const findings = valid.map(classifyTool)
  const risky = findings.filter((f) => AT_RISK.includes(f.verdict))
  return { server, tools: findings, atRisk: risky.length, high: risky.filter((f) => f.severity === 'high').length, skipped: tools.length - valid.length }
}

// ---------------------------------------------------------------------------------------------------------
// Talking to a server: just enough MCP (initialize, initialized, tools/list) over stdio or streamable HTTP.

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'agent-shakedown-scan', version: '1' }

interface RpcMessage { jsonrpc?: string; id?: number | string | null; method?: string; result?: any; error?: { code: number; message: string } }

/** A reply to one of our requests (not a server-to-client request or notification, and not a stray log line). */
function isResponse(m: RpcMessage): boolean {
  return !!m && m.jsonrpc === '2.0' && !('method' in m) && ('result' in m || 'error' in m)
}

/** What we answer when the server sends us a request: ping gets {}, anything else "method not found". */
function answerServerRequest(m: RpcMessage): object | undefined {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string' || !('id' in m) || m.id === null || m.id === undefined) return undefined
  return m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `agent-shakedown scan does not support ${m.method}` } }
}

function toolsFrom(result: any, method: string): { tools: unknown[]; nextCursor?: string } {
  if (!result || !Array.isArray(result.tools)) throw new Error(`${method} returned no tools array`)
  return { tools: result.tools, nextCursor: typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined }
}

// Windows: .exe files start directly; .cmd/.bat shims (npx, pnpm, globally installed CLIs) need cmd.exe, with
// arguments escaped for both cmd and the program's own parser (the approach cross-spawn uses).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function escapeWinArg(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"') // backslashes before a quote double, the quote is escaped
  a = a.replace(/(\\*)$/, '$1$1') // trailing backslashes double (they precede our closing quote)
  a = `"${a}"`.replace(CMD_META, '^$1')
  return doubleEscape ? a.replace(CMD_META, '^$1') : a
}

/** Find a command the way cmd.exe would (PATH x PATHEXT). */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const candidates = (base: string) => (extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e))
  const hasDir = /[\\/]/.test(command) || isAbsolute(command)
  const dirs = hasDir ? [''] : [process.cwd(), ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)]
  for (const dir of dirs) for (const c of candidates(dir ? join(dir, command) : command)) if (existsSync(c)) return c
  return undefined
}

function spawnServer(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): ChildProcess {
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe']
  if (process.platform !== 'win32') return spawn(command, args, { stdio, env, cwd, detached: true })
  const resolved = resolveWindowsCommand(command, env)
  if (resolved && /\.(exe|com)$/i.test(resolved)) return spawn(resolved, args, { stdio, env, cwd, windowsHide: true })
  const target = resolved ?? command
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(target)
  const line = [target.replace(CMD_META, '^$1'), ...args.map((a) => escapeWinArg(a, doubleEscape))].join(' ')
  return spawn(env.comspec ?? env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio, env, cwd, windowsHide: true, windowsVerbatimArguments: true })
}

function stopServer(child: ChildProcess) {
  child.stdin?.end()
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } else {
      // The server runs in its own process group: stop it and anything it started.
      const kill = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig)
        } catch {
          child.kill(sig)
        }
      }
      kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.signalCode === null && kill('SIGKILL'), 2000).unref()
    }
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

/** Start a stdio MCP server, list its tools, stop it. */
export async function listToolsStdio(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ serverName: string; tools: unknown[] }> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const child = spawnServer(command, args, opts.env ?? process.env, opts.cwd)
  child.stdin!.on('error', () => {}) // writing to a server that already died must not crash the CLI

  let stderr = ''
  const withStderr = (msg: string) => `${msg}${stderr.trim() ? `\n--- server stderr ---\n${stderr.trim()}` : ''}`
  child.stderr!.on('data', (d) => {
    if (stderr.length < 4000) stderr += String(d)
  })
  const send = (msg: object) => {
    if (child.stdin!.writable) child.stdin!.write(`${JSON.stringify(msg)}\n`)
  }
  const pending = new Map<number, (r: RpcMessage) => void>()
  let buf = ''
  child.stdout!.on('data', (d) => {
    buf += String(d)
    if (buf.length > 64 * 1024 * 1024) buf = '' // a runaway server; the timeout reports it
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue // servers that log to stdout
      let msg: RpcMessage
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const answer = answerServerRequest(msg)
      if (answer) send(answer)
      else if (isResponse(msg) && typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      }
    }
  })

  let exited: string | undefined
  const exitWaiters: Array<() => void> = []
  const onGone = (why: string) => {
    exited ??= why
    for (const w of exitWaiters.splice(0)) w()
  }
  child.on('exit', (code, signal) => onGone(`exited (${signal ?? code})`))
  child.on('error', (e) => onGone(`failed to start: ${e.message}`))

  let nextId = 1
  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      const fail = () => reject(new Error(withStderr(`server ${exited} before answering ${method}`)))
      if (exited) return fail()
      exitWaiters.push(fail)
      pending.set(id, (r) => (r.error ? reject(new Error(`${method}: ${r.error.message}`)) : resolve(r.result)))
      send({ jsonrpc: '2.0', id, method, params })
    })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(withStderr(`no answer within ${timeoutMs / 1000}s`))), timeoutMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const tools: unknown[] = []
        let cursor: string | undefined
        for (let page = 0; page < 50; page++) {
          const res = toolsFrom(await request('tools/list', cursor ? { cursor } : {}), 'tools/list')
          tools.push(...res.tools)
          cursor = res.nextCursor
          if (!cursor) break
        }
        return { serverName: String(init?.serverInfo?.name ?? command), tools }
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
    stopServer(child)
  }
}

/** Read one JSON-RPC reply from a streamable-HTTP response (JSON or SSE), answering server requests on the way. */
async function readReply(res: Response, id: number, onServerRequest: (answer: object) => void): Promise<RpcMessage> {
  const type = res.headers.get('content-type') ?? ''
  const handle = (m: RpcMessage): RpcMessage | undefined => {
    const answer = answerServerRequest(m)
    if (answer) onServerRequest(answer)
    else if (isResponse(m) && m.id === id) return m
    return undefined
  }
  if (!type.includes('text/event-stream')) {
    const body = JSON.parse(await res.text())
    for (const m of Array.isArray(body) ? body : [body]) {
      const r = handle(m)
      if (r) return r
    }
    throw new Error(`no JSON-RPC reply to request ${id}`)
  }
  // SSE: read event by event and stop as soon as our reply arrives; a server may leave the stream open.
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value) buf += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
        const event = buf.slice(0, sep)
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '')
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        let m: RpcMessage
        try {
          m = JSON.parse(data)
        } catch {
          continue
        }
        const r = handle(m)
        if (r) return r
      }
      if (done) throw new Error(`stream ended without a reply to request ${id}`)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** List the tools of a streamable-HTTP MCP server. */
export async function listToolsHttp(url: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<{ serverName: string; tools: unknown[] }> {
  const signal = AbortSignal.timeout(timeoutMs)
  let session: string | undefined
  let nextId = 1
  const postRaw = (body: object) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(session ? { 'mcp-session-id': session } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    })
  // Answers to server requests (ping) go back as their own POST; the server doesn't reply with a body.
  const answer = (msg: object) => void postRaw(msg).then((r) => r.body?.cancel()).catch(() => {})
  const request = async (method: string, params: object) => {
    const id = nextId++
    const res = await postRaw({ jsonrpc: '2.0', id, method, params })
    session = res.headers.get('mcp-session-id') ?? session
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${(await res.text()).slice(0, 300)}`)
    const reply = await readReply(res, id, answer)
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
    return reply.result
  }
  const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })
  const note = await postRaw({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await note.body?.cancel().catch(() => {}) // 202 with no body, or a stream we don't need
  const tools: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = toolsFrom(await request('tools/list', cursor ? { cursor } : {}), 'tools/list')
    tools.push(...res.tools)
    cursor = res.nextCursor
    if (!cursor) break
  }
  return { serverName: String(init?.serverInfo?.name ?? new URL(url).host), tools }
}

// ---------------------------------------------------------------------------------------------------------
// Output

export function formatScan(r: ScanResult, color = false): string {
  const c = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s)
  if (r.tools.length === 0) {
    return `shakedown scan: ${r.server}  ${c('33', 'the server listed no tools')}${r.skipped ? ` (${r.skipped} malformed entr${r.skipped === 1 ? 'y' : 'ies'} skipped)` : ''}\n  Nothing was checked. Many servers only list tools when a flag or env var enables them (e.g. --tools=all).\n`
  }
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
    ...(r.skipped ? [`  note: ${r.skipped} malformed tools/list entr${r.skipped === 1 ? 'y was' : 'ies were'} skipped`] : []),
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
    )
  }
  lines.push(`${c('1', 'Note:')} a static check of names, schemas and annotations; it never calls a tool. Confirm findings with a crash test.`)
  return `${lines.join('\n')}\n`
}

export const SCAN_USAGE = `Usage:
  npx agent-shakedown scan -- <command> [args...]    start a stdio MCP server and check its tools
  npx agent-shakedown scan --url <url> [--header "Name: value"]   check a streamable-HTTP MCP server
  npx agent-shakedown scan --file tools.json          check a saved tools/list result

Options:
  --json         print the findings as JSON
  --timeout <s>  seconds to wait for the server (default 30)

Exit codes: 0 nothing high-risk, 1 a tool that moves money or reaches a person can repeat on retry,
2 the server couldn't be read or listed no tools.
Examples:
  npx agent-shakedown scan -- npx -y @paypal/mcp --tools=all
  npx agent-shakedown scan -- node build/index.js
`
