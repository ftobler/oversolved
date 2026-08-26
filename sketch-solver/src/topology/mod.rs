//! Sketch area builder (topology): the geometry half of the sketch area
//! pipeline, ported from the former TypeScript implementation
//! (`frontend/src/kernel/topology.ts` and its numeric companions
//! `curveIntersect.ts`/`curveSplit.ts`, deleted once the port reached parity;
//! the TS side keeps only the decorator, see below).
//!
//! The split boundary (see `feature/topology-to-rust.md`): this crate owns the
//! geometry (pairwise intersection, vertex merge, half-edge DCEL, face cycles,
//! standalone loops, hole nesting) and returns a STRUCTURAL topology
//! (`TopologyOut`) tagging every edge/surface with its source entity id plus a
//! deterministic index. It emits NO ancestry query strings; the TS layer
//! decorates the structural output with queries and classifiers in
//! `frontend/src/kernel/topologyDecorate.ts` (driven by `query.ts`). The loop
//! sampling helpers here mirror their surviving TS namesakes in
//! `frontend/src/kernel/profileLoops.ts`.
//!
//! Float parity with the original TS source is load-bearing: vertex-merge
//! order, the surface/edge index ordering, and sort tie-breaks all feed the
//! strings the TS decorator builds. Tolerances are mirrored exactly from
//! `frontend/src/kernel/solverConstants.ts`, and a vitest guard
//! (`solverConstants.test.ts`) parses this file to fail when either side of
//! that mirror drifts.

pub mod codec;
pub mod curve_intersect;
pub mod curve_split;
pub mod dcel;
pub mod profile_loops;

// Tolerances mirrored from frontend/src/kernel/solverConstants.ts. These four
// must stay byte-equal to their TS counterparts; solverConstants.test.ts reads
// them back out of this file to enforce it.
pub const TOL_TOPOLOGY_EPS: f64 = 1e-9;
pub const TOL_TOPOLOGY_MERGE: f64 = 1e-5;
pub const TOL_TOPOLOGY_SPLIT: f64 = 1e-7;
pub const TOL_NEAR_ZERO_AREA: f64 = 1e-12;

pub use dcel::{detect_topology, InputEntity, TopologyOut};
