import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SimulatedCrash, crashSignal, formatReport, isSimulatedCrash, runScenario, type FaultResult, type Report } from '../../src/index.js'
import { findLyingAnnotations, formatLyingAnnotations, untestedIdempotentClaims } from './lying-annotations.js'
import { connect, listToolDefinitions, refundScenario, type RefundAgentOptions, type Turn, type World } from './refund-agent.js'

async function run(opts: RefundAgentOptions): Promise<Report<World>> {
  const report = await runScenario(refundScenario(opts))
  console.log(formatReport(report))
  return report
}

const statuses = (r: Report<World>) =>
  Object.fromEntries(r.results.map((x) => [x.label, x.faultNotTriggered ? 'MISS' : x.passed ? 'pass' : 'FAIL']))
const byLabel = (r: Report<World>) => Object.fromEntries(r.results.map((x) => [x.label, x])) as Record<string, FaultResult<World>>
const toolTurns = (t: Turn[]) => t.filter((x): x is Extract<Turn, { role: 'tool' }> => x.role === 'tool')

const DOUBLE_REFUND = ['expected exactly 5000 refunded on ch_1, found 10000', 'expected at most 1 refund(s) on ch_1, found 2']
const DOUBLE_EMAIL = ['expected exactly 1 email(s) to ada@example.com, found 2']
const CRASH_TEXT = 'Process exited unexpectedly while calling refund (connection closed)'

describe('how McpServer surfaces errors to the host', () => {
  it('turns every thrown handler error into an isError tool result, never a JSON-RPC error', async () => {
    const server = new McpServer({ name: 'probe', version: '0.0.1' })
    server.registerTool('boom', { inputSchema: { n: z.number() } }, async () => {
      throw new Error('kaboom')
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'probe-client', version: '0.0.1' })
    await client.connect(ct)
    try {
      // Plain throw from the handler.
      await expect(client.callTool({ name: 'boom', arguments: { n: 1 } })).resolves.toEqual({
        content: [{ type: 'text', text: 'kaboom' }],
        isError: true,
      })
      // Even protocol-ish failures (bad args, unknown tool) come back as isError results in SDK 1.32.
      const badArgs = await client.callTool({ name: 'boom', arguments: { n: 'x' } })
      expect(badArgs.isError).toBe(true)
      expect(JSON.stringify(badArgs.content)).toMatch(/MCP error -32602: Input validation error/)
      const unknown = await client.callTool({ name: 'nope', arguments: {} })
      expect(unknown.isError).toBe(true)
      expect(JSON.stringify(unknown.content)).toMatch(/Tool nope not found/)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('an aborted callTool() rejects with McpError -32001 wrapping String(reason): the original error is lost', async () => {
    // This is why runMcpHost() rethrows signal.reason instead of the rejection.
    const crash = new AbortController()
    const server = new McpServer({ name: 'probe', version: '0.0.1' })
    let handlerRan = false
    server.registerTool('refund', { inputSchema: { n: z.number() } }, async () => {
      handlerRan = true
      const err = new SimulatedCrash('refund')
      crash.abort(err)
      throw err
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'probe-client', version: '0.0.1' })
    await client.connect(ct)
    try {
      const rejection = await client.callTool({ name: 'refund', arguments: { n: 1 } }, undefined, { signal: crash.signal }).then(
        () => {
          throw new Error('expected callTool to reject')
        },
        (e: unknown) => e,
      )
      expect(handlerRan).toBe(true)
      expect(rejection).toBeInstanceOf(McpError)
      expect((rejection as McpError).code).toBe(-32001) // ErrorCode.RequestTimeout, although nothing timed out
      expect((rejection as McpError).message).toBe(`MCP error -32001: ConnectionClosedError: ${CRASH_TEXT}`)
      expect(isSimulatedCrash(rejection)).toBe(false)
      expect(isSimulatedCrash(crash.signal.reason)).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('shows Shakedown faults to the model as error text in a tool result', async () => {
    const report = await run({ mode: 'naive' })
    const timeout = toolTurns(byLabel(report)['timeout-after-commit on refund']!.world.transcripts[0]!)
    expect(timeout.map((t) => [t.name, t.isError, t.via])).toEqual([
      ['lookup_charge', false, 'result'],
      ['refund', true, 'result'],
      ['refund', false, 'result'], // the model retried the same call, and it committed again
      ['send_email', false, 'result'],
    ])
    expect(timeout[1]!.text).toBe('Request to refund timed out after 30000ms (no response received)')
  })

  it('swallows the simulated crash like any other tool error unless the host watches crashSignal()', async () => {
    // abortOnCrash: false = a host that does not pass crashSignal(). McpServer catches
    // SimulatedCrash and returns an isError result; the host never dies.
    const report = await run({ mode: 'naive', abortOnCrash: false })
    const crash = byLabel(report)['crash-after-commit on refund']!
    expect(crash.crashSwallowed).toBe(true)
    expect(crash.world.transcripts).toHaveLength(2) // run, then resume
    const first = crash.world.transcripts[0]!
    // The model reads the neutral crash message and retries; shake() blocks the retries (the process is dead).
    expect(toolTurns(first).filter((t) => t.name === 'refund').map((t) => t.text)).toEqual(Array(3).fill(CRASH_TEXT))
    expect(first.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringMatching(/could not complete/) })
    const refundCalls = crash.calls.filter((c) => c.tool === 'refund' && c.phase === 'run')
    expect(refundCalls.map((c) => [c.fault ?? null, c.committed, c.blocked ?? false])).toEqual([
      ['crash-after-commit', true, false],
      [null, false, true],
      [null, false, true],
    ])
    expect(formatReport(report)).toContain('framework caught the simulated crash and kept going')
    // The verdict does not change: the re-run job refunds again either way.
    expect(crash.violations).toEqual(DOUBLE_REFUND)
  })

  it('stops the host on the crash when it passes crashSignal() (the default)', async () => {
    const report = await run({ mode: 'naive' })
    const crash = byLabel(report)['crash-after-commit on refund']!
    expect(crash.crashSwallowed).toBe(false)
    expect(crash.agentError).toBeUndefined()
    const first = crash.world.transcripts[0]!
    // The dead host records nothing after the refund call it was waiting on.
    expect(first.at(-1)).toMatchObject({ role: 'assistant', call: { name: 'refund' } })
    expect(crash.calls.some((c) => c.blocked)).toBe(false)
    expect(crash.world.transcripts).toHaveLength(2)
  })

  it('crashSignal() in the resume phase is a fresh, live signal, safe to pass to the new host', async () => {
    const base = refundScenario({ mode: 'fixed' })
    const seen: unknown[] = []
    const report = await runScenario({
      ...base,
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      resume: async (w) => {
        const signal = crashSignal()!
        seen.push(signal.aborted)
        const { client, close } = await connect(w, { mode: 'fixed' })
        seen.push(await client.listTools(undefined, { signal }).then(() => 'listed', (e: unknown) => isSimulatedCrash(e)))
        await close()
        return base.resume!(w)
      },
    })
    expect(seen).toEqual([false, 'listed']) // the resumed process gets its own signal
    expect(report.passed).toBe(true)
  })
})

describe('naive MCP tools', () => {
  it('fail every after-commit fault and job redelivery (observed results)', async () => {
    const report = await run({ mode: 'naive' })
    expect(statuses(report)).toEqual({
      'baseline (no fault)': 'pass',
      'error-before-commit on refund': 'pass',
      'timeout-after-commit on refund': 'FAIL',
      'duplicate-delivery on refund': 'FAIL',
      'crash-after-commit on refund': 'FAIL',
      'error-before-commit on send_email': 'pass',
      'timeout-after-commit on send_email': 'FAIL',
      'duplicate-delivery on send_email': 'FAIL',
      'crash-after-commit on send_email': 'FAIL',
      'job-redelivery': 'FAIL',
    })
    expect(report.passed).toBe(false)
    const r = byLabel(report)
    expect(r['timeout-after-commit on refund']!.violations).toEqual(DOUBLE_REFUND)
    expect(r['duplicate-delivery on refund']!.calls.filter((c) => c.tool === 'refund').map((c) => [c.delivery, c.committed])).toEqual([
      [1, true],
      [2, true],
    ])
    expect(r['timeout-after-commit on send_email']!.violations).toEqual(DOUBLE_EMAIL)
    // Re-running the job after a crash on send_email (or a redelivery) re-does the refund too.
    expect(r['crash-after-commit on send_email']!.violations).toEqual([...DOUBLE_REFUND, ...DOUBLE_EMAIL])
    expect(r['job-redelivery']!.violations).toEqual([...DOUBLE_REFUND, ...DOUBLE_EMAIL])
  })
})

describe('idempotent() ledger without a downstream key', () => {
  it('a per-server (volatile) ledger catches none of the after-commit faults', async () => {
    // shake() sits inside idempotent(): a timeout or crash at the boundary means the
    // ledger was never written, so the retry or the re-run job executes again.
    const report = await run({ mode: 'ledger-only' })
    const failed = report.results.filter((r) => !r.passed).map((r) => r.label)
    expect(failed).toEqual([
      'timeout-after-commit on refund',
      'duplicate-delivery on refund',
      'crash-after-commit on refund',
      'timeout-after-commit on send_email',
      'duplicate-delivery on send_email',
      'crash-after-commit on send_email',
      'job-redelivery',
    ])
  })

  it('a durable ledger covers job redelivery but still misses the commit-to-ledger window', async () => {
    // This is the configuration the v1 README reported as passing every fault
    // (it wrapped shake(idempotent(...)), so faults never hit the side-effect boundary).
    const report = await run({ mode: 'ledger-only', ledger: 'durable' })
    expect(statuses(report)).toMatchObject({
      'timeout-after-commit on refund': 'FAIL',
      'duplicate-delivery on refund': 'FAIL',
      'crash-after-commit on refund': 'FAIL',
      'timeout-after-commit on send_email': 'FAIL',
      'duplicate-delivery on send_email': 'FAIL',
      'crash-after-commit on send_email': 'FAIL',
      'job-redelivery': 'pass',
    })
    const r = byLabel(report)
    // Crash on send_email: the refund reached the durable ledger, the email did not.
    expect(r['crash-after-commit on send_email']!.violations).toEqual(DOUBLE_EMAIL)
    expect(r['job-redelivery']!.dedupes).toBe(2)
  })
})

describe('fixed MCP tools: ledger + key sent downstream', () => {
  it('pass every default fault, including crash-after-commit and job-redelivery, with volatile per-server ledgers', async () => {
    const report = await run({ mode: 'fixed' })
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(1 + 2 * 4 + 1)
    expect(report.problems).toEqual([])
    for (const res of report.results) {
      expect(res.world.stripe.listRefunds('ch_1')).toHaveLength(1)
      expect(res.world.mailer.outbox('ada@example.com')).toHaveLength(1)
    }
    const r = byLabel(report)
    // The model's retry after the timeout reached Stripe and was replayed from the Idempotency-Key.
    const timeout = r['timeout-after-commit on refund']!
    expect(timeout.dedupes).toBe(1)
    expect(timeout.calls.filter((c) => c.tool === 'refund').map((c) => [c.outcome, c.committed, c.deduped ?? false])).toEqual([
      ['error', true, false],
      ['ok', false, true],
    ])
    // After a crash the new server has an empty ledger; the downstream key catches the redo.
    const crash = r['crash-after-commit on send_email']!
    expect(crash.calls.filter((c) => c.phase === 'resume' && c.effect === 'write').map((c) => [c.tool, c.deduped])).toEqual([
      ['refund', true],
      ['send_email', true],
    ])
    expect(r['job-redelivery']!.dedupes).toBe(2)
  })

  it('also pass when the host swallows the crash (no crashSignal())', async () => {
    const report = await run({ mode: 'fixed', abortOnCrash: false })
    expect(report.passed).toBe(true)
    expect(report.results.filter((r) => r.crashSwallowed).map((r) => r.label)).toEqual([
      'crash-after-commit on refund',
      'crash-after-commit on send_email',
    ])
  })
})

describe('tool annotations', () => {
  it('are visible to the host over the protocol', async () => {
    const tools = await listToolDefinitions({ mode: 'naive' })
    const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
    expect(ann['lookup_charge']).toMatchObject({ readOnlyHint: true })
    expect(ann['refund']).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true })
    expect(ann['send_email']).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false })
  })

  it('lying-annotation detector flags the naive refund tool, which claims idempotentHint:true', async () => {
    const report = await run({ mode: 'naive' })
    const lies = findLyingAnnotations(report, await listToolDefinitions({ mode: 'naive' }))
    console.log(formatLyingAnnotations(lies))
    expect(lies.map((l) => [l.tool, l.fault])).toEqual([['refund', 'duplicate-delivery on refund']])
    // send_email also fails duplicate delivery, but it honestly declares idempotentHint:false.
  })

  it('flags both tools of the ledger-only server: an in-process ledger does not make a tool idempotent', async () => {
    const report = await run({ mode: 'ledger-only' })
    const lies = findLyingAnnotations(report, await listToolDefinitions({ mode: 'ledger-only' }))
    console.log(formatLyingAnnotations(lies))
    expect(lies.map((l) => [l.tool, l.fault])).toEqual([
      ['refund', 'duplicate-delivery on refund'],
      ['send_email', 'duplicate-delivery on send_email'],
    ])
  })

  it('finds no lies (and no untested claims) on the fixed server', async () => {
    const report = await run({ mode: 'fixed' })
    const tools = await listToolDefinitions({ mode: 'fixed' })
    expect(tools.filter((t) => t.annotations?.idempotentHint).map((t) => t.name)).toEqual(['refund', 'send_email'])
    expect(findLyingAnnotations(report, tools)).toEqual([])
    expect(untestedIdempotentClaims(report, tools)).toEqual([])
  })
})
