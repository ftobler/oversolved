use super::Problem;
use crate::constraints::{Constraint, Ref, RefRole};
use crate::Kind;

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
        r.push(da[0] * db[1] - da[1] * db[0]);
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
        // user-facing value stays non-negative.
        match c.sign {
            Some(s) => r.push(cross.atan2(dot) - s * value.to_radians()),
            None => r.push(cross.abs().atan2(dot) - value.to_radians()),
        }
    }
}
