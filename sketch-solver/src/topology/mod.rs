//! Sketch area builder (topology) — Rust port of the TypeScript
//! `frontend/src/kernel/topology.ts` pipeline and its pure-numeric companions
//! (`curveIntersect.ts`, `curveSplit.ts`, the topology slice of `profileLoops.ts`).
//!
//! The split boundary (see `feature/topology-to-rust.md`): this crate owns the
//! GEOMETRY — pairwise intersection, vertex merge, half-edge DCEL, face cycles,
//! standalone loops, hole nesting — and returns a STRUCTURAL topology
//! (`TopologyOut`) tagging every edge/surface with its source entity id plus a
//! deterministic index. It emits NO ancestry query strings; the TS layer keeps
//! `query.ts` and decorates the structural output with queries and classifiers.
//!
//! Float parity with the TS source is load-bearing: vertex-merge order, the
//! surface/edge index ordering, and sort tie-breaks all feed the strings the TS
//! decorator builds. Tolerances are mirrored exactly from `solverConstants.ts`.

pub mod codec;
pub mod curve_intersect;
pub mod curve_split;
pub mod dcel;
pub mod profile_loops;

// Tolerances mirrored from frontend/src/kernel/solverConstants.ts.
pub const TOL_TOPOLOGY_EPS: f64 = 1e-9;
pub const TOL_TOPOLOGY_MERGE: f64 = 1e-5;
pub const TOL_TOPOLOGY_SPLIT: f64 = 1e-7;
pub const TOL_NEAR_ZERO_AREA: f64 = 1e-12;

pub use dcel::{detect_topology, InputEntity, TopologyOut};
