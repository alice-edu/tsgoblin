// tsgoblin build: the vue-tsc `--build` drop-in. Point it at the project's REAL
// tsconfig (the same one `tsc -b`/`vue-tsc --build` uses — composite, includes `.vue`,
// has `references`) and everything else is internal:
//
//   1. Walk the project-reference graph from the root tsconfig.
//   2. Classify each project: "has-.vue" vs pure-TS. Only has-.vue projects get codegen
//      + a derived config; pure-TS references (e.g. backend) build from their REAL config.
//   3. Codegen `*.vue.ts` + `.tsgoblin-maps.json` per has-.vue project.
//   4. Synthesize an ephemeral derived tsconfig at each has-.vue package ROOT that
//      `extends` the real one but swaps `.vue` for the generated `.vue.ts` (via an
//      explicit `files` list) and rewrites references to has-.vue projects → their
//      derived config. Pure-TS references are left pointing at their real config.
//   5. `tsgo -b <root-derived>` — native build mode topo-sorts the graph, builds each
//      referenced project's decls, and redirects cross-project source imports to those
//      decls (so a downstream `.vue` type-checks against an upstream `.vue`'s decls).
//   6. Parity-filter the combined output (merging every has-.vue project's manifest) and
//      remap survivors to `.vue`. Delegated to `check.mjs --build`.
//
// No `.tsgo` variants, no emit variant, no orchestration config — the reference graph
// IS the build plan. Usage:
//   tsgoblin build <tsconfig> [--incremental] [--repo-root=<dir>] [--baseline=<path>]
//                             [--types-wildcard]

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const here = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const incremental = argv.includes('--incremental')
// See the long note in check.mjs: tsgo (TS7) defaults `types` to `[]`, so ambient
// @types globals tsc 5.x auto-includes go missing and real errors are silenced.
// `--build` rejects the `--types` CLI flag (TS5094), so here the wildcard rides in
// the derived tsconfig's compilerOptions instead.
const typesWildcard = argv.includes('--types-wildcard')
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const rootArg = argv.find((a) => !a.startsWith('--'))
if (!rootArg) {
  console.error(
    'Usage: tsgoblin build <tsconfig> [--incremental] [--repo-root=<dir>] [--baseline=<path>] [--types-wildcard]',
  )
  process.exit(2)
}
const repoRoot = opt('repo-root') ? path.resolve(opt('repo-root')) : process.cwd()
const baseline = opt('baseline') ? path.resolve(opt('baseline')) : null

const DERIVED = '.tsgoblin-build.tsconfig.json'
const OUT = './.tsgoblin-build'

// A reference `path` may be a directory or a tsconfig file; normalize to the file.
function toConfigFile(p) {
  const abs = path.resolve(p)
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'tsconfig.json') : abs
}
function readParsed(configPath) {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`[tsgoblin] cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    },
  })
  if (!parsed) throw new Error(`[tsgoblin] cannot read ${configPath}`)
  return parsed
}
// A project is "has-.vue" iff any `.vue` source exists under its directory.
function hasVueSources(dir) {
  return (
    ts.sys.readDirectory(dir, ['.vue'], ['**/node_modules/**', '**/dist/**', '**/.tsgoblin-build/**'], undefined)
      .length > 0
  )
}

// Walk the reference graph (deduped by resolved config path).
const graph = new Map() // configPath -> { dir, refs: configPath[], hasVue }
function visit(configPath) {
  configPath = toConfigFile(configPath)
  if (graph.has(configPath)) return
  const parsed = readParsed(configPath)
  const dir = path.dirname(configPath)
  const refs = (parsed.projectReferences ?? []).map((r) => toConfigFile(r.path))
  graph.set(configPath, { dir, refs, hasVue: hasVueSources(dir) })
  for (const r of refs) visit(r)
}
const rootCfg = toConfigFile(rootArg)
visit(rootCfg)

const vueProjects = [...graph].filter(([, i]) => i.hasVue)
if (!graph.get(rootCfg).hasVue) {
  console.error('[tsgoblin] build: root project has no .vue sources — use `tsgoblin check` for a pure-TS project.')
  process.exit(2)
}

// Step 3: codegen per has-.vue project (real config → *.vue.ts + manifest).
for (const [cfg] of vueProjects) {
  const r = spawnSync(
    process.execPath,
    [path.join(here, 'generate.mjs'), cfg, ...(incremental ? ['--incremental'] : [])],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) {
    console.error(`[tsgoblin] build: codegen failed for ${cfg}`)
    process.exit(r.status ?? 1)
  }
}

// Step 4: synthesize the ephemeral derived config at each has-.vue package root.
const rel = (from, to) => {
  const p = path.relative(from, to).split(path.sep).join('/')
  return p.startsWith('.') ? p : './' + p
}
for (const [cfg, info] of vueProjects) {
  // Re-parse AFTER codegen so `fileNames` picks up the on-disk `*.vue.ts` and, because
  // ts does not know the `.vue` extension, naturally omits the `.vue` sources.
  const files = readParsed(cfg).fileNames.filter((f) => !f.endsWith('.vue'))
  const references = info.refs.map((refCfg) => {
    const refInfo = graph.get(refCfg)
    const target = refInfo?.hasVue ? path.join(refInfo.dir, DERIVED) : refCfg
    return { path: rel(info.dir, target) }
  })
  const derived = {
    extends: rel(info.dir, cfg),
    compilerOptions: {
      composite: true,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      sourceMap: false,
      noEmit: false,
      outDir: `${OUT}/decls`,
      tsBuildInfoFile: `${OUT}/tsbuildinfo`,
      // PARTIAL by construction: a derived config is synthesized only for has-.vue
      // projects (step 2), so pure-TS references still build from their REAL config and
      // keep tsgo's narrow `types: []`. Covering them too would mean synthesizing a
      // derived config for every project in the graph — a change to the build model,
      // deliberately not made here.
      ...(typesWildcard ? { types: ['*'] } : {}),
    },
    references,
    files: files.map((f) => rel(info.dir, f)),
    include: [],
    exclude: [],
  }
  fs.writeFileSync(path.join(info.dir, DERIVED), JSON.stringify(derived, null, 2) + '\n')
}

// Step 5 + 6: native `tsgo -b` on the root derived config, then the parity filter with
// every has-.vue project's manifest merged. check.mjs default-loads the root project's
// manifest; the others come in via --maps.
const rootInfo = graph.get(rootCfg)
const extraMaps = vueProjects
  .filter(([cfg]) => cfg !== rootCfg)
  .map(([, i]) => `--maps=${path.join(i.dir, '.tsgoblin-maps.json')}`)
const r = spawnSync(
  process.execPath,
  [
    path.join(here, 'check.mjs'),
    path.join(rootInfo.dir, DERIVED),
    '--build',
    `--repo-root=${repoRoot}`,
    ...(baseline ? [`--baseline=${baseline}`] : []),
    ...extraMaps,
  ],
  { stdio: 'inherit' },
)
process.exit(r.status ?? 1)
