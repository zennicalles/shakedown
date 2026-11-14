import { readFileSync } from 'node:fs'
import { FakeMailer, mailerInvariants } from './fakes/mailer.js'
import { FakeStripe, stripeInvariants } from './fakes/stripe.js'
import { isSimulatedCrash } from './faults.js'
import { currentIdempotencyKey, idempotent } from './fix/idempotent.js'
import { formatReport } from './report.js'
import { runScenario, type Report } from './runner.js'
import { shake } from './shake.js'

/** The built-in demo behind `npx agent-shakedown demo`: no API key, no network. */
export const README_URL = 'https://github.com/zennicalles/shakedown#readme'

interface RefundArgs { ticket: string; charge: string; amount: number }
interface EmailArgs { ticket: string; to: string; subject: string; body: string }
type Tool = (a: any) => Promise<unknown>
interface World { stripe: FakeStripe; mailer: FakeMailer; charge: string; tools: { lookup: Tool; refund: Tool; email: Tool } }

function makeWorld(fixed: boolean): World {
  const stripe = new FakeStripe()
  const mailer = new FakeMailer()
  const charge = stripe.charges.create({ amount: 10_000, customer: 'cus_ada' }).id
  // With the fix, the key idempotent() holds is sent downstream, so a retry is a replay.
  const opts = () => (fixed ? { idempotencyKey: currentIdempotencyKey()! } : {})
  const refund = shake('refund', async (a: RefundArgs) =>
    stripe.refunds.create({ charge: a.charge, amount: a.amount, metadata: { ticket: a.ticket } }, opts()))
  const email = shake('send_email', async (a: EmailArgs) => mailer.send({ to: a.to, subject: a.subject, body: a.body }, opts()))
  const lookup = shake('lookup_charge', async (a: { charge: string }) => stripe.charges.retrieve(a.charge), { effect: 'read' })
  if (!fixed) return { stripe, mailer, charge, tools: { lookup, refund, email } }
  return {
    stripe,
    mailer,
    charge,
    tools: {
      lookup,
      // Key on the ticket (the logical operation), never on text the model wrote.
      refund: idempotent(refund, { key: (a: RefundArgs) => `refund:${a.ticket}` }),
      email: idempotent(email, { key: (a: EmailArgs) => `refund-email:${a.ticket}` }),
    },
  }
}

/** A scripted refund agent. Like a real model, it retries an errored tool call up to 3 times. */
async function refundAgent(w: World): Promise<void> {
  const steps: Array<[Tool, unknown]> = [
    [w.tools.lookup, { charge: w.charge }],
    [w.tools.refund, { ticket: 'T-1', charge: w.charge, amount: 5_000 }],
    [w.tools.email, { ticket: 'T-1', to: 'ada@example.com', subject: 'Your refund', body: '£50 is on its way.' }],
  ]
  for (const [call, args] of steps) {
    for (let attempt = 1; ; attempt++) {
      try {
        await call(args)
        break
      } catch (e) {
        if (isSimulatedCrash(e) || attempt === 3) throw e // a crash ends the process; then give up
      }
    }
  }
}

const scenario = (fixed: boolean) =>
  runScenario<World>({
    name: `refund agent (${fixed ? 'fixed tools' : 'naive tools'})`,
    setup: () => makeWorld(fixed),
    run: refundAgent,
    invariants: [stripeInvariants.refundedExactly('ch_1', 5_000), mailerInvariants.sentExactly('ada@example.com', 1)],
  })

/** Run the demo agent under every fault, first with naive tools, then with the fix. */
export async function runDemo(): Promise<{ naive: Report<World>; fixed: Report<World> }> {
  return { naive: await scenario(false), fixed: await scenario(true) }
}

const ESC = '\u001b['
const paint = (on: boolean) => (code: string, s: string) => (on ? `${ESC}${code}m${s}${ESC}0m` : s)

/** Colour a formatReport() block: FAIL red, pass/PASS green, other verdicts yellow. */
function colourReport(text: string, color: boolean): string {
  const c = paint(color)
  return text
    .replace(/  (PASS|SAFE|FAIL)$/m, (_, v: string) => `  ${c(v === 'FAIL' ? '1;31' : '1;32', v)}`)
    .replace(/\[(FAIL|pass|MISS|UNTESTED|INCOMPLETE)\]/g, (_, v: string) => `[${c(v === 'FAIL' ? '31' : v === 'pass' ? '32' : '33', v)}]`)
    .replace(/^( {9}- .*)$/gm, (l) => c('31', l))
}

/** The demo's full text output. */
export async function demoText(color = false): Promise<string> {
  const c = paint(color)
  const { naive, fixed } = await runDemo()
  return [
    c('1', '1/2  A refund agent with naive tools, under every fault Shakedown injects'),
    c('2', '     It looks up ch_1, refunds £50, emails the customer, and retries a failed call up to 3 times.'),
    '',
    colourReport(formatReport(naive), color),
    '',
    c('1', '2/2  Same agent, fixed: idempotent() + the key sent downstream via currentIdempotencyKey()'),
    '',
    colourReport(formatReport(fixed), color),
    '',
    `${c('1', 'What it means:')} a lost reply, a crash or a redelivery made the naive agent refund £50 twice.`,
    `${c('1', 'Read more:')} ${README_URL}`,
    `${c('1', 'Your agent:')} npm install -D agent-shakedown, then wrap your own tools with shake().`,
    '',
  ].join('\n')
}

const USAGE = `agent-shakedown: crash-test your AI agent's tool calls

Usage:
  npx agent-shakedown demo        run a built-in refund agent under every fault (no API key, no network)
  npx agent-shakedown --help      show this help
  npx agent-shakedown --version   print the version

Shakedown is a test library: npm install -D agent-shakedown, then wrap your tools with shake().
Docs: ${README_URL}
`

export interface CliIO { out: (s: string) => void; err: (s: string) => void; color: boolean }

/** The `agent-shakedown` command. Returns the exit code. */
export async function cli(argv: string[], io: CliIO): Promise<number> {
  const [cmd] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') return (io.out(USAGE), 0)
  if (cmd === '--version' || cmd === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    return (io.out(`${pkg.version}\n`), 0)
  }
  if (cmd === 'demo') return (io.out(await demoText(io.color)), 0)
  io.err(`agent-shakedown: unknown command '${cmd}'\n\n${USAGE}`)
  return 1
}
