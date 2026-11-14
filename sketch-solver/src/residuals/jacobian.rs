//! Analytic and finite-difference Jacobian rows for the constraint set.

use super::geom::is_curve;
use super::misc::{anchor_is_first_pair, group_coord_count};
use super::Problem;
use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::fit_spline::ParamLayout;
use crate::{Kind, DEG2RAD};
use nalgebra::DMatrix;
use solver_core::sparse::SparseRow;

/// One Jacobian row under construction. A column may be added more than once
/// (two point references on the same entity, say), and `finish` sums the
/// repeats: `jtj_diag` squares sparse entries one by one, so a repeated column
/// would read `a² + b²` where the true entry is `(a + b)²`.
struct RowBuf(Vec<(usize, f64)>);

impl RowBuf {
    fn new() -> Self {
        RowBuf(Vec::new())
    }

    fn add(&mut self, col: usize, v: f64) {
        self.0.push((col, v));
    }

    fn finish(mut self) -> SparseRow {
        self.0.sort_unstable_by_key(|&(col, _)| col);
        let mut out: SparseRow = Vec::with_capacity(self.0.len());
        for (col, v) in self.0 {
            match out.last_mut() {
                Some(last) if last.0 == col => last.1 += v,
                _ => out.push((col, v)),
            }
        }
        out.retain(|&(_, v)| v != 0.0);
        out
    }
}

/// Central-difference step for one param: `cbrt(eps)` is the three-point
/// stencil's truncation/round-off balance, times the param's own magnitude and
/// floored at the problem's local length. The floor used to be a fixed 1.0,
/// which on a 0.01 mm sketch stepped 6e-4 of the geometry: the derivative
/// became a chord across a visible arc instead of a tangent. A zero floor has
/// nothing to read and keeps the unit step.
fn fd_step(xj: f64, floor: f64) -> f64 {
    let floor = if floor > 0.0 { floor } else { 1.0 };
    f64::EPSILON.cbrt() * xj.abs().max(floor)
}

/// Bounding-box diagonal of a point list, the local scale of a chain carrier.
fn bbox_span(points: &[[f64; 2]]) -> f64 {
    let (mut min, mut max) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for p in points {
        for (k, v) in p.iter().enumerate() {
            min[k] = min[k].min(*v);
            max[k] = max[k].max(*v);
        }
    }
    (max[0] - min[0]).hypot(max[1] - min[1])
}

impl Problem<'_> {
    // ─── Analytic Jacobian ───
    //
    // Derivative rows that mirror `residuals` row-for-row. Smooth/explicit
    // constraints get hand-written derivatives; the gnarlier ones (those whose
    // residual normalizes a direction or goes through atan2) fall back to a
    // per-constraint central finite difference over only their involved params.
    // The fallback keeps correctness trivially (it IS finite differences) while
    // the common cheap constraints avoid the O(2N) full-FD cost.

    /// Sparse rows of the full stacked Jacobian: one row per residual
    /// (constraint rows from `jac_one`) followed by the pin and equality-pin
    /// rows. Shared by both the dense and sparse Jacobian builders. Rows are
    /// built sparse from the start; materializing them n wide made every drag
    /// tick O(m n) before the sparse solver even saw them.
    fn jacobian_rows(&self, x: &[f64]) -> Vec<SparseRow> {
        let mut rows: Vec<SparseRow> = Vec::new();
        // One perturbation buffer for every finite-difference constraint.
        let mut scratch = x.to_vec();
        for c in &self.constraints {
            self.jac_one(c, x, &mut scratch, &mut rows);
        }
        for &i in &self.pinned_indices {
            rows.push(vec![(i, 1.0)]);
        }
        for &(i, _) in &self.equality_pins {
            rows.push(vec![(i, 1.0)]);
        }
        rows
    }

    /// Jacobian of the full stacked residual at `x` (m rows x `n` params).
    pub fn jacobian(&self, x: &[f64], n: usize) -> DMatrix<f64> {
        let rows = self.jacobian_rows(x);
        let mut j = DMatrix::<f64>::zeros(rows.len(), n);
        for (r_i, row) in rows.iter().enumerate() {
            for &(c_i, v) in row {
                j[(r_i, c_i)] = v;
            }
        }
        j
    }

    /// Sparse Jacobian: each row as `(col_index, value)` pairs for nonzero
    /// entries, the same row set as `jacobian`. `n` is kept for symmetry with
    /// the dense builder; sparse rows carry their own column indices.
    pub fn jacobian_sparse(&self, x: &[f64], _n: usize) -> Vec<SparseRow> {
        self.jacobian_rows(x)
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
                let size = self.param_count_of(*index);
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
    /// analytic derivative, and for any constraint that names a fit spline
    /// through a selector with no closed-form point (see
    /// `has_unnamed_fit_spline_operand`).
    /// `xp` is a copy of `x` the caller owns; each perturbed param is restored
    /// before the next, so it is a copy of `x` again on return.
    fn fd_constraint_rows(&self, c: &Constraint, x: &[f64], xp: &mut [f64]) -> Vec<SparseRow> {
        let base = self.residual_one_vec(c, x);
        let k = base.len();
        if k == 0 {
            return Vec::new();
        }
        let mut rows: Vec<RowBuf> = (0..k).map(|_| RowBuf::new()).collect();
        let floor = self.fd_floor(c, x);
        for j in self.involved_params(c) {
            let h = fd_step(x[j], floor);
            xp[j] = x[j] + h;
            let fp = self.residual_one_vec(c, xp);
            xp[j] = x[j] - h;
            let fm = self.residual_one_vec(c, xp);
            xp[j] = x[j];
            let inv = 1.0 / (2.0 * h);
            for (row, (&p, &m)) in fp.iter().zip(fm.iter()).enumerate() {
                rows[row].add(j, (p - m) * inv);
            }
        }
        rows.into_iter().map(RowBuf::finish).collect()
    }

    /// The finite-difference floor for one constraint: the sketch scale reduced
    /// to the world span of the entities it touches.
    ///
    /// The sketch scale is the bounding-box diagonal of the whole drawing, so
    /// a millimetre feature inside a metre-wide sketch would be differenced at
    /// a step proportional to the metre. Taking the smallest involved entity
    /// span keeps the step proportional to the thing the residual is computed
    /// on. A point operand has no span of its own and leaves the sketch scale.
    fn fd_floor(&self, c: &Constraint, x: &[f64]) -> f64 {
        let mut floor = self.scale();
        for (_, r) in &c.refs {
            let Ref::Entity { index, .. } = r else {
                continue;
            };
            let span = self.entity_span(*index, x);
            if span > 0.0 {
                floor = floor.min(span);
            }
        }
        floor
    }

    /// A characteristic world span of one entity at `x`: line length, circle or
    /// arc diameter, the ellipse's major diameter, or the bounding-box diagonal
    /// of a spline's control points or a fit spline's fit points. A point is 0,
    /// which `fd_floor` reads as "no local scale".
    fn entity_span(&self, index: u32, x: &[f64]) -> f64 {
        let ep = self.params(x, index);
        match self.kind_of(index) {
            Kind::Line => (ep[2] - ep[0]).hypot(ep[3] - ep[1]),
            Kind::Circle | Kind::Arc => 2.0 * ep[2].abs(),
            Kind::Ellipse => 2.0 * ep[2].abs().max(ep[3].abs()),
            Kind::Point => 0.0,
            Kind::Spline => bbox_span(&[
                [ep[0], ep[1]],
                [ep[2], ep[3]],
                [ep[4], ep[5]],
                [ep[6], ep[7]],
            ]),
            Kind::FitSpline => {
                let Some(layout) = self.fit_layout(index) else {
                    return 0.0;
                };
                let points: Vec<[f64; 2]> = (0..layout.points)
                    .map(|i| [ep[2 * i], ep[2 * i + 1]])
                    .collect();
                bbox_span(&points)
            }
        }
    }

    /// True when the constraint names a fit spline through a selector
    /// `Problem::point` resolves to the chain's mid-chord point (`Absent`, a
    /// centre, or any other selector that is not a named fit point or handle).
    ///
    /// That point depends on every param of the entity through the tridiagonal
    /// interpolation, so there is no small analytic Jacobian for it. Without
    /// this route `point_jac` returned an empty row while the residual was
    /// nonzero: LM could not reduce it, the verdict read Overconstrained, and
    /// the rank pass never saw the row.
    fn has_unnamed_fit_spline_operand(&self, c: &Constraint) -> bool {
        c.refs.iter().any(|(_, r)| match r {
            Ref::Entity { index, point } => {
                self.kind_of(*index) == Kind::FitSpline
                    && !matches!(
                        point,
                        PointSelector::Start
                            | PointSelector::End
                            | PointSelector::Fit(_)
                            | PointSelector::C1
                            | PointSelector::C2
                    )
            }
            Ref::External { .. } => false,
        })
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
                    // Fit spline: every named selector is one of the entity's
                    // own param pairs, so the Jacobian is the identity there.
                    // The curve midpoint (an unnamed selector) depends on every
                    // param through the interpolation; `jac_one` routes any
                    // constraint that names it to the finite-difference rows
                    // before it can reach this arm, and the empty result here
                    // stays as the explicit marker that no analytic row exists.
                    Kind::FitSpline => {
                        let layout = self.fit_layout(index).unwrap_or(ParamLayout {
                            points: 0,
                            handle_start: false,
                            handle_end: false,
                        });
                        match point {
                            PointSelector::Start => vec![(off, 1.0, 0.0), (off + 1, 0.0, 1.0)],
                            PointSelector::End => {
                                let base = off + 2 * layout.points.saturating_sub(1);
                                vec![(base, 1.0, 0.0), (base + 1, 0.0, 1.0)]
                            }
                            PointSelector::Fit(k) => {
                                let base = off + 2 * k as usize;
                                vec![(base, 1.0, 0.0), (base + 1, 0.0, 1.0)]
                            }
                            PointSelector::C1 => {
                                let base = off + 2 * layout.points;
                                vec![(base, 1.0, 0.0), (base + 1, 0.0, 1.0)]
                            }
                            PointSelector::C2 => {
                                let base = off
                                    + 2 * layout.points
                                    + if layout.handle_start { 2 } else { 0 };
                                vec![(base, 1.0, 0.0), (base + 1, 0.0, 1.0)]
                            }
                            _ => Vec::new(),
                        }
                    }
                }
            }
        }
    }

    fn jac_one(&self, c: &Constraint, x: &[f64], xp: &mut [f64], rows: &mut Vec<SparseRow>) {
        let Some(kind) = c.kind() else { return };
        // The fit-spline mid-chord reference is the one point `point()` can
        // resolve without a small analytic Jacobian, so the whole constraint
        // takes the finite-difference row. Checked before the dispatch because
        // several analytic arms (point distance, axis alignment, fixed)
        // resolve operands through `point_jac`.
        if self.has_unnamed_fit_spline_operand(c) {
            rows.extend(self.fd_constraint_rows(c, x, xp));
            return;
        }
        match kind {
            ConstraintKind::Horizontal => self.jac_axis_aligned(c, x, rows, true),
            ConstraintKind::Vertical => self.jac_axis_aligned(c, x, rows, false),
            ConstraintKind::Length => self.jac_length(c, x, rows),
            ConstraintKind::Radius => self.jac_single_param(c, rows, 2, 1.0),
            ConstraintKind::Diameter => self.jac_single_param(c, rows, 2, 2.0),
            ConstraintKind::Parallel => self.jac_parallel(c, x, rows),
            ConstraintKind::Concentric => self.jac_concentric(c, rows),
            ConstraintKind::EqualLength => self.jac_equal_length(c, x, rows),
            ConstraintKind::PointDistance => self.jac_point_distance(c, x, rows),
            ConstraintKind::PointDistanceX => self.jac_point_distance_axis(c, x, rows, 0),
            ConstraintKind::PointDistanceY => self.jac_point_distance_axis(c, x, rows, 1),
            ConstraintKind::RadiusDifference => self.jac_radius_difference(c, x, rows),
            ConstraintKind::Coincident => self.jac_coincident(c, x, xp, rows),
            ConstraintKind::Fixed => self.jac_fixed(c, x, rows),
            ConstraintKind::Group => self.jac_group(c, x, rows),
            // Direction-normalizing / atan2 residuals: finite-difference fallback.
            ConstraintKind::LineDistance
            | ConstraintKind::Normal
            | ConstraintKind::Angle
            | ConstraintKind::Tangent
            | ConstraintKind::Midpoint => rows.extend(self.fd_constraint_rows(c, x, xp)),
        }
    }

    fn jac_axis_aligned(
        &self,
        c: &Constraint,
        x: &[f64],
        rows: &mut Vec<SparseRow>,
        horizontal: bool,
    ) {
        // component index in a 2D point: y for horizontal, x for vertical.
        let comp = if horizontal { 1 } else { 0 };
        if let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) {
            let mut row = RowBuf::new();
            for (i, dx, dy) in self.point_jac(x, a) {
                row.add(i, if comp == 1 { dy } else { dx });
            }
            for (i, dx, dy) in self.point_jac(x, b) {
                row.add(i, -(if comp == 1 { dy } else { dx }));
            }
            rows.push(row.finish());
        } else if let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Target) {
            let off = self.offset_of(index);
            let mut row = RowBuf::new();
            if horizontal {
                row.add(off + 3, 1.0); // ep[3] (end.y)
                row.add(off + 1, -1.0); // ep[1] (start.y)
            } else {
                row.add(off + 2, 1.0); // ep[2] (end.x)
                row.add(off, -1.0); // ep[0] (start.x)
            }
            rows.push(row.finish());
        }
    }

    fn jac_length(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
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
        let mut row = RowBuf::new();
        if nrm > 0.0 {
            row.add(off, -dx / nrm);
            row.add(off + 1, -dy / nrm);
            row.add(off + 2, dx / nrm);
            row.add(off + 3, dy / nrm);
        }
        rows.push(row.finish());
    }

    fn jac_single_param(
        &self,
        c: &Constraint,
        rows: &mut Vec<SparseRow>,
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
        let mut row = RowBuf::new();
        row.add(off + local, coeff);
        rows.push(row.finish());
    }

    fn jac_parallel(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
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
        // r = L * u / N with u = da.x*db.y - da.y*db.x, N = |da| |db| and L a
        // constant seed length. dr = L * (du / N - u * dN / N^2); N is
        // constant once floored (see `norm_product`).
        let l = self.line_pair_len0(ai, bi);
        let u = da[0] * db[1] - da[1] * db[0];
        let (nn, live) = self.norm_product(da, db);
        let (na, nb) = (
            (da[0] * da[0] + da[1] * da[1]).sqrt(),
            (db[0] * db[0] + db[1] * db[1]).sqrt(),
        );
        let k = if live { u / (nn * nn) } else { 0.0 };
        // Derivatives w.r.t. the direction vectors themselves.
        let d_da = [
            l * (db[1] / nn - k * nb * da[0] / na.max(f64::MIN_POSITIVE)),
            l * (-db[0] / nn - k * nb * da[1] / na.max(f64::MIN_POSITIVE)),
        ];
        let d_db = [
            l * (-da[1] / nn - k * na * db[0] / nb.max(f64::MIN_POSITIVE)),
            l * (da[0] / nn - k * na * db[1] / nb.max(f64::MIN_POSITIVE)),
        ];
        // da = a_end - a_start, db = b_end - b_start.
        let mut row = RowBuf::new();
        row.add(oa, -d_da[0]);
        row.add(oa + 1, -d_da[1]);
        row.add(oa + 2, d_da[0]);
        row.add(oa + 3, d_da[1]);
        row.add(ob, -d_db[0]);
        row.add(ob + 1, -d_db[1]);
        row.add(ob + 2, d_db[0]);
        row.add(ob + 3, d_db[1]);
        rows.push(row.finish());
    }

    fn jac_concentric(&self, c: &Constraint, rows: &mut Vec<SparseRow>) {
        let (Some(Ref::Entity { index: ai, .. }), Some(Ref::Entity { index: bi, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        let (oa, ob) = (self.offset_of(ai), self.offset_of(bi));
        let mut rx = RowBuf::new();
        rx.add(oa, 1.0);
        rx.add(ob, -1.0);
        rows.push(rx.finish());
        let mut ry = RowBuf::new();
        ry.add(oa + 1, 1.0);
        ry.add(ob + 1, -1.0);
        rows.push(ry.finish());
    }

    fn jac_equal_length(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
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
            let mut row = RowBuf::new();
            row.add(oa + 2, 1.0);
            row.add(ob + 2, -1.0);
            rows.push(row.finish());
            return;
        }
        if ka != Kind::Line || kb != Kind::Line {
            return;
        }
        let ea = self.params(x, ai);
        let eb = self.params(x, bi);
        let na = ((ea[2] - ea[0]).powi(2) + (ea[3] - ea[1]).powi(2)).sqrt();
        let nb = ((eb[2] - eb[0]).powi(2) + (eb[3] - eb[1]).powi(2)).sqrt();
        let mut row = RowBuf::new();
        if na > 0.0 {
            let (dx, dy) = (ea[2] - ea[0], ea[3] - ea[1]);
            row.add(oa, -dx / na);
            row.add(oa + 1, -dy / na);
            row.add(oa + 2, dx / na);
            row.add(oa + 3, dy / na);
        }
        if nb > 0.0 {
            let (dx, dy) = (eb[2] - eb[0], eb[3] - eb[1]);
            row.add(ob, dx / nb);
            row.add(ob + 1, dy / nb);
            row.add(ob + 2, -dx / nb);
            row.add(ob + 3, -dy / nb);
        }
        rows.push(row.finish());
    }

    fn jac_point_distance(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
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
        let mut row = RowBuf::new();
        // A zero euclidean distance is a coincident, which one row cannot
        // express: the mutation layer refuses value 0 instead of authoring
        // this kink.
        if d > 0.0 {
            for (i, dpx, dpy) in self.point_jac(x, a) {
                row.add(i, (-ux / d) * dpx + (-uy / d) * dpy);
            }
            for (i, dpx, dpy) in self.point_jac(x, b) {
                row.add(i, (ux / d) * dpx + (uy / d) * dpy);
            }
        }
        rows.push(row.finish());
    }

    /// Analytic row for one axis of the point-to-point dimension. `axis` is 0
    /// for x and 1 for y, the same component `r_point_distance_axis` measures.
    ///
    /// The unsigned residual is `|d| - value`: its slope is the sign of `d`,
    /// and at the kink `d == 0` any non-zero slope is full rank, so +1 is
    /// taken (the signed default elsewhere). The old finite difference read
    /// (|h| - |-h|) / 2h = 0 there and left an empty row, which cost the
    /// sketch the degree of freedom the zero dimension should remove and made
    /// the dimension read redundant.
    fn jac_point_distance_axis(
        &self,
        c: &Constraint,
        x: &[f64],
        rows: &mut Vec<SparseRow>,
        axis: usize,
    ) {
        let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        if c.value.is_none() {
            return;
        }
        let d = self.point(x, b)[axis] - self.point(x, a)[axis];
        // A signed residual is `d - sign * value`: the orientation scales the
        // target, so its slope stays +1 whichever side was authored.
        let slope = if c.sign.is_some() || d == 0.0 {
            1.0
        } else {
            d.signum()
        };
        let mut row = RowBuf::new();
        for (i, dpx, dpy) in self.point_jac(x, a) {
            row.add(i, -slope * if axis == 0 { dpx } else { dpy });
        }
        for (i, dpx, dpy) in self.point_jac(x, b) {
            row.add(i, slope * if axis == 0 { dpx } else { dpy });
        }
        rows.push(row.finish());
    }

    /// Analytic row for the radial gap. `r_radius_difference` measures
    /// `|ra - rb| - value`, whose slope is the sign of the gap; the gap of
    /// zero is the same kink as the axis distance, and +1 there keeps the row
    /// full rank so a zero gap still ties the two radii together.
    fn jac_radius_difference(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
        let (Some(Ref::Entity { index: ai, .. }), Some(Ref::Entity { index: bi, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        if c.value.is_none() || !is_curve(self.kind_of(ai)) || !is_curve(self.kind_of(bi)) {
            return;
        }
        let gap = self.params(x, ai)[2] - self.params(x, bi)[2];
        let slope = if gap == 0.0 { 1.0 } else { gap.signum() };
        let mut row = RowBuf::new();
        row.add(self.offset_of(ai) + 2, slope);
        row.add(self.offset_of(bi) + 2, -slope);
        rows.push(row.finish());
    }

    fn jac_coincident(&self, c: &Constraint, x: &[f64], xp: &mut [f64], rows: &mut Vec<SparseRow>) {
        if !self.coincident_is_point_point(c) {
            rows.extend(self.fd_constraint_rows(c, x, xp));
            return;
        }
        let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return;
        };
        // r = [pa.x - pb.x, pa.y - pb.y]
        let mut rx = RowBuf::new();
        let mut ry = RowBuf::new();
        for (i, dpx, dpy) in self.point_jac(x, a) {
            rx.add(i, dpx);
            ry.add(i, dpy);
        }
        for (i, dpx, dpy) in self.point_jac(x, b) {
            rx.add(i, -dpx);
            ry.add(i, -dpy);
        }
        rows.push(rx.finish());
        rows.push(ry.finish());
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
                    || b_kind == Some(Kind::Ellipse)
                    || b_kind == Some(Kind::Spline) || b_kind == Some(Kind::FitSpline)))
            // point-on-curve (reversed): A is a curve, B is a point
            || (!self.ref_is_point(&a_ref) && self.ref_is_point(&b_ref)
                && (a_kind == Some(Kind::Line)
                    || a_kind == Some(Kind::Circle) || a_kind == Some(Kind::Arc)
                    || a_kind == Some(Kind::Ellipse)
                    || a_kind == Some(Kind::Spline) || a_kind == Some(Kind::FitSpline)))
        )
    }

    /// Analytic rows for the rigid group, mirroring `r_group` row for row: the
    /// member param's own +1, and (for a coordinate row) the anchor point's
    /// point Jacobian negated on the row's axis. A point member's two rows are
    /// `point_jac(target) - point_jac(anchor)`, the same reference-offset-plus-
    /// transform shape the residual uses.
    fn jac_group(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
        let (
            Some(Ref::Entity {
                index: member,
                point: member_point,
            }),
            Some(
                anchor @ Ref::Entity {
                    index: anchor_index,
                    point: anchor_point,
                },
            ),
        ) = (c.ref_for(RefRole::Target), c.ref_for(RefRole::A))
        else {
            return;
        };
        if member_point.is_present() {
            let target = Ref::Entity {
                index: member,
                point: member_point,
            };
            if target == anchor {
                return;
            }
            let mut rx = RowBuf::new();
            let mut ry = RowBuf::new();
            for (col, dpx, dpy) in self.point_jac(x, target) {
                rx.add(col, dpx);
                ry.add(col, dpy);
            }
            for (col, dpx, dpy) in self.point_jac(x, anchor) {
                rx.add(col, -dpx);
                ry.add(col, -dpy);
            }
            rows.push(rx.finish());
            rows.push(ry.finish());
            return;
        }
        let off = self.offset_of(member);
        let size = self.param_count_of(member);
        let coords = group_coord_count(self.kind_of(member), size);
        let skip_anchor_pair =
            member == anchor_index && size >= 2 && anchor_is_first_pair(anchor_point);
        for i in 0..size {
            if skip_anchor_pair && i < 2 {
                continue;
            }
            let mut row = RowBuf::new();
            row.add(off + i, 1.0);
            if i < coords {
                for (col, dpx, dpy) in self.point_jac(x, anchor) {
                    row.add(col, -(if i % 2 == 0 { dpx } else { dpy }));
                }
            }
            rows.push(row.finish());
        }
    }

    fn jac_fixed(&self, c: &Constraint, x: &[f64], rows: &mut Vec<SparseRow>) {
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
            let mut rx = RowBuf::new();
            let mut ry = RowBuf::new();
            for (i, dpx, dpy) in self.point_jac(x, target) {
                rx.add(i, dpx);
                ry.add(i, dpy);
            }
            rows.push(rx.finish());
            rows.push(ry.finish());
        } else {
            let off = self.offset_of(index);
            let size = self.param_count_of(index);
            for i in 0..size {
                rows.push(vec![(off + i, 1.0)]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fd_step;

    #[test]
    fn the_finite_difference_step_floor_tracks_the_caller_length() {
        // A param at (or through) zero used to step by cbrt(eps) * 1.0 whatever
        // the drawing's size: 6e-6 world, or 6e-4 of a 0.01 mm sketch, which
        // differenced a curve over a visible arc. The floor now tracks the
        // length the caller passes, so the step is the same fraction of the
        // feature at any scale.
        let small = fd_step(0.0, 0.01);
        let large = fd_step(0.0, 100.0);
        assert!(
            (large / small - 1e4).abs() < 1e-9,
            "the floor did not track the scale: {small:e} vs {large:e}"
        );
        assert_eq!(fd_step(0.0, 1.0), f64::EPSILON.cbrt());
        // Above the floor the step follows the param's own magnitude, which is
        // what keeps a coordinate far from the origin differenced relatively.
        assert!(fd_step(50.0, 0.01) > fd_step(0.5, 0.01));
        assert_eq!(fd_step(50.0, 0.01), fd_step(50.0, 1.0));
        // A zero floor has nothing to read and keeps the unit step rather than
        // dividing by a zero one.
        assert_eq!(fd_step(0.0, 0.0), f64::EPSILON.cbrt());
    }
}
