/**
 * Same framework, same model, same tools; only the error text the model sees differs.
 * Isolates the effect of @openai/agents' default tool error message ("... Please try again.")
 * versus passing the real thrown error through a custom errorFunction.
 *
 *   ANTHROPIC_API_KEY=... SHAKEDOWN_ANTHROPIC_MODEL=claude-haiku-5-5 \
 *     npx vitest run --maxWorkers=1 --silent=false examples/openai-agents/error-text-experiment.test.ts
 */
import { describe, expect, it } from 'vitest'
import { setTracingDisabled } from '@openai/agents'
import { aisdk } from '@openai/agents-extensions/ai-sdk'
import { anthropic } from '@ai-sdk/anthropic'
import { runScenario } from '../../src/index.js'
import { refundScenario } from './harness.js'

setTracingDisabled(true)
const TRIALS = Number(process.env.SHAKEDOWN_TRIALS ?? 6)
const model = () => aisdk(anthropic(process.env.SHAKEDOWN_ANTHROPIC_MODEL ?? 'claude-haiku-5-5'))

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('error text experiment (refund timeout, naive tools)', () => {
  for (const errorPassthrough of [false, true]) {
    it(`${errorPassthrough ? 'real error passed through' : 'SDK default error text'}`, { timeout: 20 * 60_000 }, async () => {
      let duplicates = 0
      let lookedUpAfterError = 0
      for (let i = 1; i <= TRIALS; i++) {
        const report = await runScenario({
          ...refundScenario({ fixed: false, makeModel: model, errorPassthrough }),
          faults: [{ kind: 'timeout-after-commit', tool: 'refund' }],
        })
        const r = report.results[1]!
        const trace = r.calls.map((c) => `${c.tool}${c.fault ? `(${c.fault})` : ''}${c.outcome === 'error' ? '!' : ''}`)
        const faultAt = r.calls.findIndex((c) => c.fault)
        const lookedUp = r.calls.slice(faultAt + 1).findIndex((c) => c.tool === 'lookup_charge')
        const nextRefund = r.calls.slice(faultAt + 1).findIndex((c) => c.tool === 'refund')
        const checkedFirst = lookedUp >= 0 && (nextRefund < 0 || lookedUp < nextRefund)
        const dup = r.violations.length > 0
        if (dup) duplicates++
        if (checkedFirst) lookedUpAfterError++
        console.log(`trial ${i}: ${dup ? 'DUPLICATE' : 'no duplicate'}${r.incomplete.length ? ' (incomplete)' : ''}; looked up charge before any retry: ${checkedFirst}; calls: ${trace.join(' -> ')}`)
      }
      console.log(`RESULT ${errorPassthrough ? 'passthrough' : 'default'}: duplicates ${duplicates}/${TRIALS}, looked up charge before retrying ${lookedUpAfterError}/${TRIALS}`)
      expect(TRIALS).toBeGreaterThan(0)
    })
  }
})
