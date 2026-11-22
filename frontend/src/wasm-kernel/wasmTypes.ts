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

/** The pure profile-loop family (`profile_loops_bytes`): sampling, area,
 *  centroid, containment, subdivision, bytes in and bytes out. */
export type ProfileLoopsBytes = (input: Uint8Array) => Uint8Array

/**
 * The sketch solver and the area builder that shares its wasm instance, as one
 * load hands them back. They must come from the SAME instance: `solve_sketch_bytes`
 * and `detect_topology_bytes` are exports of one package and one heap. The
 * profile-loop family rides the same instance for the same reason.
 */
export interface SketchSolverBundle {
  solve: SolveBytes
  topology: TopologyBytes | null
  profileLoops: ProfileLoopsBytes | null
}

/**
 * The named exports a fresh require of the sketch package's nodejs entry is
 * read for. Declared rather than a loose record so a typo in an export name is
 * a compile error, and both exports are known to belong to one instance.
 */
export interface SketchPkgNodeModule {
  solve_sketch_bytes?: SolveBytes
  detect_topology_bytes?: TopologyBytes
  profile_loops_bytes?: ProfileLoopsBytes
}
