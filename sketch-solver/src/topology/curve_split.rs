//! Pure curve splitting for the area builder, ported from the former
//! `frontend/src/kernel/curveSplit.ts` (deleted once this port reached
//! parity). Cut a carrier curve at the parameters
//! `curve_intersect` found into the sub-pieces the half-edge graph consumes.
//!
//! A cubic Bezier sub-segment stays a cubic (de Casteljau), so a sliced spline
//! is represented exactly by new control points. An ellipse cut at two eccentric
//! angles yields the endpoints of the resulting elliptical arc.

pub use super::Vec2;
/// The four control points of a cubic Bezier: endpoints P1/P4 plus off-curve
/// handles P2/P3, in `[p0, c1, c2, p3]` order.
pub type BezierCtrl = [Vec2; 4];

fn lerp(p: Vec2, q: Vec2, t: f64) -> Vec2 {
    [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
}

/// Split a cubic Bezier at parameter t into (left over `[0,t]`, right over `[t,1]`).
pub fn split_bezier_at(c: &BezierCtrl, t: f64) -> (BezierCtrl, BezierCtrl) {
    let ab = lerp(c[0], c[1], t);
    let bc = lerp(c[1], c[2], t);
    let cd = lerp(c[2], c[3], t);
    let abc = lerp(ab, bc, t);
    let bcd = lerp(bc, cd, t);
    let abcd = lerp(abc, bcd, t);
    ([c[0], ab, abc, abcd], [abcd, bcd, cd, c[3]])
}

/// Control points of the cubic Bezier restricted to `[t0, t1]` (0 <= t0 < t1 <= 1).
/// Two de Casteljau cuts: trim the tail at t1, then trim the head of that piece.
pub fn subdivide_bezier(c: &BezierCtrl, t0: f64, t1: f64) -> BezierCtrl {
    // Real assert, not debug_assert: this crate ships with debug-assertions off
    // in release, and a silently-passed t0 >= t1 would produce a degenerate
    // zero-length control net instead of surfacing the caller's bug. The only
    // caller (`dcel.rs`) already skips t1 <= t0 pairs, so this should never
    // actually fire; it exists to catch a future caller that doesn't.
    assert!(t1 > t0, "subdivide_bezier: need t0 < t1");
    let (left, _) = split_bezier_at(c, t1); // curve over [0, t1]
    if t0 <= 0.0 {
        return left;
    }
    let (_, right) = split_bezier_at(&left, t0 / t1); // re-parameterized head cut
    right
}

/// Point on an ellipse at eccentric angle phi with pre-computed rotation trig.
pub fn ellipse_point_at(center: Vec2, a: f64, b: f64, cr: f64, sr: f64, phi: f64) -> Vec2 {
    let ax = a * phi.cos();
    let ay = b * phi.sin();
    [center[0] + ax * cr - ay * sr, center[1] + ax * sr + ay * cr]
}

/// Cubic Bezier point at parameter t from control points p0, c1, c2, p3.
pub fn bezier_point(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, t: f64) -> Vec2 {
    let mt = 1.0 - t;
    let w0 = mt * mt * mt;
    let w1 = 3.0 * mt * mt * t;
    let w2 = 3.0 * mt * t * t;
    let w3 = t * t * t;
    [
        w0 * p0[0] + w1 * c1[0] + w2 * c2[0] + w3 * p3[0],
        w0 * p0[1] + w1 * c1[1] + w2 * c2[1] + w3 * p3[1],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bez_at(c: &BezierCtrl, t: f64) -> Vec2 {
        bezier_point(c[0], c[1], c[2], c[3], t)
    }

    #[test]
    fn subdivide_reconstructs_the_original_curve() {
        let c: BezierCtrl = [[0.0, 0.0], [1.0, 2.0], [2.0, -1.0], [3.0, 1.0]];
        // The sub-Bezier over [t0,t1] evaluated at local s must equal the parent
        // evaluated at t0 + s*(t1-t0).
        let (t0, t1) = (0.25, 0.8);
        let sub = subdivide_bezier(&c, t0, t1);
        for k in 0..=10 {
            let s = k as f64 / 10.0;
            let got = bez_at(&sub, s);
            let want = bez_at(&c, t0 + s * (t1 - t0));
            assert!((got[0] - want[0]).abs() < 1e-12);
            assert!((got[1] - want[1]).abs() < 1e-12);
        }
    }

    #[test]
    fn subdivide_from_zero_returns_left_split() {
        let c: BezierCtrl = [[0.0, 0.0], [1.0, 2.0], [2.0, -1.0], [3.0, 1.0]];
        let sub = subdivide_bezier(&c, 0.0, 0.5);
        let (left, _) = split_bezier_at(&c, 0.5);
        assert_eq!(sub, left);
    }

    #[test]
    #[should_panic(expected = "need t0 < t1")]
    fn subdivide_rejects_non_increasing_params() {
        let c: BezierCtrl = [[0.0, 0.0], [1.0, 2.0], [2.0, -1.0], [3.0, 1.0]];
        subdivide_bezier(&c, 0.5, 0.5);
    }

    #[test]
    fn ellipse_point_at_axis_aligned() {
        // theta=0 => cr=1, sr=0
        let p = ellipse_point_at([1.0, 2.0], 3.0, 1.0, 1.0, 0.0, 0.0);
        assert!((p[0] - 4.0).abs() < 1e-12 && (p[1] - 2.0).abs() < 1e-12);
        let q = ellipse_point_at([1.0, 2.0], 3.0, 1.0, 1.0, 0.0, std::f64::consts::FRAC_PI_2);
        assert!((q[0] - 1.0).abs() < 1e-12 && (q[1] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn ellipse_point_at_rotated_90_degrees() {
        // theta=90 => cr=0, sr=1, swaps the axes: the major axis now points +y.
        // At phi=0 the semi-major endpoint sits directly above the center;
        // at phi=pi/2 the semi-minor endpoint sits to its left.
        let major = ellipse_point_at([1.0, 2.0], 3.0, 1.0, 0.0, 1.0, 0.0);
        assert!((major[0] - 1.0).abs() < 1e-9 && (major[1] - 5.0).abs() < 1e-9);
        let minor = ellipse_point_at([1.0, 2.0], 3.0, 1.0, 0.0, 1.0, std::f64::consts::FRAC_PI_2);
        assert!((minor[0] - 0.0).abs() < 1e-9 && (minor[1] - 2.0).abs() < 1e-9);
    }

    #[test]
    fn ellipse_point_at_rotated_45_degrees() {
        // theta=45 => cr=sr=sqrt(2)/2. Semi-major endpoint (phi=0) lands on the
        // diagonal at distance a from the center: (a*cos45, a*sin45).
        let d2 = std::f64::consts::FRAC_1_SQRT_2;
        let p = ellipse_point_at([0.0, 0.0], 2.0, 1.0, d2, d2, 0.0);
        let d = 2.0 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((p[0] - d).abs() < 1e-9 && (p[1] - d).abs() < 1e-9);
    }

    #[test]
    fn split_bezier_at_preserves_endpoints_and_seam() {
        let c: BezierCtrl = [[0.0, 0.0], [1.0, 2.0], [2.0, -1.0], [3.0, 1.0]];
        let t = 0.3;
        let (left, right) = split_bezier_at(&c, t);
        // Outer endpoints are the parent's; the inner seam is C0-continuous and
        // equals the parent evaluated at t.
        assert_eq!(left[0], c[0]);
        assert_eq!(right[3], c[3]);
        assert_eq!(left[3], right[0]);
        let seam = bez_at(&c, t);
        assert!((left[3][0] - seam[0]).abs() < 1e-12);
        assert!((left[3][1] - seam[1]).abs() < 1e-12);
    }

    #[test]
    fn split_bezier_halves_reparameterize_the_parent() {
        let c: BezierCtrl = [[0.0, 0.0], [1.0, 2.0], [2.0, -1.0], [3.0, 1.0]];
        let t = 0.4;
        let (left, right) = split_bezier_at(&c, t);
        for k in 0..=10 {
            let s = k as f64 / 10.0;
            // Left half over local s maps to parent param s*t.
            let gl = bez_at(&left, s);
            let wl = bez_at(&c, s * t);
            assert!((gl[0] - wl[0]).abs() < 1e-12 && (gl[1] - wl[1]).abs() < 1e-12);
            // Right half over local s maps to parent param t + s*(1-t).
            let gr = bez_at(&right, s);
            let wr = bez_at(&c, t + s * (1.0 - t));
            assert!((gr[0] - wr[0]).abs() < 1e-12 && (gr[1] - wr[1]).abs() < 1e-12);
        }
    }
}
