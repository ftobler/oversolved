//! Constraint residual builders, ported arm-for-arm from
//! `oversolved/kernel/solver_residuals.py`.
//!
//! `Problem` precomputes the per-solve invariants (entity kinds/offsets, the
//! initial param vector `x0`, the line-circle coincident map) once, then
//! `residuals(x)` evaluates the stacked residual vector for a candidate `x`.
//! Computation is in `f64` to match Python's `float64`; the wire format's `f32`
//! is widened on decode and narrowed only at output.
//!
//! `pinned_mask` and `equality_pins` are lowered to extra residual rows here
//! (one `x[i] - target` row each), which is exactly what `_residual_fixed`
//! produces for a full-entity / explicit-target pin. The crate therefore treats
//! them identically to a `fixed` constraint for solve, rank, and status.

use crate::constraints::{Axis, Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::sparse::SparseRow;
use crate::{Entity, Input, Kind};
use nalgebra::DMatrix;
use std::collections::HashMap;

/// A point in sketch-plane coordinates.
type P2 = [f64; 2];

const DEG2RAD: f64 = std::f64::consts::PI / 180.0;

/// A circle or arc: both store their radius at param index 2, so constraints
/// like equal-radius and circle/circle tangency treat them interchangeably.
fn is_curve(k: Kind) -> bool {
    matches!(k, Kind::Circle | Kind::Arc)
}

/// Point-on-ellipse conic residual. `ep` is the ellipse param block
/// `[cx, cy, a, b, theta_deg]`; the result is 0 exactly on the curve, negative
/// inside, positive outside. Mirrors the formula in `feature/ellipse-entity.md`.
fn ellipse_point_residual(p: P2, ep: &[f64]) -> f64 {
    let (cx, cy, a, b) = (ep[0], ep[1], ep[2], ep[3]);
    let theta = ep[4] * DEG2RAD;
    let (ct, st) = (theta.cos(), theta.sin());
    let dx = p[0] - cx;
    let dy = p[1] - cy;
    let u = dx * ct + dy * st;
    let v = dy * ct - dx * st;
    u * u / (a * a) + v * v / (b * b) - 1.0
}

/// Evaluate a cubic Bezier `B(t)`. `sp` is the spline param block
/// `[x1, y1, x2, y2, x3, y3, x4, y4]`.
fn bezier_eval(sp: &[f64], t: f64) -> P2 {
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
fn bezier_deriv(sp: &[f64], t: f64) -> P2 {
    let t2 = t * t;
    let mt = 1.0 - t;
    let mt2 = mt * mt;
    [
        3.0 * mt2 * (sp[2] - sp[0])
            + 6.0 * mt * t * (sp[4] - sp[2])
            + 3.0 * t2 * (sp[6] - sp[4]),
        3.0 * mt2 * (sp[3] - sp[1])
            + 6.0 * mt * t * (sp[5] - sp[3])
            + 3.0 * t2 * (sp[7] - sp[5]),
    ]
}

/// Second derivative `B''(t)` of a cubic Bezier.
fn bezier_deriv2(sp: &[f64], t: f64) -> P2 {
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
fn bezier_closest_t(sp: &[f64], p: P2) -> f64 {
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
fn spline_point_residual(p: P2, sp: &[f64]) -> f64 {
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

pub struct Problem<'a> {
    entities: &'a [Entity],
    /// Initial param vector (widened from the wire `f32`), the `x0` of the
    /// `fixed` fallback and the pin rows.
    pub x0: Vec<f64>,
    constraints: &'a [Constraint],
    pinned_indices: Vec<usize>,
    equality_pins: Vec<(usize, f64)>,
    /// (line_index, circle_index) -> which line endpoint is pinned to the
    /// circle, mirroring `line_circle_coincident` in `_build_residuals_fn`.
    line_circle_coincident: HashMap<(u32, u32), PointSelector>,
}

impl<'a> Problem<'a> {
    pub fn new(input: &'a Input) -> Self {
        let x0: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();

        let pinned_indices: Vec<usize> =
            (0..x0.len()).filter(|&i| input.is_pinned(i)).collect();
        let equality_pins: Vec<(usize, f64)> = input
            .equality_pins
            .iter()
            .map(|p| (p.param_index as usize, p.target as f64))
            .collect();

        let mut line_circle_coincident = HashMap::new();
        for c in &input.constraints {
            if c.kind() != Some(ConstraintKind::Coincident) {
                continue;
            }
            let a = c.ref_for(RefRole::A);
            let b = c.ref_for(RefRole::B);
            if let (
                Some(Ref::Entity {
                    index: a_idx,
                    point: a_pt,
                }),
                Some(Ref::Entity {
                    index: b_idx,
                    point: b_pt,
                }),
            ) = (a, b)
            {
                // a is a line with an explicit point; b is a circle without one.
                if a_pt.is_present()
                    && input.entities.get(a_idx as usize).map(|e| e.kind) == Some(Kind::Line)
                    && input.entities.get(b_idx as usize).map(|e| e.kind) == Some(Kind::Circle)
                    && !b_pt.is_present()
                {
                    let sel = if a_pt == PointSelector::End {
                        PointSelector::End
                    } else {
                        PointSelector::Start
                    };
                    line_circle_coincident.insert((a_idx, b_idx), sel);
                }
            }
        }

        Problem {
            entities: &input.entities,
            x0,
            constraints: &input.constraints,
            pinned_indices,
            equality_pins,
            line_circle_coincident,
        }
    }

    fn kind_of(&self, index: u32) -> Kind {
        self.entities[index as usize].kind
    }

    fn offset_of(&self, index: u32) -> usize {
        self.entities[index as usize].param_offset
    }

    /// The flat param slice of one entity.
    fn params<'x>(&self, x: &'x [f64], index: u32) -> &'x [f64] {
        let off = self.offset_of(index);
        let size = self.kind_of(index).param_count();
        &x[off..off + size]
    }

    /// Resolve a reference to a 2D point, mirroring `get_point`.
    fn point(&self, x: &[f64], r: Ref) -> P2 {
        match r {
            Ref::External { x: ex, y: ey } => [ex, ey],
            Ref::Entity { index, point } => {
                let ep = self.params(x, index);
                match self.kind_of(index) {
                    Kind::Line => {
                        if point == PointSelector::End {
                            [ep[2], ep[3]]
                        } else {
                            [ep[0], ep[1]]
                        }
                    }
                    Kind::Circle => [ep[0], ep[1]],
                    Kind::Arc => {
                        if point == PointSelector::Center {
                            [ep[0], ep[1]]
                        } else {
                            let (cx, cy, rad) = (ep[0], ep[1], ep[2]);
                            let a_deg = if point == PointSelector::End {
                                ep[4]
                            } else {
                                ep[3]
                            };
                            let a = a_deg.to_radians();
                            [cx + rad * a.cos(), cy + rad * a.sin()]
                        }
                    }
                    Kind::Point => [ep[0], ep[1]],
                    // Ellipse: center by default; the 4 axis endpoints resolve
                    // from (a, b, theta) so a point_distance to the center pins
                    // the major/minor radius. ep = [cx, cy, a, b, theta_deg].
                    Kind::Ellipse => {
                        let (cx, cy, a, b) = (ep[0], ep[1], ep[2], ep[3]);
                        let theta = ep[4].to_radians();
                        let (ct, st) = (theta.cos(), theta.sin());
                        match point {
                            PointSelector::Major => [cx + a * ct, cy + a * st],
                            PointSelector::MajorNeg => [cx - a * ct, cy - a * st],
                            PointSelector::Minor => [cx - b * st, cy + b * ct],
                            PointSelector::MinorNeg => [cx + b * st, cy - b * ct],
                            _ => [cx, cy],
                        }
                    }
                    // Spline: start is P1, end is P4, C1/C2 the off-curve control
                    // points P2/P3; any other selector resolves to the curve
                    // midpoint B(0.5). ep = [x1,y1, x2,y2, x3,y3, x4,y4].
                    Kind::Spline => match point {
                        PointSelector::Start => [ep[0], ep[1]],
                        PointSelector::End => [ep[6], ep[7]],
                        PointSelector::C1 => [ep[2], ep[3]],
                        PointSelector::C2 => [ep[4], ep[5]],
                        _ => bezier_eval(ep, 0.5),
                    },
                }
            }
        }
    }

    /// Unit radius direction at a contact point, mirroring `_radius_dir`.
    fn radius_dir(&self, x: &[f64], arc_index: u32, arc_point: PointSelector, contact: P2) -> P2 {
        let ep = self.params(x, arc_index);
        if self.kind_of(arc_index) == Kind::Circle {
            let rv = [contact[0] - ep[0], contact[1] - ep[1]];
            let rn = (rv[0] * rv[0] + rv[1] * rv[1]).sqrt();
            if rn > 1e-10 {
                [rv[0] / rn, rv[1] / rn]
            } else {
                [0.0, 0.0]
            }
        } else {
            let a_deg = if arc_point == PointSelector::End {
                ep[4]
            } else {
                ep[3]
            };
            let a = a_deg.to_radians();
            [a.cos(), a.sin()]
        }
    }

    /// Evaluate the full stacked residual vector for `x`: every constraint's
    /// rows in order, then the pinned-mask rows, then the equality-pin rows.
    pub fn residuals(&self, x: &[f64]) -> Vec<f64> {
        let mut r: Vec<f64> = Vec::new();
        for c in self.constraints {
            self.residual_one(c, x, &mut r);
        }
        for &i in &self.pinned_indices {
            r.push(x[i] - self.x0[i]);
        }
        for &(i, target) in &self.equality_pins {
            r.push(x[i] - target);
        }
        r
    }

    /// Residual rows of a single constraint. Caller-only constraints (those
    /// whose required roles are missing, e.g. a query that did not resolve to a
    /// local entity) contribute no rows, matching the Python filter that drops
    /// them before solve.
    pub fn residual_one(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some(kind) = c.kind() else { return };
        match kind {
            ConstraintKind::Horizontal => self.r_axis_aligned(c, x, r, true),
            ConstraintKind::Vertical => self.r_axis_aligned(c, x, r, false),
            ConstraintKind::Length => self.r_length(c, x, r),
            ConstraintKind::Radius => self.r_radius(c, x, r),
            ConstraintKind::Diameter => self.r_diameter(c, x, r),
            ConstraintKind::LineDistance => self.r_line_distance(c, x, r),
            ConstraintKind::Coincident => self.r_coincident(c, x, r),
            ConstraintKind::Normal => self.r_normal(c, x, r),
            ConstraintKind::Parallel => self.r_parallel(c, x, r),
            ConstraintKind::Angle => self.r_angle(c, x, r),
            ConstraintKind::Tangent => self.r_tangent(c, x, r),
            ConstraintKind::EqualLength => self.r_equal_length(c, x, r),
            ConstraintKind::PointDistance => self.r_point_distance(c, x, r),
            ConstraintKind::Midpoint => self.r_midpoint(c, x, r),
            ConstraintKind::Concentric => self.r_concentric(c, x, r),
            ConstraintKind::Fixed => self.r_fixed(c, x, r),
        }
    }

    // horizontal (`horizontal=true`) / vertical share structure: the a/b form
    // equalizes a coordinate of two points, the target form equalizes the two
    // ends of a single line.
    fn r_axis_aligned(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>, horizontal: bool) {
        if let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) {
            let pa = self.point(x, a);
            let pb = self.point(x, b);
            let comp = if horizontal { 1 } else { 0 };
            r.push(pa[comp] - pb[comp]);
        } else if let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Target) {
            let ep = self.params(x, index);
            if horizontal {
                r.push(ep[3] - ep[1]);
            } else {
                r.push(ep[2] - ep[0]);
            }
        }
    }

    fn r_length(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index, .. }), Some(value)) =
            (c.ref_for(RefRole::Target), c.value)
        else {
            return;
        };
        let ep = self.params(x, index);
        let (dx, dy) = (ep[2] - ep[0], ep[3] - ep[1]);
        r.push((dx * dx + dy * dy).sqrt() - value);
    }

    fn r_radius(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index, .. }), Some(value)) =
            (c.ref_for(RefRole::Target), c.value)
        else {
            return;
        };
        r.push(self.params(x, index)[2] - value);
    }

    fn r_diameter(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index, .. }), Some(value)) =
            (c.ref_for(RefRole::Target), c.value)
        else {
            return;
        };
        r.push(2.0 * self.params(x, index)[2] - value);
    }

    fn r_line_distance(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(a), Some(b), Some(value)) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value)
        else {
            return;
        };
        let Ref::Entity { index: a_idx, .. } = a else {
            return;
        };
        let ep_a = self.params(x, a_idx);
        let pb = self.point(x, b);
        let (dx, dy) = (ep_a[2] - ep_a[0], ep_a[3] - ep_a[1]);
        let n = (dx * dx + dy * dy).sqrt();
        let (nx, ny) = if n > 0.0 { (-dy / n, dx / n) } else { (0.0, 1.0) };
        let vx = pb[0] - ep_a[0];
        let vy = pb[1] - ep_a[1];
        r.push(vx * nx + vy * ny - value);
    }

    fn r_coincident(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(a_ref), Some(b_ref)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        let a_external = matches!(a_ref, Ref::External { .. });
        let b_external = matches!(b_ref, Ref::External { .. });
        let a_point_present = matches!(a_ref, Ref::Entity { point, .. } if point.is_present());
        let b_point_present = matches!(b_ref, Ref::Entity { point, .. } if point.is_present());
        let a_kind = match a_ref {
            Ref::Entity { index, .. } => Some(self.kind_of(index)),
            _ => None,
        };
        let b_kind = match b_ref {
            Ref::Entity { index, .. } => Some(self.kind_of(index)),
            _ => None,
        };
        let b_index = match b_ref {
            Ref::Entity { index, .. } => Some(index),
            _ => None,
        };

        if !a_external
            && !b_external
            && !a_point_present
            && !b_point_present
            && a_kind == Some(Kind::Line)
            && b_kind == Some(Kind::Line)
        {
            let a_idx = match a_ref {
                Ref::Entity { index, .. } => index,
                _ => return,
            };
            let ea = self.params(x, a_idx).to_vec();
            let eb = self.params(x, b_index.unwrap()).to_vec();
            let da = [ea[2] - ea[0], ea[3] - ea[1]];
            let db = [eb[2] - eb[0], eb[3] - eb[1]];
            r.push(da[0] * db[1] - da[1] * db[0]);
            let n = (da[0] * da[0] + da[1] * da[1]).sqrt();
            let (nx, ny) = if n > 0.0 {
                (-da[1] / n, da[0] / n)
            } else {
                (0.0, 1.0)
            };
            r.push((eb[0] - ea[0]) * nx + (eb[1] - ea[1]) * ny);
        } else if !b_external && !b_point_present && b_kind == Some(Kind::Line) {
            let pa = self.point(x, a_ref);
            let ep_b = self.params(x, b_index.unwrap());
            let (dx, dy) = (ep_b[2] - ep_b[0], ep_b[3] - ep_b[1]);
            let n = (dx * dx + dy * dy).sqrt();
            let (nx, ny) = if n > 0.0 { (-dy / n, dx / n) } else { (0.0, 1.0) };
            r.push((pa[0] - ep_b[0]) * nx + (pa[1] - ep_b[1]) * ny);
        } else if !b_external
            && !b_point_present
            && (b_kind == Some(Kind::Circle) || b_kind == Some(Kind::Arc))
        {
            let pa = self.point(x, a_ref);
            let ep_b = self.params(x, b_index.unwrap());
            let dist = ((pa[0] - ep_b[0]).powi(2) + (pa[1] - ep_b[1]).powi(2)).sqrt();
            r.push(dist - ep_b[2]);
        } else if !b_external && !b_point_present && b_kind == Some(Kind::Ellipse) {
            // Point-on-ellipse: the conic equation in the ellipse's local frame.
            // ep_b = [cx, cy, a, b, theta_deg]; rotate the offset into the axis
            // frame, then evaluate (u/a)^2 + (v/b)^2 - 1.
            let pa = self.point(x, a_ref);
            let ep_b = self.params(x, b_index.unwrap());
            r.push(ellipse_point_residual(pa, ep_b));
        } else if !b_external && !b_point_present && b_kind == Some(Kind::Spline) {
            // Point-on-spline: signed perpendicular distance to the closest
            // point on the cubic Bezier, mirroring the point-on-line row.
            let pa = self.point(x, a_ref);
            let ep_b = self.params(x, b_index.unwrap());
            r.push(spline_point_residual(pa, ep_b));
        } else {
            let pa = self.point(x, a_ref);
            let pb = self.point(x, b_ref);
            r.push(pa[0] - pb[0]);
            r.push(pa[1] - pb[1]);
        }
    }

    fn r_normal(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        let (Ref::Entity { index: a_idx, .. }, Ref::Entity { index: b_idx, .. }) = (a, b) else {
            return;
        };
        let a_kind = self.kind_of(a_idx);
        let b_kind = self.kind_of(b_idx);
        if a_kind == Kind::Line && b_kind == Kind::Line {
            let ea = self.params(x, a_idx);
            let eb = self.params(x, b_idx);
            let da = [ea[2] - ea[0], ea[3] - ea[1]];
            let db = [eb[2] - eb[0], eb[3] - eb[1]];
            r.push(da[0] * db[0] + da[1] * db[1]);
            return;
        }
        let (line_ref, arc_ref) = if a_kind == Kind::Line { (a, b) } else { (b, a) };
        let (line_idx, arc_idx, arc_pt) = match (line_ref, arc_ref) {
            (
                Ref::Entity { index: li, .. },
                Ref::Entity {
                    index: ai,
                    point: ap,
                },
            ) => (li, ai, ap),
            _ => return,
        };
        let line_ep = self.params(x, line_idx);
        let line_dir = [line_ep[2] - line_ep[0], line_ep[3] - line_ep[1]];
        let contact = [line_ep[2], line_ep[3]];
        let rd = self.radius_dir(x, arc_idx, arc_pt, contact);
        r.push(line_dir[0] * rd[1] - line_dir[1] * rd[0]);
    }

    fn r_parallel(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index: a_idx, .. }), Some(Ref::Entity { index: b_idx, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        // Parallel is only defined for line directions. A non-line operand (a
        // hand-edited or legacy doc) contributes no rows rather than reading
        // its params as endpoints: a circle would index out of bounds and an
        // arc would solve toward a garbage direction. Must stay in sync with
        // the same guard in `jac_parallel`.
        if self.kind_of(a_idx) != Kind::Line || self.kind_of(b_idx) != Kind::Line {
            return;
        }
        let ea = self.params(x, a_idx);
        let eb = self.params(x, b_idx);
        let da = [ea[2] - ea[0], ea[3] - ea[1]];
        let db = [eb[2] - eb[0], eb[3] - eb[1]];
        r.push(da[0] * db[1] - da[1] * db[0]);
    }

    fn r_angle(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (
            Some(Ref::Entity { index: a_idx, .. }),
            Some(Ref::Entity { index: b_idx, .. }),
            Some(value),
        ) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value)
        else {
            return;
        };
        let ea = self.params(x, a_idx);
        let eb = self.params(x, b_idx);
        let da = [ea[2] - ea[0], ea[3] - ea[1]];
        let db = [eb[2] - eb[0], eb[3] - eb[1]];
        let dot = da[0] * db[0] + da[1] * db[1];
        let cross = da[0] * db[1] - da[1] * db[0];
        let angle = cross.abs().atan2(dot);
        r.push(angle - value.to_radians());
    }

    fn r_tangent(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (line_ref, arc_ref) = if c.has_role(RefRole::Line) && c.has_role(RefRole::Arc) {
            (c.ref_for(RefRole::Line).unwrap(), c.ref_for(RefRole::Arc).unwrap())
        } else {
            let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
                return;
            };
            match a {
                Ref::Entity { index, .. } if self.kind_of(index) == Kind::Line => (a, b),
                _ => (b, a),
            }
        };
        let (line_idx, arc_idx, arc_pt) = match (line_ref, arc_ref) {
            (
                Ref::Entity { index: li, .. },
                Ref::Entity {
                    index: ai,
                    point: ap,
                },
            ) => (li, ai, ap),
            _ => return,
        };
        // Neither operand is a line: this is curve/curve tangency (two circles
        // or arcs). The centers' distance equals rA+rB when the circles touch
        // externally or |rA-rB| when one sits inside the other; follow whichever
        // the current geometry is nearest so the solver never flips the tangency
        // type mid-solve. The Jacobian comes from the finite-difference fallback.
        if !matches!(self.kind_of(line_idx), Kind::Line) {
            let ca = self.params(x, line_idx);
            let cb = self.params(x, arc_idx);
            let d = ((ca[0] - cb[0]).powi(2) + (ca[1] - cb[1]).powi(2)).sqrt();
            let (ra, rb) = (ca[2], cb[2]);
            let external = d - (ra + rb);
            let internal = d - (ra - rb).abs();
            r.push(if external.abs() <= internal.abs() {
                external
            } else {
                internal
            });
            return;
        }
        let line_ep = self.params(x, line_idx).to_vec();
        let arc_ep = self.params(x, arc_idx).to_vec();
        let mut line_dir = [line_ep[2] - line_ep[0], line_ep[3] - line_ep[1]];
        let norm = (line_dir[0] * line_dir[0] + line_dir[1] * line_dir[1])
            .sqrt()
            .max(1e-12);
        line_dir[0] /= norm;
        line_dir[1] /= norm;

        if self.kind_of(arc_idx) == Kind::Spline {
            // Line tangent to a spline endpoint: the line direction is parallel
            // to the Bezier tangent there, so the cross product is zero.
            let sp = self.params(x, arc_idx);
            let tan = match arc_pt {
                PointSelector::End => bezier_deriv(sp, 1.0),
                PointSelector::Start => bezier_deriv(sp, 0.0),
                _ => bezier_deriv(sp, 0.5),
            };
            let tn = (tan[0] * tan[0] + tan[1] * tan[1]).sqrt().max(1e-12);
            let (tx, ty) = (tan[0] / tn, tan[1] / tn);
            r.push(line_dir[0] * ty - line_dir[1] * tx);
        } else if self.kind_of(arc_idx) == Kind::Circle {
            if let Some(&pinned_pt) = self.line_circle_coincident.get(&(line_idx, arc_idx)) {
                let contact = if pinned_pt == PointSelector::Start {
                    [line_ep[0], line_ep[1]]
                } else {
                    [line_ep[2], line_ep[3]]
                };
                let rd = self.radius_dir(x, arc_idx, arc_pt, contact);
                r.push(line_dir[0] * rd[0] + line_dir[1] * rd[1]);
            } else {
                let contact = [line_ep[2], line_ep[3]];
                let rd = self.radius_dir(x, arc_idx, arc_pt, contact);
                r.push(line_dir[0] * rd[0] + line_dir[1] * rd[1]);
                let dist =
                    ((contact[0] - arc_ep[0]).powi(2) + (contact[1] - arc_ep[1]).powi(2)).sqrt();
                r.push(dist - arc_ep[2]);
            }
        } else {
            let contact = [line_ep[2], line_ep[3]];
            let rd = self.radius_dir(x, arc_idx, arc_pt, contact);
            r.push(line_dir[0] * rd[0] + line_dir[1] * rd[1]);
        }
    }

    fn r_equal_length(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index: a_idx, .. }), Some(Ref::Entity { index: b_idx, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        let ea = self.params(x, a_idx);
        let eb = self.params(x, b_idx);
        let (ka, kb) = (self.kind_of(a_idx), self.kind_of(b_idx));
        if ka == Kind::Line && kb == Kind::Line {
            let len_a = ((ea[2] - ea[0]).powi(2) + (ea[3] - ea[1]).powi(2)).sqrt();
            let len_b = ((eb[2] - eb[0]).powi(2) + (eb[3] - eb[1]).powi(2)).sqrt();
            r.push(len_a - len_b);
        } else if is_curve(ka) && is_curve(kb) {
            // Equal between two circles/arcs compares radii (params[2] holds the
            // radius for both kinds). Must stay in sync with jac_equal_length.
            r.push(ea[2] - eb[2]);
        }
        // A line/curve mix would compare a length to a radius, which is not a
        // meaningful equality: contribute no row (the UI also refuses to author
        // it; see the equal_length entityKindGroups guard).
    }

    fn r_point_distance(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(a), Some(b), Some(value)) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value)
        else {
            return;
        };
        let pa = self.point(x, a);
        let pb = self.point(x, b);
        let dist = ((pb[0] - pa[0]).powi(2) + (pb[1] - pa[1]).powi(2)).sqrt();
        r.push(dist - value);
    }

    fn r_midpoint(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let mid: P2 = if let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Line) {
            let ep = self.params(x, index);
            [(ep[0] + ep[2]) / 2.0, (ep[1] + ep[3]) / 2.0]
        } else if let (Some(pa_ref), Some(pb_ref)) =
            (c.ref_for(RefRole::PointA), c.ref_for(RefRole::PointB))
        {
            let pa = self.point(x, pa_ref);
            let pb = self.point(x, pb_ref);
            [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0]
        } else {
            return;
        };
        let Some(pt_ref) = c.ref_for(RefRole::Point) else {
            return;
        };
        let pt = self.point(x, pt_ref);
        let axis = c.axis.unwrap_or(Axis::Both);
        if axis.includes_x() {
            r.push(pt[0] - mid[0]);
        }
        if axis.includes_y() {
            r.push(pt[1] - mid[1]);
        }
    }

    fn r_concentric(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index: a_idx, .. }), Some(Ref::Entity { index: b_idx, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        let ea = self.params(x, a_idx);
        let eb = self.params(x, b_idx);
        r.push(ea[0] - eb[0]);
        r.push(ea[1] - eb[1]);
    }

    fn r_fixed(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some(target) = c.ref_for(RefRole::Target) else {
            return;
        };
        let Ref::Entity { index, point } = target else {
            return;
        };
        let has_point = point.is_present();
        let has_xy = c.xy.is_some();
        if has_point || has_xy {
            let pt = self.point(x, target);
            let (fix_x, fix_y) = match c.xy {
                Some((fx, fy)) => (fx, fy),
                None => {
                    let p0 = self.point(&self.x0, target);
                    (p0[0], p0[1])
                }
            };
            r.push(pt[0] - fix_x);
            r.push(pt[1] - fix_y);
        } else {
            let off = self.offset_of(index);
            let size = self.kind_of(index).param_count();
            for i in 0..size {
                r.push(x[off + i] - self.x0[off + i]);
            }
        }
    }

    // ─── Analytic Jacobian ───
    //
    // Derivative rows that mirror `residuals` row-for-row. Smooth/explicit
    // constraints get hand-written derivatives; the gnarlier ones (those whose
    // residual normalizes a direction or goes through atan2) fall back to a
    // per-constraint central finite difference over only their involved params.
    // The fallback keeps correctness trivially (it IS finite differences) while
    // the common cheap constraints avoid the O(2N) full-FD cost.

    /// Jacobian of the full stacked residual at `x` (m rows x `n` params).
    pub fn jacobian(&self, x: &[f64], n: usize) -> DMatrix<f64> {
        let mut rows: Vec<Vec<f64>> = Vec::new();
        for c in self.constraints {
            self.jac_one(c, x, n, &mut rows);
        }
        for &i in &self.pinned_indices {
            let mut row = vec![0.0; n];
            row[i] = 1.0;
            rows.push(row);
        }
        for &(i, _) in &self.equality_pins {
            let mut row = vec![0.0; n];
            row[i] = 1.0;
            rows.push(row);
        }

        let m = rows.len();
        let mut j = DMatrix::<f64>::zeros(m, n);
        for (r_i, row) in rows.iter().enumerate() {
            for (c_i, &v) in row.iter().enumerate() {
                j[(r_i, c_i)] = v;
            }
        }
        j
    }

    /// Sparse Jacobian: each row as `(col_index, value)` pairs for nonzero entries.
    /// Builds the same row set as `jacobian` but converts to sparse representation.
    pub fn jacobian_sparse(&self, x: &[f64], n: usize) -> Vec<SparseRow> {
        let mut dense_rows: Vec<Vec<f64>> = Vec::new();
        for c in self.constraints {
            self.jac_one(c, x, n, &mut dense_rows);
        }
        for &i in &self.pinned_indices {
            let mut row = vec![0.0; n];
            row[i] = 1.0;
            dense_rows.push(row);
        }
        for &(i, _) in &self.equality_pins {
            let mut row = vec![0.0; n];
            row[i] = 1.0;
            dense_rows.push(row);
        }

        dense_rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .enumerate()
                    .filter(|&(_, v)| v != 0.0)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn residual_one_vec(&self, c: &Constraint, x: &[f64]) -> Vec<f64> {
        let mut r = Vec::new();
        self.residual_one(c, x, &mut r);
        r
    }

    /// Param indices a constraint's references touch (full entity blocks).
    fn involved_params(&self, c: &Constraint) -> Vec<usize> {
        let mut idxs = Vec::new();
        for (_, rf) in &c.refs {
            if let Ref::Entity { index, .. } = rf {
                let off = self.offset_of(*index);
                let size = self.kind_of(*index).param_count();
                for i in 0..size {
                    if !idxs.contains(&(off + i)) {
                        idxs.push(off + i);
                    }
                }
            }
        }
        idxs
    }

    /// Central finite-difference rows for one constraint, perturbing only the
    /// params it touches. Used as the fallback for constraints without an
    /// analytic derivative.
    fn fd_constraint_rows(&self, c: &Constraint, x: &[f64], n: usize) -> Vec<Vec<f64>> {
        let base = self.residual_one_vec(c, x);
        let k = base.len();
        if k == 0 {
            return Vec::new();
        }
        let mut rows = vec![vec![0.0; n]; k];
        let mut xp = x.to_vec();
        for j in self.involved_params(c) {
            let h = f64::EPSILON.cbrt() * x[j].abs().max(1.0);
            xp[j] = x[j] + h;
            let fp = self.residual_one_vec(c, &xp);
            xp[j] = x[j] - h;
            let fm = self.residual_one_vec(c, &xp);
            xp[j] = x[j];
            let inv = 1.0 / (2.0 * h);
            for (row, (&p, &m)) in fp.iter().zip(fm.iter()).enumerate() {
                rows[row][j] = (p - m) * inv;
            }
        }
        rows
    }

    /// Jacobian of a 2D point reference w.r.t. its entity params: a list of
    /// `(param_index, d(point.x), d(point.y))`. External refs contribute nothing.
    fn point_jac(&self, x: &[f64], r: Ref) -> Vec<(usize, f64, f64)> {
        match r {
            Ref::External { .. } => Vec::new(),
            Ref::Entity { index, point } => {
                let off = self.offset_of(index);
                match self.kind_of(index) {
                    Kind::Line => {
                        if point == PointSelector::End {
                            vec![(off + 2, 1.0, 0.0), (off + 3, 0.0, 1.0)]
                        } else {
                            vec![(off, 1.0, 0.0), (off + 1, 0.0, 1.0)]
                        }
                    }
                    // Circle/Point resolve to their first two params (center /
                    // xy), so the point Jacobian is the identity on those.
                    Kind::Circle | Kind::Point => {
                        vec![(off, 1.0, 0.0), (off + 1, 0.0, 1.0)]
                    }
                    // Ellipse: center is the identity; an axis endpoint also
                    // depends on a/b and theta. Mirror the `point()` formulas.
                    Kind::Ellipse => {
                        let base = vec![(off, 1.0, 0.0), (off + 1, 0.0, 1.0)];
                        let ep = self.params(x, index);
                        let (a, b) = (ep[2], ep[3]);
                        let theta = ep[4].to_radians();
                        let (ct, st) = (theta.cos(), theta.sin());
                        let mut j = base;
                        match point {
                            PointSelector::Major => {
                                j.push((off + 2, ct, st));
                                j.push((off + 4, -a * st * DEG2RAD, a * ct * DEG2RAD));
                            }
                            PointSelector::MajorNeg => {
                                j.push((off + 2, -ct, -st));
                                j.push((off + 4, a * st * DEG2RAD, -a * ct * DEG2RAD));
                            }
                            PointSelector::Minor => {
                                j.push((off + 3, -st, ct));
                                j.push((off + 4, -b * ct * DEG2RAD, -b * st * DEG2RAD));
                            }
                            PointSelector::MinorNeg => {
                                j.push((off + 3, st, -ct));
                                j.push((off + 4, b * ct * DEG2RAD, b * st * DEG2RAD));
                            }
                            _ => {}
                        }
                        j
                    }
                    Kind::Arc => {
                        if point == PointSelector::Center {
                            vec![(off, 1.0, 0.0), (off + 1, 0.0, 1.0)]
                        } else {
                            let ep = self.params(x, index);
                            let rad = ep[2];
                            let (a_idx, a_deg) = if point == PointSelector::End {
                                (off + 4, ep[4])
                            } else {
                                (off + 3, ep[3])
                            };
                            let a = a_deg.to_radians();
                            vec![
                                (off, 1.0, 0.0),
                                (off + 1, 0.0, 1.0),
                                (off + 2, a.cos(), a.sin()),
                                (a_idx, -rad * a.sin() * DEG2RAD, rad * a.cos() * DEG2RAD),
                            ]
                        }
                    }
                    // Spline: start/end and the C1/C2 control points are the
                    // identity on their own param pairs; the midpoint
                    // B(0.5) = (P1 + 3P2 + 3P3 + P4)/8 depends on all four
                    // control points. Mirror the `point()` selectors.
                    Kind::Spline => match point {
                        PointSelector::Start => vec![(off, 1.0, 0.0), (off + 1, 0.0, 1.0)],
                        PointSelector::End => vec![(off + 6, 1.0, 0.0), (off + 7, 0.0, 1.0)],
                        PointSelector::C1 => vec![(off + 2, 1.0, 0.0), (off + 3, 0.0, 1.0)],
                        PointSelector::C2 => vec![(off + 4, 1.0, 0.0), (off + 5, 0.0, 1.0)],
                        _ => vec![
                            (off, 0.125, 0.0),
                            (off + 1, 0.0, 0.125),
                            (off + 2, 0.375, 0.0),
                            (off + 3, 0.0, 0.375),
                            (off + 4, 0.375, 0.0),
                            (off + 5, 0.0, 0.375),
                            (off + 6, 0.125, 0.0),
                            (off + 7, 0.0, 0.125),
                        ],
                    },
                }
            }
        }
    }

    fn jac_one(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        let Some(kind) = c.kind() else { return };
        match kind {
            ConstraintKind::Horizontal => self.jac_axis_aligned(c, x, n, rows, true),
            ConstraintKind::Vertical => self.jac_axis_aligned(c, x, n, rows, false),
            ConstraintKind::Length => self.jac_length(c, x, n, rows),
            ConstraintKind::Radius => self.jac_single_param(c, n, rows, 2, 1.0),
            ConstraintKind::Diameter => self.jac_single_param(c, n, rows, 2, 2.0),
            ConstraintKind::Parallel => self.jac_parallel(c, x, n, rows),
            ConstraintKind::Concentric => self.jac_concentric(c, n, rows),
            ConstraintKind::EqualLength => self.jac_equal_length(c, x, n, rows),
            ConstraintKind::PointDistance => self.jac_point_distance(c, x, n, rows),
            ConstraintKind::Coincident => self.jac_coincident(c, x, n, rows),
            ConstraintKind::Fixed => self.jac_fixed(c, x, n, rows),
            // Direction-normalizing / atan2 residuals: finite-difference fallback.
            ConstraintKind::LineDistance
            | ConstraintKind::Normal
            | ConstraintKind::Angle
            | ConstraintKind::Tangent
            | ConstraintKind::Midpoint => rows.extend(self.fd_constraint_rows(c, x, n)),
        }
    }

    fn jac_axis_aligned(
        &self,
        c: &Constraint,
        x: &[f64],
        n: usize,
        rows: &mut Vec<Vec<f64>>,
        horizontal: bool,
    ) {
        // component index in a 2D point: y for horizontal, x for vertical.
        let comp = if horizontal { 1 } else { 0 };
        if let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) {
            let mut row = vec![0.0; n];
            for (i, dx, dy) in self.point_jac(x, a) {
                row[i] += if comp == 1 { dy } else { dx };
            }
            for (i, dx, dy) in self.point_jac(x, b) {
                row[i] -= if comp == 1 { dy } else { dx };
            }
            rows.push(row);
        } else if let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Target) {
            let off = self.offset_of(index);
            let mut row = vec![0.0; n];
            if horizontal {
                row[off + 3] += 1.0; // ep[3] (end.y)
                row[off + 1] -= 1.0; // ep[1] (start.y)
            } else {
                row[off + 2] += 1.0; // ep[2] (end.x)
                row[off] -= 1.0; // ep[0] (start.x)
            }
            rows.push(row);
        }
    }

    fn jac_length(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Target) else {
            return;
        };
        if c.value.is_none() {
            return;
        }
        let off = self.offset_of(index);
        let ep = self.params(x, index);
        let (dx, dy) = (ep[2] - ep[0], ep[3] - ep[1]);
        let nrm = (dx * dx + dy * dy).sqrt();
        let mut row = vec![0.0; n];
        if nrm > 0.0 {
            row[off] = -dx / nrm;
            row[off + 1] = -dy / nrm;
            row[off + 2] = dx / nrm;
            row[off + 3] = dy / nrm;
        }
        rows.push(row);
    }

    fn jac_single_param(
        &self,
        c: &Constraint,
        n: usize,
        rows: &mut Vec<Vec<f64>>,
        local: usize,
        coeff: f64,
    ) {
        let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Target) else {
            return;
        };
        if c.value.is_none() {
            return;
        }
        let off = self.offset_of(index);
        let mut row = vec![0.0; n];
        row[off + local] = coeff;
        rows.push(row);
    }

    fn jac_parallel(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        let (Some(Ref::Entity { index: ai, .. }), Some(Ref::Entity { index: bi, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        // Mirror the non-line guard in `r_parallel`: residual and Jacobian row
        // counts must agree, so a skipped residual must skip its row here too.
        if self.kind_of(ai) != Kind::Line || self.kind_of(bi) != Kind::Line {
            return;
        }
        let ea = self.params(x, ai).to_vec();
        let eb = self.params(x, bi).to_vec();
        let da = [ea[2] - ea[0], ea[3] - ea[1]];
        let db = [eb[2] - eb[0], eb[3] - eb[1]];
        let (oa, ob) = (self.offset_of(ai), self.offset_of(bi));
        let mut row = vec![0.0; n];
        // r = da.x*db.y - da.y*db.x
        row[oa] += -db[1];
        row[oa + 2] += db[1];
        row[oa + 1] += db[0];
        row[oa + 3] += -db[0];
        row[ob] += da[1];
        row[ob + 2] += -da[1];
        row[ob + 1] += -da[0];
        row[ob + 3] += da[0];
        rows.push(row);
    }

    fn jac_concentric(&self, c: &Constraint, n: usize, rows: &mut Vec<Vec<f64>>) {
        let (Some(Ref::Entity { index: ai, .. }), Some(Ref::Entity { index: bi, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        let (oa, ob) = (self.offset_of(ai), self.offset_of(bi));
        let mut rx = vec![0.0; n];
        rx[oa] = 1.0;
        rx[ob] = -1.0;
        rows.push(rx);
        let mut ry = vec![0.0; n];
        ry[oa + 1] = 1.0;
        ry[ob + 1] = -1.0;
        rows.push(ry);
    }

    fn jac_equal_length(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        let (Some(Ref::Entity { index: ai, .. }), Some(Ref::Entity { index: bi, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        let (ka, kb) = (self.kind_of(ai), self.kind_of(bi));
        let (oa, ob) = (self.offset_of(ai), self.offset_of(bi));
        // Curve/curve equality compares radii: d(rA - rB) is +1 / -1 on the two
        // radius params (index 2). Mirror the residual's kind branching so the
        // row count agrees; a line/curve mix contributes no row.
        if is_curve(ka) && is_curve(kb) {
            let mut row = vec![0.0; n];
            row[oa + 2] += 1.0;
            row[ob + 2] += -1.0;
            rows.push(row);
            return;
        }
        if ka != Kind::Line || kb != Kind::Line {
            return;
        }
        let ea = self.params(x, ai).to_vec();
        let eb = self.params(x, bi).to_vec();
        let na = ((ea[2] - ea[0]).powi(2) + (ea[3] - ea[1]).powi(2)).sqrt();
        let nb = ((eb[2] - eb[0]).powi(2) + (eb[3] - eb[1]).powi(2)).sqrt();
        let mut row = vec![0.0; n];
        if na > 0.0 {
            let (dx, dy) = (ea[2] - ea[0], ea[3] - ea[1]);
            row[oa] += -dx / na;
            row[oa + 1] += -dy / na;
            row[oa + 2] += dx / na;
            row[oa + 3] += dy / na;
        }
        if nb > 0.0 {
            let (dx, dy) = (eb[2] - eb[0], eb[3] - eb[1]);
            row[ob] += dx / nb;
            row[ob + 1] += dy / nb;
            row[ob + 2] += -dx / nb;
            row[ob + 3] += -dy / nb;
        }
        rows.push(row);
    }

    fn jac_point_distance(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        if c.value.is_none() {
            return;
        }
        let pa = self.point(x, a);
        let pb = self.point(x, b);
        let ux = pb[0] - pa[0];
        let uy = pb[1] - pa[1];
        let d = (ux * ux + uy * uy).sqrt();
        let mut row = vec![0.0; n];
        if d > 0.0 {
            for (i, dpx, dpy) in self.point_jac(x, a) {
                row[i] += (-ux / d) * dpx + (-uy / d) * dpy;
            }
            for (i, dpx, dpy) in self.point_jac(x, b) {
                row[i] += (ux / d) * dpx + (uy / d) * dpy;
            }
        }
        rows.push(row);
    }

    fn jac_coincident(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        if !self.coincident_is_point_point(c) {
            rows.extend(self.fd_constraint_rows(c, x, n));
            return;
        }
        let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        // r = [pa.x - pb.x, pa.y - pb.y]
        let mut rx = vec![0.0; n];
        let mut ry = vec![0.0; n];
        for (i, dpx, dpy) in self.point_jac(x, a) {
            rx[i] += dpx;
            ry[i] += dpy;
        }
        for (i, dpx, dpy) in self.point_jac(x, b) {
            rx[i] -= dpx;
            ry[i] -= dpy;
        }
        rows.push(rx);
        rows.push(ry);
    }

    /// True when `r_coincident` would take its final point-to-point branch (the
    /// only branch with a clean analytic derivative). Mirrors that branch logic.
    fn coincident_is_point_point(&self, c: &Constraint) -> bool {
        let (Some(a_ref), Some(b_ref)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return false;
        };
        let a_external = matches!(a_ref, Ref::External { .. });
        let b_external = matches!(b_ref, Ref::External { .. });
        let a_point = matches!(a_ref, Ref::Entity { point, .. } if point.is_present());
        let b_point = matches!(b_ref, Ref::Entity { point, .. } if point.is_present());
        let a_kind = match a_ref {
            Ref::Entity { index, .. } => Some(self.kind_of(index)),
            _ => None,
        };
        let b_kind = match b_ref {
            Ref::Entity { index, .. } => Some(self.kind_of(index)),
            _ => None,
        };
        let branch1 = !a_external
            && !b_external
            && !a_point
            && !b_point
            && a_kind == Some(Kind::Line)
            && b_kind == Some(Kind::Line);
        let branch2 = !b_external && !b_point && b_kind == Some(Kind::Line);
        let branch3 = !b_external
            && !b_point
            && (b_kind == Some(Kind::Circle) || b_kind == Some(Kind::Arc));
        let branch4 = !b_external && !b_point && b_kind == Some(Kind::Ellipse);
        let branch5 = !b_external && !b_point && b_kind == Some(Kind::Spline);
        !(branch1 || branch2 || branch3 || branch4 || branch5)
    }

    fn jac_fixed(&self, c: &Constraint, x: &[f64], n: usize, rows: &mut Vec<Vec<f64>>) {
        let Some(target) = c.ref_for(RefRole::Target) else {
            return;
        };
        let Ref::Entity { index, point } = target else {
            return;
        };
        let has_point = point.is_present();
        let has_xy = c.xy.is_some();
        if has_point || has_xy {
            // r = [pt.x - fix_x, pt.y - fix_y]; fix is constant.
            let mut rx = vec![0.0; n];
            let mut ry = vec![0.0; n];
            for (i, dpx, dpy) in self.point_jac(x, target) {
                rx[i] += dpx;
                ry[i] += dpy;
            }
            rows.push(rx);
            rows.push(ry);
        } else {
            let off = self.offset_of(index);
            let size = self.kind_of(index).param_count();
            for i in 0..size {
                let mut row = vec![0.0; n];
                row[off + i] = 1.0;
                rows.push(row);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConstraintKind, EqualityPin, Options};

    fn ent(kind: Kind, off: usize) -> Entity {
        Entity {
            kind,
            param_offset: off,
        }
    }

    fn target(index: u32, point: PointSelector) -> (RefRole, Ref) {
        (RefRole::Target, Ref::Entity { index, point })
    }

    fn ab(a: Ref, b: Ref) -> Vec<(RefRole, Ref)> {
        vec![(RefRole::A, a), (RefRole::B, b)]
    }

    fn input(entities: Vec<Entity>, params: Vec<f32>, constraints: Vec<Constraint>) -> Input {
        Input {
            entities,
            params_initial: params,
            pinned_mask: Vec::new(),
            equality_pins: Vec::new(),
            constraints,
            options: Options::default(),
        }
    }

    #[test]
    fn horizontal_and_length_residuals_on_known_line() {
        // Line from (0,0) to (10,1).
        let c = vec![
            Constraint {
                kind_code: ConstraintKind::Horizontal.to_u8(),
                refs: vec![target(0, PointSelector::Absent)],
                ..Default::default()
            },
            Constraint {
                kind_code: ConstraintKind::Length.to_u8(),
                refs: vec![target(0, PointSelector::Absent)],
                value: Some(10.0),
                ..Default::default()
            },
        ];
        let inp = input(vec![ent(Kind::Line, 0)], vec![0.0, 0.0, 10.0, 1.0], c);
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0.clone());
        assert!((r[0] - 1.0).abs() < 1e-12, "horizontal: {}", r[0]);
        assert!((r[1] - (101.0_f64.sqrt() - 10.0)).abs() < 1e-12, "length: {}", r[1]);
    }

    #[test]
    fn coincident_point_point_residual() {
        // Two points: (1,2) and (4,6). Coincident residual = (dx, dy) = (-3,-4).
        let c = vec![Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: ab(
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Xy,
                },
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
            ),
            ..Default::default()
        }];
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![1.0, 2.0, 4.0, 6.0],
            c,
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0.clone());
        assert_eq!(r.len(), 2);
        assert!((r[0] - (-3.0)).abs() < 1e-12);
        assert!((r[1] - (-4.0)).abs() < 1e-12);
    }

    #[test]
    fn arc_endpoint_get_point_uses_radius_and_angle() {
        // Arc center (0,0) r=2, start angle 90deg -> start point (0,2).
        let inp = input(vec![ent(Kind::Arc, 0)], vec![0.0, 0.0, 2.0, 90.0, 180.0], vec![]);
        let p = Problem::new(&inp);
        let pt = p.point(
            &p.x0.clone(),
            Ref::Entity {
                index: 0,
                point: PointSelector::Start,
            },
        );
        assert!((pt[0] - 0.0).abs() < 1e-9, "x={}", pt[0]);
        assert!((pt[1] - 2.0).abs() < 1e-9, "y={}", pt[1]);
    }

    #[test]
    fn point_on_ellipse_coincident_residual() {
        // Axis-aligned ellipse: center (1,2), a=4, b=2, theta=0.
        // The point (5,2) sits on the major-axis vertex -> residual 0.
        // The point (1,4) sits on the minor-axis vertex -> residual 0.
        // The center (1,2) is fully inside -> residual -1.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Ellipse, 2)],
            vec![5.0, 2.0, 1.0, 2.0, 4.0, 2.0, 0.0],
            vec![cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0.clone());
        assert_eq!(r.len(), 1);
        assert!(r[0].abs() < 1e-12, "major vertex on ellipse: {}", r[0]);

        // Move the point to the minor vertex (1,4): still on the curve.
        let mut x = p.x0.clone();
        x[0] = 1.0;
        x[1] = 4.0;
        let r = p.residuals(&x);
        assert!(r[0].abs() < 1e-12, "minor vertex on ellipse: {}", r[0]);

        // Move the point to the center: residual -1 (fully inside).
        x[0] = 1.0;
        x[1] = 2.0;
        let r = p.residuals(&x);
        assert!((r[0] + 1.0).abs() < 1e-12, "center inside: {}", r[0]);
    }

    #[test]
    fn rotated_ellipse_point_residual() {
        // Center (0,0), a=2, b=1, rotated 90deg: the major axis points along +y.
        // So (0,2) is the major vertex and lands on the curve.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Ellipse, 2)],
            vec![0.0, 2.0, 0.0, 0.0, 2.0, 1.0, 90.0],
            vec![cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0.clone());
        assert!(r[0].abs() < 1e-12, "rotated major vertex: {}", r[0]);
    }

    #[test]
    fn ellipse_axis_endpoints_resolve_from_params() {
        // Center (1,2), a=4, b=2, theta=0: major axis along +x, minor along +y.
        let inp = input(vec![ent(Kind::Ellipse, 0)], vec![1.0, 2.0, 4.0, 2.0, 0.0], vec![]);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let pt = |sel| p.point(&x, Ref::Entity { index: 0, point: sel });
        assert_eq!(pt(PointSelector::Center), [1.0, 2.0]);
        let maj = pt(PointSelector::Major);
        assert!((maj[0] - 5.0).abs() < 1e-9 && (maj[1] - 2.0).abs() < 1e-9, "major+ {:?}", maj);
        let majn = pt(PointSelector::MajorNeg);
        assert!((majn[0] - (-3.0)).abs() < 1e-9 && (majn[1] - 2.0).abs() < 1e-9, "major- {:?}", majn);
        let min = pt(PointSelector::Minor);
        assert!((min[0] - 1.0).abs() < 1e-9 && (min[1] - 4.0).abs() < 1e-9, "minor+ {:?}", min);
        let minn = pt(PointSelector::MinorNeg);
        assert!((minn[0] - 1.0).abs() < 1e-9 && (minn[1] - 0.0).abs() < 1e-9, "minor- {:?}", minn);

        // Rotated 90deg: major axis now along +y.
        let inp2 = input(vec![ent(Kind::Ellipse, 0)], vec![0.0, 0.0, 4.0, 2.0, 90.0], vec![]);
        let p2 = Problem::new(&inp2);
        let maj2 = p2.point(&p2.x0.clone(), Ref::Entity { index: 0, point: PointSelector::Major });
        assert!((maj2[0]).abs() < 1e-9 && (maj2[1] - 4.0).abs() < 1e-9, "rotated major+ {:?}", maj2);
    }

    #[test]
    fn concentric_ellipse_and_circle_residual() {
        // Ellipse center (1,2), circle center (4,6): concentric residual (-3,-4).
        let inp = input(
            vec![ent(Kind::Ellipse, 0), ent(Kind::Circle, 5)],
            vec![1.0, 2.0, 3.0, 1.0, 0.0, 4.0, 6.0, 2.0],
            vec![cons(
                ConstraintKind::Concentric,
                ab(e_ref(0, PointSelector::Absent), e_ref(1, PointSelector::Absent)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0.clone());
        assert_eq!(r.len(), 2);
        assert!((r[0] - (-3.0)).abs() < 1e-12);
        assert!((r[1] - (-4.0)).abs() < 1e-12);
    }

    #[test]
    fn spline_point_resolves_start_end_midpoint() {
        // Cubic Bezier P1(0,0) P2(0,3) P3(3,3) P4(3,0).
        let inp = input(
            vec![ent(Kind::Spline, 0)],
            vec![0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0],
            vec![],
        );
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let pt = |sel| p.point(&x, Ref::Entity { index: 0, point: sel });
        assert_eq!(pt(PointSelector::Start), [0.0, 0.0]);
        assert_eq!(pt(PointSelector::End), [3.0, 0.0]);
        // C1/C2 resolve to the off-curve control points P2/P3.
        assert_eq!(pt(PointSelector::C1), [0.0, 3.0]);
        assert_eq!(pt(PointSelector::C2), [3.0, 3.0]);
        // B(0.5) = (P1 + 3P2 + 3P3 + P4)/8 = (1.5, 2.25).
        let mid = pt(PointSelector::Center);
        assert!((mid[0] - 1.5).abs() < 1e-9 && (mid[1] - 2.25).abs() < 1e-9, "mid {:?}", mid);
    }

    #[test]
    fn point_on_spline_coincident_residual() {
        // A point sitting exactly on B(0.5)=(1.5,2.25) -> residual ~0.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Spline, 2)],
            vec![1.5, 2.25, 0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0],
            vec![cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0.clone());
        assert_eq!(r.len(), 1);
        assert!(r[0].abs() < 1e-6, "on-curve residual {}", r[0]);

        // Move the point off the curve -> nonzero perpendicular distance.
        let mut x = p.x0.clone();
        x[1] = 0.5;
        let r = p.residuals(&x);
        assert!(r[0].abs() > 1e-3, "off-curve residual {}", r[0]);
    }

    /// Exercise both the analytic point_jac spline arm (point_distance on
    /// start + midpoint, coincident point-point) and the FD fallback branches
    /// (point-on-spline coincident, line-spline tangent) against full FD.
    #[test]
    fn spline_jacobian_matches_finite_difference() {
        use PointSelector::{Absent, Start, Xy, C1, C2};
        use RefRole::{Arc as ArcR, Line as LineR, A, B};

        let entities = vec![
            ent(Kind::Spline, 0), // 0 [0..8]
            ent(Kind::Point, 8),  // 1 [8..10]
            ent(Kind::Line, 10),  // 2 [10..14]
        ];
        let params = vec![
            0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 4.0, 0.0, // spline
            2.0, 1.0, // point
            0.0, 0.0, 1.0, 0.5, // line
        ];
        let constraints = vec![
            cons_v(ConstraintKind::PointDistance, vec![(A, e_ref(0, Start)), (B, e_ref(1, Xy))], 2.0),
            cons_v(ConstraintKind::PointDistance, vec![(A, e_ref(0, Absent)), (B, e_ref(1, Xy))], 1.0),
            // C1/C2 control-point selectors through the analytic point_jac.
            cons_v(ConstraintKind::PointDistance, vec![(A, e_ref(0, C1)), (B, e_ref(1, Xy))], 1.5),
            cons(ConstraintKind::Coincident, vec![(A, e_ref(0, C2)), (B, e_ref(1, Xy))]),
            cons(ConstraintKind::Coincident, vec![(A, e_ref(0, Start)), (B, e_ref(1, Xy))]),
            cons(ConstraintKind::Coincident, vec![(A, e_ref(1, Xy)), (B, e_ref(0, Absent))]),
            cons(ConstraintKind::Tangent, vec![(LineR, e_ref(2, Absent)), (ArcR, e_ref(0, Start))]),
        ];
        let inp = input(entities, params, constraints);
        let p = Problem::new(&inp);
        let x: Vec<f64> = inp
            .params_initial
            .iter()
            .enumerate()
            .map(|(i, &v)| v as f64 + 0.21 * ((i as f64) * 1.7).sin())
            .collect();
        let n = x.len();

        let analytic = p.jacobian(&x, n);
        let residual_fn = |xx: &[f64]| p.residuals(xx);
        let m = residual_fn(&x).len();
        let fd = crate::lm::fd_jacobian(&residual_fn, &x, m);
        for r in 0..m {
            for col in 0..n {
                let diff = (analytic[(r, col)] - fd[(r, col)]).abs();
                assert!(
                    diff < 1e-4,
                    "row {r} col {col}: analytic={} fd={} (diff {diff})",
                    analytic[(r, col)],
                    fd[(r, col)],
                );
            }
        }
    }

    #[test]
    fn pinned_mask_and_equality_pins_add_rows() {
        let mut inp = input(vec![ent(Kind::Point, 0)], vec![3.0, 7.0], vec![]);
        inp.pinned_mask = vec![0b01]; // pin param 0 to its initial (3.0)
        inp.equality_pins = vec![EqualityPin {
            param_index: 1,
            target: 5.0,
        }];
        let p = Problem::new(&inp);
        let r = p.residuals(&[3.0, 9.0]);
        // pin row: x[0]-x0[0] = 3-3 = 0 ; equality row: x[1]-target = 9-5 = 4
        assert_eq!(r.len(), 2);
        assert!((r[0]).abs() < 1e-12);
        assert!((r[1] - 4.0).abs() < 1e-12);
    }

    fn e_ref(index: u32, point: PointSelector) -> Ref {
        Ref::Entity { index, point }
    }

    /// A parallel constraint between non-line entities (hand-edited or legacy
    /// docs; the UI refuses to author them) must contribute zero rows in both
    /// the residual and the Jacobian: a circle operand would otherwise read
    /// out of bounds (3-param block) and an arc operand would steer toward a
    /// garbage direction built from its radius and angles.
    #[test]
    fn parallel_skips_non_line_entities() {
        let abs = PointSelector::Absent;
        let entities = vec![
            ent(Kind::Circle, 0), // C1 [0..3]
            ent(Kind::Arc, 3),    // A1 [3..8]
            ent(Kind::Arc, 8),    // A2 [8..13]
            ent(Kind::Line, 13),  // L1 [13..17]
            ent(Kind::Line, 17),  // L2 [17..21]
        ];
        let params = vec![
            1.0, 2.0, 0.5, // C1
            0.0, 0.0, 2.0, 10.0, 80.0, // A1
            5.0, 5.0, 1.0, 200.0, 300.0, // A2
            0.0, 0.0, 3.0, 1.0, // L1
            1.0, 2.0, 4.0, 5.0, // L2
        ];
        let constraints = vec![
            cons(ConstraintKind::Parallel, ab(e_ref(0, abs), e_ref(1, abs))), // circle/arc
            cons(ConstraintKind::Parallel, ab(e_ref(1, abs), e_ref(2, abs))), // arc/arc
            cons(ConstraintKind::Parallel, ab(e_ref(0, abs), e_ref(3, abs))), // circle/line
            cons(ConstraintKind::Parallel, ab(e_ref(3, abs), e_ref(4, abs))), // line/line
        ];
        let inp = input(entities, params, constraints);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        // Only the line/line pairing contributes a row; the rest are skipped.
        let r = p.residuals(&x);
        assert_eq!(r.len(), 1);
        let j = p.jacobian(&x, n);
        assert_eq!(j.nrows(), 1);
    }

    /// Equal between two circles compares radii, and tangent between two circles
    /// drives the centers apart by rA+rB (external) or |rA-rB| (internal). Both
    /// used to misread a circle's 3-param block as a line and produce garbage;
    /// now they have proper curve/curve residuals.
    #[test]
    fn equal_radius_and_circle_tangent() {
        let abs = PointSelector::Absent;
        // C1 center (0,0) r=2; C2 center (10,0) r=3.
        let make = || vec![ent(Kind::Circle, 0), ent(Kind::Circle, 3)];
        let params = || vec![0.0, 0.0, 2.0, 10.0, 0.0, 3.0];

        // Equal radius: residual = rA - rB = 2 - 3 = -1, and the analytic
        // Jacobian agrees with finite differences.
        {
            let cons_eq = cons(ConstraintKind::EqualLength, ab(e_ref(0, abs), e_ref(1, abs)));
            let inp = input(make(), params(), vec![cons_eq]);
            let p = Problem::new(&inp);
            let x = p.x0.clone();
            let n = x.len();
            let r = p.residuals(&x);
            assert_eq!(r.len(), 1);
            assert!((r[0] - (2.0 - 3.0)).abs() < 1e-12, "equal radius: {}", r[0]);
            let analytic = p.jacobian(&x, n);
            let fd = crate::lm::fd_jacobian(&|xx: &[f64]| p.residuals(xx), &x, 1);
            for col in 0..n {
                assert!(
                    (analytic[(0, col)] - fd[(0, col)]).abs() < 1e-5,
                    "equal jac col {col}: analytic={} fd={}",
                    analytic[(0, col)],
                    fd[(0, col)],
                );
            }
        }

        // Tangent: d=10, rA+rB=5, |rA-rB|=1. External (10-5=5) is nearer than
        // internal (10-1=9), so the residual is the external one.
        {
            let cons_tan = cons(ConstraintKind::Tangent, ab(e_ref(0, abs), e_ref(1, abs)));
            let inp = input(make(), params(), vec![cons_tan]);
            let p = Problem::new(&inp);
            let r = p.residuals(&p.x0.clone());
            assert_eq!(r.len(), 1);
            assert!((r[0] - 5.0).abs() < 1e-12, "circle tangent: {}", r[0]);
        }
    }

    fn cons(kind: ConstraintKind, refs: Vec<(RefRole, Ref)>) -> Constraint {
        Constraint {
            kind_code: kind.to_u8(),
            refs,
            ..Default::default()
        }
    }

    fn cons_v(kind: ConstraintKind, refs: Vec<(RefRole, Ref)>, value: f64) -> Constraint {
        Constraint {
            kind_code: kind.to_u8(),
            refs,
            value: Some(value),
            ..Default::default()
        }
    }

    /// Cover every constraint kind (and both coincident analytic + fallback
    /// branches, plus the arc point_jac) in one problem, then assert the
    /// analytic Jacobian matches a full finite-difference Jacobian everywhere.
    /// FD is the trusted oracle (it is what shadow-mode parity validated against
    /// Python), so this gate catches any hand-derivative mistake.
    #[test]
    fn analytic_jacobian_matches_finite_difference() {
        use PointSelector::{Absent, Center, End, Major, Minor, Start, Xy};
        use RefRole::{Arc as ArcR, Line as LineR, Point as PointR, A, B, Target};

        let entities = vec![
            ent(Kind::Line, 0),   // 0  L1 [0..4]
            ent(Kind::Line, 4),   // 1  L2 [4..8]
            ent(Kind::Circle, 8), // 2  C1 [8..11]
            ent(Kind::Arc, 11),   // 3  A1 [11..16]
            ent(Kind::Point, 16), // 4  P1 [16..18]
            ent(Kind::Point, 18), // 5  P2 [18..20]
            ent(Kind::Ellipse, 20), // 6  E1 [20..25]
        ];
        let params = vec![
            0.0, 0.0, 3.0, 1.0, // L1
            1.0, 2.0, 4.0, 5.0, // L2
            2.0, 3.0, 2.5, // C1
            1.0, 1.0, 2.0, 30.0, 120.0, // A1
            5.0, 6.0, // P1
            7.0, 2.0, // P2
            2.5, 3.5, 4.0, 2.0, 25.0, // E1 (cx, cy, a, b, theta_deg)
        ];

        let constraints = vec![
            cons(ConstraintKind::Horizontal, vec![(Target, e_ref(0, Absent))]),
            cons(ConstraintKind::Horizontal, vec![(A, e_ref(0, Start)), (B, e_ref(4, End))]),
            cons(ConstraintKind::Vertical, vec![(Target, e_ref(1, Absent))]),
            cons_v(ConstraintKind::Length, vec![(Target, e_ref(0, Absent))], 5.0),
            cons_v(ConstraintKind::Radius, vec![(Target, e_ref(2, Absent))], 4.0),
            cons_v(ConstraintKind::Diameter, vec![(Target, e_ref(2, Absent))], 8.0),
            cons(ConstraintKind::Parallel, vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))]),
            cons(ConstraintKind::Concentric, vec![(A, e_ref(2, Absent)), (B, e_ref(3, Absent))]),
            cons(ConstraintKind::EqualLength, vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))]),
            cons_v(ConstraintKind::PointDistance, vec![(A, e_ref(4, Xy)), (B, e_ref(5, Xy))], 3.0),
            // coincident: analytic point-point (incl. arc endpoint point_jac)
            cons(ConstraintKind::Coincident, vec![(A, e_ref(4, Xy)), (B, e_ref(5, Xy))]),
            cons(ConstraintKind::Coincident, vec![(A, e_ref(3, Start)), (B, e_ref(5, Xy))]),
            // coincident fallback branches
            cons(ConstraintKind::Coincident, vec![(A, e_ref(4, Xy)), (B, e_ref(1, Absent))]),
            cons(ConstraintKind::Coincident, vec![(A, e_ref(4, Xy)), (B, e_ref(2, Absent))]),
            cons(ConstraintKind::Coincident, vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))]),
            // point-on-ellipse (FD fallback branch) and concentric ellipse+circle
            cons(ConstraintKind::Coincident, vec![(A, e_ref(5, Xy)), (B, e_ref(6, Absent))]),
            cons(ConstraintKind::Concentric, vec![(A, e_ref(6, Absent)), (B, e_ref(2, Absent))]),
            // ellipse axis-endpoint point_distance (exercises the endpoint point_jac)
            cons_v(ConstraintKind::PointDistance, vec![(A, e_ref(6, Center)), (B, e_ref(6, Major))], 4.0),
            cons_v(ConstraintKind::PointDistance, vec![(A, e_ref(6, Center)), (B, e_ref(6, Minor))], 2.0),
            // direction-normalizing / atan2 fallbacks
            cons(ConstraintKind::Normal, vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))]),
            cons_v(ConstraintKind::Angle, vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))], 30.0),
            cons(ConstraintKind::Tangent, vec![(LineR, e_ref(0, Absent)), (ArcR, e_ref(2, Absent))]),
            cons(ConstraintKind::Tangent, vec![(LineR, e_ref(0, Absent)), (ArcR, e_ref(3, Start))]),
            cons(ConstraintKind::Midpoint, vec![(LineR, e_ref(0, Absent)), (PointR, e_ref(4, Xy))]),
            cons_v(ConstraintKind::LineDistance, vec![(A, e_ref(0, Absent)), (B, e_ref(5, Xy))], 1.0),
            // fixed: explicit-xy point, point+xy, and full-entity
            Constraint {
                kind_code: ConstraintKind::Fixed.to_u8(),
                refs: vec![(Target, e_ref(4, Absent))],
                xy: Some((1.0, 1.0)),
                ..Default::default()
            },
            Constraint {
                kind_code: ConstraintKind::Fixed.to_u8(),
                refs: vec![(Target, e_ref(0, Start))],
                xy: Some((0.0, 0.0)),
                ..Default::default()
            },
            cons(ConstraintKind::Fixed, vec![(Target, e_ref(1, Absent))]),
            // arc center selector through fixed (exercises Center point_jac)
            Constraint {
                kind_code: ConstraintKind::Fixed.to_u8(),
                refs: vec![(Target, e_ref(3, Center))],
                xy: Some((1.0, 1.0)),
                ..Default::default()
            },
        ];

        let mut inp = input(entities, params, constraints);
        inp.pinned_mask = vec![0b0000_0010]; // pin param 1
        inp.equality_pins = vec![EqualityPin {
            param_index: 9,
            target: 2.0,
        }];

        let p = Problem::new(&inp);
        // Evaluate away from the seed so derivatives are exercised at a generic point.
        let x: Vec<f64> = inp
            .params_initial
            .iter()
            .enumerate()
            .map(|(i, &v)| v as f64 + 0.37 * ((i as f64) * 1.3).sin())
            .collect();
        let n = x.len();

        let analytic = p.jacobian(&x, n);
        let residual_fn = |xx: &[f64]| p.residuals(xx);
        let m = residual_fn(&x).len();
        let fd = crate::lm::fd_jacobian(&residual_fn, &x, m);

        assert_eq!(analytic.nrows(), m);
        assert_eq!(fd.nrows(), m);
        for r in 0..m {
            for col in 0..n {
                let diff = (analytic[(r, col)] - fd[(r, col)]).abs();
                assert!(
                    diff < 1e-4,
                    "row {r} col {col}: analytic={} fd={} (diff {diff})",
                    analytic[(r, col)],
                    fd[(r, col)],
                );
            }
        }
    }
}
