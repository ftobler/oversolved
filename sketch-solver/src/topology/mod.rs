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
//! deterministic index. Which bounded faces are FILLABLE is the even/odd rule
//! over the closed carriers (`dcel::holes`): a washer sliced across by a line
//! yields its two ring halves, not four regions, while an untouched shell keeps
//! its standalone island. It emits NO ancestry query strings; the TS layer
//! decorates the structural output with queries and classifiers in
//! `frontend/src/kernel/topologyDecorate.ts` (driven by `query.ts`). The loop
//! sampling helpers here mirror their surviving TS namesakes in
//! `frontend/src/kernel/profileLoops.ts`.
//!
//! Float parity with the original TS source is load-bearing: vertex-merge
//! order, the surface/edge index ordering, and sort tie-breaks all feed the
//! strings the TS decorator builds. Tolerances are mirrored exactly from
//! `frontend/src/kernel/solverConstants.ts`, and a vitest guard
//! (`solverConstants.test.ts`) parses `geom-core/src/lib.rs` to fail when
//! either side of that mirror drifts. Which of them are resolution-derived and
//! which are deliberately absolute is the ladder in
//! `sketch_solver::tolerance`; the constants themselves sit on the absolute
//! side in `geom-core`, each with the reason it is not a multiple.
//!
//! The pure curve and loop machinery (`Vec2`, `EdgeGeom`, `profile_loops`,
//! `curve_split`, `curve_intersect`) lives in `geom-core`, the crate this one
//! depends on; it is re-exported here so the topology modules keep their
//! historical paths.

// The moved families: `geom-core` owns the one implementation, `sketch-solver`
// keeps the DCEL/decorator/query half that is allowed to know about surfaces.
pub(crate) use geom_core::{curve_intersect, curve_split, profile_loops};

pub(crate) mod codec;
pub(crate) mod dcel;
// The invariant oracle: an independent judge of `detect_topology`'s output.
// Compiled for every test build, and for a build that opts into the `fuzz`
// feature (the node pkg the repro test drives); the production WASM binary
// carries neither.
#[cfg(any(test, feature = "fuzz"))]
pub(crate) mod oracle;
// The seeded generator and minimiser: test-only, it exists to drive the oracle.
#[cfg(test)]
pub(crate) mod fuzz;

pub(crate) use geom_core::TWO_PI;
pub use geom_core::{TOL_TOPOLOGY_EPS, TOL_TOPOLOGY_MERGE, TOL_TOPOLOGY_SPLIT};

/// Area floor for FACE EXISTENCE: a traced cycle smaller than this is a
/// degenerate sliver, not a face. Deliberately looser than
/// `TOL_NEAR_ZERO_AREA` (the near-zero-area notion used for centroid/area
/// weighting), and named separately so the existence gate and the near-zero
/// gate cannot be tuned as if they were the same threshold. `pub(crate)` on
/// purpose: only the topology slice needs it, and the `solverConstants`
/// parity guard enumerates the `pub TOL_*` mirrors, which this one is not.
pub(crate) const TOL_FACE_EXISTENCE_MIN_AREA: f64 = 1e-10;

pub(crate) use dcel::detect_topology;
