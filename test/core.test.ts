import { describe, expect, it } from 'vitest'
import {
  FakeMailer,
  FakeStripe,
  MailerError,
  isViolation,
  crashSignal,
  currentPhase,
  processIsDead,
  unlessDead,
  MemoryLedger,
  StripeError,
  assertPassed,
  assertSafe,
  currentIdempotencyKey,
  currentRun,
  formatReport,
  idempotent,
  mailerInvariants,
  runScenario,
  shake,
  stripeInvariants,
  type Invariant,
  type Report,
  type Scenario,
} from '../src/index.js'
import { scriptedAgent } from './helpers.js'

interface RefundArgs { ticket: string; charge: string; amount: number }
interface EmailArgs { ticket: string; to: string; subject: string; body: string }
interface World {
  stripe: FakeStripe
  mailer: FakeMailer
  chargeId: string
  tools: {
    lookup: (a: { charge: string }) => Promise<unknown>
    refund: (a: RefundArgs) => Promise<unknown>
    email: (a: EmailArgs) => Promise<unknown>
  }
}

/**
 * naive:        plain tools
 * ledger-only:  idempotent() ledger outside the side effect, no key sent downstream
 * durable-ledger-only: same, but the ledger survives crashes (a real DB)
 * fixed:        ledger + the logical key sent downstream (Stripe/mail Idempotency-Key)
 */
type Mode = 'naive' | 'ledger-only' | 'durable-ledger-only' | 'fixed'

function makeWorld(mode: Mode): World {
  const stripe = new FakeStripe()
  const mailer = new FakeMailer()
  const charge = stripe.charges.create({ amount: 10_000, customer: 'cus_ada' })
  const downstream = mode === 'fixed'

  // shake() sits at the side-effect boundary, where real timeouts happen.
  const rawRefund = shake('refund', async (a: RefundArgs) => {
    const key = downstream ? currentIdempotencyKey() : undefined
    return stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, key ? { idempotencyKey: key } : {})
  })
  const rawEmail = shake('send_email', async (a: EmailArgs) => {
    const key = downstream ? currentIdempotencyKey() : undefined
    return mailer.send({ to: a.to, subject: a.subject, body: a.body }, key ? { idempotencyKey: key } : {})
  })

  let refund = rawRefund
  let email = rawEmail
  if (mode !== 'naive') {
    const store = () => (mode === 'durable-ledger-only' ? new MemoryLedger({ durable: true }) : new MemoryLedger())
    refund = idempotent(rawRefund, { key: (a) => `refund:${a.ticket}`, store: store() })
    email = idempotent(rawEmail, { key: (a) => `email:${a.ticket}:${a.subject}`, store: store() })
  }
  return {
    stripe,
    mailer,
    chargeId: charge.id,
    tools: {
      lookup: shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' }),
      refund,
      email,
    },
  }
}

const runAgent = (w: World) =>
  scriptedAgent([
    { call: w.tools.lookup, args: { charge: w.chargeId } },
    { call: w.tools.refund, args: { ticket: 'T-1', charge: w.chargeId, amount: 5_000 } },
    { call: w.tools.email, args: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund', body: '£50 is on its way.' } },
  ])

function refundScenario(mode: Mode): Scenario<World> {
  return {
    name: `refund agent (${mode})`,
    setup: () => makeWorld(mode),
    run: runAgent,
    invariants: [
      stripeInvariants.refundedExactly('ch_1', 5_000),
      stripeInvariants.refundCountAtMost('ch_1', 1),
      mailerInvariants.sentExactly('ada@example.com', 1),
    ],
  }
}

const byLabel = (r: Report<World>) => Object.fromEntries(r.results.map((x) => [x.label, x]))
const verdicts = (r: Report<World>) => Object.fromEntries(r.results.map((x) => [x.label, x.faultNotTriggered ? 'miss' : x.passed ? 'pass' : 'fail']))

describe('naive tools', () => {
  it('pass the baseline and the control fault, fail every after-commit fault and redelivery', async () => {
    const report = await runScenario(refundScenario('naive'))
    expect(verdicts(report)).toEqual({
      'baseline (no fault)': 'pass',
      'error-before-commit on refund': 'pass',
      'timeout-after-commit on refund': 'fail',
      'duplicate-delivery on refund': 'fail',
      'crash-after-commit on refund': 'fail',
      'error-before-commit on send_email': 'pass',
      'timeout-after-commit on send_email': 'fail',
      'duplicate-delivery on send_email': 'fail',
      'crash-after-commit on send_email': 'fail',
      'job-redelivery': 'fail',
    })
    expect(byLabel(report)['timeout-after-commit on refund']!.violations).toContain('expected exactly 5000 refunded on ch_1, found 10000')
    expect(report.results.some((r) => r.label.includes('lookup_charge'))).toBe(false)
    expect(() => assertSafe(report)).toThrow(/FAIL/)
  })

  it('records both deliveries of a duplicate', async () => {
    const report = await runScenario(refundScenario('naive'))
    const dup = byLabel(report)['duplicate-delivery on refund']!
    const refunds = dup.calls.filter((c) => c.tool === 'refund')
    expect(refunds.map((c) => c.delivery)).toEqual([1, 2])
    expect(refunds.every((c) => c.committed)).toBe(true)
    expect(formatReport(report)).toContain('[FAIL] duplicate-delivery on refund  (3 writes committed')
  })
})

describe('the fix', () => {
  it('a ledger alone does not survive a timeout or crash at the side-effect boundary', async () => {
    const v = verdicts(await runScenario(refundScenario('ledger-only')))
    expect(v['timeout-after-commit on refund']).toBe('fail')
    expect(v['crash-after-commit on refund']).toBe('fail')
    expect(v['duplicate-delivery on refund']).toBe('fail')
  })

  it('a durable ledger alone still misses the commit-to-ledger window, but covers redelivery', async () => {
    const v = verdicts(await runScenario(refundScenario('durable-ledger-only')))
    expect(v['timeout-after-commit on refund']).toBe('fail')
    expect(v['crash-after-commit on refund']).toBe('fail')
    expect(v['job-redelivery']).toBe('pass')
  })

  it('ledger + key sent downstream passes every fault, and the report counts the replays', async () => {
    const report = await runScenario(refundScenario('fixed'))
    if (!report.passed) console.log(formatReport(report))
    expect(report.passed).toBe(true)
    expect(report.results).toHaveLength(10)
    const timeout = byLabel(report)['timeout-after-commit on refund']!
    expect(timeout.dedupes).toBe(1)
    expect(timeout.calls.filter((c) => c.tool === 'refund' && c.committed)).toHaveLength(1)
    expect(timeout.calls.filter((c) => c.tool === 'refund' && c.deduped)).toHaveLength(1)
  })

  it('a volatile in-memory ledger is wiped by a crash, like a real restart', async () => {
    // Fault OUTSIDE the ledger, ledger volatile: the crash wipes it, so the resume refunds again.
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      setup: () => {
        const w = makeWorld('naive')
        const stripe = w.stripe
        const inner = idempotent(async (a: RefundArgs) => stripe.refunds.create({ charge: a.charge, amount: a.amount }), {
          key: (a) => `refund:${a.ticket}`,
        })
        w.tools.refund = shake('refund', inner)
        return w
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    expect(report.results[1]!.passed).toBe(false)
  })
})

describe('honest verdicts', () => {
  it('fails the report when an explicit fault never triggers, and explains why', async () => {
    const report = await runScenario({ ...refundScenario('fixed'), faults: [{ kind: 'timeout-after-commit', tool: 'refunds' }] })
    expect(report.passed).toBe(false)
    expect(report.results[1]!.notTriggeredReason).toBe('refunds was never called')
    const report2 = await runScenario({ ...refundScenario('fixed'), faults: [{ kind: 'timeout-after-commit', tool: 'refund', onCall: 2 }] })
    expect(report2.results[1]!.notTriggeredReason).toMatch(/called 1 time\(s\), fewer than onCall=2/)
  })

  it('rejects invalid onCall values', async () => {
    const report = await runScenario({ ...refundScenario('fixed'), faults: [{ kind: 'timeout-after-commit', tool: 'refund', onCall: 0 }] })
    expect(report.passed).toBe(false)
    expect(report.problems[0]).toMatch(/onCall must be an integer >= 1/)
  })

  it('treats onCall without a tool as the Nth write call of any tool', async () => {
    const report = await runScenario({ ...refundScenario('naive'), faults: [{ kind: 'timeout-after-commit', onCall: 2 }] })
    const r = report.results[1]!
    expect(r.label).toBe('timeout-after-commit on write call #2')
    expect(r.calls.find((c) => c.fault)!.tool).toBe('send_email')
  })

  it('fails when the baseline agent throws, and when nothing was faulted', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      run: async () => {
        throw new TypeError('tools is undefined')
      },
      invariants: [stripeInvariants.refundCountAtMost('ch_1', 1)],
    })
    expect(report.passed).toBe(false)
    expect(report.results[0]!.violations[0]).toMatch(/baseline agent error: tools is undefined/)
    expect(report.problems[0]).toMatch(/no write calls/)
  })

  it('treats an invariant that does not return true as a violation', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      faults: [],
      // Block-bodied arrow with no return: a classic silent pass.
      invariants: [((w: World) => {
        w.stripe.listRefunds()
      }) as unknown as Invariant<World>],
    })
    expect(report.results[0]!.violations[0]).toBe('invariant #1 returned undefined')
  })

  it('retargets the fault when the targeted call fails for real before injection', async () => {
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      setup: () => {
        let first = true // fresh per run: the first refund attempt has bad args, as LLMs sometimes produce
        const w = makeWorld('naive')
        const real = w.tools.refund
        w.tools.refund = async (a) => real({ ...a, amount: first ? ((first = false), 0.5) : a.amount })
        return w
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      invariants: [stripeInvariants.refundCountAtMost('ch_1', 1)],
    })
    const r = report.results[1]!
    const refunds = r.calls.filter((c) => c.tool === 'refund')
    expect(refunds[0]).toMatchObject({ outcome: 'error', committed: false })
    expect(refunds[0]!.fault).toBeUndefined()
    expect(refunds[1]).toMatchObject({ fault: 'crash-after-commit', committed: true })
    expect(r.faultNotTriggered).toBe(false)
  })

  it('blocks and records calls after a swallowed crash, and flags the swallow', async () => {
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      run: async (w) => {
        await w.tools.refund({ ticket: 'T-1', charge: w.chargeId, amount: 5_000 }).catch(() => {})
        await w.tools.email({ ticket: 'T-1', to: 'ada@example.com', subject: 's', body: 'b' }).catch(() => {})
      },
      resume: async () => {},
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
      invariants: [stripeInvariants.refundCountAtMost('ch_1', 1)],
    })
    const r = report.results[1]!
    expect(r.crashSwallowed).toBe(true)
    expect(r.calls.find((c) => c.tool === 'send_email')).toMatchObject({ blocked: true, committed: false })
    expect(formatReport(report)).toContain('framework caught the simulated crash')
  })

  it('does not leak run context between concurrent scenarios', async () => {
    await Promise.all([runScenario(refundScenario('naive')), runScenario(refundScenario('fixed'))])
    expect(currentRun()).toBeNull()
    const f = shake('send_email', async (n: number) => n * 2)
    await expect(f(21)).resolves.toBe(42)
  })
})

describe('safety vs completion', () => {
  // An agent that gives up after a refund timeout: refund done, customer never emailed.
  const givesUp = (w: World) =>
    scriptedAgent(
      [
        { call: w.tools.refund, args: { ticket: 'T-1', charge: w.chargeId, amount: 5_000 } },
        { call: w.tools.email, args: { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund', body: 'b' } },
      ],
      1,
    )

  it('classifies a job that stopped short as incomplete, not as a safety failure', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      run: givesUp,
      faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
      allowBaselineError: false,
    })
    const r = report.results[1]!
    expect(r.violations).toEqual([])
    expect(r.incomplete).toEqual(['expected exactly 1 email(s) to ada@example.com, found 0'])
    expect(r.passed).toBe(false)
    expect(report.passed).toBe(false)
    expect(report.safe).toBe(true)
    expect(() => assertSafe(report)).not.toThrow()
    expect(() => assertPassed(report)).toThrow(/INCOMPLETE/)
    expect(formatReport(report)).toContain('~ incomplete: expected exactly 1 email(s)')
  })

  it('keeps duplicates as safety violations', async () => {
    const report = await runScenario(refundScenario('naive'))
    expect(report.safe).toBe(false)
    const t = report.results.find((r) => r.label === 'timeout-after-commit on refund')!
    expect(t.violations).toContain('expected exactly 5000 refunded on ch_1, found 10000')
    expect(t.incomplete).toEqual([])
  })

  it('is not safe when the baseline itself does not complete', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      run: async (w) => {
        await w.tools.refund({ ticket: 'T-1', charge: w.chargeId, amount: 5_000 })
      },
    })
    expect(report.results[0]!.incomplete[0]).toMatch(/found 0/)
    expect(report.safe).toBe(false)
  })

  it('honours a declared kind on object invariants and a returned Violation', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      faults: [],
      allowUntriggered: true,
      invariants: [
        { name: 'audit note written', kind: 'completion', check: () => 'no audit note' },
        () => ({ kind: 'completion', message: 'custom completion' }),
        () => 'plain string defaults to safety',
      ],
    })
    expect(report.results[0]!.incomplete).toEqual(['no audit note', 'custom completion'])
    expect(report.results[0]!.violations).toEqual(['plain string defaults to safety'])
  })

  it('built-in at-least invariants report completion', () => {
    const stripe = new FakeStripe()
    const mailer = new FakeMailer()
    stripe.createCharge({ amount: 100 })
    expect(stripeInvariants.refundedAtLeast('ch_1', 50)({ stripe })).toMatchObject({ kind: 'completion' })
    expect(mailerInvariants.sentAtLeast('a@x', 1)({ mailer })).toMatchObject({ kind: 'completion' })
  })
})

describe('no false passes (pre-publish review)', () => {
  it('a no-op resume after a crash on naive tools is UNTESTED, not safe', async () => {
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      resume: async () => {},
      faults: [
        { kind: 'crash-after-commit', tool: 'refund' },
        { kind: 'crash-after-commit', tool: 'send_email' },
      ],
    })
    expect(report.results[1]!.untested).toBe(true)
    expect(report.results[1]!.incomplete.length).toBeGreaterThan(0)
    expect(report.safe).toBe(false)
    expect(() => assertSafe(report)).toThrow(/UNTESTED/)
  })

  it('a row whose fault never triggered still shows FAIL when a duplicate happened', async () => {
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      run: async (w) => {
        await w.tools.refund({ ticket: 'T-1', charge: w.chargeId, amount: 5_000 })
        await w.tools.refund({ ticket: 'T-1', charge: w.chargeId, amount: 5_000 })
      },
      faults: [{ kind: 'timeout-after-commit', tool: 'send_email' }],
      invariants: [stripeInvariants.refundCountAtMost('ch_1', 1)],
      allowBaselineError: true,
    })
    expect(formatReport(report)).toContain('[FAIL] timeout-after-commit on send_email')
    expect(report.safe).toBe(false)
  })

  it('reports a problem when no fault triggered at all, even with allowUntriggered', async () => {
    const report = await runScenario({
      ...refundScenario('fixed'),
      allowUntriggered: true,
      faults: [
        { kind: 'timeout-after-commit', tool: 'nope' },
        { kind: 'crash-after-commit', tool: 'also_nope' },
      ],
    })
    expect(report.problems).toContain('no fault triggered: nothing was tested')
    expect(report.safe).toBe(false)
    expect(report.passed).toBe(false)
  })

  it('rejects an unknown fault kind instead of silently skipping the call', async () => {
    const report = await runScenario({
      ...refundScenario('fixed'),
      faults: [{ kind: 'timeout-before-commit' as never, tool: 'send_email' }],
    })
    expect(report.problems[0]).toMatch(/unknown kind/)
    expect(report.safe).toBe(false)
  })

  it('keeps an explicitly declared safety invariant as safety even if the check says completion', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      faults: [],
      invariants: [{ name: 'declared', kind: 'safety', check: stripeInvariants.refundedExactly('ch_1', 9_000) }],
    })
    expect(report.results[0]!.violations).toEqual(['expected exactly 9000 refunded on ch_1, found 5000'])
    expect(report.results[0]!.incomplete).toEqual([])
  })

  it('classifies an over-send as safety and rejects malformed Violation objects', async () => {
    const mailer = new FakeMailer()
    mailer.send({ to: 'a@x', subject: 's', body: 'b' })
    mailer.send({ to: 'a@x', subject: 's', body: 'b' })
    expect(mailerInvariants.sentExactly('a@x', 1)({ mailer })).toMatchObject({ kind: 'safety' })
    expect(isViolation({ kind: 'completion' })).toBe(false)
    expect(isViolation({ kind: 'oops', message: 'x' })).toBe(false)
  })

  it('a throwing invariant uses its declared kind', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      faults: [],
      invariants: [
        {
          name: 'boom',
          kind: 'completion',
          check: () => {
            throw new Error('x')
          },
        },
      ],
    })
    expect(report.results[0]!.incomplete).toEqual(['boom threw: x'])
  })
})

describe('adapter helpers', () => {
  it('gives the resumed process a fresh, live crash signal and reports the phase', async () => {
    const seen: Array<{ phase: string | null; aborted: boolean | undefined; dead: boolean }> = []
    const look = () => seen.push({ phase: currentPhase(), aborted: crashSignal()?.aborted, dead: processIsDead() })
    await runScenario<World>({
      ...refundScenario('fixed'),
      run: async (w) => {
        try {
          await runAgent(w)
        } finally {
          look()
        }
      },
      resume: async (w) => {
        look()
        await runAgent(w)
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    // baseline run, crashed run, resume
    expect(seen).toEqual([
      { phase: 'run', aborted: false, dead: false },
      { phase: 'run', aborted: true, dead: true },
      { phase: 'resume', aborted: false, dead: false },
    ])
    expect(currentPhase()).toBeNull()
  })

  it('unlessDead() drops durable writes from the crashed process', async () => {
    const saved: string[] = []
    const save = unlessDead((s: string) => void saved.push(s))
    await runScenario<World>({
      ...refundScenario('fixed'),
      run: async (w) => {
        save('before')
        await runAgent(w).catch(() => {})
        save('after-crash?')
      },
      resume: async (w) => {
        save('resumed')
        await runAgent(w)
      },
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    // baseline: before, after-crash?; crashed run: before (after-crash? dropped); resume: resumed
    expect(saved).toEqual(['before', 'after-crash?', 'before', 'resumed'])
  })

  it('marks a redelivery whose resume errors without writing as UNTESTED, never safe', async () => {
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      resume: async () => {
        throw new Error('cannot resume a finished run')
      },
      faults: [{ kind: 'job-redelivery' }],
    })
    const r = report.results[1]!
    expect(r.untested).toBe(true)
    expect(r.passed).toBe(false)
    expect(report.safe).toBe(false)
    expect(r.untestedReason).toMatch(/errored \(cannot resume a finished run\)/)
    expect(formatReport(report)).toContain('[UNTESTED] job-redelivery')
  })

  it('notes a hollow pass: the resumed job made no writes but the job was already complete', async () => {
    const report = await runScenario<World>({
      ...refundScenario('naive'),
      resume: async () => {},
      faults: [{ kind: 'job-redelivery' }],
    })
    const r = report.results[1]!
    expect(r.untested).toBe(false)
    expect(r.passed).toBe(true)
    expect(r.notes[0]).toMatch(/made no write calls/)
  })

  it('treats any error after a swallowed-then-rethrown crash as the crash, not an agent error', async () => {
    const report = await runScenario<World>({
      ...refundScenario('fixed'),
      run: async (w) => {
        await w.tools.refund({ ticket: 'T-1', charge: w.chargeId, amount: 5_000 }).catch(() => {})
        throw new Error('McpError -32001: Request timed out') // a framework wrapping the abort
      },
      resume: runAgent,
      faults: [{ kind: 'crash-after-commit', tool: 'refund' }],
    })
    expect(report.results[1]!.agentError).toBeUndefined()
    expect(report.results[1]!.passed).toBe(true)
  })
})

describe('FakeMailer', () => {
  it('replays a repeated idempotency key and rejects it with a different payload', () => {
    const m = new FakeMailer()
    const a = m.send({ to: 'a@x', subject: 's', body: 'b' }, { idempotencyKey: 'k' })
    expect(m.send({ to: 'a@x', subject: 's', body: 'b' }, { idempotencyKey: 'k' }).id).toBe(a.id)
    expect(() => m.send({ to: 'a@x', subject: 'reworded', body: 'b' }, { idempotencyKey: 'k' })).toThrow(MailerError)
    expect(m.outbox()).toHaveLength(1)
  })
})

describe('FakeStripe', () => {
  it('replays idempotent requests and rejects reused keys with different params or endpoints', () => {
    const s = new FakeStripe()
    const c = s.createCharge({ amount: 1000 })
    const a = s.createRefund({ charge: c.id, amount: 300 }, { idempotencyKey: 'k1' })
    const b = s.createRefund({ charge: c.id, amount: 300 }, { idempotencyKey: 'k1' })
    expect(b.id).toBe(a.id)
    expect(s.refundedTotal(c.id)).toBe(300)
    expect(() => s.createRefund({ charge: c.id, amount: 400 }, { idempotencyKey: 'k1' })).toThrow(/same parameters/)
    expect(() => s.createCharge({ amount: 300 }, { idempotencyKey: 'k1' })).toThrow(/same endpoint/)
  })

  it('replays a stored execution error, but not a validation error', () => {
    const s = new FakeStripe()
    const c = s.createCharge({ amount: 1000 })
    expect(() => s.createRefund({ charge: c.id, amount: 5000 }, { idempotencyKey: 'k' })).toThrow(StripeError)
    expect(() => s.createRefund({ charge: c.id, amount: 5000 }, { idempotencyKey: 'k' })).toThrow(/greater than unrefunded/)
    expect(() => s.createRefund({ charge: c.id, amount: 50.5 }, { idempotencyKey: 'v' })).toThrow(/positive integer/)
    expect(s.createRefund({ charge: c.id, amount: 50 }, { idempotencyKey: 'v' }).amount).toBe(50)
  })

  it('dedupes charge creation with an idempotency key', () => {
    const s = new FakeStripe()
    expect(s.charges.create({ amount: 100 }, { idempotencyKey: 'c' }).id).toBe(s.charges.create({ amount: 100 }, { idempotencyKey: 'c' }).id)
  })

  it('rejects over-refunds and full re-refunds like Stripe', () => {
    const s = new FakeStripe()
    const c = s.createCharge({ amount: 1000 })
    expect(() => s.createRefund({ charge: c.id, amount: 1001 })).toThrow(/greater than unrefunded/)
    s.createRefund({ charge: c.id })
    expect(s.retrieveCharge(c.id).refunded).toBe(true)
    expect(() => s.createRefund({ charge: c.id })).toThrow(/already been refunded/)
  })

  it('snapshots and restores', () => {
    const s = new FakeStripe()
    const c = s.createCharge({ amount: 1000 })
    const snap = s.snapshot()
    s.createRefund({ charge: c.id, amount: 100 })
    s.restore(snap)
    expect(s.listRefunds()).toHaveLength(0)
    expect(s.createCharge({ amount: 5 }).id).toBe('ch_2')
  })
})
