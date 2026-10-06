use super::geom::is_curve;
use super::{Problem, P2};
use crate::constraints::{Constraint, Ref, RefRole};
use crate::Kind;

impl Problem<'_> {
    pub(super) fn r_length(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index, .. }), Some(value)) = (c.ref_for(RefRole::Target), c.value)
        else {
            return;
        };
        let ep = self.params(x, index);
        let (dx, dy) = (ep[2] - ep[0], ep[3] - ep[1]);
        r.push((dx * dx + dy * dy).sqrt() - value);
    }

    pub(super) fn r_line_distance(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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
        let (nx, ny) = if n > 0.0 {
            (-dy / n, dx / n)
        } else {
            (0.0, 1.0)
        };
        let vx = pb[0] - ep_a[0];
        let vy = pb[1] - ep_a[1];
        // The perpendicular offset is already signed (the normal direction picks
        // a side). The orientation sign selects which side `value` targets;
        // absent, it defaults to +1, reproducing the legacy signed residual.
        let proj = vx * nx + vy * ny;
        r.push(proj - c.sign.unwrap_or(1.0) * value);
    }

    pub(super) fn r_radius(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index, .. }), Some(value)) = (c.ref_for(RefRole::Target), c.value)
        else {
            return;
        };
        r.push(self.params(x, index)[2] - value);
    }

    pub(super) fn r_diameter(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index, .. }), Some(value)) = (c.ref_for(RefRole::Target), c.value)
        else {
            return;
        };
        r.push(2.0 * self.params(x, index)[2] - value);
    }

    /// Dimension between two circles/arcs (typically concentric): the gap
    /// |rA - rB| equals the target value. Absolute so it is independent of which
    /// operand was selected first, and the dimension value the user types is the
    /// positive radial gap. The Jacobian uses the finite-difference fallback.
    pub(super) fn r_radius_difference(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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

    pub(super) fn r_equal_length(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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

    /// Resolve the A/B point pair and target value shared by the point-distance
    /// constraints. `None` when any ref or the value is absent.
    fn point_pair_value(&self, c: &Constraint, x: &[f64]) -> Option<(P2, P2, f64)> {
        let (a, b, value) = (c.ref_for(RefRole::A)?, c.ref_for(RefRole::B)?, c.value?);
        Some((self.point(x, a), self.point(x, b), value))
    }

    pub(super) fn r_point_distance(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some((pa, pb, value)) = self.point_pair_value(c, x) else {
            return;
        };
        let dist = ((pb[0] - pa[0]).powi(2) + (pb[1] - pa[1]).powi(2)).sqrt();
        r.push(dist - value);
    }

    pub(super) fn r_point_distance_axis(
        &self,
        c: &Constraint,
        x: &[f64],
        r: &mut Vec<f64>,
        axis: usize,
    ) {
        let Some((pa, pb, value)) = self.point_pair_value(c, x) else {
            return;
        };
        let d = pb[axis] - pa[axis];
        match c.sign {
            Some(s) => r.push(d - s * value),
            None => r.push(d.abs() - value),
        }
    }
}
