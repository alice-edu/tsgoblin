// vue-tsgo self-test — proves the de-Aliced package works standalone against a
// tiny fixture Vue project: clean tree ⇒ 0 real errors, and an injected script
// type error ⇒ caught, remapped to the .vue source position.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const pkg = path.resolve(here, '..')
const fixture = path.join(here, 'fixture')
const gen = path.join(pkg, 'src/generate.mjs')
const check = path.join(pkg, 'src/check.mjs')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.error(`  ✗ ${m}`)
}

function generate() {
  const r = spawnSync(process.execPath, [gen, 'tsconfig.json'], { cwd: fixture, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('generate failed:\n' + (r.stderr || r.stdout))
}
function runCheck() {
  const r = spawnSync(
    process.execPath,
    [check, 'tsconfig.tsgo.json', `--repo-root=${fixture}`],
    { cwd: fixture, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const diags = []
  const re = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+):/
  for (const line of (r.stdout || '').split('\n')) {
    const m = re.exec(line)
    if (m) diags.push({ file: m[1], line: +m[2], col: +m[3], code: m[4] })
  }
  return { exit: r.status, diags }
}

console.log('[vue-tsgo selftest]')

// 1. Clean fixture ⇒ 0 real errors.
generate()
{
  const { exit, diags } = runCheck()
  if (exit === 0 && diags.length === 0) ok('clean fixture: 0 real errors')
  else bad(`clean fixture expected 0, got ${diags.length}: ${JSON.stringify(diags)}`)
}

// 2. Injected <script> type error ⇒ caught, mapped to the .vue.
const probe = path.join(fixture, 'src/Probe.vue')
try {
  fs.writeFileSync(
    probe,
    ['<script setup lang="ts">', "const n: number = 'not a number'", '</script>', '<template><div>{{ n }}</div></template>', ''].join('\n'),
  )
  generate()
  const { diags } = runCheck()
  const hit = diags.find((d) => d.file.endsWith('Probe.vue') && d.line === 2 && d.code === 'TS2322')
  if (hit) ok(`injected error caught at Probe.vue(2,${hit.col}) TS2322`)
  else bad(`injected error not caught: ${JSON.stringify(diags)}`)
} finally {
  fs.rmSync(probe, { force: true })
  fs.rmSync(probe + '.ts', { force: true })
}

// leave the fixture tree clean
generate()
console.log(failures === 0 ? '\n[vue-tsgo selftest] PASS' : `\n[vue-tsgo selftest] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
