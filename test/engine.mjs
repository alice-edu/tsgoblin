// tsgoblin engine regression tests — the engine's own self-tests, dogfooding the
// `selftest` and `check-all` subcommands against the fixture:
//   1. selftest subcommand ⇒ clean tree 0 real errors + injected <script>/<template>
//      errors caught at the EXACT remapped .vue (line,col). (parity tests 1-3)
//   2. incremental codegen manifest === full-regen manifest (no staleness). (parity 4)
//   3. check-all orchestration: multi-package config, emit step, per-package PASS
//      summary, exit 0 on a clean tree.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const pkg = path.resolve(here, '..')
const cli = path.join(pkg, 'bin/cli.mjs')
const fixture = path.join(here, 'fixture')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => (failures++, console.error(`  ✗ ${m}`))
const node = (args, cwd = pkg) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

console.log('[tsgoblin engine]')

// 1. selftest subcommand: clean⇒0 + injected script/template errors at exact positions.
{
  const r = node([cli, 'selftest', path.join(fixture, 'tsconfig.tsgo.json')])
  if (r.status === 0) ok('selftest subcommand: clean⇒0, injected <script>+<template> errors at exact positions')
  else bad(`selftest subcommand failed (exit ${r.status}):\n${r.stdout}${r.stderr}`)
}

// 2. incremental codegen === full regen (determinism that lets --incremental skip work).
{
  const gen = path.join(pkg, 'src/generate.mjs')
  const maps = path.join(fixture, '.tsgoblin-maps.json')
  node([gen, 'tsconfig.json'], fixture)
  const full = fs.readFileSync(maps, 'utf8')
  node([gen, 'tsconfig.json', '--incremental'], fixture)
  const incr = fs.readFileSync(maps, 'utf8')
  if (full === incr) ok('incremental codegen manifest === full regen (no staleness)')
  else bad(`incremental manifest diverged from full regen (${incr.length} vs ${full.length} bytes)`)
  node([gen, 'tsconfig.json'], fixture) // leave a clean, full generated tree
}

// 3. check-all: multi-package config (fixture as one package with an emit step) ⇒ PASS.
{
  const cfgPath = path.join(os.tmpdir(), `tsgoblin-engine-checkall-${process.pid}.json`)
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      repoRoot: fixture,
      packages: [
        { name: 'fixture', dir: '.', generate: 'tsconfig.json', emit: 'tsconfig.tsgo-emit.json', check: 'tsconfig.tsgo.json' },
      ],
    }),
  )
  try {
    const r = node([cli, 'check-all', cfgPath])
    if (r.status === 0 && /check-all: PASS/.test(r.stderr)) ok('check-all: clean multi-package config ⇒ PASS, exit 0')
    else bad(`check-all expected PASS/exit 0, got exit ${r.status}:\n${r.stdout}${r.stderr}`)
  } finally {
    fs.rmSync(cfgPath, { force: true })
    fs.rmSync(path.join(fixture, 'dist-tsgo'), { recursive: true, force: true })
    fs.rmSync(path.join(fixture, 'dist'), { recursive: true, force: true })
    fs.rmSync(path.join(fixture, '.tsgo-tsbuildinfo'), { force: true })
  }
}

console.log(failures === 0 ? '\n[tsgoblin engine] PASS' : `\n[tsgoblin engine] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
