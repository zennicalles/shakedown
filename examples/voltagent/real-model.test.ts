/**
 * Same scenario against a real model. Skipped unless ANTHROPIC_API_KEY or
 * OPENAI_API_KEY is set. Override the model with SHAKEDOWN_MODEL.
 *
 *   ANTHROPIC_API_KEY=... npx vitest run --maxWorkers=1 examples/voltagent/real-model.test.ts
 *
 * Each scenario makes 10 agent runs (baseline, 8 tool faults, job-redelivery)
 * of 3-6 model calls each, plus a resume after each crash and the redelivery.
 */
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { describe, expect, it } from 'vitest'
import { formatReport, runScenario } from '../../src/index.js'
import { refundScenario } from './refund-agent.js'

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

function realModel(): LanguageModel {
  if (process.env.ANTHROPIC_API_KEY) return anthropic(process.env.SHAKEDOWN_MODEL ?? 'claude-haiku-5-5')
  return openai(process.env.SHAKEDOWN_MODEL ?? 'gpt-5.4-mini')
}

const TIMEOUT = 10 * 60_000

describe.skipIf(!hasKey)('VoltAgent refund agent with a real model', () => {
  it(
    'naive tools: report what the real model does under each fault',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'naive', makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.problems).toEqual([]) // report only: real models vary run to run
    },
    TIMEOUT,
  )

  it(
    'fixed tools (volatile ledger + downstream key): no duplicates under any fault',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'fixed', makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.safe).toBe(true) // jobs that stop short are reported, not failed
    },
    TIMEOUT,
  )

  it(
    'fixed tools + needsApproval on refund: no duplicates under any fault',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'fixed', refundNeedsApproval: true, makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.safe).toBe(true)
    },
    TIMEOUT,
  )
})
