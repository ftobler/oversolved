use super::geom::{ellipse_point_residual, spline_point_residual};
use super::Problem;
use crate::constraints::{Constraint, Ref, RefRole};
use crate::Kind;

impl Problem<'_> {
    /// Residual for a point lying on an entity (line/circle/arc/ellipse/spline).
    /// Used symmetrically regardless of whether the point is the A or B ref.
    fn r_point_on_entity(
        &self,
        x: &[f64],
        point: Ref,
        entity_index: u32,
        entity_kind: Kind,
        r: &mut Vec<f64>,
    ) {
        let pa = self.point(x, point);
        let ep = self.params(x, entity_index);
        match entity_kind {
            Kind::Line => {
                let (dx, dy) = (ep[2] - ep[0], ep[3] - ep[1]);
                let n = (dx * dx + dy * dy).sqrt();
                let (nx, ny) = if n > 0.0 {
                    (-dy / n, dx / n)
                } else {
                    (0.0, 1.0)
                };
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

    pub(super) fn r_coincident(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(a_ref), Some(b_ref)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        // Carry the entity index and kind together so each arm below can
        // destructure them without unwrapping a separate Option. An operand
        // that is not an entity leaves this None and falls through to the
        // point-point arm, which handles every non-entity reference.
        let a_entity = match a_ref {
            Ref::Entity { index, .. } => Some((index, self.kind_of(index))),
            _ => None,
        };
        let b_entity = match b_ref {
            Ref::Entity { index, .. } => Some((index, self.kind_of(index))),
            _ => None,
        };

        if !self.ref_is_point(&a_ref)
            && !self.ref_is_point(&b_ref)
            && matches!(a_entity, Some((_, Kind::Line)))
            && matches!(b_entity, Some((_, Kind::Line)))
        {
            let (Some((a_idx, _)), Some((b_idx, _))) = (a_entity, b_entity) else {
                return;
            };
            let ea = self.params(x, a_idx);
            let eb = self.params(x, b_idx);
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
        } else if !self.ref_is_point(&b_ref) && matches!(b_entity, Some((_, Kind::Line))) {
            let Some((b_idx, _)) = b_entity else { return };
            self.r_point_on_entity(x, a_ref, b_idx, Kind::Line, r);
        } else if !self.ref_is_point(&b_ref)
            && matches!(b_entity, Some((_, Kind::Circle | Kind::Arc)))
        {
            let Some((b_idx, b_kind)) = b_entity else {
                return;
            };
            self.r_point_on_entity(x, a_ref, b_idx, b_kind, r);
        } else if !self.ref_is_point(&b_ref) && matches!(b_entity, Some((_, Kind::Ellipse))) {
            let Some((b_idx, _)) = b_entity else { return };
            self.r_point_on_entity(x, a_ref, b_idx, Kind::Ellipse, r);
        } else if !self.ref_is_point(&b_ref) && matches!(b_entity, Some((_, Kind::Spline))) {
            let Some((b_idx, _)) = b_entity else { return };
            self.r_point_on_entity(x, a_ref, b_idx, Kind::Spline, r);
        } else if !self.ref_is_point(&a_ref)
            && matches!(a_entity, Some((_, Kind::Line)))
            && self.ref_is_point(&b_ref)
        {
            let Some((a_idx, _)) = a_entity else { return };
            self.r_point_on_entity(x, b_ref, a_idx, Kind::Line, r);
        } else if !self.ref_is_point(&a_ref)
            && matches!(a_entity, Some((_, Kind::Circle | Kind::Arc)))
            && self.ref_is_point(&b_ref)
        {
            let Some((a_idx, a_kind)) = a_entity else {
                return;
            };
            self.r_point_on_entity(x, b_ref, a_idx, a_kind, r);
        } else if !self.ref_is_point(&a_ref)
            && matches!(a_entity, Some((_, Kind::Ellipse)))
            && self.ref_is_point(&b_ref)
        {
            let Some((a_idx, _)) = a_entity else { return };
            self.r_point_on_entity(x, b_ref, a_idx, Kind::Ellipse, r);
        } else if !self.ref_is_point(&a_ref)
            && matches!(a_entity, Some((_, Kind::Spline)))
            && self.ref_is_point(&b_ref)
        {
            let Some((a_idx, _)) = a_entity else { return };
            self.r_point_on_entity(x, b_ref, a_idx, Kind::Spline, r);
        } else {
            let pa = self.point(x, a_ref);
            let pb = self.point(x, b_ref);
            r.push(pa[0] - pb[0]);
            r.push(pa[1] - pb[1]);
        }
    }
}
