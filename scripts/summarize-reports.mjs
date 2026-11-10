#!/usr/bin/env node
/**
 * Summarize Shakedown reports printed in vitest logs (formatReport output).
 *
 *   node scripts/summarize-reports.mjs .tmp/real-*.log [--json out.json]
 *
 * Each failing row is classified from its violation messages:
 *   duplicate  - something happened more than once (refund total/count over, >1 email)
 *   incomplete - the job stopped short (refund under, 0 emails)
 * Rows are aggregated per (scenario, fault) across all runs found in the logs.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const jsonAt = args.indexOf('--json')
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null
const files = args.filter((a, i) => jsonAt < 0 || (i !== jsonAt && i !== jsonAt + 1))

const agg = new Map() // key scenario||fault -> {scenario, fault, runs, pass, duplicate, incomplete, other, miss, untested, hollow}
let scenario = null
let row = null
const bump = (k, f) => {
  const key = `${scenario}||${f}`
  if (!agg.has(key)) agg.set(key, { scenario, fault: f, runs: 0, pass: 0, duplicate: 0, incomplete: 0, other: 0, miss: 0, untested: 0, hollow: 0 })
  return agg.get(key)
}
const flush = () => {
  if (!row) return
  const a = bump(row.status, row.fault)
  a.runs++
  const safety = row.violations.filter((v) => v.kind === 'safety')
  if (row.status === 'MISS' && safety.length === 0) a.miss++
  else if (row.status === 'UNTESTED') a.untested++
  else if (row.status === 'pass') {
    a.pass++
    if (row.hollow) a.hollow++
  } else {
    // New-format logs (decided per FILE) mark completion lines with "~ incomplete:": every other
    // "- " line is a safety violation. Old logs only have "- " lines, classified by over/under count.
    // Harness or agent failures (baseline agent error, an invariant that threw) are never duplicates.
    const realSafety = safety.filter((v) => !/^baseline agent error:/.test(v.text) && !/ threw: /.test(v.text))
    const dup = newFormat ? realSafety.length > 0 : realSafety.some((v) => /found (\d+)/.test(v.text) && isOver(v.text))
    const inc = newFormat
      ? row.violations.some((v) => v.kind === 'completion')
      : safety.some((v) => /found (\d+)/.test(v.text) && !isOver(v.text))
    if (dup) a.duplicate++
    else if (inc) a.incomplete++
    else a.other++
  }
  row = null
}
function isOver(v) {
  // "expected exactly 5000 refunded on ch_1, found 10000" / "expected at most 1 ..., found 2" / "expected exactly 1 email(s) ..., found 0"
  const m = v.match(/expected (?:exactly|at most) (\d+).*found (\d+)/)
  return m ? Number(m[2]) > Number(m[1]) : false
}

let newFormat = false
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  newFormat = /~ incomplete:|\[(INCOMPLETE|UNTESTED)\]/.test(text)
  for (const line of text.split(/\r?\n/)) {
    const s = line.match(/^shakedown: (.+?)\s+(PASS|FAIL|SAFE)$/)
    if (s) {
      flush()
      scenario = s[1]
      continue
    }
    const r = line.match(/^\s+\[(pass|FAIL|MISS|INCOMPLETE|UNTESTED)\] (.+?)  \(/)
    if (r && scenario) {
      flush()
      row = { status: r[1], fault: r[2], violations: [], hollow: false }
      continue
    }
    if (row) {
      const v = line.match(/^\s+(-|~ incomplete:) (.+)$/)
      if (v) row.violations.push({ kind: v[1] === '-' ? 'safety' : 'completion', text: v[2] })
      else if (/note: the (resumed|redelivered) job made no write calls, so this pass comes from the resume path/.test(line)) row.hollow = true
      else if (!/^\s{9}/.test(line)) flush()
    }
  }
  flush()
  scenario = null
}

const rows = [...agg.values()]
const cell = (a) => {
  const parts = []
  if (a.duplicate) parts.push(`**${a.duplicate}/${a.runs} duplicate**`)
  if (a.incomplete) parts.push(`${a.incomplete}/${a.runs} incomplete`)
  if (a.other) parts.push(`${a.other}/${a.runs} other`)
  if (a.untested) parts.push(`${a.untested}/${a.runs} untested`)
  if (a.miss) parts.push(`${a.miss}/${a.runs} not triggered`)
  if (a.pass) parts.push(`${a.pass}/${a.runs} ok${a.hollow ? ` (${a.hollow} hollow)` : ''}`)
  return parts.join(', ')
}
let cur = null
for (const a of rows) {
  if (a.scenario !== cur) {
    cur = a.scenario
    console.log(`\n### ${cur}\n\n| Fault | Result |\n|---|---|`)
  }
  console.log(`| ${a.fault} | ${cell(a)} |`)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2))
