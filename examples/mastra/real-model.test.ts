/**
 * The same scenarios against a real model, through Mastra's model router
 * ('provider/model' strings; the key is read from ANTHROPIC_API_KEY / OPENAI_API_KEY).
 * Skipped unless a key is set. Override the model with SHAKEDOWN_MODEL, e.g.
 *   SHAKEDOWN_MODEL=anthropic/claude-sonnet-5-5 npx vitest run --maxWorkers=1 examples/mastra/real-model.test.ts
 *
 * Real models are not scripted, so the naive results are printed, not asserted:
 * whether a model retries after "timed out" or "connection closed" is exactly
 * what this measures. The fixed tools (ledger + downstream idempotency key, with
 * volatile ledgers) must pass every fault regardless of what the model does.
 *
 * A real model may legitimately skip a retry and never call send_email, which
 * the `exactly one email` invariant reports; that is a real finding, not noise.
 */
import './no-telemetry.js'
import { describe, expect, it } from 'vitest'
import { formatReport, runScenario } from '../../src/index.js'
import { agentScenario, durableScenario, type ModelFactory } from './scenarios.js'

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)
// Model ids taken from @mastra/core 1.82's provider registry (provider-types.generated.d.ts).
const modelId =
  process.env.SHAKEDOWN_MODEL ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic/claude-haiku-5-5' : 'openai/gpt-5.4-mini')
const real: ModelFactory = () => modelId as `${string}/${string}`

describe.skipIf(!hasKey)(`real model (${modelId})`, () => {
  for (const [label, make] of [
    ['Agent.generate', agentScenario],
    ['DurableAgent + recover()', durableScenario],
  ] as const) {
    it(`${label}: naive tools (report only)`, async () => {
      const report = await runScenario(make('naive', real))
      console.log(formatReport(report))
      expect(report.problems).toEqual([]) // report only: real models vary run to run
    }, 300_000)

    it(`${label}: ledger + downstream key pass every fault`, async () => {
      const report = await runScenario(make('fixed', real))
      console.log(formatReport(report))
      expect(report.safe).toBe(true) // no duplicates under any fault; jobs that stop short are reported, not failed
    }, 300_000)
  }
})
