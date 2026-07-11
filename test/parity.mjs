// The parity contract, enforced: tsgoblin's diagnostics must EQUAL real `vue-tsc`'s
// on the same fixture. This is what actually breaks when the pinned tsgo
// (@typescript/native-preview) or @vue/language-core drifts — the selftest checks
// tsgoblin's self-consistency, this checks it against the ground truth.
//
// Fixture-scale, so running vue-tsc is ~seconds. Run in CI (incl. the weekly cron).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const pkg = path.resolve(here, '..')
const fixture = path.join(here, 'fixture')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.error(`  ✗ ${m}`)
}

function findBin(name) {
  let dir = pkg
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'node_modules/.bin', name)
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error(`binary not found: ${name}`)
}
const vueTsc = findBin('vue-tsc')

// Normalize diagnostics to a comparable set of "file(line,col) CODE" (drop the
// human message — positions + code are the contract; messages differ cosmetically).
const DIAG = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+):/
function parse(out) {
  const set = new Set()
  for (const line of out.split('\n')) {
    const m = DIAG.exec(line.trim())
    if (m) set.add(`${path.normalize(m[1])}(${m[2]},${m[3]}) ${m[4]}`)
  }
  return set
}
function vueTscDiags() {
  const r = spawnSync(vueTsc, ['--noEmit', '-p', 'tsconfig.json'], {
    cwd: fixture,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return parse(r.stdout || '')
}
function tsgoblinDiags() {
  const gen = spawnSync(process.execPath, [path.join(pkg, 'src/generate.mjs'), 'tsconfig.json'], {
    cwd: fixture,
    encoding: 'utf8',
  })
  if (gen.status !== 0) throw new Error('generate failed:\n' + (gen.stderr || gen.stdout))
  const r = spawnSync(
    process.execPath,
    [path.join(pkg, 'src/check.mjs'), 'tsconfig.tsgo.json', `--repo-root=${fixture}`],
    { cwd: fixture, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return parse(r.stdout || '')
}
function assertEqual(label, a, b) {
  const onlyVue = [...a].filter((x) => !b.has(x))
  const onlyTsg = [...b].filter((x) => !a.has(x))
  if (onlyVue.length === 0 && onlyTsg.length === 0) ok(`${label} (${a.size} diagnostic(s), identical)`)
  else
    bad(
      `${label} DIVERGES:\n` +
        onlyVue.map((x) => `      only vue-tsc: ${x}`).join('\n') +
        (onlyVue.length && onlyTsg.length ? '\n' : '') +
        onlyTsg.map((x) => `      only tsgoblin: ${x}`).join('\n'),
    )
}

console.log('[tsgoblin parity vs vue-tsc]')

// 1. Clean fixture (incl. App.vue passing props to Widget — the template
//    component-prop path). Both must report the same (empty) set.
assertEqual('clean fixture', vueTscDiags(), tsgoblinDiags())

// 2. Injected type error: both must report the SAME diagnostic at the SAME position.
const probe = path.join(fixture, 'src/ParityProbe.vue')
try {
  fs.writeFileSync(
    probe,
    ['<script setup lang="ts">', "const n: number = 'not a number'", '</script>', '<template><div>{{ n }}</div></template>', ''].join('\n'),
  )
  assertEqual('injected error', vueTscDiags(), tsgoblinDiags())
} finally {
  fs.rmSync(probe, { force: true })
  fs.rmSync(probe + '.ts', { force: true })
}

console.log(failures === 0 ? '\n[tsgoblin parity vs vue-tsc] PASS' : `\n[tsgoblin parity vs vue-tsc] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
