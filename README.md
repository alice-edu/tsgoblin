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

4. **Divergence baseline (optional, `--baseline`).** `tsgo` and `tsc` are different
   compilers with (currently) a few genuine checker/lib differences. A small, reviewed
   `--baseline` JSON accepts those known divergences by `(file, code, message-prefix)`
   and warns on stale entries so the list can't silently rot.

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

## License

MIT
