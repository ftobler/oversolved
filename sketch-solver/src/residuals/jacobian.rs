//! Analytic and finite-difference Jacobian rows for the constraint set.

use super::geom::is_curve;
use super::Problem;
use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::{Kind, DEG2RAD};
use nalgebra::DMatrix;
use solver_core::sparse::SparseRow;

impl Problem<'_> {
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
