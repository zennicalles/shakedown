/**
 * Write-ahead intent ("store the id before you call") for a provider that CANNOT
 * deduplicate (plain SMTP, an API without idempotency keys). Each strategy runs
 * against every default fault; the table it prints is docs/results/write-ahead-2026-11-10.md.
 */
import { describe, expect, it } from 'vitest'
import {
  FakeMailer,
  MemoryLedger,
  SimulatedTransientError,
  currentIdempotencyKey,
  formatReport,
  idempotent,
  mailerInvariants,
  runScenario,
  shake,
  type Report,
  type Scenario,
} from '../src/index.js'
import { scriptedAgent } from './helpers.js'

interface EmailArgs { ticket: string; to: string; subject: string; body: string }
interface World { mailer: FakeMailer; email: (a: EmailArgs) => Promise<unknown> }

type Strategy =
  | 'naive'
  | 'ledger-after'
  | 'write-ahead-retry'
  | 'write-ahead-skip'
  | 'write-ahead-skip+notCommitted'
  | 'write-ahead-reconcile'
  | 'provider-key'

function world(strategy: Strategy, ledger: MemoryLedger): World {
  const mailer = new FakeMailer()
  const providerKey = strategy === 'provider-key'
  // shake() at the boundary: the actual send. `ref` is our own tag on the message, which a
  // provider without idempotency keys can still store and let us search (reconcile).
  const send = shake('send_email', async (a: EmailArgs) => {
    const key = currentIdempotencyKey()
    return mailer.send(
      { to: a.to, subject: a.subject, body: a.body, ...(key ? { ref: key } : {}) },
      providerKey && key ? { idempotencyKey: key } : {},
    )
  })
  const key = (a: EmailArgs) => `refund-email:${a.ticket}`
  const email = (() => {
    switch (strategy) {
      case 'naive':
        return send
      case 'ledger-after':
      case 'provider-key':
        return idempotent(send, { key, store: ledger })
      case 'write-ahead-retry':
        return idempotent(send, { key, store: ledger, onPending: 'retry' })
      case 'write-ahead-skip':
        return idempotent(send, { key, store: ledger, onPending: 'skip' })
      case 'write-ahead-skip+notCommitted':
        return idempotent(send, {
          key,
          store: ledger,
          onPending: 'skip',
          // The transport told us the connection failed before the request went out.
          notCommitted: (e) => e instanceof SimulatedTransientError,
        })
      case 'write-ahead-reconcile':
        return idempotent(send, {
          key,
          store: ledger,
          onPending: ({ key: k }) => {
            const hit = mailer.findByRef(k)[0]
            return hit ? { found: true, result: { id: hit.id } } : { found: false }
          },
        })
    }
  })()
  return { mailer, email }
}

function scenario(strategy: Strategy): Scenario<World> {
  // The ledger stands in for a durable database: it survives a crash. Without that,
  // a pending record dies with the process and write-ahead can't help.
  let ledger = new MemoryLedger({ durable: true })
  return {
    name: strategy,
    setup: () => {
      ledger = new MemoryLedger({ durable: true })
      return world(strategy, ledger)
    },
    run: (w) => scriptedAgent([{ call: w.email, args: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund', body: '£50 is on its way.' } }]),
    invariants: [mailerInvariants.sentExactly('ada@example.com', 1)],
    allowBaselineError: false,
  }
}

const verdict = (r: Report<World>) =>
  Object.fromEntries(
    r.results.map((x) => [
      x.label,
      x.violations.length ? 'DUPLICATE' : x.untested ? 'untested' : x.incomplete.length ? 'incomplete' : x.faultNotTriggered ? 'miss' : 'ok',
    ]),
  )

const FAULTS = [
  'baseline (no fault)',
  'error-before-commit on send_email',
  'timeout-after-commit on send_email',
  'duplicate-delivery on send_email',
  'crash-after-commit on send_email',
  'job-redelivery',
]

describe('write-ahead intent with a provider that cannot deduplicate', () => {
  const STRATEGIES: Strategy[] = [
    'naive',
    'ledger-after',
    'write-ahead-retry',
    'write-ahead-skip',
    'write-ahead-skip+notCommitted',
    'write-ahead-reconcile',
    'provider-key',
  ]
  const expected: Record<Strategy, string[]> = {
    // baseline, error-before, timeout-after, duplicate-delivery, crash-after, redelivery
    naive: ['ok', 'ok', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE'],
    'ledger-after': ['ok', 'ok', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'ok'],
    'write-ahead-retry': ['ok', 'ok', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'ok'],
    'write-ahead-skip': ['ok', 'incomplete', 'ok', 'DUPLICATE', 'ok', 'ok'],
    'write-ahead-skip+notCommitted': ['ok', 'ok', 'ok', 'DUPLICATE', 'ok', 'ok'],
    'write-ahead-reconcile': ['ok', 'ok', 'ok', 'DUPLICATE', 'ok', 'ok'],
    'provider-key': ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  }
  const table: string[] = ['| Strategy | ' + FAULTS.join(' | ') + ' |', '|---|' + FAULTS.map(() => '---').join('|') + '|']

  for (const s of STRATEGIES) {
    it(s, async () => {
      const report = await runScenario(scenario(s))
      const v = verdict(report)
      const row = FAULTS.map((f) => v[f])
      table.push(`| ${s} | ${row.join(' | ')} |`)
      if (JSON.stringify(row) !== JSON.stringify(expected[s])) console.log(formatReport(report))
      expect(row).toEqual(expected[s])
    })
  }

  it('prints the table', () => {
    console.log(table.join('\n'))
    expect(table.length).toBe(2 + STRATEGIES.length)
  })
})

describe('idempotent() write-ahead API', () => {
  it('rejects notCommitted without onPending, or with a store that cannot delete', () => {
    expect(() => idempotent(async () => 1, { key: () => 'k', notCommitted: () => true })).toThrow(/onPending/)
    const noDelete = { get: () => undefined, set: () => {} }
    expect(() => idempotent(async () => 1, { key: () => 'k', store: noDelete, onPending: 'skip', notCommitted: () => true })).toThrow(/delete/)
  })

  it('skip throws PossiblyCommittedError when it finds a pending record', async () => {
    const store = new MemoryLedger({ durable: true })
    store.set('k', { status: 'pending', at: 1 })
    const f = idempotent(async () => 'sent', { key: () => 'k', store, onPending: 'skip' })
    await expect(f()).rejects.toMatchObject({ name: 'PossiblyCommittedError', code: 'POSSIBLY_COMMITTED' })
  })

  it('reconcile marks the operation done when the system of record has it, and runs it when not', async () => {
    const store = new MemoryLedger({ durable: true })
    let runs = 0
    const exists = new Set<string>()
    const f = idempotent(async (id: string) => (runs++, `sent ${id}`), {
      key: (id) => id,
      store,
      onPending: ({ key }) => (exists.has(key) ? { found: true, result: `found ${key}` } : { found: false }),
    })
    store.set('a', { status: 'pending', at: 1 })
    exists.add('a')
    await expect(f('a')).resolves.toBe('found a')
    expect(store.get('a')).toMatchObject({ status: 'done', result: 'found a' })
    store.set('b', { status: 'pending', at: 1 })
    await expect(f('b')).resolves.toBe('sent b')
    expect(runs).toBe(1)
  })

  it('without onPending, a pending record written by another process is not treated as done', async () => {
    const store = new MemoryLedger({ durable: true })
    store.set('k', { status: 'pending', at: 1 })
    const f = idempotent(async () => 'ran', { key: () => 'k', store })
    await expect(f()).resolves.toBe('ran')
  })
})

describe('regressions from the write-ahead review', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('two concurrent calls with the same key run the side effect once (ledger and write-ahead)', async () => {
    for (const onPending of [undefined, 'skip', 'retry'] as const) {
      let runs = 0
      const f = idempotent(
        async () => {
          runs++
          await sleep(5)
          return 'sent'
        },
        { key: () => 'k', store: new MemoryLedger({ durable: true }), ...(onPending ? { onPending } : {}) },
      )
      await Promise.all([f(), f()])
      expect(runs, `onPending=${onPending}`).toBe(1)
    }
  })

  it('two workers sharing a store with claim(): one sends, the other is refused', async () => {
    const store = new MemoryLedger({ durable: true })
    let runs = 0
    const worker = () =>
      idempotent(
        async () => {
          runs++
          await sleep(5)
          return 'sent'
        },
        { key: () => 'k', store, onPending: 'skip' },
      )
    const results = await Promise.allSettled([worker()(), worker()()])
    expect(runs).toBe(1)
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('fails closed on a ledger entry that is not explicitly pending', async () => {
    let runs = 0
    const store = { get: () => ({ status: 'DONE', result: 'r', at: 1 }) as never, set() {} }
    const f = idempotent(async () => (runs++, 'fresh'), { key: () => 'k', store })
    await expect(f()).resolves.toBe('r')
    expect(runs).toBe(0)
  })

  it('notCommitted only clears its own pending record', async () => {
    const store = new MemoryLedger({ durable: true })
    const failing = idempotent(
      async () => {
        await sleep(10)
        store.set('k', { status: 'pending', at: 2, attempt: 'someone-else' })
        throw new Error('ECONNREFUSED')
      },
      { key: () => 'k', store, onPending: 'retry', notCommitted: (e) => /ECONNREFUSED/.test(String(e)) },
    )
    await expect(failing()).rejects.toThrow('ECONNREFUSED')
    expect(store.get('k')).toMatchObject({ status: 'pending', attempt: 'someone-else' })
  })

  it('a guard on one tool does not make another tool count as tested on resume', async () => {
    interface W { mailer: FakeMailer; refunds: number; email: () => Promise<unknown>; refund: () => Promise<unknown> }
    const report = await runScenario<W>({
      name: 'unrelated guard',
      setup: () => {
        const mailer = new FakeMailer()
        const w = { mailer, refunds: 0 } as W
        w.email = idempotent(
          shake('send_email', async () => mailer.send({ to: 'a@x', subject: 's', body: 'b' })),
          { key: () => 'email:T-1', store: new MemoryLedger({ durable: true }), onPending: 'skip' },
        )
        w.refund = shake('refund', async () => void w.refunds++)
        return w
      },
      run: async (w) => {
        await w.email()
        await w.refund()
      },
      // Resume replays the email guard (refused), then dies before ever retrying the refund.
      resume: async (w) => {
        await w.email().catch(() => {})
        throw new Error('checkpoint for step 2 not found')
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      invariants: [(w) => w.refunds <= 1 || 'refund ran twice', (w) => w.mailer.outbox().length <= 1 || 'email sent twice'],
    })
    const r = report.results[1]!
    expect(r.untested).toBe(true)
    expect(report.safe).toBe(false)
  })

  it('a write-ahead guard on the faulted tool does count, with an explicit note', async () => {
    const report = await runScenario(scenario('write-ahead-skip'))
    const crash = report.results.find((r) => r.label === 'crash-after-commit on send_email')!
    expect(crash.untested).toBe(false)
    expect(crash.passed).toBe(true)
    expect(crash.notes.join(' ')).toMatch(/write-ahead guard on send_email refused or reconciled/)
  })
})
