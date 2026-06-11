//! Pure curve splitting for the area builder — Rust port of
//! `frontend/src/kernel/curveSplit.ts`. Cut a carrier curve at the parameters
//! `curve_intersect` found into the sub-pieces the half-edge graph consumes.
//!
//! A cubic Bezier sub-segment stays a cubic (de Casteljau), so a sliced spline
//! is represented exactly by new control points. An ellipse cut at two eccentric
//! angles yields the endpoints of the resulting elliptical arc.

pub type Vec2 = [f64; 2];
pub type BezierCtrl = [Vec2; 4];

fn lerp(p: Vec2, q: Vec2, t: f64) -> Vec2 {
    [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
}

/// Split a cubic Bezier at parameter t into (left over [0,t], right over [t,1]).
pub fn split_bezier_at(c: &BezierCtrl, t: f64) -> (BezierCtrl, BezierCtrl) {
    let ab = lerp(c[0], c[1], t);
    let bc = lerp(c[1], c[2], t);
    let cd = lerp(c[2], c[3], t);
    let abc = lerp(ab, bc, t);
    let bcd = lerp(bc, cd, t);
    let abcd = lerp(abc, bcd, t);
    ([c[0], ab, abc, abcd], [abcd, bcd, cd, c[3]])
}

/// Control points of the cubic Bezier restricted to [t0, t1] (0 <= t0 < t1 <= 1).
/// Two de Casteljau cuts: trim the tail at t1, then trim the head of that piece.
pub fn subdivide_bezier(c: &BezierCtrl, t0: f64, t1: f64) -> BezierCtrl {
    debug_assert!(t1 > t0, "subdivide_bezier: need t0 < t1");
    let (left, _) = split_bezier_at(c, t1); // curve over [0, t1]
    if t0 <= 0.0 {
        return left;
    }
    let (_, right) = split_bezier_at(&left, t0 / t1); // re-parameterized head cut
    right
}

/// Point on an ellipse at eccentric angle phi (theta in degrees).
pub fn ellipse_point_at(center: Vec2, a: f64, b: f64, theta_deg: f64, phi: f64) -> Vec2 {
    let cr = (theta_deg * std::f64::consts::PI / 180.0).cos();
    let sr = (theta_deg * std::f64::consts::PI / 180.0).sin();
    let ax = a * phi.cos();
    let ay = b * phi.sin();
    [
        center[0] + ax * cr - ay * sr,
        center[1] + ax * sr + ay * cr,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bez_at(c: &BezierCtrl, t: f64) -> Vec2 {
        let mt = 1.0 - t;
        let w0 = mt * mt * mt;
        let w1 = 3.0 * mt * mt * t;
        let w2 = 3.0 * mt * t * t;
        let w3 = t * t * t;
        [
            w0 * c[0][0] + w1 * c[1][0] + w2 * c[2][0] + w3 * c[3][0],
            w0 * c[0][1] + w1 * c[1][1] + w2 * c[2][1] + w3 * c[3][1],
        ]
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
    fn ellipse_point_at_axis_aligned() {
        let p = ellipse_point_at([1.0, 2.0], 3.0, 1.0, 0.0, 0.0);
        assert!((p[0] - 4.0).abs() < 1e-12 && (p[1] - 2.0).abs() < 1e-12);
        let q = ellipse_point_at([1.0, 2.0], 3.0, 1.0, 0.0, std::f64::consts::FRAC_PI_2);
        assert!((q[0] - 1.0).abs() < 1e-12 && (q[1] - 3.0).abs() < 1e-12);
    }
}
