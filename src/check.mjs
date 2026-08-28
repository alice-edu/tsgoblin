// tsgoblin parity filter: run tsgo over the generated tree, then filter its raw
// diagnostics down to the exact set vue-tsc (Volar) would report.
//
// For diagnostics in generated `*.vue.ts`, Volar only surfaces those whose generated
// position falls in a `verification`-enabled mapping (see generate.mjs). We drop the
// rest and remap survivors back to the original `.vue` source position. Diagnostics in
// real `.ts` files pass through unchanged.
//
// Usage: node scripts/tsgoblin/check.mjs <tsconfig> [--build] [--incremental]
//                                        [--maps=<path> ...]
//
// <tsconfig> is resolved against cwd; tsgo runs with cwd = its directory ("root").
// The verification manifest defaults to <root>/.tsgoblin-maps.json; pass --maps=<p>
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

// The manifest layout this file knows how to read; must equal generate.mjs's
// CODEGEN_VERSION. Reading an older manifest with the wrong segment stride would
// misinterpret every offset and silently report nonsense, so refuse instead.
const MANIFEST_VERSION = 4

// Merge the default manifest with any --maps= manifests (files keyed by abs path).
const mapsPaths = [path.join(root, '.tsgoblin-maps.json'), ...extraMaps]
const maps = { files: {} }
for (const mp of mapsPaths) {
  if (!fs.existsSync(mp)) {
    console.error(`[tsgoblin] missing ${mp} — run \`tsgoblin generate\` first`)
    process.exit(2)
  }
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
  if (m.version !== MANIFEST_VERSION) {
    console.error(
      `[tsgoblin] ${mp} was written by codegen v${m.version ?? '?'}, this check expects v${MANIFEST_VERSION} — re-run \`tsgoblin generate\``,
    )
    process.exit(2)
  }
  Object.assign(maps.files, m.files)
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

// Volar's bounds test (@volar/source-map/lib/translateOffset.js:11,29) is
// `start >= fromOffset && start <= fromOffset + fromLength` — INCLUSIVE at the upper
// end, so a ZERO-LENGTH mapping matches at exactly its offset. That is not a rounding
// detail. Volar's Vue template codegen emits zero-length mappings as the anchor for a
// generated expression's start — e.g. one at the `__VLS_ctx` of `__VLS_ctx.someProp`,
// pointing back at the bare `someProp` in the .vue — and TS reports whole-expression
// diagnostics (TS18048 possibly-undefined, TS2531/TS2532 possibly-null, TS2349
// not-callable) at exactly that start. tsgoblin's half-open `off < gEnd` could never
// match a zero-length segment, so every such diagnostic was misclassified as template
// glue and silently dropped — a false green (ALI-7886).
//
// Which candidate wins matters for the reported column, so the scan is two-tier,
// mirroring Volar's `findMatchingStartEnd` (@volar/source-map/lib/sourceMap.js:46-71):
// Volar yields FIRST from a mapping that maps the diagnostic's start AND its end, and
// only falls back to a start-only match when no mapping covers both. A mapping that can
// cover an end strictly greater than the start must extend past the start — i.e. exactly
// the segments in TIER 1 below. So:
//   tier 1  segments that EXTEND PAST off (off < gStart + genLen) — the pre-existing
//           half-open rule, so every diagnostic kept before is kept at the same position;
//   tier 2  segments that merely TOUCH off (off === gStart + genLen, which is where
//           zero-length anchors live) — purely additive, recovering the dropped ones.
// Making tier 1 win reproduces vue-tsc's column on a prop-type error (it reports the
// prop NAME, not the `:` before it), which a single inclusive pass gets wrong.
//
// Deliberate deviation, in the SAFE direction: Volar's end-offset requirement itself is
// not modelled — tsgo's `--pretty false` output carries only `(line,col)`, i.e. the
// start, so there is no length to test. Keying on the start alone makes tsgoblin's
// surviving set a SUPERSET of Volar's: tsgoblin can over-report, never silently drop.
const SEG_STRIDE = 5 // [genStart, genLen, srcStart, srcLen, denyId] — see generate.mjs

// The first segment in the given tier that covers `off` and whose per-code suppression
// (Volar's `verification.shouldReport`, probed + serialized by generate.mjs) admits
// `bareCode`, remapped to a .vue position. null when the tier has no such segment.
function matchTier(entry, off, bareCode, extendsPast) {
  const seg = entry.seg
  for (let i = 0; i < seg.length; i += SEG_STRIDE) {
    const gStart = seg[i]
    const genLen = seg[i + 1]
    if (extendsPast ? !(off >= gStart && off < gStart + genLen) : off !== gStart + genLen) continue
    const denyId = seg[i + 4]
    if (denyId !== 0 && entry.deny[denyId - 1].includes(bareCode)) continue
    const srcOff = seg[i + 2] + Math.min(off - gStart, seg[i + 3])
    const p = offsetToPos(getStarts(entry.vue), srcOff)
    return { keep: true, vue: entry.vue, line: p.line, col: p.col }
  }
  return null
}

// A diagnostic in a generated file survives iff some verification-enabled segment covers
// its start offset and admits its code; returns the remapped .vue position, else drop.
function remap(genFileAbs, line, col, code) {
  const entry = maps.files[genFileAbs]
  if (!entry) return { keep: true } // not a tracked generated file → keep as-is
  const off = posToOffset(getStarts(genFileAbs), line, col)
  const bareCode = code.startsWith('TS') ? code.slice(2) : code
  return matchTier(entry, off, bareCode, true) ?? matchTier(entry, off, bareCode, false) ?? { keep: false }
}

const incremental = process.argv.includes('--incremental')
// tsgo is TypeScript 7, where `types` defaults to `[]` (microsoft/TypeScript#63054):
// @types packages under typeRoots are no longer auto-included as globals, so a tsgo
// program can be MISSING ambient declarations that tsc 5.x — and therefore vue-tsc,
// our parity oracle — puts in. A missing global makes types collapse to a weaker
// shape, which SILENCES real errors rather than adding noise: a false green, the one
// outcome a type gate must never produce. `--types '*'` is the upstream opt-back-in
// wildcard and reproduces tsc's program exactly. It cannot live in the shared
// tsconfig because tsc 5.x rejects `"*"` with TS2688, so it is injected here, on the
// tsgo invocation only.
const typesWildcard = process.argv.includes('--types-wildcard')
const tsgo = findTsgo()
// --pretty false forces the machine-parseable `path(line,col): error TSxxxx:` format.
// tsgo does NOT auto-disable pretty/ANSI on a non-TTY pipe, so without this the diag
// regex below matches nothing (silent false-green).
//
// `--types` is rejected alongside `--build` (TS5094), so build mode carries the
// wildcard in the derived tsconfig's compilerOptions instead — see build.mjs.
const args = buildMode
  ? ['--build', tsconfigArg, '--verbose', '--pretty', 'false']
  : [
      ...(incremental
        ? ['-p', tsconfigArg, '--incremental', '--tsBuildInfoFile', 'dist/.tsgo-tsbuildinfo', '--pretty', 'false']
        : ['--noEmit', '-p', tsconfigArg, '--pretty', 'false']),
      ...(typesWildcard ? ['--types', '*'] : []),
    ]

const t0 = performance.now()
const res = spawnSync(tsgo, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const tsgoMs = Math.round(performance.now() - t0)
const out = (res.stdout || '') + (res.stderr || '')

// Parse: `path(line,col): error TSxxxx: message`  (paths relative to the tsgo cwd)
const diagRe = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
const lines = out.split('\n')
// tsgo exits non-zero both for "found type errors" and for "failed to run at all"
// (spawn failure, crash, unreadable config). In the second case there is nothing for
// diagRe to match, and reporting "0 real errors, exit 0" would be a false green — the
// one outcome a type gate must never produce. Distinguish the two by whether tsgo
// emitted any parseable diagnostic at all.
if ((res.error || res.status !== 0) && !lines.some((l) => diagRe.test(l))) {
  console.error(
    `[tsgoblin] tsgo failed to run (status ${res.status}${res.signal ? `, signal ${res.signal}` : ''}) and produced no parseable diagnostics:`,
  )
  console.error(res.error ? String(res.error) : out.trim() || '(no output)')
  process.exit(2)
}
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
    const r = remap(abs, Number(lineS), Number(colS), code)
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
    console.error('[tsgoblin] --write-baseline requires --baseline=<path>')
    process.exit(2)
  }
  const entries = survivors.map((s) => ({
    file: s.file,
    code: s.code,
    msg: s.msg.slice(0, MSG_KEY_LEN),
    reason: 'TODO: document why tsgo diverges from tsc here',
  }))
  fs.writeFileSync(baselinePath, JSON.stringify({ entries }, null, 2) + '\n')
  console.error(`[tsgoblin] wrote ${entries.length} baseline entries to ${baselinePath}`)
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
  console.error(`\n[tsgoblin] ⚠️ ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'} (no longer reported — clean these up):`)
  for (const e of stale) console.error(`  - ${e.file} ${e.code} "${e.msg}"`)
}

console.error(
  `\n[tsgoblin] tsgo ${tsgoMs}ms · ${real.length} real error(s) · ` +
    `${survivors.length - real.length} accepted divergence(s) · ${droppedVue} template-glue diagnostics suppressed`,
)
process.exit(real.length > 0 ? 1 : 0)
