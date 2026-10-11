use super::geom::{bezier_closest_t, bezier_deriv};
use super::{Problem, P2};
use crate::constraints::{Constraint, PointSelector, Ref, RefRole};
use crate::{Kind, DEG2RAD, MIN_SEMI_AXIS_SQ};

impl Problem<'_> {
    // horizontal (`horizontal=true`) / vertical share structure: the a/b form
    // equalizes a coordinate of two points, the target form equalizes the two
    // ends of a single line.
    pub(super) fn r_axis_aligned(
        &self,
        c: &Constraint,
        x: &[f64],
        r: &mut Vec<f64>,
        horizontal: bool,
    ) {
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

    pub(super) fn r_parallel(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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
        // sin(angle) times a seed length (see `scale.rs`). The raw cross
        // product scaled with length squared, and shrinking either line was a
        // way to satisfy it.
        let (nn, _) = self.norm_product(da, db);
        r.push(self.line_pair_len0(a_idx, b_idx) * (da[0] * db[1] - da[1] * db[0]) / nn);
    }

    pub(super) fn r_normal(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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
            // cos(angle) times a seed length, as for parallel.
            let (nn, _) = self.norm_product(da, db);
            r.push(self.line_pair_len0(a_idx, b_idx) * (da[0] * db[0] + da[1] * db[1]) / nn);
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
        // The curve's unit normal at the contact; the line must run along it.
        let nd = match self.kind_of(arc_idx) {
            Kind::Spline => self.spline_normal(x, arc_idx, arc_pt, contact),
            Kind::Ellipse => self.ellipse_normal(x, arc_idx, contact),
            _ => self.radius_dir(x, arc_idx, arc_pt, contact),
        };
        // sin(angle to the normal) times the line's seed length.
        let scale = self.line_len0(line_idx) / self.dir_norm(line_dir);
        r.push(scale * (line_dir[0] * nd[1] - line_dir[1] * nd[0]));
    }

    /// Unit normal of a spline at the point a normal constraint names: its
    /// start or end for those selectors, otherwise the curve point closest to
    /// the contact. A spline has no centre, so reading its first control
    /// point as one (the circle path) made the line merely pass through it.
    fn spline_normal(&self, x: &[f64], index: u32, sel: PointSelector, contact: P2) -> P2 {
        let sp = self.params(x, index);
        let t = match sel {
            PointSelector::Start => 0.0,
            PointSelector::End => 1.0,
            _ => bezier_closest_t(sp, contact),
        };
        let d = bezier_deriv(sp, t);
        let n = (d[0] * d[0] + d[1] * d[1]).sqrt();
        if n < 1e-12 {
            return [0.0, 0.0];
        }
        [-d[1] / n, d[0] / n]
    }

    /// Unit normal of an ellipse at `contact`: the gradient of its conic
    /// `(u/a)^2 + (v/b)^2`. The line through the centre (the circle path) is
    /// normal to an ellipse only at its four axis ends.
    fn ellipse_normal(&self, x: &[f64], index: u32, contact: P2) -> P2 {
        let ep = self.params(x, index);
        let theta = ep[4] * DEG2RAD;
        let (ct, st) = (theta.cos(), theta.sin());
        let (dx, dy) = (contact[0] - ep[0], contact[1] - ep[1]);
        let gu = (dx * ct + dy * st) / (ep[2] * ep[2]).max(MIN_SEMI_AXIS_SQ);
        let gv = (dy * ct - dx * st) / (ep[3] * ep[3]).max(MIN_SEMI_AXIS_SQ);
        let g = [gu * ct - gv * st, gu * st + gv * ct];
        let n = (g[0] * g[0] + g[1] * g[1]).sqrt();
        if n < 1e-12 {
            return [0.0, 0.0];
        }
        [g[0] / n, g[1] / n]
    }

    pub(super) fn r_angle(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
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
        // user-facing value stays non-negative. The signed difference is
        // wrapped back into (-180, 180]: atan2 jumps at the +-180 cut, so a
        // target of 180 against a line at -179 would otherwise read -359 and
        // steer the solver the long way round. The angle error is weighted by
        // a seed length so the row reads as a displacement like the others.
        let err = match c.sign {
            Some(s) => {
                let d = cross.atan2(dot) - s * value.to_radians();
                d.sin().atan2(d.cos())
            }
            None => cross.abs().atan2(dot) - value.to_radians(),
        };
        r.push(self.line_pair_len0(a_idx, b_idx) * err);
    }
}
