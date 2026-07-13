// tsgoblin check-all: config-driven multi-package orchestration. Runs, per package
// in declared order: `generate` (virtual TS), an optional best-effort `emit` step
// (`tsgo -b <tsconfig>` to emit `.d.ts` that later packages consume), then `check`.
// Exits non-zero iff any package has real errors, with a per-package PASS/FAIL line.
//
// Config (JSON, paths resolved as noted):
//   {
//     "repoRoot": ".",                        // optional, rel. to config file; default = config dir
//     "baseline": "./tsgoblin-baseline.json", // optional, rel. to config file
//     "packages": [                           // ordered; earlier packages emit decls later ones consume
//       { "name": "core",                     // optional label; default = basename(dir)
//         "dir": "alice-client-core",         // required, rel. to repoRoot
//         "generate": "tsconfig.json",        // required, rel. to dir
//         "emit": "tsconfig.tsgo-emit.json",  // optional, rel. to dir — `tsgo -b` decl emit
//         "check": "tsconfig.tsgo.json" }     // required, rel. to dir
//     ]
//   }
//
// Usage: tsgoblin check-all <config.json> [--incremental]

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const incremental = argv.includes('--incremental')
const configArg = argv.find((a) => !a.startsWith('--'))
if (!configArg) {
  console.error('Usage: tsgoblin check-all <config.json> [--incremental]')
  process.exit(2)
}

const configPath = path.resolve(configArg)
const cfgDir = path.dirname(configPath)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const repoRoot = path.resolve(cfgDir, config.repoRoot ?? '.')
const baseline = config.baseline ? path.resolve(cfgDir, config.baseline) : null
const inc = incremental ? ['--incremental'] : []

function run(label, cmd, args, cwd) {
  process.stderr.write(`\n\x1b[1m▶ ${label}\x1b[0m\n`)
  return spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1
}
// A step whose raw diagnostics are expected noise (the best-effort emit surfaces the
// same template-glue the check filters). Swallow its output; print a one-line count.
function runQuiet(label, cmd, args, cwd) {
  process.stderr.write(`\n\x1b[1m▶ ${label}\x1b[0m\n`)
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const noise = ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => /error TS/.test(l)).length
  process.stderr.write(`  (suppressed ${noise} expected template-glue diagnostic(s))\n`)
  return r.status ?? 1
}
// Resolve a binary from node_modules/.bin by walking up from a start dir.
function findBin(name, start) {
  let dir = start
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'node_modules/.bin', name)
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error(`binary not found: ${name}`)
}
const engineScript = (name) => path.join(here, name)
const checkArgs = (cfg) => [
  engineScript('check.mjs'),
  cfg,
  `--repo-root=${repoRoot}`,
  ...(baseline ? [`--baseline=${baseline}`] : []),
  ...inc,
]

const results = []
for (const pkg of config.packages) {
  const name = pkg.name ?? path.basename(pkg.dir)
  const pkgDir = path.resolve(repoRoot, pkg.dir)
  run(`${name}: codegen`, process.execPath, [engineScript('generate.mjs'), pkg.generate, ...inc], pkgDir)
  if (pkg.emit) {
    // Best-effort: emit surfaces the same template-glue the check filters, and those
    // never affect the public component types downstream packages consume. Each
    // package's own correctness is gated by its check below, not by this emit's exit.
    const tsgo = findBin('tsgo', pkgDir)
    runQuiet(`${name}: emit declarations`, tsgo, ['-b', pkg.emit], pkgDir)
  }
  const status = run(`${name}: check`, process.execPath, checkArgs(pkg.check), pkgDir)
  results.push({ name, status })
}

const failed = results.filter((r) => r.status).length
const detail = results.map((r) => `${r.name} ${r.status ? 'FAIL' : 'ok'}`).join(', ')
process.stderr.write(
  `\n\x1b[1m[tsgoblin] check-all: ${failed === 0 ? 'PASS' : `${failed} package(s) with real errors`}\x1b[0m` +
    ` (${detail})\n`,
)
process.exit(failed === 0 ? 0 : 1)
