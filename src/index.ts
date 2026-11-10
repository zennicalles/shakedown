export { shake, type ShakeOptions } from './shake.js'
export {
  runScenario,
  defaultFaults,
  isViolation,
  type Scenario,
  type Invariant,
  type InvariantResult,
  type Violation,
  type ViolationKind,
  type Report,
  type FaultResult,
} from './runner.js'
export {
  TOOL_FAULT_KINDS,
  ALL_FAULT_KINDS,
  describeFault,
  validateFault,
  isSimulatedCrash,
  SimulatedCrash,
  SimulatedTimeoutError,
  SimulatedTransientError,
  type FaultKind,
  type FaultSpec,
} from './faults.js'
export {
  currentRun,
  crashSignal,
  currentPhase,
  processIsDead,
  unlessDead,
  registerVolatile,
  markDeduped,
  type CallRecord,
  type Effect,
  type Phase,
  type RunContext,
} from './context.js'
export { formatReport, reportToMarkdown, assertSafe, assertPassed, ShakedownFailure } from './report.js'
export { FakeStripe, StripeError, stripeInvariants, stableStringify } from './fakes/stripe.js'
export type { Charge, Refund, CreateRefundParams, RequestOptions } from './fakes/stripe.js'
export { FakeMailer, MailerError, mailerInvariants, type Email } from './fakes/mailer.js'
export {
  idempotent,
  currentIdempotencyKey,
  MemoryLedger,
  PossiblyCommittedError,
  type PendingPolicy,
  type Reconciled,
  type LedgerStore,
  type LedgerEntry,
  type IdempotentOptions,
} from './fix/idempotent.js'
