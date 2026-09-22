//! Constraint residual builders.
//!
//! `Problem` precomputes the per-solve invariants (entity kinds/offsets, the
//! initial param vector `x0`, the line-circle coincident map) once, then
//! `residuals(x)` evaluates the stacked residual vector for a candidate `x`.
//! Computation is in `f64`; the wire format's `f32` is widened on decode and
//! narrowed only at output.
//!
//! `pinned_mask` and `equality_pins` are lowered to extra residual rows here
//! (one `x[i] - target` row each), which is exactly what `_residual_fixed`
//! produces for a full-entity / explicit-target pin. The crate therefore treats
//! them identically to a `fixed` constraint for solve, rank, and status.

use crate::constraints::{Axis, Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use solver_core::sparse::SparseRow;
use crate::{Entity, Input, Kind, DEG2RAD, MIN_SEMI_AXIS_SQ};
use nalgebra::DMatrix;
use std::collections::HashMap;

/// A point in sketch-plane coordinates.
type P2 = [f64; 2];

/// A circle or arc: both store their radius at param index 2, so constraints
/// like equal-radius and circle/circle tangency treat them interchangeably.
fn is_curve(k: Kind) -> bool {
    matches!(k, Kind::Circle | Kind::Arc)
}

/// Kind behind an entity ref; `None` for external refs, which carry their own
/// coordinates and read nothing from the local param buffer.
fn ref_kind(input: &Input, r: &Ref) -> Option<Kind> {
    match r {
        Ref::Entity { index, .. } => input.entities.get(*index as usize).map(|e| e.kind),
        Ref::External { .. } => None,
    }
}

/// True when a ref supplies at least `slots` local params. External refs
/// trivially do (nothing local is read); absent optional roles never reach
/// this helper (callers default them to eligible).
fn ref_supplies_slots(input: &Input, r: &Ref, slots: usize) -> bool {
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
/// inside, positive outside. Mirrors the formula in `feature/ellipse-entity.md`.
fn ellipse_point_residual(p: P2, ep: &[f64]) -> f64 {
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
    /// Only the constraints whose every entity reference is addressable (see
    /// `Input::entity_params_in_range`) and whose operand kinds supply the
    /// param slots their builder reads (see `operand_kinds_supply_slots`).
    /// Dropped at build time so no residual row can index off the end.
    constraints: Vec<&'a Constraint>,
    pinned_indices: Vec<usize>,
    equality_pins: Vec<(usize, f64)>,
    /// (line_index, curve_index) -> which line endpoint is pinned to the
    /// curve (circle or arc). An arc tangent uses the same pinned-foot path as
    /// a circle once the coincident is known.
    line_circle_coincident: HashMap<(u32, u32), PointSelector>,
}

impl<'a> Problem<'a> {
    pub fn new(input: &'a Input) -> Self {
        let x0: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();

        let pinned_indices: Vec<usize> =
            (0..x0.len()).filter(|&i| input.is_pinned(i)).collect();
        // A pin naming a param the buffer does not have is stale in exactly the
        // same way a stale entity ref is; its row would index off the end of x.
        let equality_pins: Vec<(usize, f64)> = input
            .equality_pins
            .iter()
            .map(|p| (p.param_index as usize, p.target as f64))
            .filter(|&(i, _)| i < x0.len())
            .collect();

        // The wire carries indices the crate never issued, so a stale or
        // corrupt entity ref reaches us as a plain in-range-looking integer.
        // Constraints that name one are dropped whole: a half-evaluated
        // constraint is worse than an absent one, and the missing-role path
        // already establishes "drop, do not panic" as the contract.
        let constraints: Vec<&Constraint> = input
            .constraints
            .iter()
            .filter(|c| {
                c.refs.iter().all(|(_, r)| match r {
                    Ref::Entity { index, .. } => input.entity_params_in_range(*index as usize),
                    Ref::External { .. } => true,
                })
            })
            // Same contract one level up: an operand whose KIND has no param at
            // a slot its builder reads (a Length on a Point target) would also
            // panic the worker mid-solve, so it is dropped whole here rather
            // than guarded ad hoc per builder.
            .filter(|c| Self::operand_kinds_supply_slots(input, c))
            .collect();

        let mut line_circle_coincident = HashMap::new();
        for c in &constraints {
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
                // a is a line with an explicit point; b is a curve without one.
                if a_pt.is_present()
                    && input.entities.get(a_idx as usize).map(|e| e.kind) == Some(Kind::Line)
                    && is_curve(input.entities.get(b_idx as usize).map(|e| e.kind).unwrap_or(Kind::Point))
                    && !b_pt.is_present()
                {
                    let sel = if a_pt == PointSelector::End {
                        PointSelector::End
                    } else {
                        PointSelector::Start
                    };
                    line_circle_coincident.insert((a_idx, b_idx), sel);
                }
                // Symmetric: b is a line with an explicit point; a is a curve without one.
                if b_pt.is_present()
                    && input.entities.get(b_idx as usize).map(|e| e.kind) == Some(Kind::Line)
                    && is_curve(input.entities.get(a_idx as usize).map(|e| e.kind).unwrap_or(Kind::Point))
                    && !a_pt.is_present()
                {
                    let sel = if b_pt == PointSelector::End {
                        PointSelector::End
                    } else {
                        PointSelector::Start
                    };
                    line_circle_coincident.insert((b_idx, a_idx), sel);
                }
            }
        }

        Problem {
            entities: &input.entities,
            x0,
            constraints,
            pinned_indices,
            equality_pins,
            line_circle_coincident,
        }
    }

    /// Kind-aware counterpart to the range filter above. A well-formed
    /// constraint can still name an operand whose kind has no param at a slot
    /// its builder indexes (a Length targeting a Point, say); `decode_input`
    /// accepts such payloads verbatim from postMessage, and one slice-index
    /// panic kills the whole worker. The constraint is dropped whole, exactly
    /// like a stale reference, so residual and Jacobian row counts (analytic
    /// and finite-difference alike) stay consistent automatically: both are
    /// computed from this filtered list only. Slot requirements are
    /// transcribed from each `r_*` builder; eligible kinds keep their exact
    /// previous behavior.
    fn operand_kinds_supply_slots(input: &Input, c: &Constraint) -> bool {
        let Some(kind) = c.kind() else { return true };
        // Absent optional roles default to eligible: their builders already
        // contribute no rows for them.
        let supplies = |role: RefRole, slots: usize| {
            c.ref_for(role)
                .is_none_or(|r| ref_supplies_slots(input, &r, slots))
        };
        match kind {
            ConstraintKind::Horizontal | ConstraintKind::Vertical => {
                // The a/b form compares points resolved through `point()` for
                // every kind; only the bare-entity form reads endpoints
                // straight out of the param block.
                if c.ref_for(RefRole::A).is_some() && c.ref_for(RefRole::B).is_some() {
                    true
                } else {
                    supplies(RefRole::Target, 4)
                }
            }
            ConstraintKind::Length => supplies(RefRole::Target, 4),
            ConstraintKind::Radius | ConstraintKind::Diameter => supplies(RefRole::Target, 3),
            ConstraintKind::LineDistance => supplies(RefRole::A, 4),
            ConstraintKind::Angle => supplies(RefRole::A, 4) && supplies(RefRole::B, 4),
            ConstraintKind::Midpoint => supplies(RefRole::Line, 4),
            ConstraintKind::Tangent => {
                // Reproduce the builder's operand pairing: explicit line/arc
                // roles win, otherwise the A/B pair ordered line-kind-first.
                let pair = match (c.ref_for(RefRole::Line), c.ref_for(RefRole::Arc)) {
                    (Some(lr), Some(ar)) => Some((lr, ar)),
                    _ => match (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) {
                        (Some(a), Some(b)) if ref_kind(input, &a) != Some(Kind::Line) => {
                            Some((b, a))
                        }
                        (Some(a), Some(b)) => Some((a, b)),
                        _ => None,
                    },
                };
                match pair {
                    // A leading line takes the endpoint-tangency paths, which
                    // gate the second operand's kind themselves and never
                    // index past it.
                    Some((lr, _)) if ref_kind(input, &lr) == Some(Kind::Line) => true,
                    // Otherwise both operands feed the centers/radii curve
                    // branch, which reads each radius at slot 2.
                    Some((lr, ar)) => {
                        ref_supplies_slots(input, &lr, 3) && ref_supplies_slots(input, &ar, 3)
                    }
                    None => true,
                }
            }
            ConstraintKind::Normal => {
                let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
                    return true;
                };
                let (ka, kb) = (ref_kind(input, &a), ref_kind(input, &b));
                if ka == Some(Kind::Line) && kb == Some(Kind::Line) {
                    return true;
                }
                // Mirror the builder's split: whichever operand plays the curve
                // supplies the contact normal, center-only for a circle but
                // from the start/end angle params for every other kind.
                let (line_ref, arc_ref) = if ka == Some(Kind::Line) { (&a, &b) } else { (&b, &a) };
                let arc_ok = match ref_kind(input, arc_ref) {
                    None | Some(Kind::Circle) => true,
                    _ => ref_supplies_slots(input, arc_ref, 5),
                };
                arc_ok && ref_supplies_slots(input, line_ref, 4)
            }
            // Parallel, equal-length and radius-difference gate their own
            // kinds in their builders; coincident and the point-distance
            // family resolve all operands through `point()` and are safe for
            // every kind.
            _ => true,
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

    /// Resolve a reference to a 2D point.
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

    /// Unit radius direction at a contact point. Both circles and arcs measure
    /// the radial from the centre to the ACTUAL contact: an arc's start/end
    /// angle params describe its own endpoints, not wherever a pinned line foot
    /// happens to sit, so keying the direction off them ignored the contact.
    fn radius_dir(&self, x: &[f64], arc_index: u32, arc_point: PointSelector, contact: P2) -> P2 {
        let ep = self.params(x, arc_index);
        let rv = [contact[0] - ep[0], contact[1] - ep[1]];
        let rn = (rv[0] * rv[0] + rv[1] * rv[1]).sqrt();
        if rn > 1e-10 {
            return [rv[0] / rn, rv[1] / rn];
        }
        // Degenerate fallback: the contact collapsed onto the centre. An arc
        // can still name a parametric radial from its endpoint angles; a
        // circle has no such params and degrades to a zero-direction row.
        if self.kind_of(arc_index) == Kind::Arc {
            let a_deg = if arc_point == PointSelector::End {
                ep[4]
            } else {
                ep[3]
            };
            let a = a_deg.to_radians();
            return [a.cos(), a.sin()];
        }
        [0.0, 0.0]
    }

    /// Evaluate the full stacked residual vector for `x`: every constraint's
    /// rows in order, then the pinned-mask rows, then the equality-pin rows.
    pub fn residuals(&self, x: &[f64]) -> Vec<f64> {
        let mut r: Vec<f64> = Vec::new();
        for c in &self.constraints {
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
    /// local entity) contribute no rows: they are dropped before solve.
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
        ConstraintKind::PointDistanceX => self.r_point_distance_axis(c, x, r, 0),
        ConstraintKind::PointDistanceY => self.r_point_distance_axis(c, x, r, 1),
            ConstraintKind::Midpoint => self.r_midpoint(c, x, r),
            ConstraintKind::Concentric => self.r_concentric(c, x, r),
            ConstraintKind::Fixed => self.r_fixed(c, x, r),
            ConstraintKind::RadiusDifference => self.r_radius_difference(c, x, r),
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
        // The perpendicular offset is already signed (the normal direction picks
        // a side). The orientation sign selects which side `value` targets;
        // absent, it defaults to +1, reproducing the legacy signed residual.
        let proj = vx * nx + vy * ny;
        r.push(proj - c.sign.unwrap_or(1.0) * value);
    }

    /// True when the ref denotes a single point: an external reference, an
    /// entity with an explicit point selector, or a Point-kind entity.
    fn ref_is_point(&self, r: &Ref) -> bool {
        match r {
            Ref::External { .. } => true,
            Ref::Entity { point, index } => point.is_present() || self.kind_of(*index) == Kind::Point,
        }
    }

    /// Residual for a point lying on an entity (line/circle/arc/ellipse/spline).
    /// Used symmetrically regardless of whether the point is the A or B ref.
    fn r_point_on_entity(&self, x: &[f64], point: Ref, entity_index: u32, entity_kind: Kind, r: &mut Vec<f64>) {
        let pa = self.point(x, point);
        let ep = self.params(x, entity_index);
        match entity_kind {
            Kind::Line => {
                let (dx, dy) = (ep[2] - ep[0], ep[3] - ep[1]);
                let n = (dx * dx + dy * dy).sqrt();
                let (nx, ny) = if n > 0.0 { (-dy / n, dx / n) } else { (0.0, 1.0) };
                r.push((pa[0] - ep[0]) * nx + (pa[1] - ep[1]) * ny);
            }
            Kind::Circle | Kind::Arc => {
                let dist = ((pa[0] - ep[0]).powi(2) + (pa[1] - ep[1]).powi(2)).sqrt();
                r.push(dist - ep[2]);
            }
            Kind::Ellipse => r.push(ellipse_point_residual(pa, ep)),
            Kind::Spline => r.push(spline_point_residual(pa, ep)),
            _ => {}
        }
    }

    fn r_coincident(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(a_ref), Some(b_ref)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
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
        let a_index = match a_ref {
            Ref::Entity { index, .. } => Some(index),
            _ => None,
        };

        if !self.ref_is_point(&a_ref)
            && !self.ref_is_point(&b_ref)
            && a_kind == Some(Kind::Line)
            && b_kind == Some(Kind::Line)
        {
            let a_idx = match a_ref {
                Ref::Entity { index, .. } => index,
                _ => return,
            };
            let ea = self.params(x, a_idx);
            let eb = self.params(x, b_index.unwrap());
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
        } else if !self.ref_is_point(&b_ref) && b_kind == Some(Kind::Line) {
            self.r_point_on_entity(x, a_ref, b_index.unwrap(), Kind::Line, r);
        } else if !self.ref_is_point(&b_ref)
            && (b_kind == Some(Kind::Circle) || b_kind == Some(Kind::Arc))
        {
            self.r_point_on_entity(x, a_ref, b_index.unwrap(), b_kind.unwrap(), r);
        } else if !self.ref_is_point(&b_ref) && b_kind == Some(Kind::Ellipse) {
            self.r_point_on_entity(x, a_ref, b_index.unwrap(), Kind::Ellipse, r);
        } else if !self.ref_is_point(&b_ref) && b_kind == Some(Kind::Spline) {
            self.r_point_on_entity(x, a_ref, b_index.unwrap(), Kind::Spline, r);
        } else if !self.ref_is_point(&a_ref) && a_kind == Some(Kind::Line) && self.ref_is_point(&b_ref) {
            self.r_point_on_entity(x, b_ref, a_index.unwrap(), Kind::Line, r);
        } else if !self.ref_is_point(&a_ref)
            && (a_kind == Some(Kind::Circle) || a_kind == Some(Kind::Arc))
            && self.ref_is_point(&b_ref)
        {
            self.r_point_on_entity(x, b_ref, a_index.unwrap(), a_kind.unwrap(), r);
        } else if !self.ref_is_point(&a_ref) && a_kind == Some(Kind::Ellipse) && self.ref_is_point(&b_ref) {
            self.r_point_on_entity(x, b_ref, a_index.unwrap(), Kind::Ellipse, r);
        } else if !self.ref_is_point(&a_ref) && a_kind == Some(Kind::Spline) && self.ref_is_point(&b_ref) {
            self.r_point_on_entity(x, b_ref, a_index.unwrap(), Kind::Spline, r);
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
        // Without an orientation sign the unsigned angle in [0, 180] is matched,
        // so the two mirror configurations (line B turned +theta or -theta from
        // line A) both satisfy it. With a sign the *signed* angle in (-180, 180]
        // is matched against `sign * value`, pinning the handedness while the
        // user-facing value stays non-negative.
        match c.sign {
            Some(s) => r.push(cross.atan2(dot) - s * value.to_radians()),
            None => r.push(cross.abs().atan2(dot) - value.to_radians()),
        }
    }

    fn r_tangent(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (line_ref, arc_ref) =
            if let (Some(lr), Some(ar)) = (c.ref_for(RefRole::Line), c.ref_for(RefRole::Arc)) {
                (lr, ar)
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
        let line_ep = self.params(x, line_idx);
        let arc_ep = self.params(x, arc_idx);
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
        } else if matches!(self.kind_of(arc_idx), Kind::Circle | Kind::Arc) {
            // Line tangent to a circle or arc (identical math: an arc reuses its
            // underlying circle). If a coincident maps a line endpoint to the
            // curve, the contact is pinned and we measure perpendicularity of the
            // line direction against the radial direction at that endpoint.
            // Otherwise the line body is tangent to the circle: perpendicular
            // distance from the centre to the infinite line equals the radius.
            if let Some(&pinned_pt) = self.line_circle_coincident.get(&(line_idx, arc_idx)) {
                // Contact is whichever line endpoint the coincident constraint
                // pinned onto the curve. Resolving through `point()` with the
                // stored selector (not a hand-inverted copy of it) keeps this
                // honest for both pin sides: reading the opposite foot measured
                // tangency at a point the constraints never tied down, and a
                // correctly-tangent sketch read ~-0.9 instead of 0.
                let contact = self.point(x, Ref::Entity { index: line_idx, point: pinned_pt });
                let rd = self.radius_dir(x, arc_idx, arc_pt, contact);
                r.push(line_dir[0] * rd[0] + line_dir[1] * rd[1]);
            } else {
                let (cx, cy) = (arc_ep[0], arc_ep[1]);
                let num = (cx - line_ep[0]) * line_dir[1]
                    - (cy - line_ep[1]) * line_dir[0];
                r.push(num.abs() - arc_ep[2]);
            }
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

    /// Dimension between two circles/arcs (typically concentric): the gap
    /// |rA - rB| equals the target value. Absolute so it is independent of which
    /// operand was selected first, and the dimension value the user types is the
    /// positive radial gap. The Jacobian uses the finite-difference fallback.
    fn r_radius_difference(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (
            Some(Ref::Entity { index: a_idx, .. }),
            Some(Ref::Entity { index: b_idx, .. }),
            Some(value),
        ) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value)
        else {
            return;
        };
        if !is_curve(self.kind_of(a_idx)) || !is_curve(self.kind_of(b_idx)) {
            return;
        }
        let ra = self.params(x, a_idx)[2];
        let rb = self.params(x, b_idx)[2];
        r.push((ra - rb).abs() - value);
    }

    /// Resolve the A/B point pair and target value shared by the point-distance
    /// constraints. `None` when any ref or the value is absent.
    fn point_pair_value(&self, c: &Constraint, x: &[f64]) -> Option<(P2, P2, f64)> {
        let (a, b, value) = (c.ref_for(RefRole::A)?, c.ref_for(RefRole::B)?, c.value?);
        Some((self.point(x, a), self.point(x, b), value))
    }

    fn r_point_distance(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some((pa, pb, value)) = self.point_pair_value(c, x) else {
            return;
        };
        let dist = ((pb[0] - pa[0]).powi(2) + (pb[1] - pa[1]).powi(2)).sqrt();
        r.push(dist - value);
    }

    fn r_point_distance_axis(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>, axis: usize) {
        let Some((pa, pb, value)) = self.point_pair_value(c, x) else {
            return;
        };
        let d = pb[axis] - pa[axis];
        match c.sign {
            Some(s) => r.push(d - s * value),
            None => r.push(d.abs() - value),
        }
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

    /// Dense rows of the full stacked Jacobian: one row per residual (constraint
    /// rows from `jac_one`) followed by the pin and equality-pin rows. Shared by
    /// both the dense and sparse Jacobian builders.
    fn jacobian_rows(&self, x: &[f64], n: usize) -> Vec<Vec<f64>> {
        let mut rows: Vec<Vec<f64>> = Vec::new();
        for c in &self.constraints {
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
        rows
    }

    /// Jacobian of the full stacked residual at `x` (m rows x `n` params).
    pub fn jacobian(&self, x: &[f64], n: usize) -> DMatrix<f64> {
        let rows = self.jacobian_rows(x, n);
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
        self.jacobian_rows(x, n)
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
        let mut seen = std::collections::HashSet::new();
        for (_, rf) in &c.refs {
            if let Ref::Entity { index, .. } = rf {
                let off = self.offset_of(*index);
                let size = self.kind_of(*index).param_count();
                for i in 0..size {
                    seen.insert(off + i);
                }
            }
        }
        let mut idxs: Vec<usize> = seen.into_iter().collect();
        idxs.sort();
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
            | ConstraintKind::Midpoint
            | ConstraintKind::RadiusDifference
            | ConstraintKind::PointDistanceX
            | ConstraintKind::PointDistanceY => rows.extend(self.fd_constraint_rows(c, x, n)),
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
        let ea = self.params(x, ai);
        let eb = self.params(x, bi);
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
        let ea = self.params(x, ai);
        let eb = self.params(x, bi);
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
        let a_kind = match a_ref {
            Ref::Entity { index, .. } => Some(self.kind_of(index)),
            _ => None,
        };
        let b_kind = match b_ref {
            Ref::Entity { index, .. } => Some(self.kind_of(index)),
            _ => None,
        };
        !(
            // curve-curve: both are non-point entities of recognized curve kind
            (!self.ref_is_point(&a_ref) && !self.ref_is_point(&b_ref)
                && a_kind == Some(Kind::Line) && b_kind == Some(Kind::Line))
            // point-on-curve: B is a curve, A is a point
            || (!self.ref_is_point(&b_ref)
                && (b_kind == Some(Kind::Line)
                    || b_kind == Some(Kind::Circle) || b_kind == Some(Kind::Arc)
                    || b_kind == Some(Kind::Ellipse) || b_kind == Some(Kind::Spline)))
            // point-on-curve (reversed): A is a curve, B is a point
            || (!self.ref_is_point(&a_ref) && self.ref_is_point(&b_ref)
                && (a_kind == Some(Kind::Line)
                    || a_kind == Some(Kind::Circle) || a_kind == Some(Kind::Arc)
                    || a_kind == Some(Kind::Ellipse) || a_kind == Some(Kind::Spline)))
        )
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
    use crate::test_util::*;
    use crate::{ConstraintKind, EqualityPin, Options, Status, solve_sketch};

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
        let r = p.residuals(&p.x0);
        assert!((r[0] - 1.0).abs() < 1e-12, "horizontal: {}", r[0]);
        assert!((r[1] - (101.0_f64.sqrt() - 10.0)).abs() < 1e-12, "length: {}", r[1]);
    }

    #[test]
    fn constraint_with_out_of_range_entity_ref_is_dropped() {
        // A stale index the host never revoked: index 3 with one entity. The
        // constraint contributes no rows instead of panicking the Worker.
        let inp = input(
            vec![ent(Kind::Line, 0)],
            vec![0.0, 0.0, 10.0, 1.0],
            vec![
                cons(ConstraintKind::Horizontal, vec![target(0, PointSelector::Absent)]),
                cons(ConstraintKind::Horizontal, vec![target(3, PointSelector::Absent)]),
            ],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1, "only the addressable constraint contributes a row");
        assert!((r[0] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn constraint_on_entity_whose_params_overrun_the_buffer_is_dropped() {
        // The index resolves but the entity's 4 line params run past the 3-param
        // buffer: the params slice would panic, so the constraint goes too.
        let inp = input(
            vec![ent(Kind::Line, 0)],
            vec![0.0, 0.0, 10.0],
            vec![cons(ConstraintKind::Horizontal, vec![target(0, PointSelector::Absent)])],
        );
        let p = Problem::new(&inp);
        assert!(p.residuals(&p.x0).is_empty());
    }

    /// A well-formed but wrong-kind operand reaches the worker verbatim from
    /// postMessage (decode_input does not kind-check). Each payload below made
    /// its builder index past a short param block before the centralized
    /// eligibility filter existed; each must now be dropped whole: no residual
    /// rows and, because both analytic and finite-difference Jacobians are
    /// built from the same filtered list, no Jacobian rows either.
    #[test]
    fn constraints_whose_operand_kind_lacks_the_read_slots_are_dropped() {
        use RefRole::{Arc as ArcR, Line as LineR};
        let absent = PointSelector::Absent;
        // Shared fixture: point P0 [0..2], circle C1 [2..5], line L2 [5..9].
        let entities = || {
            vec![
                ent(Kind::Point, 0),
                ent(Kind::Circle, 2),
                ent(Kind::Line, 5),
            ]
        };
        let params = || vec![1.0, 2.0, 5.0, 5.0, 1.0, 0.0, 0.0, 4.0, 0.0];
        let payloads: Vec<(&str, Constraint)> = vec![
            (
                "horizontal target point",
                cons(ConstraintKind::Horizontal, vec![target(0, absent)]),
            ),
            (
                "length target point",
                cons_v(ConstraintKind::Length, vec![target(0, absent)], 3.0),
            ),
            (
                "radius target point",
                cons_v(ConstraintKind::Radius, vec![target(0, absent)], 1.0),
            ),
            (
                "diameter target point",
                cons_v(ConstraintKind::Diameter, vec![target(0, absent)], 2.0),
            ),
            (
                "line_distance circle as line",
                cons_v(
                    ConstraintKind::LineDistance,
                    ab(e_ref(1, absent), e_ref(0, PointSelector::Xy)),
                    1.0,
                ),
            ),
            (
                "angle circle vs point",
                cons_v(ConstraintKind::Angle, ab(e_ref(1, absent), e_ref(0, absent)), 30.0),
            ),
            (
                "midpoint point in line role",
                cons(
                    ConstraintKind::Midpoint,
                    vec![
                        (LineR, e_ref(0, absent)),
                        (RefRole::Point, e_ref(2, PointSelector::Start)),
                    ],
                ),
            ),
            // The reported trigger: A=Point is not a line, so dispatch falls
            // through to curve/curve and reads the point's slot-2 radius.
            (
                "tangent point circle",
                cons(ConstraintKind::Tangent, ab(e_ref(0, absent), e_ref(1, absent))),
            ),
            (
                "tangent explicit roles on wrong kinds",
                cons(
                    ConstraintKind::Tangent,
                    vec![(LineR, e_ref(1, absent)), (ArcR, e_ref(0, absent))],
                ),
            ),
            (
                "normal point line",
                cons(ConstraintKind::Normal, ab(e_ref(0, absent), e_ref(2, absent))),
            ),
            (
                "normal two circles",
                cons(ConstraintKind::Normal, ab(e_ref(1, absent), e_ref(1, absent))),
            ),
        ];
        for (name, c) in payloads {
            let inp = input(entities(), params(), vec![c]);
            let p = Problem::new(&inp);
            let x = p.x0.clone();
            let n = x.len();
            assert!(
                p.residuals(&x).is_empty(),
                "{name}: wrong-kind operand must drop the whole constraint"
            );
            assert_eq!(
                p.jacobian(&x, n).nrows(),
                0,
                "{name}: Jacobian rows must match the dropped residual"
            );
        }
    }

    /// The end-to-end shape of the bug: one postMessage carrying wrong-kind
    /// operands must not trap the wasm worker; the sketch solves with those
    /// constraints silently dropped.
    #[test]
    fn wrong_kind_payload_solves_instead_of_panicking() {
        let absent = PointSelector::Absent;
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Circle, 2), ent(Kind::Line, 5)],
            vec![1.0, 2.0, 5.0, 5.0, 1.0, 0.0, 0.0, 4.0, 0.0],
            vec![
                cons(ConstraintKind::Tangent, ab(e_ref(0, absent), e_ref(1, absent))),
                cons(ConstraintKind::Normal, ab(e_ref(0, absent), e_ref(2, absent))),
                cons_v(ConstraintKind::Length, vec![target(0, absent)], 3.0),
                cons_v(ConstraintKind::Angle, ab(e_ref(1, absent), e_ref(0, absent)), 30.0),
            ],
        );
        let out = solve_sketch(&inp);
        // Every constraint was dropped, so nothing is constrained at all and
        // the stacked residual is exactly empty.
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        assert_eq!(out.diagnostics.residual_norm, 0.0);
    }

    #[test]
    fn equality_pin_past_the_param_buffer_is_dropped() {
        let mut inp = input(vec![ent(Kind::Point, 0)], vec![1.0, 2.0], vec![]);
        inp.equality_pins = vec![
            EqualityPin { param_index: 1, target: 5.0 },
            EqualityPin { param_index: 9, target: 5.0 },
        ];
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1, "only the in-range pin contributes a row");
        assert!((r[0] - (2.0 - 5.0)).abs() < 1e-12);
    }

    #[test]
    fn horizontal_a_b_equalizes_y_of_two_points() {
        // Two points at (0,0) and (5,3). Horizontal a/b residual = pa.y - pb.y = -3.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 5.0, 3.0],
            vec![cons(
                ConstraintKind::Horizontal,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - (-3.0)).abs() < 1e-12, "horizontal a/b: {}", r[0]);
    }

    #[test]
    fn vertical_a_b_equalizes_x_of_two_points() {
        // Two points at (0,0) and (5,3). Vertical a/b residual = pa.x - pb.x = -5.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 5.0, 3.0],
            vec![cons(
                ConstraintKind::Vertical,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - (-5.0)).abs() < 1e-12, "vertical a/b: {}", r[0]);
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
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        assert!((r[0] - (-3.0)).abs() < 1e-12);
        assert!((r[1] - (-4.0)).abs() < 1e-12);
    }

    #[test]
    fn point_on_circle_coincident_symmetric_residual() {
        // Circle at (0,0) r=5, point at (8,0).
        // Residual = dist((8,0), (0,0)) - 5 = 8 - 5 = 3.
        // Circle in role A (Absent/locus), point in role B (Xy).
        let c = vec![Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: ab(
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
            ),
            ..Default::default()
        }];
        let inp = input(
            vec![ent(Kind::Circle, 0), ent(Kind::Point, 3)],
            vec![0.0, 0.0, 5.0, 8.0, 0.0],
            c,
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - 3.0).abs() < 1e-12, "residual: {}", r[0]);
    }

    #[test]
    fn point_on_line_coincident_with_external_point() {
        // A line locus (role A, Absent) coincident with an EXTERNAL point (the
        // document origin form) must read as point-on-line, not pin the line's
        // start. Vertical line x=0 from (0,0) to (0,10); external point (3,5).
        // Signed perpendicular distance = -3 -> a SINGLE residual row.
        let c = vec![Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: ab(
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
                Ref::External { x: 3.0, y: 5.0 },
            ),
            ..Default::default()
        }];
        let inp = input(vec![ent(Kind::Line, 0)], vec![0.0, 0.0, 0.0, 10.0], c);
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1, "point-on-line is one row, not point-to-point's two");
        assert!((r[0] - (-3.0)).abs() < 1e-12, "residual: {}", r[0]);
    }

    #[test]
    fn line_circle_tangent_residual() {
        // Line from (0,0) to (3,1), circle at (2,3) r=2.5.
        // Perpendicular distance from center to line = |2*1 - 3*3| / sqrt(10)
        // = 7 / sqrt(10). Residual = 7/sqrt(10) - 2.5.
        let abs = PointSelector::Absent;
        let c = vec![Constraint {
            kind_code: ConstraintKind::Tangent.to_u8(),
            refs: vec![
                (RefRole::Line, Ref::Entity { index: 0, point: abs }),
                (RefRole::Arc, Ref::Entity { index: 1, point: abs }),
            ],
            ..Default::default()
        }];
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
            vec![0.0, 0.0, 3.0, 1.0, 2.0, 3.0, 2.5],
            c,
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        let expected = 7.0 / (10.0_f64).sqrt() - 2.5;
        assert!((r[0] - expected).abs() < 1e-12, "residual: {}, expected: {}", r[0], expected);
    }

    /// Normal between a line and a circle goes through `radius_dir` at the line
    /// endpoint: the residual is the cross product of the line direction with
    /// the unit radial direction there, and the FD-fallback Jacobian has a
    /// matching row. No other test covers the mixed line/curve form.
    #[test]
    fn normal_between_line_and_circle_contributes_one_row() {
        // Line along +x from origin to (4,0); circle center (8,8) r=2. Contact
        // is the line end (4,0), radial direction (-4,-8)/sqrt(80), so the
        // residual is 4 * (-8/sqrt(80)).
        let absent = PointSelector::Absent;
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
            vec![0.0, 0.0, 4.0, 0.0, 8.0, 8.0, 2.0],
            vec![cons(ConstraintKind::Normal, ab(e_ref(0, absent), e_ref(1, absent)))],
        );
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        let r = p.residuals(&x);
        assert_eq!(r.len(), 1);
        let expected = -32.0 / (80.0_f64).sqrt();
        assert!((r[0] - expected).abs() < 1e-12, "normal line/circle: {}", r[0]);
        // The FD fallback for this kind must mirror the row count.
        assert_eq!(p.jacobian(&x, n).nrows(), 1);
    }

    /// Normal between a line and an ARC is keyed to the actual contact (the
    /// line endpoint), not the arc's own angle params. Pinned at a
    /// configuration where the two readings disagree on purpose: with start/end
    /// angles 0..90deg an angle-keyed radial would be (1,0) and the residual a
    /// false zero, while the contact-keyed radial is (0,-1).
    #[test]
    fn normal_between_line_and_arc_is_keyed_to_the_contact() {
        // Line along +x ending at (4,0); arc centre (4,8). The radial from the
        // centre to that contact is (0,-1), so cross(line_dir, radial) = -4.
        let absent = PointSelector::Absent;
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
            vec![0.0, 0.0, 4.0, 0.0, 4.0, 8.0, 2.0, 0.0, 90.0],
            vec![cons(ConstraintKind::Normal, ab(e_ref(0, absent), e_ref(1, absent)))],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - (-4.0)).abs() < 1e-12, "normal line/arc: {}", r[0]);
    }

    /// The contact collapsed onto the arc centre: `radius_dir` cannot divide,
    /// so an arc falls back to the parametric radial named by its angle params.
    /// With selector Absent that is the start angle; here 0deg means (1,0) and
    /// the diagonal line direction gives cross = -5.
    #[test]
    fn normal_line_arc_degenerate_contact_uses_the_parametric_radial() {
        let absent = PointSelector::Absent;
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
            vec![0.0, 0.0, 5.0, 5.0, 5.0, 5.0, 2.0, 0.0, 90.0],
            vec![cons(ConstraintKind::Normal, ab(e_ref(0, absent), e_ref(1, absent)))],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!(r[0].is_finite(), "no NaN out of the degenerate contact");
        assert!((r[0] - (-5.0)).abs() < 1e-12, "normal degenerate: {}", r[0]);
    }

    // ─── line-arc tangent tests ───

    /// Unpinned line-arc tangent: the line is nowhere near the arc's start/end
    /// angles, but it IS tangent to the arc's underlying circle. The correct
    /// residual is the perpendicular distance of the arc centre to the line
    /// minus the arc radius -- identical to the unpinned line-circle case.
    #[test]
    fn line_arc_tangent_unpinned() {
        // Arc at (0,0) r=2, angles 0..180 (upper half). Horizontal line y=2
        // from (0,2) to (10,2): distance centre->line = 2 = radius -> tangent.
        let abs = PointSelector::Absent;
        let c = vec![Constraint {
            kind_code: ConstraintKind::Tangent.to_u8(),
            refs: vec![
                (RefRole::Line, Ref::Entity { index: 0, point: abs }),
                (RefRole::Arc, Ref::Entity { index: 1, point: abs }),
            ],
            ..Default::default()
        }];
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
            vec![0.0, 2.0, 10.0, 2.0, 0.0, 0.0, 2.0, 0.0, 180.0],
            c,
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        // centre (0,0) to horizontal line y=2: distance = 2, radius = 2 => zero
        assert!(r[0].abs() < 1e-12, "horizontal line y=2 tangent to arc r=2: {}", r[0]);
    }

    /// A line that is NOT tangent to the arc's circle yields a non-zero
    /// residual. Uses a vertical line so the broken arc-start-angle path
    /// cannot produce the correct result by accident.
    #[test]
    fn line_arc_tangent_not_tangent() {
        let abs = PointSelector::Absent;
        let c = vec![Constraint {
            kind_code: ConstraintKind::Tangent.to_u8(),
            refs: vec![
                (RefRole::Line, Ref::Entity { index: 0, point: abs }),
                (RefRole::Arc, Ref::Entity { index: 1, point: abs }),
            ],
            ..Default::default()
        }];
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
            // vertical line x=0, arc at (3,0) r=2: centre->line = 3, radius = 2 => offset 1
            vec![0.0, 0.0, 0.0, 10.0, 3.0, 0.0, 2.0, 0.0, 180.0],
            c,
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - 1.0).abs() < 1e-12, "offset 1: {}", r[0]);
    }

    /// Pinned line-circle tangency must measure the radial at whichever line
    /// endpoint the coincident constraint actually pinned. Here that is the END,
    /// so a correctly-tangent seed reads exactly 0; the inverted-selector bug
    /// read the START instead (-3/sqrt(34) ~ -0.51 here) and drove LM off a
    /// feasible pose.
    #[test]
    fn line_circle_tangent_honors_the_pinned_end() {
        // Circle at origin r=5; line from (5,-3) up to (5,0): its END sits on
        // the circle and the direction is vertical, i.e. perpendicular to the
        // radial at (5,0).
        let absent = PointSelector::Absent;
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
            vec![5.0, -3.0, 5.0, 0.0, 0.0, 0.0, 5.0],
            vec![
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(0, PointSelector::End), e_ref(1, absent)),
                ),
                cons(
                    ConstraintKind::Tangent,
                    vec![
                        (RefRole::Line, e_ref(0, absent)),
                        (RefRole::Arc, e_ref(1, absent)),
                    ],
                ),
            ],
        );
        let p = Problem::new(&inp);
        assert_eq!(p.line_circle_coincident.get(&(0, 1)), Some(&PointSelector::End));
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        assert!(r[0].abs() < 1e-12, "coincident: {}", r[0]);
        assert!(r[1].abs() < 1e-12, "tangent at pinned END: {}", r[1]);
    }

    /// The mirrored pin side: the START endpoint is the one tied to the circle.
    /// Reading the opposite foot again produced a phantom -3/sqrt(34).
    #[test]
    fn line_circle_tangent_honors_the_pinned_start() {
        // Same circle; the line runs DOWN from (5,0) so its START sits on it.
        let absent = PointSelector::Absent;
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
            vec![5.0, 0.0, 5.0, -3.0, 0.0, 0.0, 5.0],
            vec![
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(0, PointSelector::Start), e_ref(1, absent)),
                ),
                cons(
                    ConstraintKind::Tangent,
                    vec![
                        (RefRole::Line, e_ref(0, absent)),
                        (RefRole::Arc, e_ref(1, absent)),
                    ],
                ),
            ],
        );
        let p = Problem::new(&inp);
        assert_eq!(p.line_circle_coincident.get(&(0, 1)), Some(&PointSelector::Start));
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        assert!(r[0].abs() < 1e-12, "coincident: {}", r[0]);
        assert!(r[1].abs() < 1e-12, "tangent at pinned START: {}", r[1]);
    }

    /// Pinned line-arc tangency with the contact MID-SWEEP (45 deg of a 0..90
    /// arc): the radial there comes from the contact itself. The old arc arm
    /// keyed the direction off the arc's stored start angle instead, ignoring
    /// the contact entirely and reading -sqrt(2)/2 for this exact geometry.
    #[test]
    fn line_arc_tangent_honors_the_pinned_contact_mid_sweep() {
        let absent = PointSelector::Absent;
        let (c45, s45) = (45.0_f64.to_radians().cos(), 45.0_f64.to_radians().sin());
        // Arc centre origin r=5 sweeping 0..90 deg; the line's END is pinned at
        // the 45 deg point and the line runs along the tangent there.
        let end = [5.0 * c45, 5.0 * s45];
        let start = [end[0] + 3.0 * s45, end[1] - 3.0 * c45];
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
            vec![
                start[0] as f32, start[1] as f32, end[0] as f32, end[1] as f32,
                0.0, 0.0, 5.0, 0.0, 90.0,
            ],
            vec![
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(0, PointSelector::End), e_ref(1, absent)),
                ),
                cons(
                    ConstraintKind::Tangent,
                    vec![
                        (RefRole::Line, e_ref(0, absent)),
                        (RefRole::Arc, e_ref(1, absent)),
                    ],
                ),
            ],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        // The 45 deg contact only survives the f32 param buffer to ~1e-9.
        assert!(r[0].abs() < 1e-7, "coincident: {}", r[0]);
        assert!(r[1].abs() < 1e-7, "tangent at mid-sweep contact: {}", r[1]);
    }

    /// End-to-end shape of the bug: a sketch already satisfying its pinned
    /// tangency must solve as a no-op. Driving away (or reporting
    /// Overconstrained from a phantom residual) locked a correct drawing.
    #[test]
    fn solve_from_a_pinned_tangent_seed_stays_put() {
        let absent = PointSelector::Absent;
        let mk = |line_params: [f32; 4], curve_params: Vec<f32>, curve: Kind| {
            input(
                vec![ent(Kind::Line, 0), ent(curve, 4)],
                [line_params.as_slice(), &curve_params].concat(),
                vec![
                    cons(
                        ConstraintKind::Coincident,
                        ab(e_ref(0, PointSelector::End), e_ref(1, absent)),
                    ),
                    cons(
                        ConstraintKind::Tangent,
                        vec![
                            (RefRole::Line, e_ref(0, absent)),
                            (RefRole::Arc, e_ref(1, absent)),
                        ],
                    ),
                ],
            )
        };
        let circle_case = mk([5.0, -3.0, 5.0, 0.0], vec![0.0, 0.0, 5.0], Kind::Circle);
        let arc_case = mk(
            [
                (5.0 * 45.0_f64.to_radians().cos() + 3.0 * 45.0_f64.to_radians().sin()) as f32,
                (5.0 * 45.0_f64.to_radians().sin() - 3.0 * 45.0_f64.to_radians().cos()) as f32,
                (5.0 * 45.0_f64.to_radians().cos()) as f32,
                (5.0 * 45.0_f64.to_radians().sin()) as f32,
            ],
            vec![0.0, 0.0, 5.0, 0.0, 90.0],
            Kind::Arc,
        );
        for (name, inp) in [("circle", circle_case), ("arc", arc_case)] {
            let out = solve_sketch(&inp);
            assert_ne!(
                out.overall_status,
                Status::Overconstrained.to_u8(),
                "{name}: a tangent seed must not read overconstrained"
            );
            assert!(
                out.diagnostics.residual_norm < 1e-6,
                "{name}: residual {} at an already-feasible seed",
                out.diagnostics.residual_norm
            );
            for (i, (got, want)) in out.params_solved.iter().zip(&inp.params_initial).enumerate() {
                assert!(
                    (*got as f64 - *want as f64).abs() < 1e-3,
                    "{name}: param {i} moved from {want} to {got}"
                );
            }
        }
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
        let r = p.residuals(&p.x0);
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
        let r = p.residuals(&p.x0);
        assert!(r[0].abs() < 1e-12, "rotated major vertex: {}", r[0]);
    }

    #[test]
    fn collapsed_ellipse_semi_axis_stays_finite() {
        // A semi-axis dragged (or decoded) to zero must not divide the conic
        // residual by zero: one NaN row makes every later LM step NaN and the
        // whole sketch stops converging with nothing reported.
        for ep in [
            [0.0, 0.0, 0.0, 1.0, 0.0],  // a collapsed
            [0.0, 0.0, 2.0, 0.0, 0.0],  // b collapsed
            [0.0, 0.0, 0.0, 0.0, 0.0],  // both
        ] {
            let r = ellipse_point_residual([1.0, 1.0], &ep);
            assert!(r.is_finite(), "residual for {ep:?} was {r}");
        }
    }

    #[test]
    fn collapsed_ellipse_keeps_the_stacked_residual_finite() {
        // The same degeneracy through the real constraint path: a point-on-
        // ellipse row over an ellipse whose minor axis has collapsed.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Ellipse, 2)],
            vec![3.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0],
            vec![cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!(r[0].is_finite(), "point-on-collapsed-ellipse row: {}", r[0]);
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
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        assert!((r[0] - (-3.0)).abs() < 1e-12);
        assert!((r[1] - (-4.0)).abs() < 1e-12);
    }

    #[test]
    fn point_distance_x_residual_constrains_x_distance() {
        // Two points at (0,0) and (10,5) with value = 10:
        // point_distance_x residual = |10-0| - 10 = 0
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_v(
                ConstraintKind::PointDistanceX,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                10.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!(r[0].abs() < 1e-12, "point_distance_x residual {}", r[0]);
    }

    #[test]
    fn point_distance_x_residual_nonzero_when_wrong() {
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_v(
                ConstraintKind::PointDistanceX,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                7.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - 3.0).abs() < 1e-12, "expected 3, got {}", r[0]);
    }

    #[test]
    fn point_distance_y_residual_constrains_y_distance() {
        // Two points at (0,0) and (10,5) with value = 5:
        // point_distance_y residual = |5-0| - 5 = 0
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_v(
                ConstraintKind::PointDistanceY,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                5.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!(r[0].abs() < 1e-12, "point_distance_y residual {}", r[0]);
    }

    #[test]
    fn point_distance_y_residual_nonzero_when_wrong() {
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_v(
                ConstraintKind::PointDistanceY,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                3.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - 2.0).abs() < 1e-12, "expected 2, got {}", r[0]);
    }

    #[test]
    fn point_distance_x_signed_pins_b_to_the_right() {
        // pb is +10 to the right of pa. sign +1, value 10 -> (10-0) - 1*10 = 0.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_vs(
                ConstraintKind::PointDistanceX,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                10.0,
                1.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!(r[0].abs() < 1e-12, "signed +1 same side: {}", r[0]);
    }

    #[test]
    fn point_distance_x_signed_wrong_side_is_nonzero_not_satisfied_by_abs() {
        // pb sits to the right (+10) but sign -1 demands the left side. The abs
        // residual would read 0 here (bistable); the signed one reads 20, so the
        // solver is pushed to actually move pb to the other side.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_vs(
                ConstraintKind::PointDistanceX,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                10.0,
                -1.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert!((r[0] - 20.0).abs() < 1e-12, "signed -1 wrong side: {}", r[0]);
    }

    #[test]
    fn point_distance_x_signed_negative_side_satisfied_when_b_is_left() {
        // pb is -10 (left of pa). sign -1, value 10 -> (-10-0) - (-1*10) = 0.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, -10.0, 5.0],
            vec![cons_vs(
                ConstraintKind::PointDistanceX,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                10.0,
                -1.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert!(r[0].abs() < 1e-12, "signed -1 correct (left) side: {}", r[0]);
    }

    #[test]
    fn point_distance_x_without_sign_keeps_legacy_abs_bistability() {
        // No sign: pb on the left still satisfies value 10 via the absolute
        // residual (|-10| - 10 = 0). Pins that the legacy path is untouched.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, -10.0, 5.0],
            vec![cons_v(
                ConstraintKind::PointDistanceX,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                10.0,
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert!(r[0].abs() < 1e-12, "legacy abs both sides: {}", r[0]);
    }

    #[test]
    fn point_distance_y_signed_picks_the_side() {
        // pb is +5 above pa; sign +1 satisfies, sign -1 reads 10.
        let mk = |sign: f64| {
            input(
                vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
                vec![0.0, 0.0, 10.0, 5.0],
                vec![cons_vs(
                    ConstraintKind::PointDistanceY,
                    ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                    5.0,
                    sign,
                )],
            )
        };
        let up = mk(1.0);
        let pu = Problem::new(&up);
        assert!(pu.residuals(&pu.x0)[0].abs() < 1e-12);
        let down = mk(-1.0);
        let pd = Problem::new(&down);
        assert!((pd.residuals(&pd.x0)[0] - 10.0).abs() < 1e-12);
    }

    #[test]
    fn line_distance_signed_selects_side_and_defaults_to_legacy() {
        // Line A along +x through origin; point b 5 above it. Normal is (0,1),
        // so the signed perpendicular offset is +5.
        let mk = |by: f32, sign: Option<f64>| {
            let c = Constraint {
                kind_code: ConstraintKind::LineDistance.to_u8(),
                refs: ab(e_ref(0, PointSelector::Absent), e_ref(1, PointSelector::Xy)),
                value: Some(5.0),
                sign,
                ..Default::default()
            };
            input(
                vec![ent(Kind::Line, 0), ent(Kind::Point, 4)],
                vec![0.0, 0.0, 10.0, 0.0, 3.0, by],
                vec![c],
            )
        };
        // No sign -> legacy signed residual against +value: b above satisfies.
        let none = mk(5.0, None);
        let pn = Problem::new(&none);
        assert!(pn.residuals(&pn.x0)[0].abs() < 1e-12, "legacy +1 default");
        // sign -1 wants b below; b above reads 10.
        let wrong = mk(5.0, Some(-1.0));
        let pw = Problem::new(&wrong);
        assert!((pw.residuals(&pw.x0)[0] - 10.0).abs() < 1e-12, "signed -1 wrong side");
        // sign -1 with b below is satisfied.
        let right = mk(-5.0, Some(-1.0));
        let pr = Problem::new(&right);
        assert!(pr.residuals(&pr.x0)[0].abs() < 1e-12, "signed -1 correct side");
    }

    #[test]
    fn angle_signed_pins_handedness_legacy_is_side_agnostic() {
        // Line A along +x (dir 0). Line B is either +y (dir +90, cross>0) or
        // -y (dir -90, cross<0). value 90 in all cases.
        let mk = |by_end: f32, sign: Option<f64>| {
            let c = Constraint {
                kind_code: ConstraintKind::Angle.to_u8(),
                refs: ab(e_ref(0, PointSelector::Absent), e_ref(1, PointSelector::Absent)),
                value: Some(90.0),
                sign,
                ..Default::default()
            };
            input(
                vec![ent(Kind::Line, 0), ent(Kind::Line, 4)],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, by_end],
                vec![c],
            )
        };
        // Legacy (no sign): both handedness configs satisfy the unsigned angle.
        let lpos = mk(1.0, None);
        let lp = Problem::new(&lpos);
        assert!(lp.residuals(&lp.x0)[0].abs() < 1e-12, "legacy +y");
        let lneg = mk(-1.0, None);
        let ln = Problem::new(&lneg);
        assert!(ln.residuals(&ln.x0)[0].abs() < 1e-12, "legacy -y");
        // sign +1 wants the +90 (CCW) handedness: +y satisfies, -y reads pi.
        let spos = mk(1.0, Some(1.0));
        let sp = Problem::new(&spos);
        assert!(sp.residuals(&sp.x0)[0].abs() < 1e-12, "signed +1 with +y");
        let sneg = mk(-1.0, Some(1.0));
        let sn = Problem::new(&sneg);
        assert!(
            (sn.residuals(&sn.x0)[0].abs() - std::f64::consts::PI).abs() < 1e-12,
            "signed +1 with -y must be off by a half turn: {}",
            sn.residuals(&sn.x0)[0]
        );
        // sign -1 flips it: -y now satisfies.
        let smneg = mk(-1.0, Some(-1.0));
        let smn = Problem::new(&smneg);
        assert!(smn.residuals(&smn.x0)[0].abs() < 1e-12, "signed -1 with -y");
    }

    #[test]
    fn midpoint_line_form_constrains_point_to_segment_center() {
        // Line [0,0 -> 4,2] has midpoint (2,1). A point sitting there is feasible
        // in both axes; the big-jac test only checks this branch's derivative, not
        // the residual value, so this pins the formula direction (pt - mid).
        let inp = input(
            vec![ent(Kind::Line, 0), ent(Kind::Point, 4)],
            vec![0.0, 0.0, 4.0, 2.0, 2.0, 1.0],
            vec![cons(
                ConstraintKind::Midpoint,
                vec![
                    (RefRole::Line, e_ref(0, PointSelector::Absent)),
                    (RefRole::Point, e_ref(1, PointSelector::Xy)),
                ],
            )],
        );
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        assert!(r[0].abs() < 1e-12 && r[1].abs() < 1e-12, "on-center {:?}", r);

        // Move the point to (5,7): residual = (5-2, 7-1) = (3, 6).
        let mut x = p.x0.clone();
        x[4] = 5.0;
        x[5] = 7.0;
        let r = p.residuals(&x);
        assert!((r[0] - 3.0).abs() < 1e-12 && (r[1] - 6.0).abs() < 1e-12, "off-center {:?}", r);
    }

    #[test]
    fn midpoint_point_pair_form_uses_average_of_two_points() {
        // PointA (0,0) + PointB (10,4) -> midpoint (5,2). The point-pair branch
        // (RefRole::PointA/PointB) is exercised by no other test.
        let inp = input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2), ent(Kind::Point, 4)],
            vec![0.0, 0.0, 10.0, 4.0, 5.0, 5.0],
            vec![cons(
                ConstraintKind::Midpoint,
                vec![
                    (RefRole::PointA, e_ref(0, PointSelector::Xy)),
                    (RefRole::PointB, e_ref(1, PointSelector::Xy)),
                    (RefRole::Point, e_ref(2, PointSelector::Xy)),
                ],
            )],
        );
        let p = Problem::new(&inp);
        // Point is at (5,5); midpoint is (5,2) -> residual (0, 3).
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2);
        assert!(r[0].abs() < 1e-12 && (r[1] - 3.0).abs() < 1e-12, "point-pair {:?}", r);
    }

    #[test]
    fn midpoint_axis_filter_emits_only_the_selected_component() {
        // Line midpoint (2,1), point at (5,7). Axis::X keeps only the x row (3),
        // Axis::Y keeps only the y row (6). The axis-restricted branches have no
        // other coverage.
        let make = |axis: Axis| Constraint {
            kind_code: ConstraintKind::Midpoint.to_u8(),
            refs: vec![
                (RefRole::Line, e_ref(0, PointSelector::Absent)),
                (RefRole::Point, e_ref(1, PointSelector::Xy)),
            ],
            axis: Some(axis),
            ..Default::default()
        };
        let entities = vec![ent(Kind::Line, 0), ent(Kind::Point, 4)];
        let params = vec![0.0, 0.0, 4.0, 2.0, 5.0, 7.0];

        let inp_x = input(entities.clone(), params.clone(), vec![make(Axis::X)]);
        let px = Problem::new(&inp_x);
        let rx = px.residuals(&px.x0.clone());
        assert_eq!(rx.len(), 1);
        assert!((rx[0] - 3.0).abs() < 1e-12, "axis-x {:?}", rx);

        let inp_y = input(entities, params, vec![make(Axis::Y)]);
        let py = Problem::new(&inp_y);
        let ry = py.residuals(&py.x0.clone());
        assert_eq!(ry.len(), 1);
        assert!((ry[0] - 6.0).abs() < 1e-12, "axis-y {:?}", ry);
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
        let r = p.residuals(&p.x0);
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
        let fd = solver_core::lm::fd_jacobian(&residual_fn, &x, m);
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
            let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| p.residuals(xx), &x, 1);
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
            let r = p.residuals(&p.x0);
            assert_eq!(r.len(), 1);
            assert!((r[0] - 5.0).abs() < 1e-12, "circle tangent: {}", r[0]);
        }
    }

    /// A radius-difference dimension between two concentric circles drives the
    /// gap |rA - rB| to the target value.
    #[test]
    fn radius_difference_dimension() {
        let abs = PointSelector::Absent;
        // Concentric circles at the origin: rA=2, rB=5 -> current gap 3.
        let entities = vec![ent(Kind::Circle, 0), ent(Kind::Circle, 3)];
        let params = vec![0.0, 0.0, 2.0, 0.0, 0.0, 5.0];
        let c = cons_v(
            ConstraintKind::RadiusDifference,
            ab(e_ref(0, abs), e_ref(1, abs)),
            4.0,
        );
        let inp = input(entities, params, vec![c]);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        // residual = |2 - 5| - 4 = 3 - 4 = -1.
        let r = p.residuals(&x);
        assert_eq!(r.len(), 1);
        assert!((r[0] - (-1.0)).abs() < 1e-12, "radius diff: {}", r[0]);
        // The finite-difference Jacobian is well-defined away from rA == rB.
        let analytic = p.jacobian(&x, n);
        assert_eq!(analytic.nrows(), 1);
    }

    /// Build the full entities/params/constraints for the all-constraints Jacobian
    /// coverage test, then assert the analytic Jacobian matches FD. The FD is the
    /// trusted oracle (it is finite differences of the residual itself), so this
    /// gate catches any hand-derivative mistake.
    ///
    /// Extracted to a helper so the bigger problem (with RadiusDifference,
    /// PointDistanceX/Y) stays manageable.
    fn check_big_jac_problem(
        entities: Vec<Entity>,
        params: Vec<f32>,
        constraints: Vec<Constraint>,
        pinned_mask: Vec<u8>,
        equality_pins: Vec<EqualityPin>,
    ) {
        let inp = Input {
            entities,
            params_initial: params,
            pinned_mask,
            equality_pins,
            constraints,
            options: Options::default(),
        };
        let p = Problem::new(&inp);
        // Perturb away from seed so derivatives are exercised at a generic point.
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
        let fd = solver_core::lm::fd_jacobian(&residual_fn, &x, m);
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
            ent(Kind::Circle, 25), // 7  C2 [25..28]
        ];
        let params = vec![
            0.0, 0.0, 3.0, 1.0, // L1
            1.0, 2.0, 4.0, 5.0, // L2
            2.0, 3.0, 2.5, // C1
            1.0, 1.0, 2.0, 30.0, 120.0, // A1
            5.0, 6.0, // P1
            7.0, 2.0, // P2
            2.5, 3.5, 4.0, 2.0, 25.0, // E1 (cx, cy, a, b, theta_deg)
            10.0, -5.0, 1.5, // C2
        ];

        let constraints = vec![
            cons(ConstraintKind::Horizontal, vec![(Target, e_ref(0, Absent))]),
            cons(ConstraintKind::Horizontal, vec![(A, e_ref(0, Start)), (B, e_ref(4, End))]),
            cons(ConstraintKind::Vertical, vec![(Target, e_ref(1, Absent))]),
            cons(ConstraintKind::Vertical, vec![(A, e_ref(4, Xy)), (B, e_ref(5, Xy))]),
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
            // radius-difference dimension between C1 and C2
            cons_v(ConstraintKind::RadiusDifference, ab(e_ref(2, Absent), e_ref(7, Absent)), 1.0),
            // point-distance-x/y between P1 and P2
            cons_v(ConstraintKind::PointDistanceX, ab(e_ref(4, Xy), e_ref(5, Xy)), 2.0),
            cons_v(ConstraintKind::PointDistanceY, ab(e_ref(4, Xy), e_ref(5, Xy)), 4.0),
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

        check_big_jac_problem(
            entities,
            params,
            constraints,
            vec![0b0000_0010], // pin param 1
            vec![EqualityPin {
                param_index: 9,
                target: 2.0,
            }],
        );
    }

    /// The sparse Jacobian is the drag fast path's only derivative source, and
    /// unlike the dense one it had no cross-check against the residual at all.
    /// It must be the dense matrix with exact zeros dropped: reconstructing the
    /// sparse rows must reproduce the dense entry in every column, and at least
    /// one row must actually be sparse (otherwise the filter is a no-op).
    #[test]
    fn jacobian_sparse_matches_dense_jacobian() {
        use PointSelector::{Absent, Start, Xy};
        use RefRole::{Arc as ArcR, Line as LineR, Target};

        // Mixed analytic and finite-difference rows so both derivative paths
        // feed the sparse conversion.
        let entities = vec![
            ent(Kind::Line, 0),   // L1 [0..4]
            ent(Kind::Line, 4),   // L2 [4..8]
            ent(Kind::Circle, 8), // C1 [8..11]
            ent(Kind::Point, 11), // P1 [11..13]
        ];
        let params = vec![
            0.0, 0.0, 3.0, 1.0, // L1
            1.0, 2.0, 4.0, 5.0, // L2
            2.0, 3.0, 2.5, // C1
            5.0, 6.0, // P1
        ];
        let constraints = vec![
            cons(ConstraintKind::Horizontal, vec![(Target, e_ref(0, Absent))]),
            cons_v(ConstraintKind::Length, vec![(Target, e_ref(0, Absent))], 5.0),
            cons(ConstraintKind::Parallel, ab(e_ref(0, Absent), e_ref(1, Absent))),
            cons_v(ConstraintKind::Radius, vec![(Target, e_ref(2, Absent))], 4.0),
            cons(ConstraintKind::Coincident, ab(e_ref(3, Xy), e_ref(1, Absent))),
            cons_v(ConstraintKind::Angle, ab(e_ref(0, Absent), e_ref(1, Absent)), 30.0),
            cons_v(ConstraintKind::PointDistance, ab(e_ref(3, Xy), e_ref(0, Start)), 1.0),
            cons(
                ConstraintKind::Tangent,
                vec![(LineR, e_ref(0, Absent)), (ArcR, e_ref(2, Absent))],
            ),
        ];
        let inp = input(entities, params, constraints);
        let p = Problem::new(&inp);
        let x: Vec<f64> = inp
            .params_initial
            .iter()
            .enumerate()
            .map(|(i, &v)| v as f64 + 0.13 * ((i as f64) * 0.9).cos())
            .collect();
        let n = x.len();

        let dense = p.jacobian(&x, n);
        let sparse = p.jacobian_sparse(&x, n);

        assert_eq!(sparse.len(), dense.nrows());
        assert!(
            sparse.iter().any(|row| row.len() < n),
            "expected the zero-stripping to drop columns from at least one row"
        );
        for (r, row) in sparse.iter().enumerate() {
            let mut reconstructed = vec![0.0; n];
            for &(c, v) in row {
                assert_ne!(v, 0.0, "row {r} col {c} stored an explicit zero");
                reconstructed[c] = v;
            }
            for c in 0..n {
                assert!(
                    (reconstructed[c] - dense[(r, c)]).abs() < 1e-15,
                    "row {r} col {c}: sparse={} dense={}",
                    reconstructed[c],
                    dense[(r, c)],
                );
            }
        }
    }
}
