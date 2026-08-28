// Valid iff @types/ambient-probe is ABSENT from the program. With it, `ProbeRegistry`
// also requires `fromAmbientPackage`, so this literal is a real TS2741.
export const registry: ProbeRegistry = { base: 'ok' }
