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
//! (`solverConstants.test.ts`) parses this file to fail when either side of
//! that mirror drifts. Which of them are resolution-derived and which are
//! deliberately absolute is the ladder in `crate::tolerance`; the constants
//! below all sit on the absolute side, and each says why.

pub(crate) mod codec;
pub(crate) mod curve_intersect;
pub(crate) mod curve_split;
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
pub(crate) mod profile_loops;

/// A 2D point/vector shared by the intersection, split, loop and DCEL modules.
/// Defined once here so those modules do not each carry their own alias.
pub type Vec2 = [f64; 2];

/// Full turn in radians, shared by the angle-wrapping and intersection code.
pub(crate) const TWO_PI: f64 = 2.0 * std::f64::consts::PI;

// Tolerances mirrored from frontend/src/kernel/solverConstants.ts. These four
// must stay byte-equal to their TS counterparts; solverConstants.test.ts reads
// them back out of this file to enforce it. The ladder they belong to (which
// thresholds are resolution-derived and which are deliberately absolute) is
// `crate::tolerance`.
//
// All four are DELIBERATELY ABSOLUTE, unlike the resolution-derived thresholds
// in `crate::tolerance`: they are the area builder's identity rule and the
// rungs it shares with the TS side and OCC, and the ladder's lower rung is
// OCC's own compiled-in `Precision::Confusion` (`OCC_CONFUSION`), which is not
// ours to scale. A relative `TOL_TOPOLOGY_MERGE`, for instance, would drop
// below `TOL_LOOP_CLOSURE` on a tiny sketch and open the "looks closed and is
// not" band from the other side. The scale-relative half of the pipeline (the
// solve verdict and the tangency budgets) reads against
// `crate::tolerance::resolution` instead, at the scale that half measures.
/// The smallest quantity the builder treats as nonzero: a degenerate
/// direction's squared length, a parameter's inside-the-segment slack, a
/// radius floor. Absolute because it guards the shape of the expression (a
/// division, a segment test), not how close the solver converged.
pub const TOL_TOPOLOGY_EPS: f64 = 1e-9;
/// World-space vertex merge: two area-builder vertices closer than this are
/// one, and the floor under the tangency gap budget. Absolute on purpose (see
/// the ladder note above). It is the one rung read against the solver's
/// REALISED coincidence residual rather than its width, and the realised
/// residual is a measurement (1e-6 world at unit scale, the venn report), not
/// a derived bound; the verdict width, the bound, is a multiple of the
/// resolution (`crate::tolerance::verdict_tol`) and grows with the sketch, so
/// the two are read at their own scales rather than forced into one.
pub const TOL_TOPOLOGY_MERGE: f64 = 1e-5;
/// Parameter-space slack for "this parameter is inside the finite segment" and
/// the split-parameter de-dup width. Dimensionless (a curve parameter), so an
/// absolute value is the only kind it can be.
pub const TOL_TOPOLOGY_SPLIT: f64 = 1e-7;
/// Area floor for the near-zero-area notion (centroid/area weighting). An area
/// is a length squared, so it cannot be a multiple of the length resolution;
/// it stays a fixed area floor well under any authored region.
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
