// vue-tsgo parity filter: run tsgo over the generated tree, then filter its raw
// diagnostics down to the exact set vue-tsc (Volar) would report.
//
// For diagnostics in generated `*.vue.ts`, Volar only surfaces those whose generated
// position falls in a `verification`-enabled mapping (see generate.mjs). We drop the
// rest and remap survivors back to the original `.vue` source position. Diagnostics in
// real `.ts` files pass through unchanged.
//
// Usage: node scripts/vue-tsgo/check.mjs <tsconfig> [--build] [--incremental]
//                                        [--maps=<path> ...]
//
// <tsconfig> is resolved against cwd; tsgo runs with cwd = its directory ("root").
// The verification manifest defaults to <root>/.vue-tsgo-maps.json; pass --maps=<p>
// (repeatable) to merge additional packages' manifests for a unified whole-FE check.
// All display + baseline paths are repo-relative so a divergence has one stable key
// regardless of which config surfaces it.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const argvRest = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = argvRest.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const tsconfigArg = argvRest.find((a) => !a.startsWith('--')) ?? 'tsconfig.tsgo.json'
const root = path.dirname(path.resolve(tsconfigArg)) // tsgo cwd (the package dir)
// Display + baseline paths are relative to --repo-root so a divergence has one stable
// key regardless of which config surfaces it. Defaults to cwd.
const repoRoot = path.resolve(opt('repo-root', process.cwd()))
const buildMode = argvRest.includes('--build')
const writeBaseline = argvRest.includes('--write-baseline')
const extraMaps = argvRest.filter((a) => a.startsWith('--maps=')).map((a) => a.slice('--maps='.length))
const repoRel = (abs) => path.relative(repoRoot, abs)

// Known, reviewed tsgo↔tsc compiler divergences that vue-tsc does NOT report — the
// project's own reviewed data, passed via --baseline=<path>. A diagnostic is accepted
// (not a failure) iff it matches a baseline entry by (repo-relative file, code,
// message-prefix). Stale entries (matching nothing) are reported so it can't rot.
const baselinePath = opt('baseline', null)
const baseline =
  baselinePath && fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')).entries
    : []
const MSG_KEY_LEN = 60
const baselineKey = (file, code, msg) => `${file}::${code}::${msg.slice(0, MSG_KEY_LEN)}`
const baselineKeys = new Set(baseline.map((e) => baselineKey(e.file, e.code, e.msg)))

// Merge the default manifest with any --maps= manifests (files keyed by abs path).
const mapsPaths = [path.join(root, '.vue-tsgo-maps.json'), ...extraMaps]
const maps = { files: {} }
for (const mp of mapsPaths) {
  if (!fs.existsSync(mp)) {
    console.error(`[vue-tsgo] missing ${mp} — run \`vue-tsgo generate\` first`)
    process.exit(2)
  }
  Object.assign(maps.files, JSON.parse(fs.readFileSync(mp, 'utf8')).files)
}

// Resolve the tsgo binary from the workspace root's node_modules.
function findTsgo() {
  let dir = root
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'node_modules/.bin/tsgo')
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error('tsgo binary not found')
}

// Line-start offset table (UTF-16 units, matching TS column semantics).
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}
function posToOffset(starts, line, col) {
  return starts[line - 1] + (col - 1)
}
function offsetToPos(starts, offset) {
  // binary search for the greatest line-start <= offset
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 }
}

const fileCache = new Map()
function getStarts(file) {
  let e = fileCache.get(file)
  if (!e) {
    e = lineStarts(fs.readFileSync(file, 'utf8'))
    fileCache.set(file, e)
  }
  return e
}

// A diagnostic in a generated file survives iff its start offset is within a
// verification-enabled segment; returns the remapped .vue position, or null to drop.
function remap(genFileAbs, line, col) {
  const entry = maps.files[genFileAbs]
  if (!entry) return { keep: true } // not a tracked generated file → keep as-is
  const genStarts = getStarts(genFileAbs)
  const off = posToOffset(genStarts, line, col)
  const seg = entry.seg
  for (let i = 0; i < seg.length; i += 3) {
    const gStart = seg[i]
    const gEnd = seg[i + 1]
    if (off >= gStart && off < gEnd) {
      const srcOff = seg[i + 2] + (off - gStart)
      const srcStarts = getStarts(entry.vue)
      const p = offsetToPos(srcStarts, srcOff)
      return { keep: true, vue: entry.vue, line: p.line, col: p.col }
    }
  }
  return { keep: false }
}

const incremental = process.argv.includes('--incremental')
const tsgo = findTsgo()
const args = buildMode
  ? ['--build', tsconfigArg, '--verbose']
  : incremental
    ? ['-p', tsconfigArg, '--incremental', '--tsBuildInfoFile', 'dist/.tsgo-tsbuildinfo']
    : ['--noEmit', '-p', tsconfigArg]

const t0 = performance.now()
const res = spawnSync(tsgo, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const tsgoMs = Math.round(performance.now() - t0)
const out = (res.stdout || '') + (res.stderr || '')

// Parse: `path(line,col): error TSxxxx: message`  (paths relative to the tsgo cwd)
const diagRe = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
const lines = out.split('\n')
let droppedVue = 0
// Each survivor: the display file (remapped to .vue where applicable) + parts.
const survivors = []

for (let i = 0; i < lines.length; i++) {
  const m = diagRe.exec(lines[i])
  if (!m) continue
  const [, relPath, lineS, colS, sev, code, msg] = m
  const abs = path.resolve(root, relPath)
  const isGen = abs.endsWith('.vue.ts') && maps.files[abs]
  if (isGen) {
    const r = remap(abs, Number(lineS), Number(colS))
    if (!r.keep) {
      droppedVue++
      continue
    }
    survivors.push({ file: repoRel(r.vue), line: r.line, col: r.col, sev, code, msg })
  } else {
    survivors.push({ file: repoRel(abs), line: Number(lineS), col: Number(colS), sev, code, msg })
  }
}

// --write-baseline: emit the current survivors as the reviewed divergence baseline.
if (writeBaseline) {
  if (!baselinePath) {
    console.error('[vue-tsgo] --write-baseline requires --baseline=<path>')
    process.exit(2)
  }
  const entries = survivors.map((s) => ({
    file: s.file,
    code: s.code,
    msg: s.msg.slice(0, MSG_KEY_LEN),
    reason: 'TODO: document why tsgo diverges from tsc here',
  }))
  fs.writeFileSync(baselinePath, JSON.stringify({ entries }, null, 2) + '\n')
  console.error(`[vue-tsgo] wrote ${entries.length} baseline entries to ${baselinePath}`)
  process.exit(0)
}

const matchedKeys = new Set()
const real = []
for (const s of survivors) {
  const key = baselineKey(s.file, s.code, s.msg)
  if (baselineKeys.has(key)) matchedKeys.add(key)
  else real.push(s)
}
// Only warn about stale baseline entries whose package is actually IN this check's
// scope (has a loaded manifest). A v2-only check consumes core as decls, so core's
// entries are out of scope, not stale.
const scopedPkgs = new Set(Object.values(maps.files).map((e) => repoRel(e.vue).split(path.sep)[0]))
const stale = baseline.filter(
  (e) => scopedPkgs.has(e.file.split('/')[0]) && !matchedKeys.has(baselineKey(e.file, e.code, e.msg)),
)

for (const s of real) console.log(`${s.file}(${s.line},${s.col}): ${s.sev} ${s.code}: ${s.msg}`)

if (stale.length) {
  console.error(`\n[vue-tsgo] ⚠️ ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'} (no longer reported — clean these up):`)
  for (const e of stale) console.error(`  - ${e.file} ${e.code} "${e.msg}"`)
}

console.error(
  `\n[vue-tsgo] tsgo ${tsgoMs}ms · ${real.length} real error(s) · ` +
    `${survivors.length - real.length} accepted divergence(s) · ${droppedVue} template-glue diagnostics suppressed`,
)
process.exit(real.length > 0 ? 1 : 0)
