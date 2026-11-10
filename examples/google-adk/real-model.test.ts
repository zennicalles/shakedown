/**
 * Same scenario against a real Gemini model through ADK's own `Gemini` class.
 * Skipped unless GOOGLE_GENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY is set
 * (the variables ADK's Gemini reads). Override the model with SHAKEDOWN_MODEL.
 *
 *   GEMINI_API_KEY=... npx vitest run --maxWorkers=1 examples/google-adk/real-model.test.ts
 *
 * Each scenario makes 10 agent runs (baseline, 8 tool faults, job-redelivery)
 * of 3-6 model calls each, plus a resume after each crash and the redelivery.
 */
import { Gemini, type BaseLlm } from '@google/adk'
import { describe, expect, it } from 'vitest'
import { formatReport, runScenario } from '../../src/index.js'
import { refundScenario } from './refund-agent.js'

const hasKey = Boolean(process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)

function realModel(): BaseLlm {
  return new Gemini({ model: process.env.SHAKEDOWN_MODEL ?? 'gemini-2.5-flash' })
}

const TIMEOUT = 10 * 60_000

describe.skipIf(!hasKey)('Google ADK refund agent with a real model', () => {
  it(
    'naive tools: report what the real model does under each fault',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'naive', makeModel: realModel }))
      console.log(formatReport(report))
      // A real model is not scripted, so only the report itself is asserted.
      expect(report.problems).toEqual([]) // report only: real models vary run to run
    },
    TIMEOUT,
  )

  it(
    'fixed tools (volatile ledger + downstream key): every fault passes',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'fixed', makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
    },
    TIMEOUT,
  )

  it(
    'fixed tools + requireConfirmation on refund: every fault passes',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'fixed', refundNeedsApproval: true, makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
    },
    TIMEOUT,
  )
})
