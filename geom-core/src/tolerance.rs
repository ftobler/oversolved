//! The scale-relative rungs of the area builder's tolerance ladder.
//!
//! This is the geometry half of the sketch pipeline's ladder (the solver's
//! verdict, rank and contract rungs stay in `sketch-solver/src/tolerance.rs`).
//! A kernel does not carry one fixed idea of "close enough": [`resolution`] is
//! the smallest world distance the pipeline resolves on geometry of size
//! `scale`, and the tangency budgets are multiples of it read at the CURVE's
//! characteristic radius, not the sketch's, because the ambiguity a converged
//! tangency leaves is a distance on the curve.
//!
//! The deliberately absolute rungs that live beside these (`TOL_TOPOLOGY_*`,
//! `ZERO_LENGTH_SQ`, `CIRCLE_TANGENT_EPS`, the scan's `FLAT`) are in the
//! modules that apply them, each with the reason it is not a multiple.

/// Relative width of the f64 wire noise: a coordinate at magnitude `m` crosses
/// the worker boundary as f64, so it carries a rounding error of at most a few
/// `f64::EPSILON * m` (2.2e-16 relative), and the arithmetic a threshold is
/// evaluated against adds a few more. Rounded to a power of ten so the
/// multiples below stay readable powers of ten.
pub const WIRE_NOISE_REL: f64 = 1e-15;

/// The smallest world distance the pipeline resolves on geometry of size
/// `scale`: below it, two points, a zero displacement or a vanishing feature
/// are the same thing as their rounded representation. This is the unit of the
/// ladder, not a threshold: nothing compares against it directly.
pub fn resolution(scale: f64) -> f64 {
    WIRE_NOISE_REL * scale
}

/// World-space budget for reading a no-sign-change approach as a contact, in
/// resolutions of the curve's characteristic radius: `MERGE` floored, as the
/// caller passes. This is the "virtual tangent point" rule shared by the
/// closed-form arms (`lc`, `cc`, `line_ellipse`) and the sampled scan: a
/// tangent constraint that converged leaves the contact a hair short of the
/// rim, and the region closes on the foot of the closest approach.
///
/// Relative to the radius, not the sketch, because the ambiguity a converged
/// tangency leaves is the residual the tangent row drives to zero, which is a
/// distance on the curve. Relative not absolute, because a fixed world budget
/// would swallow real features on a small sketch and be lost in the solver's
/// noise on a large one. The gap form is the one a solve can be read against
/// (`h ~ sqrt(2 * r * gap)` is its square root, which is why the previous
/// h-form rule left only 52x over the reported sketch's 9e-8 residual, thin
/// enough under a square root that an area flickers in and out of a dragged
/// sketch). Applies to a MISS only, so it can only invent a contact where the
/// curves come within the budget of touching, never erase a crossing the user
/// drew.
pub const TANGENT_GAP_RESOLUTIONS: f64 = 1e10;

/// The near-tangency contact budget on a curve of characteristic radius
/// `radius`, floored at `floor` (the caller's `TOL_TOPOLOGY_MERGE`: under it a
/// foot is the same vertex as the curve end it was clamped to, so the budget
/// cannot go below the area builder's identity rule).
pub fn tangent_gap_tol(radius: f64, floor: f64) -> f64 {
    (TANGENT_GAP_RESOLUTIONS * resolution(radius)).max(floor)
}

/// How close two analytic roots on the same curves must sit before they are
/// defined to be one tangent contact: the budget on their HALF-separation `h`,
/// in resolutions of the smaller radius (the closed-form arms hold the two
/// roots at `+-h` about the foot, so the sampled scan, which measures the full
/// separation, compares against twice this; one rule, two spellings).
///
/// Exact tangency (`h == 0`) never survives floating point, so the contact is
/// DEFINED at the foot whenever the two roots are within this of coinciding:
/// a tangent pair then stays two clean standalone faces instead of being
/// sliced by a phantom sliver arc. The threshold is on the point separation
/// (not the centre-distance gap, which the square root amplifies), and it is
/// [`tangent_gap_tol`]'s rule in the other form: `gap == h * h / (dist + r)`
/// to first order, the gap a tangent row drives to zero being the square of
/// the separation the two roots leave. The two constants were sized
/// independently, so the two forms do NOT cover the same physical band: the
/// collapse band is the tighter one (it is read on the geometry-swallowing
/// side, where a wider reading would fold real lenses into one contact), and
/// the gap form is the generous one (a miss has no crossing to swallow).
/// Relative to the radius for the same reason; the caller floors the radius at
/// `TOL_TOPOLOGY_EPS` for a degenerate curve.
pub const TANGENT_COLLAPSE_RESOLUTIONS: f64 = 1e12;

/// The root-separation collapse for a pair of curves whose smaller
/// characteristic radius is `r_min`, as the half-separation `h`.
pub fn tangent_collapse_tol(r_min: f64) -> f64 {
    TANGENT_COLLAPSE_RESOLUTIONS * resolution(r_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tangency_budgets_are_the_documented_values_and_stay_a_pair() {
        // The gap budget and the collapse budget are one rule in its two forms
        // (gap == h * h / (dist + r) to first order), 100x apart in relative
        // terms: the collapse reads the half-separation h the roots leave, the
        // gap reads the depth the row drives, and the collapse band is the
        // tighter of the two on purpose (it swallows geometry). Both are
        // decimal spellings of their multiple, so the comparison here is a few
        // ulp wide.
        let r = 1000.0;
        assert!((tangent_gap_tol(r, 0.0) / r / 1e-5 - 1.0).abs() <= 1e-15);
        assert!((tangent_collapse_tol(r) / r / 1e-3 - 1.0).abs() <= 1e-15);
        assert!(tangent_collapse_tol(r) > tangent_gap_tol(r, 0.0));
        // The floor wins on a tiny curve, the relative budget on a big one.
        assert_eq!(tangent_gap_tol(0.001, 1e-5), 1e-5);
        let relative_wins = tangent_gap_tol(10.0, 1e-5);
        assert!(
            (relative_wins / 1e-4 - 1.0).abs() <= 1e-15,
            "a 10 radius outgrows the floor: {relative_wins:e}"
        );
        // Both track the curve's own size, not the sketch's.
        assert!(tangent_gap_tol(2.0 * r, 0.0) > tangent_gap_tol(r, 0.0));
        assert!(tangent_collapse_tol(2.0 * r) > tangent_collapse_tol(r));
    }
}
