//! Geometric helpers shared by the residual and Jacobian builders.

use super::P2;
use crate::constraints::Ref;
use crate::{Input, Kind, DEG2RAD, MIN_SEMI_AXIS_SQ};

/// A circle or arc: both store their radius at param index 2, so constraints
/// like equal-radius and circle/circle tangency treat them interchangeably.
pub(super) fn is_curve(k: Kind) -> bool {
    matches!(k, Kind::Circle | Kind::Arc)
}

/// Kind behind an entity ref; `None` for external refs, which carry their own
/// coordinates and read nothing from the local param buffer.
pub(super) fn ref_kind(input: &Input, r: &Ref) -> Option<Kind> {
    match r {
        Ref::Entity { index, .. } => input.entities.get(*index as usize).map(|e| e.kind),
        Ref::External { .. } => None,
    }
}

/// True when a ref supplies at least `slots` local params. External refs
/// trivially do (nothing local is read); absent optional roles never reach
/// this helper (callers default them to eligible).
pub(super) fn ref_supplies_slots(input: &Input, r: &Ref, slots: usize) -> bool {
    match r {
        Ref::External { .. } => true,
        Ref::Entity { index, .. } => input
            .entities
            .get(*index as usize)
            .is_some_and(|e| e.kind.param_count() >= slots),
    }
}

/// Point-on-ellipse conic residual. `ep` is the ellipse param block
/// `[cx, cy, a, b, theta_deg]`; the result is 0 exactly on the curve, negative
/// inside, positive outside.
pub(super) fn ellipse_point_residual(p: P2, ep: &[f64]) -> f64 {
    let (cx, cy, a, b) = (ep[0], ep[1], ep[2], ep[3]);
    let theta = ep[4] * DEG2RAD;
    let (ct, st) = (theta.cos(), theta.sin());
    let dx = p[0] - cx;
    let dy = p[1] - cy;
    let u = dx * ct + dy * st;
    let v = dy * ct - dx * st;
    u * u / (a * a).max(MIN_SEMI_AXIS_SQ) + v * v / (b * b).max(MIN_SEMI_AXIS_SQ) - 1.0
}

/// Evaluate a cubic Bezier `B(t)`. `sp` is the spline param block
/// `[x1, y1, x2, y2, x3, y3, x4, y4]`.
pub(super) fn bezier_eval(sp: &[f64], t: f64) -> P2 {
    let t2 = t * t;
    let t3 = t2 * t;
    let mt = 1.0 - t;
    let mt2 = mt * mt;
    let mt3 = mt2 * mt;
    [
        mt3 * sp[0] + 3.0 * mt2 * t * sp[2] + 3.0 * mt * t2 * sp[4] + t3 * sp[6],
        mt3 * sp[1] + 3.0 * mt2 * t * sp[3] + 3.0 * mt * t2 * sp[5] + t3 * sp[7],
    ]
}

/// First derivative `B'(t)` of a cubic Bezier (the un-normalized tangent).
pub(super) fn bezier_deriv(sp: &[f64], t: f64) -> P2 {
    let t2 = t * t;
    let mt = 1.0 - t;
    let mt2 = mt * mt;
    [
        3.0 * mt2 * (sp[2] - sp[0]) + 6.0 * mt * t * (sp[4] - sp[2]) + 3.0 * t2 * (sp[6] - sp[4]),
        3.0 * mt2 * (sp[3] - sp[1]) + 6.0 * mt * t * (sp[5] - sp[3]) + 3.0 * t2 * (sp[7] - sp[5]),
    ]
}

/// Second derivative `B''(t)` of a cubic Bezier.
pub(super) fn bezier_deriv2(sp: &[f64], t: f64) -> P2 {
    let mt = 1.0 - t;
    [
        6.0 * mt * (sp[4] - 2.0 * sp[2] + sp[0]) + 6.0 * t * (sp[6] - 2.0 * sp[4] + sp[2]),
        6.0 * mt * (sp[5] - 2.0 * sp[3] + sp[1]) + 6.0 * t * (sp[7] - 2.0 * sp[5] + sp[3]),
    ]
}

/// Parameter `t in [0, 1]` of the closest point on a cubic Bezier to `p`.
/// Coarse sample to bracket the global minimum, then a few Newton steps on
/// `f(t) = (p - B(t)) . B'(t) = 0` (stationary squared-distance). The FD
/// Jacobian path recomputes this each perturbation, so it just has to be
/// deterministic, not differentiable.
pub(super) fn bezier_closest_t(sp: &[f64], p: P2) -> f64 {
    const SAMPLES: usize = 24;
    let dist2 = |t: f64| {
        let b = bezier_eval(sp, t);
        (p[0] - b[0]).powi(2) + (p[1] - b[1]).powi(2)
    };
    let mut best_t = 0.0;
    let mut best_d = f64::INFINITY;
    for i in 0..=SAMPLES {
        let t = i as f64 / SAMPLES as f64;
        let d = dist2(t);
        if d < best_d {
            best_d = d;
            best_t = t;
        }
    }
    let mut t = best_t;
    for _ in 0..8 {
        let b = bezier_eval(sp, t);
        let d1 = bezier_deriv(sp, t);
        let d2 = bezier_deriv2(sp, t);
        let w = [p[0] - b[0], p[1] - b[1]];
        let f = w[0] * d1[0] + w[1] * d1[1];
        let fp = -(d1[0] * d1[0] + d1[1] * d1[1]) + w[0] * d2[0] + w[1] * d2[1];
        if fp.abs() < 1e-12 {
            break;
        }
        t -= f / fp;
        t = t.clamp(0.0, 1.0);
    }
    t
}

/// Signed perpendicular distance from `p` to the Bezier at its closest point:
/// `0` exactly on the curve. Used as the point-on-spline coincident residual,
/// mirroring the point-on-line normal-distance row.
pub(super) fn spline_point_residual(p: P2, sp: &[f64]) -> f64 {
    let t = bezier_closest_t(sp, p);
    let b = bezier_eval(sp, t);
    let d1 = bezier_deriv(sp, t);
    let n = (d1[0] * d1[0] + d1[1] * d1[1]).sqrt();
    if n < 1e-12 {
        // Degenerate tangent: fall back to plain distance to the closest point.
        return ((p[0] - b[0]).powi(2) + (p[1] - b[1]).powi(2)).sqrt();
    }
    let (tx, ty) = (d1[0] / n, d1[1] / n);
    let w = [p[0] - b[0], p[1] - b[1]];
    tx * w[1] - ty * w[0]
}
