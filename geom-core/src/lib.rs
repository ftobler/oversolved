//! Pure 2D geometry for the sketch pipeline: the part that never touches OCC.
//!
//! This crate is the MIT-side home of the geometry algorithms that used to live
//! in `sketch-solver/src/topology/` and, in a second copy, in TypeScript
//! (`frontend/src/kernel/profileLoops.ts`). It compiles into our own WASM
//! binary beside OpenCascade, but it is never linked into OCCT (LGPL 2.1 with
//! the Open CASCADE exception): nothing here takes or produces a shape handle,
//! and the wire crossing carries plain numbers only.
//!
//! The boundary against `sketch-solver` is the dependency direction: the solver
//! depends on this crate, never the other way. `solver-core` is used only for
//! its little-endian byte cursor.

/// A 2D point/vector shared by the intersection, split, loop and DCEL modules.
pub type Vec2 = [f64; 2];

/// Full turn in radians, shared by the angle-wrapping and intersection code.
pub const TWO_PI: f64 = 2.0 * std::f64::consts::PI;

/// Degrees->radians factor. Angle params are stored in degrees (the document's
/// arc-angle convention) and converted at use sites. Kept as one helper so every
/// call site keeps the multiply-then-divide grouping, bit-identical to the
/// conversions it replaces.
pub const DEG2RAD: f64 = std::f64::consts::PI / 180.0;

/// Degrees to radians, with the same multiply-then-divide grouping the sketch
/// pipeline has always used.
pub fn radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

/// Floor on the `semi-axis^2` an ellipse conic residual divides by.
///
/// A collapsed (or corrupt) semi-axis turns `u*u / (a*a)` into infinity or NaN,
/// and a single NaN row poisons the entire solve: every LM step from there on
/// is NaN and the sketch silently stops converging with no error anywhere.
/// Flooring the denominator keeps the row finite and very large, which pushes
/// the ellipse back out of the degeneracy instead. A NaN semi-axis floors too:
/// `f64::max` ignores the NaN operand (IEEE 754 maxNum semantics) and returns
/// the floor, so the row stays finite. Only a finite tiny axis and a NaN axis
/// reach the floor; an infinite axis squares to infinity and divides to zero.
pub const MIN_SEMI_AXIS_SQ: f64 = 1e-12;

/// Python float modulo (result takes the sign of the divisor).
pub fn pymod(a: f64, b: f64) -> f64 {
    ((a % b) + b) % b
}

pub mod curve_intersect;
pub mod curve_split;
pub mod profile_loops;
pub mod tolerance;
pub mod wire;

pub use profile_loops::{BoundaryEdge, EdgeGeom};

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
/// resolution (`crate::tolerance::verdict_tol` in the solver) and grows with
/// the sketch, so the two are read at their own scales rather than forced into
/// one.
pub const TOL_TOPOLOGY_MERGE: f64 = 1e-5;
/// Parameter-space slack for "this parameter is inside the finite segment" and
/// the split-parameter de-dup width. Dimensionless (a curve parameter), so an
/// absolute value is the only kind it can be.
pub const TOL_TOPOLOGY_SPLIT: f64 = 1e-7;
/// Area floor for the near-zero-area notion (centroid/area weighting). An area
/// is a length squared, so it cannot be a multiple of the length resolution;
/// it stays a fixed area floor well under any authored region.
pub const TOL_NEAR_ZERO_AREA: f64 = 1e-12;
