/**
 * The same scenarios against a real model. Skipped unless a key is present.
 *
 *   OPENAI_API_KEY=...    uses the SDK's default OpenAI provider (override with SHAKEDOWN_OPENAI_MODEL)
 *   ANTHROPIC_API_KEY=... uses Claude through the SDK's AI SDK adapter
 *                         (@openai/agents-extensions/ai-sdk + @ai-sdk/anthropic;
 *                         override with SHAKEDOWN_ANTHROPIC_MODEL)
 *
 * A real model is not deterministic, so for the naive tools we only print the
 * report; the fixed tools must pass whatever the model does on retry, as long as
 * it keeps the ticket id and email subject stable (they are the idempotency keys, sent
 * downstream to Stripe and the mailer).
 *
 * Cost: each scenario runs 10 jobs (baseline + 8 tool faults + job-redelivery), each 4 to 8 model calls
 * (crash and redelivery jobs run twice).
 */
import { describe, expect, it } from 'vitest'
import { getDefaultModel, setTracingDisabled, type Model } from '@openai/agents'
import { aisdk } from '@openai/agents-extensions/ai-sdk'
import { anthropic } from '@ai-sdk/anthropic'
import { formatReport, runScenario } from '../../src/index.js'
import { approvalScenario, refundScenario } from './harness.js'

setTracingDisabled(true)

const hasKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY

function realModel(): Model | string {
  if (process.env.OPENAI_API_KEY) return process.env.SHAKEDOWN_OPENAI_MODEL ?? getDefaultModel()
  return aisdk(anthropic(process.env.SHAKEDOWN_ANTHROPIC_MODEL ?? 'claude-opus-5-5'))
}

describe.skipIf(!hasKey)('real model', () => {
  for (const make of [refundScenario, approvalScenario]) {
    it(`${make.name}: naive tools (report only)`, { timeout: 15 * 60_000 }, async () => {
      const report = await runScenario(make({ fixed: false, makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.problems).toEqual([]) // report only: real models vary run to run
    })

    it(`${make.name}: ledger + downstream key pass every fault`, { timeout: 15 * 60_000 }, async () => {
      const report = await runScenario(make({ fixed: true, makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
    })
  }
})
