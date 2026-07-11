#!/usr/bin/env node
// vue-tsgo CLI — thin dispatcher over the codegen (generate) and parity filter (check).
//
//   vue-tsgo generate <tsconfig> [--incremental] [--src-dir=<dir>]
//   vue-tsgo check    <tsconfig> [--incremental] [--repo-root=<dir>]
//                                [--baseline=<path>] [--maps=<path> ...]
//                                [--write-baseline] [--build]
//
// See README.md for the full model.
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const [cmd, ...rest] = process.argv.slice(2)
const scripts = { generate: 'generate.mjs', check: 'check.mjs' }

if (!scripts[cmd]) {
  console.error('Usage: vue-tsgo <generate|check> <tsconfig> [options]\n')
  console.error('  generate <tsconfig> [--incremental] [--src-dir=<dir>]')
  console.error('  check    <tsconfig> [--incremental] [--repo-root=<dir>] [--baseline=<path>] [--maps=<path> ...]')
  process.exit(2)
}

const r = spawnSync(process.execPath, [path.join(here, '..', 'src', scripts[cmd]), ...rest], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
