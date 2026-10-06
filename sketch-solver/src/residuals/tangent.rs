use super::geom::bezier_deriv;
use super::Problem;
use crate::constraints::{Constraint, PointSelector, Ref, RefRole};
use crate::Kind;

impl Problem<'_> {
    pub(super) fn r_tangent(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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
                let contact = self.point(
                    x,
                    Ref::Entity {
                        index: line_idx,
                        point: pinned_pt,
                    },
                );
                let rd = self.radius_dir(x, arc_idx, arc_pt, contact);
                r.push(line_dir[0] * rd[0] + line_dir[1] * rd[1]);
            } else {
                let (cx, cy) = (arc_ep[0], arc_ep[1]);
                let num = (cx - line_ep[0]) * line_dir[1] - (cy - line_ep[1]) * line_dir[0];
                r.push(num.abs() - arc_ep[2]);
            }
        }
    }
}
