# vue-tsgo

Fast, **vue-tsc-parity** type-checking of Vue SFCs, powered by the native TypeScript
compiler **`tsgo`** (`@typescript/native-preview`, the TS 7 preview) — which is ~20-30x
faster than `tsc` but has **no Volar language-plugin API**, so it cannot read `.vue`
files. `vue-tsgo` makes it check Vue anyway, at native speed, with the **exact same
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

```sh
npm add -D vue-tsgo
# peers (usually already present in a Vue project): typescript, @vue/language-core,
# @volar/language-core, and @typescript/native-preview (tsgo)
```

## Usage

```sh
# 1. generate the virtual TS + manifest for a project
vue-tsgo generate tsconfig.json [--incremental] [--src-dir=<dir>]

# 2. run tsgo and filter to vue-tsc-parity diagnostics
vue-tsgo check tsconfig.tsgo.json \
  --repo-root=. \
  --baseline=./vue-tsgo-baseline.json \
  [--incremental] [--maps=<other-pkg>/.vue-tsgo-maps.json ...]

# regenerate the reviewed divergence baseline after a deliberate, reviewed change
vue-tsgo check tsconfig.tsgo.json --baseline=./vue-tsgo-baseline.json --write-baseline
```

`tsconfig.tsgo.json` typically `extends` your real tsconfig, sets `noEmit`, includes
`src/**/*.ts` (which now picks up the generated `*.vue.ts`) and **excludes** `*.vue`.
Keep any project references so cross-package types resolve as declaration boundaries.

### Incremental

`--incremental` makes both halves stateful: `generate` keeps a content-hash cache
(`.vue-tsgo-cache.json`) and skips unchanged SFCs (guarded by a `CODEGEN_VERSION` so it
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
`vue-tsgo` as the fast local/pre-check gate. As Volar ships native tsgo integration,
this tool becomes unnecessary.

## Development

```sh
npm install
npm run selftest   # generate + check a fixture SFC project; asserts parity
```

## License

MIT
