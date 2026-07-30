// The parity contract, enforced: tsgoblin's diagnostics must EQUAL real `vue-tsc`'s
// on the same fixture. This is what actually breaks when the pinned tsgo
// (@typescript/native-preview) or @vue/language-core drifts — the selftest checks
// tsgoblin's self-consistency, this checks it against the ground truth.
//
// The cases deliberately cover TEMPLATE diagnostics, not just <script> ones. tsgoblin's
// parity filter only ever touches diagnostics inside the generated template glue, so a
// suite that injects errors into <script> exercises none of it — that blind spot is how
// ALI-7886 shipped (a real TS18048 in a template silently classified as glue).
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
  if (r.status === 2) throw new Error('check failed:\n' + (r.stderr || r.stdout))
  return parse(r.stdout || '')
}
function assertEqual(label, a, b) {
  const onlyVue = [...a].filter((x) => !b.has(x))
  const onlyTsg = [...b].filter((x) => !a.has(x))
  if (onlyVue.length === 0 && onlyTsg.length === 0) {
    ok(`${label} (${a.size} diagnostic(s), identical)`)
    return
  }
  bad(
    `${label} DIVERGES:\n` +
      onlyVue.map((x) => `      only vue-tsc: ${x}`).join('\n') +
      (onlyVue.length && onlyTsg.length ? '\n' : '') +
      onlyTsg.map((x) => `      only tsgoblin: ${x}`).join('\n'),
  )
}

console.log('[tsgoblin parity vs vue-tsc]')

// A probe left behind by an aborted run makes the "clean fixture" case assert against a
// dirty tree and silently pass as "identical". Refuse to run on a contaminated fixture.
const probe = path.join(fixture, 'src/ParityProbe.vue')
for (const stale of [probe, probe + '.ts']) {
  if (fs.existsSync(stale)) {
    console.error(`[tsgoblin parity] stale probe left in the fixture: ${stale} — delete it and re-run`)
    process.exit(2)
  }
}

// 1. Clean fixture (incl. App.vue passing props to Widget — the template
//    component-prop path). Both must report the same (empty) set.
assertEqual('clean fixture', vueTscDiags(), tsgoblinDiags())

// 2+. Injected probes. `expect` is asserted against vue-tsc's OWN output first, so a case
// can never pass VACUOUSLY: set-equality between two empty sets is trivially true, which
// is precisely how a suppression bug hides. A case marked 'errors' must make vue-tsc
// report something; a case marked 'clean' must make it report nothing.
const cases = [
  {
    name: 'injected <script> error',
    expect: 'errors',
    src: [
      '<script setup lang="ts">',
      "const n: number = 'not a number'",
      '</script>',
      '<template><div>{{ n }}</div></template>',
    ],
  },
  {
    // ALI-7886, exactly. The props must NOT be destructured: with `const props =
    // defineProps<…>()` a bare template reference generates `__VLS_ctx.versionCount`, and
    // TS reports TS18048 on the whole member access — whose start offset is covered ONLY
    // by a zero-length verification anchor sitting at the `__VLS_ctx` prefix. Destructured
    // props generate a plain local instead, land inside the identifier's own non-empty
    // mapping, and do NOT exercise this path at all.
    name: 'template: optional prop compared unguarded (TS18048 via a zero-length anchor)',
    expect: 'errors',
    src: [
      '<script setup lang="ts">',
      'const props = defineProps<{ versionCount?: number }>()',
      'void props',
      '</script>',
      '<template>',
      '    <div v-if="versionCount > 1">many</div>',
      '</template>',
    ],
  },
  {
    // Same zero-length-anchor shape, different code — proof the filter is not keyed on a
    // list of error codes.
    name: 'template: nullable prop dereferenced unguarded (zero-length anchor, other code)',
    expect: 'errors',
    src: [
      '<script setup lang="ts">',
      'const props = defineProps<{ maybe: string | null }>()',
      'void props',
      '</script>',
      '<template>',
      '    <div>{{ maybe.length }}</div>',
      '</template>',
    ],
  },
  {
    // The glue-repair case: Volar emits the syntax-invalid `(__VLS_ctx.)` for an empty
    // handler and reports nothing. tsgoblin's length-preserving repair has to be inert to
    // the CHECKER too, not merely parseable.
    name: 'template: empty event handler (repaired glue must stay diagnostic-free)',
    expect: 'clean',
    src: [
      '<script setup lang="ts">',
      'const ok = 1',
      '</script>',
      '<template>',
      '    <div @click="">{{ ok }}</div>',
      '</template>',
    ],
  },
  {
    // Volar attaches codeFeatures.doNotReportTs2339AndTs2551 to a resolved component
    // name, so an unresolvable tag must NOT surface TS2339 — a per-mapping, per-code
    // suppression that a plain verification-enabled/disabled flag cannot express.
    name: 'template: unresolved component tag (shouldReport suppresses TS2339/TS2551)',
    expect: 'clean',
    src: [
      '<script setup lang="ts">',
      'const ok = 1',
      '</script>',
      '<template>',
      '    <NotDeclaredAnywhere>{{ ok }}</NotDeclaredAnywhere>',
      '</template>',
    ],
  },
]

for (const c of cases) {
  try {
    fs.writeFileSync(probe, c.src.join('\n') + '\n')
    const vue = vueTscDiags()
    if ((c.expect === 'errors') !== vue.size > 0) {
      bad(
        `${c.name}: the case does not exercise what it claims — expected vue-tsc to report ` +
          `${c.expect === 'errors' ? 'at least one diagnostic' : 'none'}, got ${vue.size}` +
          (vue.size ? `: ${[...vue].join(', ')}` : ''),
      )
      continue
    }
    assertEqual(c.name, vue, tsgoblinDiags())
  } finally {
    fs.rmSync(probe, { force: true })
    fs.rmSync(probe + '.ts', { force: true })
  }
}
// Leave the generated tree consistent with the (probe-free) fixture on disk.
tsgoblinDiags()

console.log(failures === 0 ? '\n[tsgoblin parity vs vue-tsc] PASS' : `\n[tsgoblin parity vs vue-tsc] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
