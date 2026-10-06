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

use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::{Entity, Input, Kind};

use self::geom::{bezier_eval, is_curve, ref_kind, ref_supplies_slots};
use std::collections::HashMap;

mod coincident;
mod distance;
mod geom;
mod jacobian;
mod linear;
mod misc;
mod tangent;

#[cfg(test)]
mod tests;

/// A point in sketch-plane coordinates.
type P2 = [f64; 2];

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

        let pinned_indices: Vec<usize> = (0..x0.len()).filter(|&i| input.is_pinned(i)).collect();
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
                    && is_curve(
                        input
                            .entities
                            .get(b_idx as usize)
                            .map(|e| e.kind)
                            .unwrap_or(Kind::Point),
                    )
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
                    && is_curve(
                        input
                            .entities
                            .get(a_idx as usize)
                            .map(|e| e.kind)
                            .unwrap_or(Kind::Point),
                    )
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
        // contribute no rows for them. An external ref resolves through
        // `point()` or contributes nothing, so `ref_kind` reports it as `None`
        // and it never satisfies an entity-kind check.
        let kind_ok = |role: RefRole, pred: fn(Kind) -> bool| {
            c.ref_for(role)
                .is_none_or(|r| ref_kind(input, &r).is_some_and(pred))
        };
        let is_line = |k: Kind| k == Kind::Line;
        match kind {
            ConstraintKind::Horizontal | ConstraintKind::Vertical => {
                // The a/b form compares points resolved through `point()` for
                // every kind; only the bare-entity form reads endpoints
                // straight out of the param block.
                if c.ref_for(RefRole::A).is_some() && c.ref_for(RefRole::B).is_some() {
                    true
                } else {
                    kind_ok(RefRole::Target, is_line)
                }
            }
            // The length, angle and line-distance builders read slots 0..4 as a
            // line's endpoints. An arc (5 params) or spline (8) has enough slots
            // but the wrong meaning for them, so the kind must be checked, not
            // just the count.
            ConstraintKind::Length => kind_ok(RefRole::Target, is_line),
            ConstraintKind::Radius | ConstraintKind::Diameter => kind_ok(RefRole::Target, is_curve),
            ConstraintKind::LineDistance => kind_ok(RefRole::A, is_line),
            ConstraintKind::Angle => kind_ok(RefRole::A, is_line) && kind_ok(RefRole::B, is_line),
            ConstraintKind::Midpoint => kind_ok(RefRole::Line, is_line),
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
                    // branch, which reads each radius at slot 2. An ellipse or
                    // spline has that slot but it is not a radius.
                    Some((lr, ar)) => {
                        ref_kind(input, &lr).is_some_and(is_curve)
                            && ref_kind(input, &ar).is_some_and(is_curve)
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
                let (line_ref, arc_ref) = if ka == Some(Kind::Line) {
                    (&a, &b)
                } else {
                    (&b, &a)
                };
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

    /// True when the ref denotes a single point: an external reference, an
    /// entity with an explicit point selector, or a Point-kind entity.
    fn ref_is_point(&self, r: &Ref) -> bool {
        match r {
            Ref::External { .. } => true,
            Ref::Entity { point, index } => {
                point.is_present() || self.kind_of(*index) == Kind::Point
            }
        }
    }
}
