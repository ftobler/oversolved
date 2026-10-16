//! The sketch pipeline's resolution and the ladder of thresholds derived from
//! it: the crate's answer to a B-rep kernel's per-shape tolerance.
//!
//! A kernel does not carry one fixed idea of "close enough". A shape is built
//! with a tolerance, the tolerance propagates through the operations, and every
//! later decision is read against it, so the same shape behaves the same at any
//! model scale. This crate does the same with one number: [`resolution`] is the
//! smallest world distance the pipeline resolves on geometry of size `scale`,
//! and every threshold here is either a multiple of it (the multiple is the
//! headroom the rule needs over the representation floor) or deliberately
//! absolute, with the reason stated where it is defined.
//!
//! Two scales feed the ladder and they are NOT interchangeable:
//!   - the SKETCH scale, `Problem::scale()`: the bounding-box diagonal of the
//!     seed geometry and of every external point the constraints name
//!     (`residuals::scale::geometry_scale`). The solve's verdict and the
//!     null-space decisions read against it.
//!   - a CURVE's characteristic radius (`curve_scale` in `topology`): how big
//!     the curve a contact is computed on is. A tangency's ambiguity is a
//!     world distance on that curve, so the tangency budgets read against it,
//!     not against the sketch: a tangent line is as ambiguous on a 500 mm
//!     circle in a big sketch as on the same circle in a small one.
//!
//! The deliberately absolute thresholds, and why they are not multiples (each
//! also states its own reason where it is defined):
//!   - `RANK_TOL`, `FREE_COMPONENT_TOL`: the Jacobian's entries are length per
//!     length, so its spectrum is dimensionless and comparable at every scale.
//!     These are numerical-rank floors on that spectrum, not geometry.
//!   - `REDUNDANT_ROW_REL`: already relative, but to the row's own norm rather
//!     than to a length: a share of the row a later row may re-use before it
//!     counts as a driver.
//!   - the `TOL_TOPOLOGY_*` constants (`topology/mod.rs`): the area builder's
//!     identity rule and its ladder with the TS side and OCC
//!     (`OCC_CONFUSION < TOL_LOOP_CLOSURE <= TOL_TOPOLOGY_MERGE`). They are
//!     rungs of a ladder whose lower rungs are OCC's own compiled-in numbers,
//!     which are not ours to scale; `TOL_TOPOLOGY_MERGE` carries the full
//!     argument, including its one caveat: it is an absolute length living
//!     beside the relative verdict width, and the two cross inside the
//!     modelled range (1e-5 world is the verdict width of a 100 mm sketch).
//!     What the merge must clear there is the solver's REALISED residual,
//!     which no rule derives: it is a measurement (1e-6 world at unit scale,
//!     the venn report), while the verdict width is only the bound.
//!   - a length threshold that is not the resolution-derived kind says so
//!     where it is defined, together with its floor relationship to the
//!     resolution. `topology`'s degeneracy guards (`ZERO_LENGTH_SQ`,
//!     `CIRCLE_TANGENT_EPS`) are guards on the shape of an expression (a
//!     division, a segment test), absolute by construction.
//!
//! The area builder's sampled scan (`topology::curve_intersect`) is the one
//! place where an absolute RESOLUTION is deliberate rather than derived:
//! `SCAN_SAMPLES` samples the scanned curve's parameter domain, ~1/80 of its
//! size per step. At the resolution above a full turn would need ~1e13
//! samples, and the scan is a detection method, not a measurement: what the
//! samples reveal is refined exactly afterwards (bisection for a crossing, the
//! collapse budget for a pair of roots, the gap budget for a miss), so the
//! sampling step bounds DETECTION only and the model's verdicts decide the
//! outcome. `scan_roots_and_grazes` states the rule from the scan's side.

/// Relative width of the f64 wire noise: a coordinate at magnitude `m` crosses
/// the worker boundary as f64 (the rev 3 wire), so it carries a rounding error
/// of at most a few `f64::EPSILON * m` (2.2e-16 relative), and the arithmetic
/// a threshold is evaluated against adds a few more. Rounded to a power of ten
/// so the multiples below stay readable powers of ten.
pub const WIRE_NOISE_REL: f64 = 1e-15;

/// The smallest world distance the pipeline resolves on geometry of size
/// `scale`: below it, two points, a zero displacement or a vanishing feature
/// are the same thing as their rounded representation. This is the unit of the
/// ladder, not a threshold: nothing compares against it directly.
pub fn resolution(scale: f64) -> f64 {
    WIRE_NOISE_REL * scale
}

// ─── The solve's verdict ───

/// How far the LM's final residual may sit off the constraint manifold and
/// still read as satisfied, in resolutions of the sketch scale.
///
/// Sized from measurement, not from the representation: rev 2's f32 params put
/// a quantized ~6e-8 of the size into every decoded coordinate, so the old
/// absolute 1e-4 on the squared norm accepted a 1e-2 miss on any sketch (4% of
/// a 0.25-wide one). Rev 3 carries f64, and the crate's own solve tests measure
/// satisfiable systems at 2.5e-8 relative residual at worst (the sparse drag
/// fast path on a two-point sketch; the cold path's worst is 9.4e-9, the
/// deliberately hard eight-line parallel chain at scale 0.01). The nearest
/// deliberately unsatisfiable case measures 2.8e-2 (a 4 percent conflict).
/// 1e-7 sits between them: 4x above the worst satisfiable reading, five orders
/// below the unsatisfiable one, and 100x tighter than the f32-sized floor.
/// The frontend sketch suites, which solve through the real wasm, all hold
/// under it.
///
/// User-typeable conflicts stay visible at the top of the scale range: 0.01 mm
/// of disagreement on a 1 m sketch is a least-squares compromise of ~7e-3 mm
/// against a 1e-4 mm verdict width (`verdict_tol(1000)`), i.e. tens of times
/// the width, not a hair. See
/// `a_user_typeable_conflict_at_a_metre_scale_is_overconstrained` in `solve`.
pub const VERDICT_RESOLUTIONS: f64 = 1e8;

/// The residual width that still reads as a satisfied solve: the verdict of
/// `solve::satisfied`. A non-finite norm (malformed residual, singular
/// blow-up) never reads as satisfied; the caller checks that.
pub fn verdict_tol(scale: f64) -> f64 {
    VERDICT_RESOLUTIONS * resolution(scale)
}

/// Singular values above this count toward the rank. Deliberately absolute and
/// dimensionless: every Jacobian entry is a residual length per parameter
/// length, so the spectrum is comparable across model scales, and this is the
/// numerical-rank floor below which a singular value cannot be told from
/// round-off (the row builders' finite-difference fallback and the Gram-Schmidt
/// walk both measure round-off at ~1e-16, and a genuine direction stays above
/// 1e-6 by orders of magnitude at every scale the app models).
pub const RANK_TOL: f64 = 1e-6;

/// A param is free when some null direction moves it by more than this. The
/// null basis is orthonormal, so a genuinely free param reads O(1) and a
/// constrained one reads round-off; absolute because the basis is already
/// normalized, in the same dimensionless space as [`RANK_TOL`].
pub const FREE_COMPONENT_TOL: f64 = 1e-6;

/// A constraint row whose remainder after orthogonalisation against every
/// earlier row falls below this share of its own norm adds no new rank, so its
/// constraint is a measurement, not a driver. Relative to the row itself (a
/// dimensionless ratio), so absolute in no useful sense; 1e-8 is three orders
/// above the round-off an exactly duplicated row leaves (a copy of an earlier
/// row reads ~1e-16 relative) and well below any real difference in constraint
/// direction.
pub const REDUNDANT_ROW_REL: f64 = 1e-8;

// ─── The area builder's curve-relative budgets ───

/// World-space budget for reading a no-sign-change approach as a contact,
/// in resolutions of the curve's characteristic radius: `MERGE` floored, as
/// the caller passes. This is the "virtual tangent point" rule shared by the
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
    fn resolution_tracks_the_scale_linearly() {
        // The unit of the ladder: monotone (a bigger sketch resolves a bigger
        // distance), linear (halving the sketch halves it), zero only at zero.
        assert_eq!(resolution(0.0), 0.0);
        let mut prev = 0.0;
        for scale in [1e-3, 1e-2, 0.5, 1.0, 2.0, 100.0, 1500.0, 1e6] {
            let r = resolution(scale);
            assert!(r > prev, "resolution must grow with the scale at {scale}");
            assert!(
                (r - WIRE_NOISE_REL * scale).abs() <= f64::EPSILON * r,
                "resolution({scale}) is not the wire noise of the scale: {r}"
            );
            prev = r;
        }
        assert_eq!(resolution(2.0), 2.0 * resolution(1.0));
    }

    #[test]
    fn resolution_covers_the_f64_grid_of_the_scale() {
        // It is a length in the representation, so it must sit above the
        // rounding of a coordinate of that magnitude: one ulp of 1.0 is
        // 2.2e-16, and the constant allows a handful of operations on top.
        assert!(resolution(1.0) >= f64::EPSILON);
        assert!(resolution(1.0) <= 32.0 * f64::EPSILON);
        for scale in [1e-3, 1.0, 1500.0] {
            assert!(resolution(scale) >= f64::EPSILON * scale);
        }
    }

    #[test]
    fn the_verdict_width_is_what_the_solver_tests_measured() {
        // The multiple is the authority; 1e-7 of the scale is its decimal
        // spelling, equal to a couple of ulp at worst rather than exactly:
        // `1e8 * 1e-15` is itself one ulp above `1e-7` (the gap and collapse
        // multiples happen to be exact, but this one is not), and the second
        // multiplication rounds once more. Measured at most 2 ulp (~4.5e-16
        // relative) across scales 1e-6..1e8. Nothing observable can tell that
        // apart at a threshold with 4x headroom on one side (the worst
        // satisfiable residual) and five orders on the other (the nearest
        // conflict), which is why the ladder states the multiple, not the
        // literal.
        let at_one = verdict_tol(1.0);
        assert!((at_one / 1e-7 - 1.0).abs() <= 1e-15, "{at_one:e}");
        let mut scale = 1e-6;
        while scale <= 1e8 {
            let rel = verdict_tol(scale) / scale;
            assert!(
                (rel / 1e-7 - 1.0).abs() <= 1e-15,
                "scale {scale:e}: the verdict width drifted past a few ulp: {rel:e}"
            );
            scale *= 1.37;
        }
        // And it grows with the sketch, which is the whole point.
        assert!(verdict_tol(1000.0) > verdict_tol(1.0));
    }

    #[test]
    fn the_tangency_budgets_are_the_documented_values_and_stay_a_pair() {
        // The gap budget and the collapse budget are one rule in its two forms
        // (gap == h * h / (dist + r) to first order), 100x apart in relative
        // terms: the collapse reads the half-separation h the roots leave, the
        // gap reads the depth the row drives, and the collapse band is the
        // tighter of the two on purpose (it swallows geometry). Both are
        // decimal spellings of their multiple, so the comparison here is a few
        // ulp wide, as in the verdict test above.
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

    #[test]
    fn the_absolute_thresholds_are_absolute_on_purpose() {
        // Not a restatement of the constants: the point is to pin their KIND.
        // Each is a numerical-rank or round-off floor whose meaning is fixed,
        // so a change here must be a deliberate edit, never a side effect of
        // moving the resolution or a threshold derived from it.
        assert_eq!([RANK_TOL, FREE_COMPONENT_TOL], [1e-6, 1e-6]);
        assert_eq!(REDUNDANT_ROW_REL, 1e-8);
        // The dimensionless rank floor sits above the unit-scale verdict width
        // and below the metre-scale one, exactly because it does not track the
        // geometry while the verdict does. If it ever scaled with the sketch it
        // would stop meaning "round-off" and start meaning "10 km".
        assert!(RANK_TOL > verdict_tol(1.0));
        assert!(RANK_TOL < verdict_tol(1000.0));
    }
}
