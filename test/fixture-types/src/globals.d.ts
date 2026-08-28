// The in-project half of the global interface. A script file (no top-level import or
// export), so `ProbeRegistry` lands in the global scope and declaration-merges with the
// half declared by @types/ambient-probe.
interface ProbeRegistry {
  base: string
}
