#!/usr/bin/env node
import { cli } from './demo.js'

// Colour only on a terminal (NO_COLOR turns it off; FORCE_COLOR turns it on for captured output).
const force = process.env.FORCE_COLOR
const color = force !== undefined && force !== '' ? force !== '0' : !!process.stdout.isTTY && process.env.NO_COLOR === undefined

process.exitCode = await cli(process.argv.slice(2), {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  color,
})
