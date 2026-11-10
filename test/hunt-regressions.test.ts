/** Regressions for the 2026-11-10 bug hunt (one test per verified finding). */
import { describe, expect, it } from 'vitest'
import {
  FakeMailer,
  FakeStripe,
  MemoryLedger,
  StripeError,
  currentIdempotencyKey,
  idempotent,
  reportToMarkdown,
  runScenario,
  shake,
  stripeInvariants,
  type Scenario,
} from '../src/index.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function retry<T>(f: () => Promise<T>, n = 3): Promise<T | undefined> {
  for (let i = 1; i <= n; i++) {
    try {
      return await f()
    } catch (e) {
      if ((e as { shakedownCrash?: boolean }).shakedownCrash || i === n) throw e
    }
  }
  return undefined
}

describe('fakes', () => {
  it('rejects a refund with a missing charge before the idempotency layer, so a corrected retry succeeds', () => {
    const s = new FakeStripe()
    s.createCharge({ amount: 1000 })
    expect(() => s.refunds.create({ charge: undefined as unknown as string, amount: 100 }, { idempotencyKey: 'k' })).toThrow(/Missing required param: charge/)
    expect(s.refunds.create({ charge: 'ch_1', amount: 100 }, { idempotencyKey: 'k' }).amount).toBe(100)
  })

  it('treats prototype-named keys and ids as ordinary strings', () => {
    const m = new FakeMailer()
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => m.send({ to: 'a@x', subject: k, body: 'b' }, { idempotencyKey: k })).not.toThrow()
    }
    expect(m.outbox()).toHaveLength(4)
    const s = new FakeStripe()
    s.createCharge({ amount: 1000 })
    expect(s.refunds.create({ charge: 'ch_1', amount: 10 }, { idempotencyKey: '__proto__' }).amount).toBe(10)
    expect(s.refunds.create({ charge: 'ch_1', amount: 10 }, { idempotencyKey: '__proto__' }).id).toBe('re_1')
    expect(() => s.charges.retrieve('constructor')).toThrow(StripeError)
  })
})

describe('runner robustness', () => {
  it('produces a report when the agent throws a value String() cannot convert', async () => {
    const report = await runScenario({
      name: 'null-proto throw',
      setup: () => ({ stripe: new FakeStripe() }),
      run: async () => {
        throw Object.create(null)
      },
      invariants: [],
      allowBaselineError: true,
    })
    expect(report.results[0]!.agentError).toBeTypeOf('string')
  })

  it('runs and records a tool whose argument is a null-prototype object holding a function', async () => {
    let ran = 0
    const report = await runScenario({
      name: 'odd args',
      setup: () => ({ f: shake('w', async (a: { cb: () => number }) => (ran++, a.cb())) }),
      run: async (w) => {
        await w.f(Object.assign(Object.create(null) as { cb: () => number }, { cb: () => 1 }))
      },
      invariants: [],
      faults: [],
    })
    expect(ran).toBeGreaterThan(0)
    expect(report.results[0]!.calls).toHaveLength(1)
  })

  it('injects a retargeted fault into exactly one of several parallel calls', async () => {
    const report = await runScenario({
      name: 'parallel retarget',
      setup: () => {
        const stripe = new FakeStripe()
        stripe.createCharge({ amount: 100 })
        stripe.createCharge({ amount: 100 })
        return { stripe, refund: shake('refund', async (a: { charge: string; amount: number }) => stripe.refunds.create(a)) }
      },
      run: async (w) => {
        await w.refund({ charge: 'ch_1', amount: 5000 }).catch(() => {}) // real error: amount too large
        await Promise.allSettled([w.refund({ charge: 'ch_1', amount: 10 }), w.refund({ charge: 'ch_2', amount: 10 })])
      },
      invariants: [],
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
    })
    expect(report.results[1]!.calls.filter((c) => c.fault)).toHaveLength(1)
  })

  it('explains a MISS caused by real errors on every targeted call', async () => {
    const report = await runScenario({
      name: 'always fails',
      setup: () => ({ f: shake('thr', async () => { throw new Error('boom') }) }),
      run: async (w) => {
        await w.f().catch(() => {})
      },
      invariants: [],
      faults: [{ kind: 'timeout-after-commit', tool: 'thr' }],
      allowUntriggered: true,
    })
    expect(report.results[1]!.notTriggeredReason).toMatch(/failed with a real error before the fault could be injected/)
  })

  it('does not count a redelivery as triggered when the job committed no writes', async () => {
    const report = await runScenario({
      name: 'no writes',
      setup: () => ({ read: shake('read', async () => 1, { effect: 'read' }), w: shake('w', async () => 1) }),
      run: async (s) => {
        await s.read()
      },
      invariants: [],
      faults: [{ kind: 'timeout-after-commit', tool: 'w' }, { kind: 'job-redelivery' }],
      allowUntriggered: true,
    })
    expect(report.results.find((r) => r.label === 'job-redelivery')!.faultNotTriggered).toBe(true)
    expect(report.problems).toContain('no fault triggered: nothing was tested')
    expect(report.safe).toBe(false)
  })

  it('marks a pass where the resume never re-attempted the at-risk tool as hollow, and counts it', async () => {
    const report = await runScenario({
      name: 'no-op resume',
      setup: () => {
        const mailer = new FakeMailer()
        return { mailer, email: shake('send_email', async () => mailer.send({ to: 'a@x', subject: 's', body: 'b' })) }
      },
      run: async (w) => {
        await w.email()
      },
      resume: async () => {},
      invariants: [(w) => w.mailer.outbox().length <= 1 || 'twice'],
      faults: [{ kind: 'crash-after-commit', tool: 'send_email' }],
    })
    expect(report.results[1]!.hollow).toBe(true)
    expect(report.hollowRows).toBe(1)
  })

  it('renders report problems and the verdict in markdown, and keeps multi-line messages on one row', async () => {
    const report = await runScenario({
      name: 'md',
      setup: () => ({}),
      run: async () => {},
      invariants: [() => 'line one\nline two'],
    })
    const md = reportToMarkdown([report])
    expect(md).toContain('| md | **report** | **FAIL** | baseline made no write calls')
    expect(md).toContain('line one line two')
  })
})

describe('idempotent() after the hunt', () => {
  it('rejects an empty key instead of silently sharing one ledger entry', async () => {
    const f = idempotent(async () => 1, { key: () => '' })
    await expect(f()).rejects.toThrow(/empty string/)
  })

  it('a worker that loses the claim never sends, under reconcile and retry too, unless reconcile finds it', async () => {
    for (const onPending of ['retry', ({}) => ({ found: false as const })] as const) {
      const store = new MemoryLedger({ durable: true })
      let runs = 0
      const worker = () =>
        idempotent(
          async () => {
            runs++
            await sleep(5)
            return 'sent'
          },
          { key: () => 'k', store, onPending },
        )
      const results = await Promise.allSettled([worker()(), worker()()])
      expect(runs).toBe(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    }
  })

  it('counts a write-ahead guard behind an adapter (the tool is learned at runtime)', async () => {
    interface W { mailer: FakeMailer; email: (to: string) => Promise<unknown> }
    const report = await runScenario<W>({
      name: 'adapter',
      setup: () => {
        const mailer = new FakeMailer()
        const ledger = new MemoryLedger({ durable: true })
        const raw = shake('send_email', async (a: { to: string }) => mailer.send({ to: a.to, subject: 's', body: 'b' }))
        // A thin adapter between idempotent() and shake(): argument normalisation.
        const adapter = async (to: string) => raw({ to: to.trim() })
        return { mailer, email: idempotent(adapter, { key: () => 'email:T-1', store: ledger, onPending: 'skip' }) }
      },
      run: async (w) => {
        await retry(() => w.email(' a@x '))
      },
      invariants: [(w) => w.mailer.outbox().length <= 1 || 'twice'],
      faults: [{ kind: 'timeout-after-commit', tool: 'send_email' }],
    })
    expect(report.results[1]!.passed).toBe(true)
  })

  it('a done-ledger replay of the at-risk tool in the resume counts as exercising it', async () => {
    interface W { mailer: FakeMailer; email: () => Promise<unknown> }
    const report = await runScenario<W>({
      name: 'replay counts',
      setup: () => {
        const mailer = new FakeMailer()
        const ledger = new MemoryLedger({ durable: true })
        return {
          mailer,
          email: idempotent(shake('send_email', async () => mailer.send({ to: 'a@x', subject: 's', body: 'b' }, { idempotencyKey: currentIdempotencyKey()! })), {
            key: () => 'email:T-1',
            store: ledger,
          }),
        }
      },
      run: async (w) => {
        await w.email()
      },
      resume: async (w) => {
        await w.email()
        throw new Error('then the worker died')
      },
      invariants: [(w) => w.mailer.outbox().length <= 1 || 'twice'],
      faults: [{ kind: 'job-redelivery' }],
    })
    const r = report.results[1]!
    expect(r.untested).toBe(false)
    expect(r.hollow).toBe(false)
  })

  it('drops ledger writes from a crashed process (a late parallel call cannot write done)', async () => {
    interface W { stripe: FakeStripe; refund: (t: string) => Promise<unknown> }
    const report = await runScenario<W>({
      name: 'late write',
      setup: () => {
        const stripe = new FakeStripe()
        const ledger = new MemoryLedger()
        stripe.createCharge({ amount: 1000 })
        stripe.createCharge({ amount: 1000 })
        const raw = shake('refund', async (a: { charge: string; slow: boolean }) => {
          if (a.slow) await sleep(20)
          return stripe.refunds.create({ charge: a.charge, amount: 100 })
        })
        return { stripe, refund: (t: string) => idempotent(raw, { key: (a) => `refund:${a.charge}`, store: ledger })({ charge: t, slow: t === 'ch_2' }) }
      },
      run: async (w) => {
        void w.refund('ch_2').catch(() => {}) // still in flight when the process dies
        await w.refund('ch_1')
      },
      resume: async (w) => {
        await sleep(40)
        await w.refund('ch_2')
      },
      invariants: [stripeInvariants.refundCountAtMost('ch_2', 1)],
      faults: [{ kind: 'crash-after-commit', tool: 'refund', onCall: 2 }],
    })
    // ch_2's slow call was in flight when ch_1 crashed; a real restart loses it, so the resume must not see a 'done' for ch_2.
    expect(report.results[1]!.calls.filter((c) => c.phase === 'resume' && c.tool === 'refund')).toHaveLength(1)
  })
})

describe('concurrent scenarios', () => {
  it('a call outside any phase is never attributed to another scenario that is running', async () => {
    let leakedInto = 0
    const slow: Scenario<{ f: () => Promise<unknown> }> = {
      name: 'slow',
      setup: () => ({ f: shake('w', async () => sleep(30)) }),
      run: async (w) => {
        await w.f()
      },
      invariants: [],
      faults: [{ kind: 'timeout-after-commit', tool: 'w' }],
    }
    const other: Scenario<{ f: () => Promise<unknown> }> = {
      name: 'other',
      setup: () => {
        const f = shake('w', async () => 1)
        return { f }
      },
      run: async (w) => {
        await w.f()
      },
      invariants: [
        async (w) => {
          // Called outside any phase, while 'slow' is mid-run: must be a plain pass-through.
          try {
            await w.f()
          } catch {
            leakedInto++
          }
          return true
        },
      ],
      faults: [],
      allowUntriggered: true,
    }
    await Promise.all([runScenario(slow), runScenario(other)])
    expect(leakedInto).toBe(0)
  })
})
