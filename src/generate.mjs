// tsgoblin codegen: emit sibling `*.vue.ts` "service code" for every SFC so the
// native tsgo checker (which has no Volar plugin API) can type-check them, AND
// emit a verification-mapping manifest so tsgo's raw diagnostics can be filtered
// down to exactly the set Volar (vue-tsc) would surface.
//
// Mechanism: @vue/language-core is vue-tsc's own codegen. For each `.vue` we build
// the VueVirtualCode and extract the embedded `script_(ts|tsx)` code — the combined
// script + typed template render function that vue-tsc itself feeds to tsc. We write
// it to `<file>.vue.ts`. Imports of `./Foo.vue` resolve to `./Foo.vue.ts` because TS
// module resolution appends `.ts` to unknown-extension specifiers. Volar global types
// come in via the `/// <reference types=".../template-helpers.d.ts" />` directives the
// codegen already emits (shared d.ts, no duplicate-declaration hazard).
//
// Parity: Volar suppresses diagnostics whose generated range is NOT covered by a
// mapping with `data.verification` truthy (that's how vue-tsc reports 0 errors on
// template glue that raw tsc/tsgo would flag). We persist every verification-enabled
// generated range (banner-adjusted) + its source offset to `.tsgoblin-maps.json` so
// `check.mjs` can drop non-verification diagnostics and remap survivors to `.vue`.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import { createParsedCommandLine, createVueLanguagePlugin } from '@vue/language-core'
import { forEachEmbeddedCode } from '@volar/language-core'

// Fixed-length banner so a single constant offset relates on-disk offsets to the
// Volar `generatedOffsets` (which are relative to the un-bannered service text).
const BANNER = '// @tsgoblin generated — DO NOT EDIT\n'
const BANNER_LEN = BANNER.length

// Volar emits syntactically-broken glue for a few tolerated template idioms
// (e.g. an empty event handler `@click=""` → `(__VLS_ctx.)`). vue-tsc survives
// these because Volar suppresses diagnostics in non-verified regions; raw tsgo
// does not. Repair the known syntax-invalid shapes into valid-but-inert TS.
// CRITICAL: these transforms MUST be length-preserving, or generatedOffsets in the
// manifest desync from the on-disk text — hence a 10-char replacement for the
// 10-char `__VLS_ctx.`.
// The replacement must also be inert to the CHECKER, not merely parseable: the
// earlier `__VLS_ctx ` (dot→space) still evaluated to the real component-context
// object, so `{ onNodeClick: (__VLS_ctx ) }` produced a genuine TS2322 ("ctx is not
// assignable to the handler type") that vue-tsc never reports. `(0 as any)` carries
// no type of its own, so the repaired glue contributes no diagnostics at all.
const CTX_GLUE_REPAIR = '(0 as any)'
function sanitize(text) {
  return text.replace(/__VLS_ctx\.(?=[)\]},;\s])/g, CTX_GLUE_REPAIR)
}

// Volar's isDiagnosticsEnabled: verification === true, or a non-null object
// (shouldReport defaults to true). undefined/false → suppressed.
function verificationEnabled(data) {
  const v = data?.verification
  return v === true || (typeof v === 'object' && v !== null)
}

// A `verification` OBJECT may carry a `shouldReport(source, code)` predicate that Volar
// evaluates PER DIAGNOSTIC (`shouldReportDiagnostics`, @volar/language-core/lib/editor.js).
// That is how @vue/language-core suppresses TS2339/TS2551 on a resolved component name,
// TS2353/TS2561 on forwarded props/events, and TS6133 on an unused script binding, while
// still type-checking those ranges for everything else. A predicate cannot go into a JSON
// manifest, so probe it here over the TS diagnostic-code space and persist the set of codes
// it suppresses. Probing DERIVES the suppression from the predicate rather than hard-coding
// today's `codeFeatures.doNotReportTsXXXX` set, so a new one is honoured automatically.
const PROBE_RANGES = [
  [1000, 19999], // TS error codes (1xxx syntactic … 18xxx)
  [80000, 80999], // suggestion diagnostics
]
// Volar passes `String(diagnostic.source)`; tsc leaves `source` unset, so the real call is
// with the string "undefined". Probe "ts" as well and treat a code as suppressed only when
// it is suppressed under BOTH — an unknown source-sensitive predicate then errs toward
// REPORTING, never toward a silent drop.
const PROBE_SOURCES = ['undefined', 'ts']
const denyCache = new Map()
// → null (report every code) | 'all' (report nothing) | string[] (codes to suppress)
function probeSuppressedCodes(verification) {
  if (typeof verification !== 'object' || verification === null) return null
  if (typeof verification.shouldReport !== 'function') return null
  if (denyCache.has(verification)) return denyCache.get(verification)
  const deny = []
  let probed = 0
  for (const [lo, hi] of PROBE_RANGES) {
    for (let c = lo; c <= hi; c++) {
      probed++
      const code = String(c)
      let suppressed = true
      for (const source of PROBE_SOURCES) {
        if ((verification.shouldReport(source, code) ?? true) === true) {
          suppressed = false
          break
        }
      }
      if (suppressed) deny.push(code)
    }
  }
  const result = deny.length === probed ? 'all' : deny.length === 0 ? null : deny
  denyCache.set(verification, result)
  return result
}

// Bump when the codegen OUTPUT format changes (sanitize rules, banner, manifest
// shape, @vue/language-core upgrade). A mismatch invalidates the whole cache so
// `--incremental` can never serve stale `*.vue.ts` from an older codegen. This is
// the guard that keeps incremental === full-regen (correctness > speed).
const CODEGEN_VERSION = 4

const t0 = performance.now()
const argv = process.argv.slice(2)
const incremental = argv.includes('--incremental')
const srcDirOpt = argv.find((a) => a.startsWith('--src-dir='))?.slice('--src-dir='.length)
const configPath = path.resolve(argv.find((a) => !a.startsWith('--')) ?? 'tsconfig.json')
const dir = path.dirname(configPath)
const manifestPath = path.join(dir, '.tsgoblin-generated.json')
const mapsPath = path.join(dir, '.tsgoblin-maps.json')
const cachePath = path.join(dir, '.tsgoblin-cache.json')

const parsed = createParsedCommandLine(ts, ts.sys, configPath)
const { options, vueOptions, fileNames } = parsed
const languagePlugin = createVueLanguagePlugin(ts, options, vueOptions, (id) => id)

// createParsedCommandLine stubs readDirectory (returns []), so its `fileNames`
// never expands include globs. Enumerate SFCs from the filesystem instead
// (--src-dir overrides the default <tsconfig-dir>/src root).
const srcDir = srcDirOpt ? path.resolve(srcDirOpt) : path.join(dir, 'src')
const vueFiles = fileNames.filter((f) => f.endsWith('.vue'))
if (vueFiles.length === 0) {
  vueFiles.push(...ts.sys.readDirectory(srcDir, ['.vue'], ['**/node_modules/**', '**/dist/**']))
}

// Prior state (only trusted when the codegen version matches).
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const prevCache = readJson(cachePath)
const prevMaps = readJson(mapsPath)
const canReuse =
  incremental && prevCache?.version === CODEGEN_VERSION && prevMaps?.version === CODEGEN_VERSION
const prevHashes = canReuse ? prevCache.files : {}
const prevManifestFiles = canReuse ? prevMaps.files : {}

// Emit `<fileName>.vue.ts` for one SFC, returning its manifest entry (verification
// segments) or null if the SFC has no embedded script code.
function processVue(fileName, source) {
  const snapshot = ts.ScriptSnapshot.fromString(source)
  const languageId = languagePlugin.getLanguageId?.(fileName) ?? 'vue'
  const root = languagePlugin.createVirtualCode(fileName, languageId, snapshot)
  if (!root) return null

  let code = null
  let ext = '.ts'
  for (const embedded of forEachEmbeddedCode(root)) {
    const m = /^script_(js|jsx|ts|tsx)$/.exec(embedded.id)
    if (m) {
      code = embedded
      ext = '.' + m[1]
      break
    }
  }
  if (code == null) return null

  const serviceText = sanitize(code.snapshot.getText(0, code.snapshot.getLength()))
  const outFile = fileName + ext
  fs.writeFileSync(outFile, BANNER + serviceText)

  // Verification-enabled generated ranges (banner-adjusted), as flat 5-tuples
  // [genStart, genLen, srcStart, srcLen, denyId] to keep the manifest compact.
  // genLen/srcLen are kept separate because Volar's own `getLengths` reads
  // `generatedLengths ?? lengths` for the generated side, and translateOffset clamps
  // the mapped offset by the TARGET length. denyId is 1-based into `deny` (0 = no
  // per-code suppression); a mapping whose predicate suppresses everything is dropped
  // outright, exactly like `verification: false`.
  const seg = []
  const deny = []
  const denyId = new Map()
  for (const mapping of code.mappings) {
    if (!verificationEnabled(mapping.data)) continue
    const suppressed = probeSuppressedCodes(mapping.data.verification)
    if (suppressed === 'all') continue
    let id = 0
    if (suppressed !== null) {
      id = denyId.get(suppressed) ?? 0
      if (id === 0) {
        deny.push(suppressed)
        id = deny.length
        denyId.set(suppressed, id)
      }
    }
    const { sourceOffsets, generatedOffsets, lengths } = mapping
    const generatedLengths = mapping.generatedLengths ?? lengths
    for (let i = 0; i < generatedOffsets.length; i++) {
      seg.push(generatedOffsets[i] + BANNER_LEN, generatedLengths[i], sourceOffsets[i], lengths[i], id)
    }
  }
  return { outFile, entry: { vue: fileName, seg, deny } }
}

let written = 0
let reused = 0
let skipped = 0
const generated = []
const manifestFiles = {}
const cacheFiles = {}

for (const fileName of vueFiles) {
  const source = fs.readFileSync(fileName, 'utf8')
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  const outFileGuess = prevHashes[fileName]?.out

  // Reuse iff: same content hash, the generated file is still on disk, and we have
  // its manifest entry from a version-matching prior run.
  if (
    canReuse &&
    prevHashes[fileName]?.hash === hash &&
    outFileGuess &&
    fs.existsSync(outFileGuess) &&
    prevManifestFiles[outFileGuess]
  ) {
    generated.push(outFileGuess)
    manifestFiles[outFileGuess] = prevManifestFiles[outFileGuess]
    cacheFiles[fileName] = { hash, out: outFileGuess }
    reused++
    continue
  }

  const res = processVue(fileName, source)
  if (!res) {
    skipped++
    continue
  }
  generated.push(res.outFile)
  manifestFiles[res.outFile] = res.entry
  cacheFiles[fileName] = { hash, out: res.outFile }
  written++
}

// Orphan cleanup: remove generated `*.vue.ts` whose source SFC no longer exists.
let removed = 0
const currentVue = new Set(vueFiles)
for (const prevVue of Object.keys(prevHashes)) {
  if (currentVue.has(prevVue)) continue
  const out = prevHashes[prevVue]?.out
  if (out && fs.existsSync(out)) {
    fs.rmSync(out, { force: true })
    removed++
  }
}

fs.writeFileSync(manifestPath, JSON.stringify(generated, null, 0))
fs.writeFileSync(mapsPath, JSON.stringify({ version: CODEGEN_VERSION, bannerLen: BANNER_LEN, files: manifestFiles }))
fs.writeFileSync(cachePath, JSON.stringify({ version: CODEGEN_VERSION, files: cacheFiles }))

const ms = Math.round(performance.now() - t0)
console.log(
  `[tsgoblin] ${incremental ? 'incremental: ' : ''}generated ${written}, reused ${reused}, removed ${removed} (skipped ${skipped}) — ${vueFiles.length} SFCs in ${ms}ms`,
)
