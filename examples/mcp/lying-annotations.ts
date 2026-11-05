/**
 * "Lying annotation" detector for MCP tools.
 *
 * MCP tool annotations are hints the server makes to hosts. idempotentHint:true
 * says "calling this repeatedly with the same arguments has no additional
 * effect", which a host may use to decide that auto-retrying after a timeout is
 * safe. Nothing in the protocol checks that claim. Shakedown can: a tool that
 * declares idempotentHint:true must survive a duplicate-delivery fault (the
 * same call delivered twice with identical arguments).
 *
 * The verdict is only as good as the wiring: shake() must wrap the raw side
 * effect, inside any idempotent() ledger. With shake(idempotent(...)) the
 * duplicate is absorbed by the ledger before it reaches the backend, and an
 * in-process ledger looks idempotent when it is not.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { FaultKind, Report } from '../../src/index.js'

export interface LyingAnnotation {
  tool: string
  claim: 'idempotentHint: true'
  /** Label of the fault result that disproves the claim. */
  fault: string
  violations: string[]
}

/**
 * @param tools the tool list as returned by client.listTools() (annotations included)
 * @param kinds fault kinds that count as evidence. Default duplicate-delivery only, which is the
 *              literal definition of idempotentHint (same call, same arguments, twice).
 */
export function findLyingAnnotations(
  report: Report,
  tools: readonly Tool[],
  kinds: readonly FaultKind[] = ['duplicate-delivery'],
): LyingAnnotation[] {
  const out: LyingAnnotation[] = []
  for (const t of tools) {
    const a = t.annotations
    // Per the spec idempotentHint is only meaningful when readOnlyHint is false.
    if (!a || a.readOnlyHint === true || a.idempotentHint !== true) continue
    for (const r of report.results) {
      if (!r.fault || r.fault.tool !== t.name || !kinds.includes(r.fault.kind)) continue
      if (r.faultNotTriggered || r.passed) continue
      out.push({ tool: t.name, claim: 'idempotentHint: true', fault: r.label, violations: r.violations })
    }
  }
  return out
}

/** Tools that declare idempotentHint:true but were never put through a qualifying fault. Untested claims. */
export function untestedIdempotentClaims(
  report: Report,
  tools: readonly Tool[],
  kinds: readonly FaultKind[] = ['duplicate-delivery'],
): string[] {
  return tools
    .filter((t) => t.annotations?.readOnlyHint !== true && t.annotations?.idempotentHint === true)
    .filter((t) => !report.results.some((r) => r.fault?.tool === t.name && kinds.includes(r.fault.kind) && !r.faultNotTriggered))
    .map((t) => t.name)
}

export function formatLyingAnnotations(found: readonly LyingAnnotation[]): string {
  if (found.length === 0) return 'annotations: no lying idempotentHint found'
  return [
    'annotations: LYING idempotentHint',
    ...found.map((f) => `  ${f.tool} declares ${f.claim} but failed "${f.fault}": ${f.violations.join('; ')}`),
  ].join('\n')
}
