use super::{Problem, P2};
use crate::constraints::{Axis, Constraint, PointSelector, Ref, RefRole};
use crate::Kind;

/// How many leading scalars of a member's param block are coordinates (as
/// opposed to shape scalars such as a radius or an arc angle).
///
/// The group holds coordinates at their reference plus the group's translation
/// and every later scalar at its reference exactly. `fit_spline` stores the fit
/// points and the optional end handles as absolute points, so its whole block
/// translates; a spline is four Bezier control points.
pub(super) fn group_coord_count(kind: Kind, param_count: usize) -> usize {
    match kind {
        Kind::Line => 4,
        Kind::Circle | Kind::Arc | Kind::Ellipse | Kind::Point => 2,
        Kind::Spline => 8,
        Kind::FitSpline => param_count,
    }
}

/// True when the anchor selector names the entity's first param pair. Every
/// kind's first point lives at params 0,1 (line/spline start, the centre of a
/// circle/arc/ellipse, a point's xy, a fit spline's first fit point), and the
/// host's lowering always writes one of these selectors.
pub(super) fn anchor_is_first_pair(point: PointSelector) -> bool {
    matches!(
        point,
        PointSelector::Absent | PointSelector::Start | PointSelector::Center | PointSelector::Xy
    )
}

impl Problem<'_> {
    pub(super) fn r_midpoint(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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

    pub(super) fn r_concentric(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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

    pub(super) fn r_fixed(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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
                    let p0 = self.point(&self.reference, target);
                    (p0[0], p0[1])
                }
            };
            r.push(pt[0] - fix_x);
            r.push(pt[1] - fix_y);
        } else {
            let off = self.offset_of(index);
            let size = self.param_count_of(index);
            for i in 0..size {
                r.push(x[off + i] - self.reference[off + i]);
            }
        }
    }

    /// Rigid group member: its coordinates hold their reference offset from the
    /// anchor point, and its shape scalars hold their reference value.
    ///
    /// The anchor point's displacement `t = anchor(x) - anchor(reference)` is the
    /// translation the whole group is allowed. Only the anchor entity's own first
    /// pair is that `t` itself, so it contributes no rows; every other member
    /// param (and the anchor's other params) gets one. The rows are therefore
    /// `(member params) - 2` per group, with no redundancy: the null space is
    /// exactly the two translations.
    pub(super) fn r_group(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (
            Some(Ref::Entity { index: member, .. }),
            Some(
                anchor @ Ref::Entity {
                    index: anchor_index,
                    ..
                },
            ),
        ) = (c.ref_for(RefRole::Target), c.ref_for(RefRole::A))
        else {
            return;
        };
        let Ref::Entity {
            point: anchor_point,
            ..
        } = anchor
        else {
            return;
        };
        let off = self.offset_of(member);
        let size = self.param_count_of(member);
        let t = self.translation(x, anchor);
        let coords = group_coord_count(self.kind_of(member), size);
        let skip_anchor_pair =
            member == anchor_index && size >= 2 && anchor_is_first_pair(anchor_point);
        for i in 0..size {
            if skip_anchor_pair && i < 2 {
                continue;
            }
            let held = self.reference[off + i];
            let residual = if i < coords {
                x[off + i] - held - t[i % 2]
            } else {
                x[off + i] - held
            };
            r.push(residual);
        }
    }
}
