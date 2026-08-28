// The ambient-@types parity contract, enforced.
//
// tsgo is TypeScript 7, which changed the default of `types` from "every @types
// package under typeRoots" to `[]` (microsoft/TypeScript#63054). tsc 5.x — and so
// vue-tsc, tsgoblin's parity oracle — still auto-includes them. The consequence is not
// that tsgo is noisier; it is that tsgo's program is MISSING ambient declarations, so
// types collapse to a weaker shape and real errors go UNREPORTED. A false green, which
// is the one outcome a type gate must never produce.
//
// `test/fixture-types` isolates that: a global-only ambient package (@types shape, never
// imported) merges a REQUIRED member into a global interface. With the package, an
// object literal in src/uses-probe.ts is a real TS2741. Without it, the literal is
// perfectly valid and the compiler says nothing.
//
// Fixture-scale, so real tsc is ~seconds. Run in CI.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const pkg = path.resolve(here, '..')
const cli = path.join(pkg, 'bin/cli.mjs')
const fixture = path.join(here, 'fixture-types')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => (failures++, console.error(`  ✗ ${m}`))

function findBin(name) {
  let dir = pkg
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'node_modules/.bin', name)
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error(`binary not found: ${name}`)
}

// Same normalization as parity.mjs: positions + code are the contract, messages differ
// cosmetically between the two compilers.
const DIAG = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+):/
function parse(out) {
  const set = new Set()
  for (const line of out.split('\n')) {
    const m = DIAG.exec(line.trim())
    if (m) set.add(`${path.normalize(m[1])}(${m[2]},${m[3]}) ${m[4]}`)
  }
  return set
}
const show = (s) => (s.size ? [...s].sort().join(', ') : '(none)')
const eq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))

console.log('[tsgoblin ambient-@types parity]')

// Ground truth: real tsc, which still auto-includes every @types package in typeRoots.
const tsc = findBin('tsc')
const tscDiags = parse(
  spawnSync(tsc, ['--noEmit', '-p', 'tsconfig.tsgo.json', '--pretty', 'false'], {
    cwd: fixture,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout || '',
)

// tsgoblin needs a codegen manifest before `check` will run.
spawnSync(process.execPath, [cli, 'generate', 'tsconfig.json'], {
  cwd: fixture,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

function tsgoblinDiags(extraArgs) {
  const r = spawnSync(process.execPath, [cli, 'check', 'tsconfig.tsgo.json', ...extraArgs], {
    cwd: fixture,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return parse((r.stdout || '') + (r.stderr || ''))
}

// 1. The fixture must actually be a trap — if tsc sees nothing, the test proves nothing.
if (tscDiags.size > 0) ok(`tsc (oracle) reports the ambient-dependent error: ${show(tscDiags)}`)
else bad('fixture is inert: tsc reported no diagnostics, so there is no false green to catch')

// 2. THE CONTRACT. With the wildcard, tsgoblin's diagnostics must equal tsc's.
//    This is what fails without --types-wildcard support: tsgo drops the ambient
//    package, the error vanishes, and the sets diverge.
{
  const withFlag = tsgoblinDiags(['--types-wildcard'])
  if (eq(withFlag, tscDiags)) ok('tsgoblin check --types-wildcard === tsc (ambient @types present)')
  else bad(`--types-wildcard diverged from tsc\n      tsc:      ${show(tscDiags)}\n      tsgoblin: ${show(withFlag)}`)
}

// 3. Characterize the default so the gap is documented rather than folklore: without
//    the flag tsgo's diagnostics are a STRICT SUBSET of tsc's — quieter, never noisier.
//    Asserting subset (not emptiness) keeps this honest if upstream changes the default
//    back: it would then simply become equality, and only check 2 governs correctness.
{
  const noFlag = tsgoblinDiags([])
  const extra = [...noFlag].filter((d) => !tscDiags.has(d))
  if (extra.length === 0) {
    const missing = [...tscDiags].filter((d) => !noFlag.has(d))
    ok(
      missing.length
        ? `default (no flag) silently drops ${missing.length} real diagnostic(s): ${missing.join(', ')}`
        : 'default (no flag) already matches tsc on this fixture',
    )
  } else {
    bad(`default reported diagnostics tsc did not — unexpected direction: ${extra.join(', ')}`)
  }
}

console.log(failures ? `\n[tsgoblin ambient-@types parity] ${failures} failure(s)` : '\n[tsgoblin ambient-@types parity] all good')
process.exit(failures ? 1 : 0)
