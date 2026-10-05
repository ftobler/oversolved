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
