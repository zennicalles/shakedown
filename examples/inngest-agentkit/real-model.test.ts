/**
 * Same scenarios against a real model. Skipped unless ANTHROPIC_API_KEY or
 * OPENAI_API_KEY is set. Override the model with SHAKEDOWN_MODEL.
 *
 *   ANTHROPIC_API_KEY=... npx vitest run --maxWorkers=1 examples/inngest-agentkit/real-model.test.ts
 *
 * Plain runtime: AgentKit fetch()es the provider itself. Inngest runtime:
 * AgentKit emits step.ai.infer and LocalInngest's gateway makes the provider
 * request (as the Inngest server would). Each scenario makes 10 agent runs
 * (baseline, 8 tool faults, job-redelivery) of 4-6 model calls each.
 */
import { anthropic, openai } from '@inngest/agent-kit'
import { describe, expect, it } from 'vitest'
import { formatReport, runScenario } from '../../src/index.js'
import { refundScenario, type ScenarioOptions } from './refund-agent.js'

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

function realModel(): ReturnType<ScenarioOptions['makeModel']> {
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic({ model: process.env.SHAKEDOWN_MODEL ?? 'claude-haiku-5-5', defaultParameters: { max_tokens: 1024 } })
  }
  return openai({ model: process.env.SHAKEDOWN_MODEL ?? 'gpt-5.4-mini' })
}

const TIMEOUT = 10 * 60_000

describe.skipIf(!hasKey)('AgentKit refund network with a real model', () => {
  it(
    'plain, naive tools: report what the real model does under each fault',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'naive', runtime: 'plain', makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.problems).toEqual([]) // report only: real models vary run to run
    },
    TIMEOUT,
  )

  it(
    'inngest, naive tools: report (the baseline is expected to duplicate on replay)',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'naive', runtime: 'inngest', makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.problems).toEqual([])
    },
    TIMEOUT,
  )

  for (const runtime of ['plain', 'inngest'] as const) {
    it(
      `${runtime}, fixed tools: no duplicates under any fault`,
      async () => {
        const report = await runScenario(refundScenario({ mode: 'fixed', runtime, makeModel: realModel }))
        console.log(formatReport(report))
        expect(report.safe).toBe(true) // jobs that stop short are reported, not failed
      },
      TIMEOUT,
    )
  }

  it(
    'inngest, fixed tools + waitForEvent approval: no duplicates under any fault',
    async () => {
      const report = await runScenario(refundScenario({ mode: 'fixed', runtime: 'inngest', refundNeedsApproval: true, makeModel: realModel }))
      console.log(formatReport(report))
      expect(report.safe).toBe(true)
    },
    TIMEOUT,
  )
})
