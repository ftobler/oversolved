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
use crate::{Entity, Input, Kind};
use std::collections::HashMap;

/// A point in sketch-plane coordinates.
type P2 = [f64; 2];

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
        let line_ep = self.params(x, line_idx).to_vec();
        let arc_ep = self.params(x, arc_idx).to_vec();
        let mut line_dir = [line_ep[2] - line_ep[0], line_ep[3] - line_ep[1]];
        let norm = (line_dir[0] * line_dir[0] + line_dir[1] * line_dir[1])
            .sqrt()
            .max(1e-12);
        line_dir[0] /= norm;
        line_dir[1] /= norm;

        if self.kind_of(arc_idx) == Kind::Circle {
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
        let len_a = ((ea[2] - ea[0]).powi(2) + (ea[3] - ea[1]).powi(2)).sqrt();
        let len_b = ((eb[2] - eb[0]).powi(2) + (eb[3] - eb[1]).powi(2)).sqrt();
        r.push(len_a - len_b);
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
}
