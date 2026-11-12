/**
 * The bytes-in/bytes-out shape every Rust/WASM solver entry point shares.
 *
 * Declared once here rather than beside each loader: the sketch solver, the
 * topology builder and the mate solver are deliberately separate crates with
 * independent wire formats, so a type declared in the sketch codec module
 * (codec.ts) would couple the mate-side glue to the sketch crate for a purely
 * nominal reason.
 */

/** A solver entry point: flat typed-array bytes in, flat typed-array bytes out. */
export type SolveBytes = (input: Uint8Array) => Uint8Array

/** The topology/area-builder entry point (`detect_topology_bytes`). */
export type TopologyBytes = (input: Uint8Array) => Uint8Array

/**
 * The sketch solver and the area builder that shares its wasm instance, as one
 * load hands them back. They must come from the SAME instance: `solve_sketch_bytes`
 * and `detect_topology_bytes` are exports of one package and one heap.
 */
export interface SketchSolverBundle {
  solve: SolveBytes
  topology: TopologyBytes | null
}

/**
 * The named exports a fresh require of the sketch package's nodejs entry is
 * read for. Declared rather than a loose record so a typo in an export name is
 * a compile error, and both exports are known to belong to one instance.
 */
export interface SketchPkgNodeModule {
  solve_sketch_bytes?: SolveBytes
  detect_topology_bytes?: TopologyBytes
}
