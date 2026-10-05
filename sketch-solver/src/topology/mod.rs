//! Sketch area builder (topology): the geometry half of the sketch area
//! pipeline, ported from the former TypeScript implementation
//! (`frontend/src/kernel/topology.ts` and its numeric companions
//! `curveIntersect.ts`/`curveSplit.ts`, deleted once the port reached parity;
//! the TS side keeps only the decorator, see below).
//!
//! The split boundary: this crate owns the
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

pub(crate) mod codec;
pub(crate) mod curve_intersect;
pub(crate) mod curve_split;
pub(crate) mod dcel;
pub(crate) mod profile_loops;

/// A 2D point/vector shared by the intersection, split, loop and DCEL modules.
/// Defined once here so those modules do not each carry their own alias.
pub type Vec2 = [f64; 2];

/// Full turn in radians, shared by the angle-wrapping and intersection code.
pub(crate) const TWO_PI: f64 = 2.0 * std::f64::consts::PI;

// Tolerances mirrored from frontend/src/kernel/solverConstants.ts. These four
// must stay byte-equal to their TS counterparts; solverConstants.test.ts reads
// them back out of this file to enforce it.
pub const TOL_TOPOLOGY_EPS: f64 = 1e-9;
pub const TOL_TOPOLOGY_MERGE: f64 = 1e-5;
pub const TOL_TOPOLOGY_SPLIT: f64 = 1e-7;
pub const TOL_NEAR_ZERO_AREA: f64 = 1e-12;
/// Area floor for FACE EXISTENCE: a traced cycle smaller than this is a
/// degenerate sliver, not a face. Deliberately looser than
/// `TOL_NEAR_ZERO_AREA` (the near-zero-area notion used for centroid/area
/// weighting), and named separately so the existence gate and the near-zero
/// gate cannot be tuned as if they were the same threshold. `pub(crate)` on
/// purpose: only the topology slice needs it, and the `solverConstants`
/// parity guard enumerates the `pub TOL_*` mirrors, which this one is not.
pub(crate) const TOL_FACE_EXISTENCE_MIN_AREA: f64 = 1e-10;

pub(crate) use dcel::detect_topology;
