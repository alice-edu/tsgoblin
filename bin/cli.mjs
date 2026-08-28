#!/usr/bin/env node
// tsgoblin CLI — thin dispatcher over the codegen (generate), parity filter (check),
// the vue-tsc `--build` drop-in (build), multi-package orchestrator (check-all), and
// engine smoke-test (selftest).
//
//   tsgoblin build     <tsconfig> [--incremental] [--repo-root=<dir>] [--baseline=<path>]
//                                 [--types-wildcard]
//   tsgoblin generate  <tsconfig> [--incremental] [--src-dir=<dir>]
//   tsgoblin check     <tsconfig> [--incremental] [--repo-root=<dir>]
//                                 [--baseline=<path>] [--maps=<path> ...]
//                                 [--write-baseline] [--build] [--types-wildcard]
//
// --types-wildcard restores tsc 5.x's automatic inclusion of every @types package
// under typeRoots, which tsgo (TS7) dropped. Without it tsgo's program can be missing
// ambient globals vue-tsc has, which SILENCES real errors. Off by default.
//   tsgoblin check-all <config.json> [--incremental]
//   tsgoblin selftest  <check-tsconfig> [--generate=<tsconfig>] [--src-dir=<dir>]
//                                 [--repo-root=<dir>] [--baseline=<path>]
//
// See README.md for the full model.
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const [cmd, ...rest] = process.argv.slice(2)
const scripts = {
  build: 'build.mjs',
  generate: 'generate.mjs',
  check: 'check.mjs',
  'check-all': 'check-all.mjs',
  selftest: 'selftest.mjs',
}

if (!scripts[cmd]) {
  console.error('Usage: tsgoblin <build|generate|check|check-all|selftest> <arg> [options]\n')
  console.error('  build     <tsconfig> [--incremental] [--repo-root=<dir>] [--baseline=<path>] [--types-wildcard]  (vue-tsc --build drop-in)')
  console.error('  generate  <tsconfig> [--incremental] [--src-dir=<dir>]')
  console.error('  check     <tsconfig> [--incremental] [--repo-root=<dir>] [--baseline=<path>] [--maps=<path> ...] [--types-wildcard]')
  console.error('  check-all <config.json> [--incremental]')
  console.error('  selftest  <check-tsconfig> [--generate=<tsconfig>] [--src-dir=<dir>] [--repo-root=<dir>] [--baseline=<path>]')
  process.exit(2)
}

const r = spawnSync(process.execPath, [path.join(here, '..', 'src', scripts[cmd]), ...rest], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
