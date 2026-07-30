# tsgoblin

Fast, **vue-tsc-parity** type-checking of Vue SFCs, powered by the native TypeScript
compiler **`tsgo`** (`@typescript/native-preview`, the TS 7 preview) — which is ~20-30x
faster than `tsc` but has **no Volar language-plugin API**, so it cannot read `.vue`
files. `tsgoblin` makes it check Vue anyway, at native speed, with the **exact same
diagnostics** vue-tsc would report.

On a large real codebase (815 SFCs), a cold `vue-tsc --build` of ~120 s drops to
**~8 s** for the equivalent tsgo check, with **exact parity** — clean tree reports 0,
and injected `<script>` and `<template>` type errors surface at the identical
`(line, col)` as vue-tsc.

## How it works

1. **Codegen (`generate`).** `@vue/language-core` is vue-tsc's own codegen. For each
   `.vue` we build the `VueVirtualCode` and extract the embedded `script_ts` — the
   combined `<script setup>` + typed template render function that vue-tsc itself feeds
   to tsc — and write it to a sibling `<File>.vue.ts`. Imports of `./Foo.vue` resolve
   to `./Foo.vue.ts` because TS module resolution appends `.ts` to unknown-extension
   specifiers. We also persist a **verification-mapping manifest**.

2. **tsgo.** Point tsgo at a tsconfig that includes the generated `*.vue.ts` and
   excludes `*.vue`. tsgo checks the whole program at native speed.

3. **Parity filter (`check`).** vue-tsc reports 0 on template glue because Volar
   suppresses diagnostics whose generated range is not covered by a mapping with
   `data.verification` truthy — that's how it ignores the internal `__VLS_` machinery
   raw tsc/tsgo would flag. `check` drops any tsgo diagnostic in a `*.vue.ts` that does
   not land in such a region, and **remaps survivors back to the original `.vue`
   line/col**. Diagnostics in real `.ts` files pass through unchanged.

   Two details of Volar's rule are easy to get wrong and both cause **silently dropped
   real errors**, so they are reproduced exactly:

   - Volar's offset test is **inclusive at both ends**
     (`@volar/source-map/lib/translateOffset.js`), so a **zero-length** mapping matches at
     exactly its offset. The Vue codegen uses zero-length mappings as the anchor for a
     generated expression's start — e.g. at the `__VLS_ctx` of `__VLS_ctx.someProp` — and
     that is precisely where TS reports whole-expression diagnostics (`TS18048` possibly
     undefined, `TS2531`/`TS2532` possibly null, `TS2349` not callable). A half-open bound
     matches none of them.
   - A `verification` **object** may carry a `shouldReport(source, code)` predicate that
     Volar evaluates per diagnostic, suppressing specific codes on specific ranges
     (`codeFeatures.doNotReportTs2339AndTs2551` on a resolved component name, and so on).
     `generate` probes that predicate over the TS diagnostic-code space and persists the
     suppressed set into the manifest, so `check` can apply it without the function.

   Volar additionally requires a diagnostic's **end** offset to map, which tsgoblin cannot
   model (tsgo's machine-readable output carries only the start position). tsgoblin
   therefore keys on the start alone, making its surviving set a **superset** of Volar's:
   it can over-report, never silently drop.

4. **Divergence baseline (optional, `--baseline`).** `tsgo` and `tsc` are different
   compilers with (currently) a few genuine checker/lib differences. A small, reviewed
   `--baseline` JSON accepts those known divergences by `(file, code, message-prefix)`
   and warns on stale entries so the list can't silently rot.

## Parity posture — what "vue-tsc parity" does and does not mean

`tsgoblin`'s guarantee is **vue-tsc parity**, reached as:

```
reported diagnostics  =  raw tsgo output  −  template glue  −  N reviewed known-divergences
```

It is **not** a claim that tsgo and vue-tsc emit byte-identical raw diagnostics. tsgo is
a TypeScript-7 preview compiler; on any real tree it will produce a handful of
diagnostics that `tsc`/`vue-tsc` (5.x) do not — genuine **checker/lib differences**, not
bugs in your code. Examples seen in practice: excess-property checks on an object literal
containing a spread (tsc relaxes them, tsgo doesn't), a newer vendored `lib.dom.d.ts`, and
library overload-resolution differences.

Parity is achieved by subtracting exactly those via the reviewed `--baseline` allowlist —
each entry **individually root-caused** and matched on `(file, code, message-prefix)`, with
a stale-entry warning so it can't silently absorb new errors. The net result equals what
`vue-tsc` reports (typically 0). As tsgo converges with tsc, the baseline shrinks toward
empty and disappears.

The `npm run parity` guard (below) is what keeps this honest: it asserts tsgoblin's output
**equals real `vue-tsc`'s** on a fixture and runs in CI on every push + weekly, so a tsgo
release that diverges on anything **outside** the reviewed baseline turns CI red rather
than passing silently.

## Install

Consume it straight from GitHub as a pinned git dependency (no registry publish
required; once the repo is public no auth is needed in CI):

```sh
npm  add -D  "tsgoblin@github:alice-edu/tsgoblin#v0.1.0"
pnpm add -D  "tsgoblin@github:alice-edu/tsgoblin#v0.1.0"
```

`@typescript/native-preview` (tsgo) is an optional peer — provide it in the consumer
(the `tsgo` binary is discovered by walking up `node_modules`).

### Use from a CI pipeline

Because the repo is public, a pipeline can just clone and run it — no token, no
registry:

```sh
git clone --depth 1 --branch v0.1.0 https://github.com/alice-edu/tsgoblin /tmp/tsgoblin
( cd /tmp/tsgoblin && npm install --omit=dev )   # installs the pinned codegen libs
node /tmp/tsgoblin/bin/cli.mjs generate path/to/tsconfig.json
node /tmp/tsgoblin/bin/cli.mjs check    path/to/tsconfig.tsgo.json --repo-root=. --baseline=path/to/baseline.json
```

or, if it's a git dependency, the `tsgoblin` bin is on `node_modules/.bin`.

## Usage

### `build` — the `vue-tsc --build` drop-in (recommended)

Point `build` at your project's **real** `tsconfig.json` — the same composite,
`.vue`-including, `references`-having config `tsc -b` / `vue-tsc --build` already uses —
and everything else is internal. No `.tsgo` variant, no emit variant, no orchestration
config.

```sh
tsgoblin build alice-client-v2/tsconfig.app.json \
  --repo-root=. \
  --baseline=./tsgoblin-baseline.json \
  [--incremental]
```

It walks the project-reference graph, classifies each project as **has-`.vue`** (gets
codegen + an ephemeral internal derived config) vs **pure-TS** (built from its real
config, e.g. a backend), codegens `*.vue.ts`, then runs a single native `tsgo -b`. Build
mode topo-sorts the graph, emits each referenced project's decls, and **redirects
cross-project source imports to those decls** — so a downstream `.vue` type-checks
against an upstream `.vue` component's types, exactly like `vue-tsc --build`'s
per-project isolation, with each project keeping its own compiler options. Output is the
parity-filtered set (every package's manifest merged), remapped to `.vue`. Exits non-zero
iff any real errors remain after `--baseline`.

The consumer footprint collapses to: the real tsconfig graph (unchanged) + an optional
`tsgoblin-baseline.json` + this one command. The internal derived configs
(`.tsgoblin-build.tsconfig.json`), `*.vue.ts`, manifests, and `.tsgoblin-build/` decls
are ephemeral tool artifacts — gitignore them.

> `check-all` (below) and the low-level `generate`/`check` primitives remain for
> non-composite trees, flat single-program checks, or engine smoke-tests. For a normal
> composite Vue monorepo, prefer `build`.

### Low-level primitives (`generate` + `check`)

```sh
# 1. generate the virtual TS + manifest for a project
tsgoblin generate tsconfig.json [--incremental] [--src-dir=<dir>]

# 2. run tsgo and filter to vue-tsc-parity diagnostics
tsgoblin check tsconfig.tsgo.json \
  --repo-root=. \
  --baseline=./tsgoblin-baseline.json \
  [--incremental] [--maps=<other-pkg>/.tsgoblin-maps.json ...]

# regenerate the reviewed divergence baseline after a deliberate, reviewed change
tsgoblin check tsconfig.tsgo.json --baseline=./tsgoblin-baseline.json --write-baseline
```

`tsconfig.tsgo.json` typically `extends` your real tsconfig, sets `noEmit`, includes
`src/**/*.ts` (which now picks up the generated `*.vue.ts`) and **excludes** `*.vue`.
Keep any project references so cross-package types resolve as declaration boundaries.

### Whole-repo orchestration (`check-all`)

`check-all` runs `generate` → optional decl-`emit` → `check` for an ordered list of
packages from one JSON config, so a monorepo's whole-FE check is a single command and
the consumer keeps only config (no orchestration script). It exits non-zero iff any
package has real errors, printing a per-package PASS/FAIL summary.

```sh
tsgoblin check-all tsgoblin.config.json [--incremental]
```

```jsonc
{
  "repoRoot": ".",                        // optional, rel. to config file; default = config dir
  "baseline": "./tsgoblin-baseline.json", // optional, rel. to config file; forwarded to every check
  "packages": [                           // ordered — earlier packages emit decls later ones consume
    {
      "name": "core",                     // optional label; default = basename(dir)
      "dir": "alice-client-core",         // required, rel. to repoRoot
      "generate": "tsconfig.json",        // required, rel. to dir — codegen config
      "emit": "tsconfig.tsgo-emit.json",  // optional, rel. to dir — `tsgo -b` decl emit for downstream
      "check": "tsconfig.tsgo.json"       // required, rel. to dir — parity-filtered check
    },
    {
      "name": "web",
      "dir": "alice-client-v2",
      "generate": "tsconfig.app.json",
      "check": "tsconfig.tsgo.json"       // consumes core's emitted decls
    }
  ]
}
```

The `emit` step is **best-effort**: `tsgo -b <emit-tsconfig>` surfaces the same
template-glue the `check` filters (which never affects the public component types a
downstream package consumes), so its output is swallowed and reported as a one-line
suppressed count. Each package's own correctness is gated by its `check`, not the emit.

### Smoke-test the engine against your tsconfig (`selftest`)

`selftest` proves the engine detects errors against a consumer's real tsconfig: it
injects a synthetic probe SFC with a known `<script>` (TS2322) and `<template>` (TS2345)
error under the config's `src` dir, runs `generate` + `check`, asserts both surface at
the exact remapped `.vue` (line,col), and that a clean tree reports 0 — then removes the
probe and restores a clean generated tree.

```sh
tsgoblin selftest tsconfig.tsgo.json \
  [--generate=tsconfig.json]  # codegen config; default = the check-tsconfig
  [--src-dir=src]             # SFC root the probe is written under; default = <config-dir>/src
  [--repo-root=.]             # display-path root; default = <config-dir>
  [--baseline=./tsgoblin-baseline.json]
```

### Incremental

`--incremental` makes both halves stateful: `generate` keeps a content-hash cache
(`.tsgoblin-cache.json`) and skips unchanged SFCs (guarded by a `CODEGEN_VERSION` so it
can never serve stale output); `check` passes `--incremental` + a `.tsbuildinfo` to
tsgo.

### Monorepos

`check` reports repo-relative paths (via `--repo-root`) so a divergence has one stable
baseline key regardless of which config surfaces it, and `--maps=` merges additional
packages' manifests. For a package whose public API includes Vue components, emit its
`.d.ts` (the generated `.vue.ts` are plain TS, so tsgo can emit them) and have the
downstream package consume those declarations — each package keeps its own compiler
options, mirroring `vue-tsc --build`'s per-project isolation.

## Caveats

`tsgo` is a **preview** compiler. Keep `vue-tsc` as the authoritative CI gate and use
`tsgoblin` as the fast local/pre-check gate. As Volar ships native tsgo integration,
this tool becomes unnecessary.

## Development

```sh
npm install
npm test           # selftest + parity
```

- `npm run selftest` — self-consistency on a fixture SFC project (clean ⇒ 0; injected
  error caught + remapped to the `.vue`).
- `npm run parity` — the real contract: asserts tsgoblin's diagnostics **equal real
  `vue-tsc`'s** on the fixture. This is the guard that catches drift when the pinned
  `@typescript/native-preview` (tsgo) or `@vue/language-core` is bumped — CI runs it on
  every push and weekly (cron), so a parity-breaking upstream release turns CI red.
- `npm run engine` — exercises the `selftest` and `check-all` subcommands against the
  fixture: clean ⇒ 0 plus injected `<script>`/`<template>` errors at exact positions,
  incremental-codegen === full-regen manifest determinism, and clean multi-package
  `check-all` ⇒ PASS/exit 0.
- `npm run build-test` — exercises `build` against a **multi-package** fixture where a
  downstream has-`.vue` package project-references an upstream has-`.vue` package: clean
  ⇒ 0, a downstream `.vue` violating the upstream `.vue` component's prop type caught at
  the exact `.vue` (line,col) **through the native `-b` decl redirect**, injected
  `<script>`/`<template>` errors at exact positions, and cross-package incremental
  determinism.

## License

MIT
