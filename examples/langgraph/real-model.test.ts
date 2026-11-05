/**
 * The same refund scenario driven by a real model instead of the scripted mock.
 * Skipped unless ANTHROPIC_API_KEY or OPENAI_API_KEY is set.
 *
 *   ANTHROPIC_API_KEY=... npx vitest run --maxWorkers=1 examples/langgraph/real-model.test.ts
 *
 * Model ids can be overridden with ANTHROPIC_MODEL / OPENAI_MODEL. Each scenario
 * makes 10 agent runs (baseline + 4 faults x 2 write tools + job-redelivery),
 * roughly 4-6 model calls each; crash and redelivery runs start a second process.
 * A real model may re-do the job when it is delivered again on the finished
 * thread, so the naive job-redelivery verdict can differ from the mock.
 */
import { ChatAnthropic } from '@langchain/anthropic'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
import { describe, expect, it } from 'vitest'
import { formatReport, runScenario } from '../../src/index.js'
import { refundScenario } from './refund-agent.js'

const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
const hasOpenAI = !!process.env.OPENAI_API_KEY

function realModel(): BaseChatModel {
  if (hasAnthropic) {
    return new ChatAnthropic({ model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5', maxTokens: 4096 }) as unknown as BaseChatModel
  }
  return new ChatOpenAI({ model: process.env.OPENAI_MODEL ?? 'gpt-5-mini' }) as unknown as BaseChatModel
}

describe.skipIf(!hasAnthropic && !hasOpenAI)('LangGraph refund agent with a real model', () => {
  it('naive tools: report what a real model does under each fault', async () => {
    const report = await runScenario(refundScenario({ fixed: false, model: () => realModel() }))
    console.log(formatReport(report))
    // Real models vary in whether they retry after an error, so only the baseline is asserted.
    expect(report.problems).toEqual([]) // report only: real models vary run to run
  }, 900_000)

  it('ledger + downstream key: every fault passes, with a volatile ledger', async () => {
    const report = await runScenario(refundScenario({ fixed: true, model: () => realModel() }))
    console.log(formatReport(report))
    expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
  }, 900_000)
})
