import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanCommand, type CliIO } from '../src/demo.js'
import { analyzeTools, classifyTool, formatScan, hasRetryGuidance, listToolsHttp, listToolsStdio, nameTokens, type McpTool } from '../src/scan.js'

const obj = (properties: Record<string, object>, required?: string[]) => ({ type: 'object', properties, ...(required ? { required } : {}) }) as never
const verdict = (t: McpTool) => classifyTool(t).verdict
const sev = (name: string, inputSchema: object = obj({ x: {} })) => classifyTool({ name, inputSchema: inputSchema as never }).severity

describe('classifyTool', () => {
  it('splits names in any style', () => {
    expect(nameTokens('createRefund')).toEqual(['create', 'refund'])
    expect(nameTokens('send-email')).toEqual(['send', 'email'])
    expect(nameTokens('payments.refund_payment')).toEqual(['payments', 'refund', 'payment'])
  })

  it('flags a money tool with no key as high risk', () => {
    expect(classifyTool({ name: 'create_refund', inputSchema: obj({ capture_id: {}, amount: {} }) })).toMatchObject({ verdict: 'unkeyed', severity: 'high' })
    expect(classifyTool({ name: 'nativeTransfer', inputSchema: obj({ to: {}, value: {} }) })).toMatchObject({ verdict: 'unkeyed', severity: 'high' })
  })

  it('flags other creates as medium', () => {
    expect(classifyTool({ name: 'create_product', inputSchema: obj({ name: {} }) })).toMatchObject({ verdict: 'unkeyed', severity: 'medium' })
  })

  it('rates by what a repeat does, not by any money word in the name', () => {
    for (const n of ['create_refund', 'pay_order', 'send_invoice', 'send_invoice_reminder', 'create_payment', 'create_message', 'native_transfer', 'refund_payment', 'sendEmail', 'find_or_create_payment', 'post_tweet'])
      expect([n, sev(n)]).toEqual([n, 'high'])
    for (const n of ['create_payment_links', 'create_payment_session', 'generate_invoice_qr_code', 'create_subscription_plan', 'create_order', 'create_invoice', 'text_to_speech'])
      expect([n, sev(n)]).toEqual([n, 'medium'])
  })

  it('finds the action behind a vendor prefix', () => {
    expect(sev('acme_pay_order', obj({ order_id: {}, amount: {} }))).toBe('high')
    expect(sev('whatsapp_send_template', obj({ to: {}, template: {} }))).toBe('high')
    expect(sev('slack_reply_to_thread', obj({ channel_id: {}, thread_ts: {}, text: {} }))).toBe('high')
    for (const n of ['slack_get_users', 'brave_web_search', 'notion-search']) expect([n, verdict({ name: n })]).toEqual([n, 'read'])
  })

  it('a messaging verb needs a recipient: email_customer is a send, email_lookup and parse_email are reads', () => {
    expect(sev('email_customer')).toBe('high')
    expect(sev('text', obj({ to: {}, body: {} }))).toBe('high')
    for (const n of ['email_lookup', 'trade_history', 'swap_quote', 'charge_status', 'transfer_status', 'parse_email', 'format_message'])
      expect([n, verdict({ name: n })]).toEqual([n, 'read'])
  })

  it('never calls a write a read because of its first word (false passes from the review)', () => {
    for (const n of ['get_or_create_charge', 'find_or_create_payment', 'verify_and_pay', 'check_out', 'checkOut', 'checkout', 'preview_and_send_email', 'resolve_dispute', 'email_report'])
      expect([n, verdict({ name: n, inputSchema: obj({ x: {} }) })]).toEqual([n, 'unkeyed'])
    for (const n of ['cancel_and_refund_order', 'update_and_send_invoice', 'toggle_autopay'])
      expect([n, verdict({ name: n, inputSchema: obj({ x: {} }) })]).toEqual([n, 'unkeyed'])
    expect(sev('verify_and_pay')).toBe('high')
    expect(sev('check_out')).toBe('high')
  })

  it('accepts a key only when the model is told to reuse it on retry', () => {
    const guided = { type: 'string', description: 'Reuse the same key when retrying a refund request so a timeout retry does not create a duplicate.' }
    expect(verdict({ name: 'create_refund', inputSchema: obj({ payment_id: {}, idempotency_key: guided }) })).toBe('keyed')
    const unique = { type: 'string', description: 'A unique string that identifies this request. Must be unique for every request.' }
    expect(classifyTool({ name: 'refund_payment', inputSchema: obj({ idempotency_key: unique }) })).toMatchObject({ verdict: 'key-no-guidance', severity: 'high', keyParam: 'idempotency_key' })
    expect(classifyTool({ name: 'create_payment', inputSchema: obj({ body: obj({ idempotencyKey: guided }) }) }).keyParam).toBe('body.idempotencyKey')
  })

  it('reads retry guidance as an instruction, not as any sentence with "same" and "retr" in it', () => {
    // Real guidance (Razorpay, Resend, and the PayPal and Square wording) counts.
    expect(hasRetryGuidance('Unique key (e.g. a UUID) sent as the X-Refund-Idempotency header. Reuse the same key when retrying a refund request so that a timeout retry does not create a duplicate refund.')).toBe(true)
    expect(hasRetryGuidance('Use the same key when retrying the same logical email; use a new key for a different email.')).toBe(true)
    expect(hasRetryGuidance('Use a fresh random UUID for each new request. If this call times out, retry the identical call with the same request_id and PayPal returns the original result.')).toBe(true)
    expect(hasRetryGuidance('If a write times out, resend the identical request (same body, same idempotency_key).')).toBe(true)
    expect(hasRetryGuidance('Reuse it when retrying a request whose outcome is unknown.', 'idempotencyKey', true)).toBe(true)
    // Unrelated, negated or opposite text doesn't.
    for (const text of [
      'Use retrieve_refund to look up the same refund later',
      'Charges the same card against the order total',
      'Must be unique. Never reuse a key, not even on retry',
      'Generate a new key; do not reuse it when retrying',
      'Retrieve the same request with get_payout_request',
      'Writes are not idempotent, so retrying the same request may charge twice.',
      '- retrieve_payment: returns the same object\n- list_payments: lists them',
      'Reuse the template from the last campaign when sending again.',
    ])
      expect([text, hasRetryGuidance(text)]).toEqual([text, false])
  })

  it('negated guidance in the key description leaves a key-no-guidance finding', () => {
    const neverReuse = { type: 'string', description: 'Must be unique. Never reuse a key, not even on retry.' }
    expect(verdict({ name: 'create_refund', inputSchema: obj({ idempotency_key: neverReuse }) })).toBe('key-no-guidance')
  })

  it('treats reads, annotated tools and update/delete verbs as not at risk', () => {
    expect(verdict({ name: 'get_invoice' })).toBe('read')
    expect(verdict({ name: 'list_orders' })).toBe('read')
    expect(verdict({ name: 'refund_lookup_x', annotations: { readOnlyHint: true } })).toBe('read')
    expect(verdict({ name: 'create_order', annotations: { idempotentHint: true } })).toBe('declared-idempotent')
    expect(verdict({ name: 'cancel_subscription' })).toBe('repeat-safe')
    expect(verdict({ name: 'update_invoice' })).toBe('repeat-safe')
  })

  it('an explicit readOnlyHint: false overrides a read-looking name', () => {
    expect(verdict({ name: 'get_x', annotations: { readOnlyHint: false } })).toBe('unkeyed')
  })

  it('recognises a pass-through API tool, high risk when it reaches payments', () => {
    const schema = obj({ service: { type: 'string' }, method: { type: 'string' }, request: { type: 'object', properties: {}, additionalProperties: true } })
    expect(classifyTool({ name: 'make_api_request', inputSchema: schema })).toMatchObject({ verdict: 'generic', severity: 'medium' })
    expect(classifyTool({ name: 'make_api_request', description: 'Available services: catalog, payments, refunds', inputSchema: schema })).toMatchObject({ verdict: 'generic', severity: 'high' })
    const guided = 'Available services: payments, refunds. If a write times out, retry it with the SAME idempotency_key.'
    expect(classifyTool({ name: 'make_api_request', description: guided, inputSchema: schema }).verdict).toBe('keyed')
    expect(classifyTool({ name: 'make_api_request', description: 'Writes are not idempotent, so retrying the same request may charge twice.', inputSchema: schema }).verdict).toBe('generic')
    expect(verdict({ name: 'call_tool', inputSchema: obj({ tool: { type: 'string' }, arguments: { type: 'object' } }) })).toBe('generic')
  })

  it('a read-named pass-through is a read unless the caller picks the HTTP method', () => {
    const open = { type: 'object', additionalProperties: true }
    expect(verdict({ name: 'get_resource', description: 'Retrieve a payment or refund by path', inputSchema: obj({ path: {}, params: open }) })).toBe('read')
    expect(verdict({ name: 'get_resource', inputSchema: obj({ method: {}, path: {}, params: open }) })).toBe('generic')
  })

  it('does not treat subscribe as safe to repeat, and ignores operation_id as a key', () => {
    expect(verdict({ name: 'subscribe_customer', inputSchema: obj({ plan: {} }) })).toBe('unkeyed')
    expect(verdict({ name: 'get_operation', inputSchema: obj({ operation_id: {} }) })).toBe('read')
    expect(verdict({ name: 'start_export', inputSchema: obj({ operation_id: {} }) })).toBe('unkeyed')
  })

  it('downgrades a money action that only targets an existing record, but not a send to a person', () => {
    const payOrder = classifyTool({ name: 'pay_order', inputSchema: obj({ id: { type: 'string' } }, ['id']) })
    expect(payOrder).toMatchObject({ verdict: 'unkeyed', severity: 'medium' })
    expect(payOrder.why).toContain('only targets an existing record (id)')
    expect(sev('send-broadcast', obj({ broadcastId: {}, scheduledAt: {} }, ['broadcastId']))).toBe('medium')
    expect(sev('create_refund', obj({ capture_id: {}, amount: {} }, ['capture_id']))).toBe('high')
    expect(sev('send_invoice_reminder', obj({ invoice_id: {}, subject: {} }, ['invoice_id']))).toBe('high')
    expect(sev('pay_order', obj({ id: {} }))).toBe('high') // no required list: no assumption
    // From the review: these really do send or move money again.
    expect(sev('send_receipt', obj({ charge_id: {}, email: {} }, ['charge_id']))).toBe('high')
    expect(sev('send_sms', obj({ contact_id: {}, template_id: {} }, ['contact_id', 'template_id']))).toBe('high')
    expect(sev('create_transfer', obj({ account_id: {}, data: obj({ amount: {} }) }, ['account_id']))).toBe('high')
  })

  it('survives odd schemas', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} }
    ;(cyclic.properties as Record<string, unknown>).self = cyclic
    expect(() => classifyTool({ name: 'create_x', inputSchema: cyclic as never })).not.toThrow()
    expect(verdict({ name: 'send_sms', inputSchema: undefined })).toBe('unkeyed')
    expect(() => classifyTool({ name: 'create_x', inputSchema: { properties: null, anyOf: 'x', required: [1] } as never })).not.toThrow()
  })
})

describe('analyzeTools / formatScan', () => {
  const tools: McpTool[] = [
    { name: 'create_refund', inputSchema: obj({ capture_id: {} }) },
    { name: 'create_product', inputSchema: obj({ name: {} }) },
    { name: 'get_refund' },
  ]

  it('counts what is at risk and prints groups, without colour when off', () => {
    const r = analyzeTools('paypal', tools)
    expect(r).toMatchObject({ atRisk: 2, high: 1, skipped: 0 })
    const text = formatScan(r)
    expect(text).toContain('shakedown scan: paypal  (3 tools)  2 tool(s) can repeat a side effect on retry, 1 of them move money or reach a person')
    expect(text).toMatch(/HIGH {2}create_refund +moves money/)
    expect(text).toContain('1 read-only')
    expect(text).not.toContain('\u001b[')
  })

  it('says so when nothing is at risk', () => {
    expect(formatScan(analyzeTools('reader', [{ name: 'get_x' }]))).toContain('no retry risks found')
  })

  it('skips malformed entries instead of crashing, and says so', () => {
    const r = analyzeTools('odd', [null, { name: 5 }, 'x', { name: 'create_refund' }])
    expect(r).toMatchObject({ skipped: 3, high: 1 })
    expect(formatScan(r)).toContain('3 malformed tools/list entries were skipped')
  })

  it('an empty list is not a pass', () => {
    const text = formatScan(analyzeTools('empty', []))
    expect(text).toContain('the server listed no tools')
    expect(text).not.toContain('no retry risks found')
  })
})

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))
const capture = () => {
  const io = { stdout: '', stderr: '' }
  const sink: CliIO = { out: (s) => void (io.stdout += s), err: (s) => void (io.stderr += s), color: false }
  return { io, sink }
}

describe('agent-shakedown scan against a real stdio server', () => {
  it('lists every page of tools, skipping log lines on stdout', async () => {
    const { serverName, tools } = await listToolsStdio(process.execPath, [fixture], { timeoutMs: 15_000 })
    expect(serverName).toBe('fake-pay')
    expect((tools as McpTool[]).map((t) => t.name)).toEqual(['create_refund', 'get_refund', 'send-email'])
  })

  it('is not fooled by a server request or a JSON log line that reuses the id it is waiting on, and answers the ping', async () => {
    // The fixture only sends the list after our ping answer arrives, so this also checks we answer.
    const { tools } = await listToolsStdio(process.execPath, [fixture, '--collide'], { timeoutMs: 15_000 })
    expect(tools).toHaveLength(3)
  })

  it('exits 1 with a high-risk finding, and prints JSON on request', async () => {
    const { io, sink } = capture()
    expect(await scanCommand(['--json', '--', process.execPath, fixture], sink)).toBe(1)
    const r = JSON.parse(io.stdout)
    expect(r).toMatchObject({ server: 'fake-pay', atRisk: 1, high: 1 })
    expect(r.tools.find((t: { name: string }) => t.name === 'send-email').verdict).toBe('keyed')
  })

  it('exits 2 when the server lists no tools', async () => {
    const { io, sink } = capture()
    expect(await scanCommand(['--', process.execPath, fixture, '--no-tools'], sink)).toBe(2)
    expect(io.stdout).toContain('the server listed no tools')
  })

  it('skips malformed tools from a live server', async () => {
    const { io, sink } = capture()
    expect(await scanCommand(['--', process.execPath, fixture, '--bad-tools'], sink)).toBe(1)
    expect(io.stdout).toContain('3 malformed tools/list entries were skipped')
  })

  it('reports a server that dies before answering, with its stderr, as exit 2', async () => {
    const { io, sink } = capture()
    const code = await scanCommand(['--timeout', '10', '--', process.execPath, '-e', 'console.error("missing PAYPAL_ACCESS_TOKEN"); process.exit(3)'], sink)
    expect(code).toBe(2)
    expect(io.stderr).toContain('missing PAYPAL_ACCESS_TOKEN')
  })

  it('passes awkward arguments through unchanged', async () => {
    const awkward = ['{"a":1}', 'C:\\My Dir\\', '', '%OS%', 'a&b', 'x"y', 'two words']
    const { serverName } = await listToolsStdio('node', [fixture, '--echo-argv', ...awkward], { timeoutMs: 15_000 })
    expect(JSON.parse(serverName)).toEqual(awkward)
  })

  it.runIf(process.platform === 'win32')('passes awkward arguments through a .cmd shim (npx-style) unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shakedown-shim-'))
    try {
      const shim = join(dir, 'fake-server.cmd')
      writeFileSync(shim, `@"${process.execPath}" "${fixture}" %*\r\n`)
      const awkward = ['{"a":1}', 'C:\\My Dir\\', '', '%OS%', 'a&b', 'x"y', 'two words']
      const { serverName } = await listToolsStdio(shim, ['--echo-argv', ...awkward], { timeoutMs: 15_000 })
      expect(JSON.parse(serverName)).toEqual(awkward)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects bad usage with exit 2', async () => {
    const { io, sink } = capture()
    expect(await scanCommand([], sink)).toBe(2)
    expect(await scanCommand(['--url'], sink)).toBe(2)
    expect(await scanCommand(['--bogus', '--', 'x'], sink)).toBe(2)
    expect(await scanCommand(['--timeout', 'abc', '--', 'x'], sink)).toBe(2)
    expect(io.stderr).toContain("--timeout expects seconds between 0 and 3600, got 'abc'")
    expect(await scanCommand(['--timeout', '1e9', '--', 'x'], sink)).toBe(2)
  })

  it('accepts --flag=value', async () => {
    const { sink } = capture()
    expect(await scanCommand(['--timeout=15', '--json', '--', process.execPath, fixture], sink)).toBe(1)
  })
})

// A streamable-HTTP MCP server, in-process. Modes by path: /json, /sse, /sse-collide (a ping with our id first),
// /sse-open (reply sent, stream left open).
describe('agent-shakedown scan against a streamable-HTTP server', () => {
  let base = ''
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const msg = JSON.parse(body || '{}')
      const mode = req.url ?? ''
      if (!('id' in msg)) return void res.writeHead(202).end() // notification
      if (!msg.method) return void res.writeHead(202).end() // our answer to a server request
      if (mode !== '/json' && msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') return void res.writeHead(400).end('no session')
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `http${mode}` } }
          : { tools: [{ name: 'create_refund', inputSchema: { type: 'object', properties: { amount: {} } } }] }
      const reply = { jsonrpc: '2.0', id: msg.id, result }
      if (mode === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' })
      if (mode === '/sse-collide' && msg.method === 'tools/list') res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'ping' })}\n\n`)
      // A multi-line data field, as the SSE format allows.
      res.write(`event: message\ndata: ${JSON.stringify(reply).replace('"result":', '\ndata: "result":')}\n\n`)
      if (mode !== '/sse-open') res.end()
    })
  })
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  for (const mode of ['/json', '/sse', '/sse-collide', '/sse-open']) {
    it(`lists tools (${mode})`, async () => {
      const started = performance.now()
      const { serverName, tools } = await listToolsHttp(`${base}${mode}`, {}, 10_000)
      expect(serverName).toBe(`http${mode}`)
      expect(tools).toHaveLength(1)
      expect(performance.now() - started).toBeLessThan(5_000) // an open stream is not waited out
    })
  }

  it('exits 1 through the CLI', async () => {
    const { sink } = capture()
    expect(await scanCommand(['--url', `${base}/sse`, '--timeout', '10'], sink)).toBe(1)
  })
})
