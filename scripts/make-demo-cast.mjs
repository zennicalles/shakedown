#!/usr/bin/env node
/**
 * Build docs/demo.cast (asciinema v2) from the REAL output of `agent-shakedown demo`.
 *
 *   npm run build && node scripts/make-demo-cast.mjs [out.cast]
 *   npx svg-term-cli --in docs/demo.cast --out docs/demo.svg --window --padding 18   (or: npm run demo:svg)
 *
 * Runs dist/cli.js with FORCE_COLOR=1, then replays its stdout line by line after
 * "typing" the command. Timing is seeded, so the same output gives the same cast.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, process.argv[2] ?? 'docs/demo.cast')
const cli = resolve(root, 'dist/cli.js')
if (!existsSync(cli)) {
  console.error('dist/cli.js not found: run `npm run build` first')
  process.exit(1)
}

const env = { ...process.env, FORCE_COLOR: '1' }
delete env.NO_COLOR
const run = spawnSync(process.execPath, [cli, 'demo'], { env, encoding: 'utf8' })
if (run.status !== 0 || !run.stdout) {
  console.error(`demo failed (exit ${run.status}):\n${run.stderr}`)
  process.exit(1)
}
const lines = run.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

// Seeded PRNG (mulberry32) so regenerating with the same output gives the same timing.
let seed = 0x5eed
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const events = []
let t = 0
const wait = (s) => void (t += s)
const emit = (delay, data) => {
  wait(delay)
  events.push([Number(t.toFixed(3)), 'o', data])
}

const prompt = '\u001b[1;32m$\u001b[0m '
const command = 'npx agent-shakedown demo'
emit(0.4, prompt)
wait(0.9)
for (const ch of command) emit(0.045 + rand() * 0.09 + (ch === ' ' ? 0.08 : 0), ch)
emit(0.55, '\r\n')
wait(0.9) // npx starting up

for (const [i, line] of lines.entries()) {
  const p = plain(line)
  const prev = plain(lines[i - 1] ?? '')
  let delay = 0.05 + rand() * 0.05
  if (/^\d\/2 /.test(p)) delay = i === 0 ? 0.1 : 2.2 // pause to read the failures before the fix
  else if (p.startsWith('shakedown:')) delay = 0.6
  else if (p.trim() === '') delay = 0.25
  else if (/^\s+- /.test(p)) delay = 0.12
  else if (prev.trim() === '' && i > 0) delay = 0.5
  emit(delay, `${line}\r\n`)
}
emit(0.6, prompt)
emit(6, '') // hold the final frame before the animation loops

const width = 100
const height = lines.length + 3
const header = { version: 2, width, height, env: { SHELL: '/bin/bash', TERM: 'xterm-256color' }, title: 'npx agent-shakedown demo' }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n')
console.log(`wrote ${out}: ${events.length} events, ${t.toFixed(1)}s, ${width}x${height}`)
