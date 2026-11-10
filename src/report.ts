import type { Report } from './runner.js'

export function formatReport(r: Report): string {
  const lines: string[] = []
  lines.push(`shakedown: ${r.scenario}  ${r.passed ? 'PASS' : r.safe ? 'SAFE' : 'FAIL'}`)
  for (const p of r.problems) lines.push(`  ! ${p}`)
  if (r.hollowRows > 0) {
    lines.push(`  note: ${r.hollowRows} row(s) passed without the resumed job re-attempting the operation at risk; those passes say nothing about idempotency`)
  }
  for (const res of r.results) {
    // Safety violations always win, even on a row whose fault never triggered.
    const status =
      res.violations.length > 0
        ? 'FAIL'
        : res.faultNotTriggered
          ? 'MISS'
          : res.untested
            ? 'UNTESTED'
            : res.incomplete.length > 0
              ? 'INCOMPLETE'
              : res.passed
                ? 'pass'
                : 'FAIL'
    const writes = res.calls.filter((c) => c.effect === 'write' && c.committed).length
    const extras = [
      `${writes} write${writes === 1 ? '' : 's'} committed`,
      ...(res.dedupes ? [`${res.dedupes} deduped`] : []),
      `${res.durationMs}ms`,
    ]
    lines.push(`  [${status}] ${res.label}  (${extras.join(', ')})`)
    if (res.faultNotTriggered) lines.push(`         fault never triggered: ${res.notTriggeredReason ?? 'targeted call did not happen'}`)
    for (const v of res.violations) lines.push(`         - ${v}`)
    for (const v of res.incomplete) lines.push(`         ~ incomplete: ${v}`)
    if (res.untested) lines.push(`         ! untested: ${res.untestedReason}`)
    if (res.crashSwallowed) {
      lines.push(`         note: the framework caught the simulated crash and kept going; let it propagate or abort on crashSignal() to model a real process death`)
    }
    if (!res.passed && res.agentError) lines.push(`         agent error: ${res.agentError}`)
    for (const n of res.notes) lines.push(`         note: ${n}`)
  }
  return lines.join('\n')
}

export function reportToMarkdown(reports: Report[]): string {
  const cell = (t: string) => t.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
  const rows = reports.flatMap((r) => [
    `| ${cell(r.scenario)} | **report** | ${r.passed ? 'PASS' : r.safe ? 'SAFE' : '**FAIL**'} | ${cell(r.problems.join('; '))} |`,
    ...r.results.map((res) => {
      const status = res.violations.length
        ? '**FAIL**'
        : res.faultNotTriggered
          ? 'not triggered'
          : res.untested
            ? 'untested'
            : res.incomplete.length
              ? 'incomplete'
              : res.passed
                ? res.hollow
                  ? 'pass (hollow)'
                  : 'pass'
                : '**FAIL**'
      const detail = [...res.violations, ...res.incomplete.map((m) => `incomplete: ${m}`), ...(res.untestedReason ? [res.untestedReason] : [])]
      return `| ${cell(r.scenario)} | ${cell(res.label)} | ${status} | ${cell(detail.join('; '))} |`
    }),
  ])
  return ['| Scenario | Fault | Result | Details |', '|---|---|---|---|', ...rows].join('\n')
}

export class ShakedownFailure extends Error {
  constructor(readonly report: Report) {
    super(`\n${formatReport(report)}`)
    this.name = 'ShakedownFailure'
  }
}

/**
 * Throw (failing the test) unless the report is SAFE: no duplicates or other
 * safety violations under any fault, every fault triggered, baseline fully passing.
 * Jobs that stop short under a fault do not fail this; use assertPassed for that.
 */
export function assertSafe(r: Report): void {
  if (!r.safe) throw new ShakedownFailure(r)
}

/** Throw unless everything held: safety AND completion under every fault. */
export function assertPassed(r: Report): void {
  if (!r.passed) throw new ShakedownFailure(r)
}
