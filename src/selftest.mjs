// tsgoblin selftest: smoke-test the engine against a consumer's own tsconfig. Injects
// a synthetic probe SFC with a KNOWN `<script>` (TS2322) and `<template>` (TS2345)
// error, runs generate + check, and asserts they surface at the EXACT remapped `.vue`
// (line,col) — and that a clean tree reports 0 real errors. The probe is created under
// the tsconfig's src dir and removed in a `finally` that restores a clean generated tree.
//
// Usage: tsgoblin selftest <check-tsconfig>
//          [--generate=<tsconfig>]  # config for the codegen pass; default = check-tsconfig
//          [--src-dir=<dir>]        # SFC root the probe is written under; default = <config-dir>/src
//          [--repo-root=<dir>]      # display-path root; default = <config-dir>
//          [--baseline=<path>]      # reviewed divergence baseline, forwarded to check

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const checkConfig = argv.find((a) => !a.startsWith('--'))
if (!checkConfig) {
  console.error('Usage: tsgoblin selftest <check-tsconfig> [--generate=<tsconfig>] [--src-dir=<dir>] [--repo-root=<dir>] [--baseline=<path>]')
  process.exit(2)
}

// Resolve configs to absolute so the engine scripts (which run with cwd=dir) locate
// them regardless of the caller's cwd.
const checkConfigAbs = path.resolve(checkConfig)
const genConfigAbs = path.resolve(opt('generate') ?? checkConfig)
const dir = path.dirname(checkConfigAbs)
const srcDir = opt('src-dir') ? path.resolve(opt('src-dir')) : path.join(dir, 'src')
const repoRoot = opt('repo-root') ? path.resolve(opt('repo-root')) : dir
const baseline = opt('baseline') ? path.resolve(opt('baseline')) : null

let failures = 0
const fail = (m) => (failures++, console.error(`  ✗ ${m}`))
const pass = (m) => console.error(`  ✓ ${m}`)

function generate() {
  const r = spawnSync(
    process.execPath,
    [path.join(here, 'generate.mjs'), genConfigAbs, `--src-dir=${srcDir}`],
    { cwd: dir, encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error('tsgoblin generate failed:\n' + (r.stderr || r.stdout))
}
// Returns { exit, diags: [{file, line, col, code}] } — file is repo-relative (check's output).
function check() {
  const r = spawnSync(
    process.execPath,
    [path.join(here, 'check.mjs'), checkConfigAbs, `--repo-root=${repoRoot}`, ...(baseline ? [`--baseline=${baseline}`] : [])],
    { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const diags = []
  const re = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+):/
  for (const line of (r.stdout || '').split('\n')) {
    const m = re.exec(line)
    if (m) diags.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4] })
  }
  return { exit: r.status, diags }
}

const probe = path.join(srcDir, '__tsgoblin_selftest_probe__.vue')
const probeRel = path.relative(repoRoot, probe)
const probeSrc = [
  '<script setup lang="ts">',
  "const badNum: number = 'x'",
  'function takesNum(x: number): number { return x }',
  '</script>',
  '',
  '<template>',
  "    <div>{{ takesNum('y') }} {{ badNum }}</div>",
  '</template>',
  '',
].join('\n')

// Expected positions from the source tokens under test: TS2322 at the assignment
// target `badNum`, TS2345 at the bad argument `'y'` inside the template expression.
function posOf(needle) {
  const idx = probeSrc.indexOf(needle)
  const before = probeSrc.slice(0, idx)
  return { line: before.split('\n').length, col: idx - before.lastIndexOf('\n') }
}
const expScript = posOf('badNum')
const expTmpl = posOf("'y'")

console.error('[tsgoblin selftest]')

// 1. Clean tree ⇒ 0 real errors.
generate()
{
  const { exit, diags } = check()
  if (exit === 0 && diags.length === 0) pass('clean tree: 0 real errors, exit 0')
  else fail(`clean tree expected 0 real errors/exit 0, got ${diags.length} errors / exit ${exit}`)
}

// 2 + 3. Injected script + template errors caught at exact positions.
try {
  fs.writeFileSync(probe, probeSrc)
  generate()
  const { exit, diags } = check()
  const inProbe = diags.filter((d) => d.file === probeRel)

  const script = inProbe.find((d) => d.code === 'TS2322')
  if (script && script.line === expScript.line && script.col === expScript.col)
    pass(`injected <script> error at ${probeRel}(${script.line},${script.col}) TS2322`)
  else fail(`<script> error: expected (${expScript.line},${expScript.col}) TS2322, got ${JSON.stringify(inProbe)}`)

  const tmpl = inProbe.find((d) => d.code === 'TS2345')
  if (tmpl && tmpl.line === expTmpl.line && tmpl.col === expTmpl.col)
    pass(`injected <template> error at ${probeRel}(${tmpl.line},${tmpl.col}) TS2345`)
  else fail(`<template> error: expected (${expTmpl.line},${expTmpl.col}) TS2345, got ${JSON.stringify(inProbe)}`)

  if (exit === 1) pass('non-zero exit when real errors present')
  else fail(`expected exit 1 with injected errors, got ${exit}`)
} finally {
  fs.rmSync(probe, { force: true })
  fs.rmSync(probe + '.ts', { force: true })
  generate() // restore a clean generated tree
}

console.error(failures === 0 ? '\n[tsgoblin selftest] PASS' : `\n[tsgoblin selftest] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
