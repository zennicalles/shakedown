import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanCommand, type CliIO } from '../src/demo.js'
import { analyzeTools, classifyTool, formatScan, listToolsStdio, nameTokens, type McpTool } from '../src/scan.js'

const obj = (properties: Record<string, object>) => ({ type: 'object', properties })
const verdict = (t: McpTool) => classifyTool(t).verdict

describe('classifyTool', () => {
  it('splits names in any style', () => {
    expect(nameTokens('createRefund')).toEqual(['create', 'refund'])
    expect(nameTokens('send-email')).toEqual(['send', 'email'])
    expect(nameTokens('payments.refund_payment')).toEqual(['payments', 'refund', 'payment'])
  })

  it('flags a money tool with no key as high risk', () => {
    const f = classifyTool({ name: 'create_refund', inputSchema: obj({ capture_id: { type: 'string' }, amount: { type: 'string' } }) })
    expect(f).toMatchObject({ verdict: 'unkeyed', severity: 'high' })
    expect(classifyTool({ name: 'nativeTransfer', inputSchema: obj({ to: {}, value: {} }) })).toMatchObject({ verdict: 'unkeyed', severity: 'high' })
  })

  it('flags other creates as medium', () => {
    expect(classifyTool({ name: 'create_product', inputSchema: obj({ name: {} }) })).toMatchObject({ verdict: 'unkeyed', severity: 'medium' })
  })

  it('accepts a key only when the model is told to reuse it on retry', () => {
    const guided = { type: 'string', description: 'Reuse the same key when retrying a refund request so a timeout retry does not create a duplicate.' }
    expect(verdict({ name: 'create_refund', inputSchema: obj({ payment_id: {}, idempotency_key: guided }) })).toBe('keyed')
    const unique = { type: 'string', description: 'A unique string that identifies this request. Must be unique for every request.' }
    expect(classifyTool({ name: 'refund_payment', inputSchema: obj({ idempotency_key: unique }) })).toMatchObject({ verdict: 'key-no-guidance', severity: 'high', keyParam: 'idempotency_key' })
    // Nested keys count, with their path.
    expect(classifyTool({ name: 'create_payment', inputSchema: obj({ body: obj({ idempotencyKey: guided }) }) }).keyParam).toBe('body.idempotencyKey')
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
    expect(verdict({ name: 'get_or_create_charge', annotations: { readOnlyHint: false } })).toBe('unkeyed')
  })

  it('recognises a pass-through API tool, high risk when it reaches payments', () => {
    const schema = obj({ service: { type: 'string' }, method: { type: 'string' }, request: { type: 'object', properties: {}, additionalProperties: true } })
    expect(classifyTool({ name: 'make_api_request', inputSchema: schema })).toMatchObject({ verdict: 'generic', severity: 'medium' })
    expect(classifyTool({ name: 'make_api_request', description: 'Available services: catalog, payments, refunds', inputSchema: schema })).toMatchObject({ verdict: 'generic', severity: 'high' })
    // A dispatcher tool (name + arguments) is a pass-through too, whatever its own name suggests.
    expect(verdict({ name: 'call_tool', inputSchema: obj({ tool: { type: 'string' }, arguments: { type: 'object' } }) })).toBe('generic')
  })

  it('does not treat subscribe as safe to repeat (a second subscription bills twice)', () => {
    expect(verdict({ name: 'subscribe_customer', inputSchema: obj({ plan: {} }) })).toBe('unkeyed')
    expect(verdict({ name: 'get_operation', inputSchema: obj({ operation_id: {} }) })).toBe('read')
    expect(verdict({ name: 'start_export', inputSchema: obj({ operation_id: {} }) })).toBe('unkeyed')
  })

  it('survives odd schemas', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} }
    ;(cyclic.properties as Record<string, unknown>).self = cyclic
    expect(() => classifyTool({ name: 'create_x', inputSchema: cyclic as never })).not.toThrow()
    expect(verdict({ name: 'send_sms', inputSchema: undefined })).toBe('unkeyed')
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
    expect(r).toMatchObject({ atRisk: 2, high: 1 })
    const text = formatScan(r)
    expect(text).toContain('shakedown scan: paypal  (3 tools)  2 tool(s) can repeat a side effect on retry, 1 of them move money or reach a person')
    expect(text).toMatch(/HIGH {2}create_refund +moves money/)
    expect(text).toContain('1 read-only')
    expect(text).not.toContain('\u001b[')
  })

  it('says so when nothing is at risk', () => {
    expect(formatScan(analyzeTools('reader', [{ name: 'get_x' }]))).toContain('no retry risks found')
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
    expect(tools.map((t) => t.name)).toEqual(['create_refund', 'get_refund', 'send-email'])
  })

  it('exits 1 with a high-risk finding, and prints JSON on request', async () => {
    const { io, sink } = capture()
    expect(await scanCommand(['--json', '--', process.execPath, fixture], sink)).toBe(1)
    const r = JSON.parse(io.stdout)
    expect(r).toMatchObject({ server: 'fake-pay', atRisk: 1, high: 1 })
    expect(r.tools.find((t: { name: string }) => t.name === 'send-email').verdict).toBe('keyed')
  })

  it('reports a server that dies before answering, with its stderr, as exit 2', async () => {
    const { io, sink } = capture()
    const code = await scanCommand(['--timeout', '10', '--', process.execPath, '-e', 'console.error("missing PAYPAL_ACCESS_TOKEN"); process.exit(3)'], sink)
    expect(code).toBe(2)
    expect(io.stderr).toContain('missing PAYPAL_ACCESS_TOKEN')
  })

  it('rejects bad usage with exit 2', async () => {
    const { sink } = capture()
    expect(await scanCommand([], sink)).toBe(2)
    expect(await scanCommand(['--url'], sink)).toBe(2)
    expect(await scanCommand(['--bogus', '--', 'x'], sink)).toBe(2)
  })
})
