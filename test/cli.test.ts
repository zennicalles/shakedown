import { describe, expect, it } from 'vitest'
import { cli, demoText, runDemo, type CliIO } from '../src/demo.js'

const capture = () => {
  const io = { stdout: '', stderr: '' }
  const sink: CliIO = { out: (s) => void (io.stdout += s), err: (s) => void (io.stderr += s), color: false }
  return { io, sink }
}

describe('npx agent-shakedown demo', () => {
  it('naive tools fail with a duplicate refund; the fixed tools pass every fault', async () => {
    const { naive, fixed } = await runDemo()
    expect(naive.passed).toBe(false)
    expect(naive.safe).toBe(false)
    const timeout = naive.results.find((r) => r.label === 'timeout-after-commit on refund')!
    expect(timeout.violations).toContain('expected exactly 5000 refunded on ch_1, found 10000')
    const dup = naive.results.find((r) => r.label === 'duplicate-delivery on refund')!
    expect(dup.violations).toContain('expected exactly 5000 refunded on ch_1, found 10000')
    expect(naive.results.find((r) => r.label === 'baseline (no fault)')!.passed).toBe(true)

    expect(fixed.passed).toBe(true)
    expect(fixed.results).toHaveLength(naive.results.length)
    expect(fixed.results.every((r) => r.passed && !r.faultNotTriggered)).toBe(true)
  })

  it('prints both reports and the next steps, without ANSI codes when colour is off', async () => {
    const text = await demoText(false)
    expect(text).toContain('shakedown: refund agent (naive tools)  FAIL')
    expect(text).toContain('[FAIL] timeout-after-commit on refund')
    expect(text).toContain('- expected exactly 5000 refunded on ch_1, found 10000')
    expect(text).toContain('shakedown: refund agent (fixed tools)  PASS')
    expect(text).toContain('wrap your own tools with shake()')
    expect(text).not.toContain('\u001b[')
    expect(await demoText(true)).toContain('\u001b[31mFAIL\u001b[0m')
  })
})

describe('agent-shakedown CLI', () => {
  it('prints usage for --help and no command', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const { io, sink } = capture()
      expect(await cli(argv, sink)).toBe(0)
      expect(io.stdout).toMatch(/Usage:[\s\S]*npx agent-shakedown demo/)
    }
  })

  it('prints the package version', async () => {
    const { io, sink } = capture()
    expect(await cli(['--version'], sink)).toBe(0)
    expect(io.stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  })

  it('exits 1 on an unknown command', async () => {
    const { io, sink } = capture()
    expect(await cli(['demoo'], sink)).toBe(1)
    expect(io.stderr).toContain("unknown command 'demoo'")
    expect(io.stdout).toBe('')
  })

  it('runs the demo and exits 0', async () => {
    const { io, sink } = capture()
    expect(await cli(['demo'], sink)).toBe(0)
    expect(io.stdout).toContain('(naive tools)  FAIL')
    expect(io.stdout).toContain('(fixed tools)  PASS')
  })
})
