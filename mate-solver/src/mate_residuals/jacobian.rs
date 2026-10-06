//! Analytic Jacobian fillers for the mate residuals, split out of
//! `mate_residuals.rs`. Each method here is the derivative of the residual
//! block built by the matching arm of `MateProblem::residuals`; the method
//! bodies and arithmetic are unchanged.

use nalgebra::DMatrix;

use super::math::*;
use super::{Mate, MateKind, MateProblem};

// ─── Jacobian ───

impl MateProblem {
    /// Build the full dense Jacobian (m × n) at x.
    pub(super) fn jacobian(&self, x: &[f64]) -> DMatrix<f64> {
        let mut j = DMatrix::zeros(self.m, self.n);
        let mut row = 0usize;
        // One finite-difference scratch shared by every filler below. The
        // fillers clone `x` into it and restore each column, so a single
        // allocation per Jacobian replaces one per tangential/roll mate (5.4).
        let mut scratch = x.to_vec();

        for (mi, mate) in self.mates.iter().enumerate() {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;
            let row_start = row;

            match mate.kind {
                MateKind::Fixed => {
                    // Point coincidence with offset.
                    self.fill_point_coincidence_offset(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.offset,
                    );
                    row += 3;
                    // Signed axis difference: a_w - sign * b_w.
                    self.fill_axis_difference(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                    // Absolute roll about A's current world axis.
                    // Finite-differenced so the Jacobian tracks the moving axis
                    // the residual measures against (see fill_roll_fd).
                    self.fill_roll_fd(&mut j, row, mi, off_a, off_b, x, &mut scratch);
                    row += 1;
                }
                MateKind::Spherical => {
                    self.fill_point_coincidence(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                    );
                    row += 3;
                }
                MateKind::Parallel => {
                    self.fill_axis_dot(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                    );
                    row += 1;
                }
                MateKind::Sliding => {
                    // Signed axis difference w/ flip.
                    self.fill_axis_difference(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                    // Perp displacement cross.
                    self.fill_perp_cross(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.a.geometry.axis,
                    );
                    row += 3;
                    // Absolute roll pin -- finite-differenced, same as Fixed's
                    // (see fill_roll_fd).
                    self.fill_roll_fd(&mut j, row, mi, off_a, off_b, x, &mut scratch);
                    row += 1;
                }
                MateKind::Rotating => {
                    self.fill_point_coincidence(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                    );
                    row += 3;
                    self.fill_axis_difference(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                }
                MateKind::SlidingRotating => {
                    self.fill_axis_difference(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                    self.fill_perp_cross(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.a.geometry.axis,
                    );
                    row += 3;
                }
                MateKind::Tangential => {
                    self.fill_tangential(&mut j, row, mi, off_a, off_b, x, mate, &mut scratch);
                    row += 1;
                }
                MateKind::CopyRotation => {
                    self.fill_copy_rotation(&mut j, row, mi, off_a, off_b, x, mate.ratio);
                    row += 1;
                }
                MateKind::ParallelPlaneDistance => {
                    self.fill_parallel_plane_dist(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.a.geometry.axis,
                    );
                    row += 1;
                    self.fill_axis_dot(
                        &mut j,
                        row,
                        off_a,
                        off_b,
                        x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                    );
                    row += 1;
                }
            }

            // Same weight the residual block carries, applied to the rows just
            // written, so the Jacobian stays the exact derivative of the
            // weighted residual. One helper for both paths keeps them from
            // drifting apart.
            scale_rows(&mut j, row_start, row, mate.weight);
        }

        // Quaternion norm residuals (1 per body whose full block is in the
        // buffer).
        for bi in 0..self.bodies.len() {
            if !self.body_block_present(bi, x.len()) {
                continue;
            }
            let off = bi * 7;
            j[(row, off + 3)] = 2.0 * x[off + 3];
            j[(row, off + 4)] = 2.0 * x[off + 4];
            j[(row, off + 5)] = 2.0 * x[off + 5];
            j[(row, off + 6)] = 2.0 * x[off + 6];
            row += 1;
        }

        // Grounded-body pin residuals (7 per grounded body in the buffer).
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] && self.body_block_present(bi, x.len()) {
                let off = bi * 7;
                for jj in 0..7 {
                    j[(row, off + jj)] = 1.0;
                    row += 1;
                }
            }
        }

        j
    }

    // ─── Jacobian fillers per residual kind ───

    /// Point coincidence: `p_a_world - p_b_world`.
    #[allow(clippy::too_many_arguments)]
    fn fill_point_coincidence(
        &self,
        j: &mut DMatrix<f64>,
        row0: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        pa: &[f64; 3],
        pb: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let dpa = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, pa);
        let dpb = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, pb);

        // `+=`, not `=`: when off_a == off_b (a self-mate, guarded against
        // upstream but the filler must not itself assume distinct bodies) the
        // A and B writes land in the same cell, and `=` would let B's write
        // silently discard A's instead of the two contributions summing.
        for comp in 0..3 {
            let r = row0 + comp;
            j[(r, off_a + comp)] += 1.0;
            j[(r, off_a + 3)] += dpa[0][comp];
            j[(r, off_a + 4)] += dpa[1][comp];
            j[(r, off_a + 5)] += dpa[2][comp];
            j[(r, off_a + 6)] += dpa[3][comp];
            j[(r, off_b + comp)] += -1.0;
            j[(r, off_b + 3)] += -dpb[0][comp];
            j[(r, off_b + 4)] += -dpb[1][comp];
            j[(r, off_b + 5)] += -dpb[2][comp];
            j[(r, off_b + 6)] += -dpb[3][comp];
        }
    }

    /// Point coincidence with a local-frame offset vector: `p_a - p_b - R_a * offset`.
    #[allow(clippy::too_many_arguments)]
    fn fill_point_coincidence_offset(
        &self,
        j: &mut DMatrix<f64>,
        row0: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        pa: &[f64; 3],
        pb: &[f64; 3],
        offset: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let dpa = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, pa);
        let dpb = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, pb);
        // drot_vec_dq is linear in the vector it rotates, so differentiating the
        // offset vector directly IS the old `offset * d(a_w)` when the vector is
        // the axial `offset * axis_a` -- the scalar form's Jacobian falls out of
        // this one exactly, no special case.
        let d_off = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, offset);

        for comp in 0..3 {
            let r = row0 + comp;
            // `+=` throughout: see fill_point_coincidence's self-mate note.
            // ∂r/∂t_a = +I
            j[(r, off_a + comp)] += 1.0;
            // ∂r/∂q_a_i = drot_dq(q_a)(p_a)[i][comp] - drot_dq(q_a)(offset)[i][comp]
            for qi in 0..4 {
                j[(r, off_a + 3 + qi)] += dpa[qi][comp] - d_off[qi][comp];
            }
            // ∂r/∂t_b = -I
            j[(r, off_b + comp)] += -1.0;
            // ∂r/∂q_b_i = -drot_dq(q_b)(p_b)[i][comp]
            for qi in 0..4 {
                j[(r, off_b + 3 + qi)] += -dpb[qi][comp];
            }
        }
    }

    /// Signed axis difference: `a_w - sign * b_w` (3 residual components). Only
    /// the quaternions carry the axes, so the translation columns stay zero.
    #[allow(clippy::too_many_arguments)]
    fn fill_axis_difference(
        &self,
        j: &mut DMatrix<f64>,
        row0: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        axis_a: &[f64; 3],
        axis_b: &[f64; 3],
        sign: f64,
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);
        let db = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, axis_b);

        for comp in 0..3 {
            let r = row0 + comp;
            for qi in 0..4 {
                j[(r, off_a + 3 + qi)] += da[qi][comp];
                j[(r, off_b + 3 + qi)] += -sign * db[qi][comp];
            }
        }
    }

    /// Axis dot product: `dot(a_w, b_w) - sign` (1 residual).
    #[allow(clippy::too_many_arguments)]
    fn fill_axis_dot(
        &self,
        j: &mut DMatrix<f64>,
        row: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        axis_a: &[f64; 3],
        axis_b: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let a_w = rotate_vec(qa.0, qa.1, qa.2, qa.3, axis_a);
        let b_w = rotate_vec(qb.0, qb.1, qb.2, qb.3, axis_b);
        let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);
        let db = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, axis_b);

        for qi in 0..4 {
            j[(row, off_a + 3 + qi)] +=
                da[qi][0] * b_w[0] + da[qi][1] * b_w[1] + da[qi][2] * b_w[2];
            j[(row, off_b + 3 + qi)] +=
                a_w[0] * db[qi][0] + a_w[1] * db[qi][1] + a_w[2] * db[qi][2];
        }
    }

    /// Perpendicular displacement cross: `cross(p_a - p_b, a_w)` (3 residuals).
    /// Measures how far B's anchor point is from A's anchor axis.
    #[allow(clippy::too_many_arguments)]
    fn fill_perp_cross(
        &self,
        j: &mut DMatrix<f64>,
        row0: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        p_a: &[f64; 3],
        p_b: &[f64; 3],
        axis_a: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let pa_w = world_point(x, off_a, p_a);
        let pb_w = world_point(x, off_b, p_b);
        let a_w = rotate_vec(qa.0, qa.1, qa.2, qa.3, axis_a);

        let d = [pa_w[0] - pb_w[0], pa_w[1] - pb_w[1], pa_w[2] - pb_w[2]];

        // cross(r, w)[comp]: components:
        //   cross_x = d_y * w_z - d_z * w_y
        //   cross_y = d_z * w_x - d_x * w_z
        //   cross_z = d_x * w_y - d_y * w_x
        //
        // For each comp, (pos_idx, pos_wk, neg_idx, neg_wk):
        //   cross_comp = d[pos_idx] * w[pos_wk] - d[neg_idx] * w[neg_wk]
        let perp_terms: [(usize, usize, usize, usize); 3] = [
            (1, 2, 2, 1), // cross_x: d_y*w_z - d_z*w_y → pos=(1, z=2), neg=(2, y=1)
            (2, 0, 0, 2), // cross_y: d_z*w_x - d_x*w_z → pos=(2, x=0), neg=(0, z=2)
            (0, 1, 1, 0), // cross_z: d_x*w_y - d_y*w_x → pos=(0, y=1), neg=(1, x=0)
        ];

        for (comp, &(pos_di, pos_wk, neg_di, neg_wk)) in perp_terms.iter().enumerate() {
            let r = row0 + comp;

            // Translation A: d = pa_w - pb_w, so ∂d/∂t_a_i = +1 for i=pos_di,neg_di
            j[(r, off_a + pos_di)] += a_w[pos_wk];
            j[(r, off_a + neg_di)] += -a_w[neg_wk];

            // Translation B: d = pa_w - pb_w, so ∂d/∂t_b_i = -1 for i=pos_di,neg_di
            j[(r, off_b + pos_di)] += -a_w[pos_wk];
            j[(r, off_b + neg_di)] += a_w[neg_wk];

            // Quaternion A: ∂r/∂q_i = cross(∂p_a_w/∂q_i, a_w) + cross(d, ∂a_w/∂q_i)
            let dpa = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, p_a);
            let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);
            for qi in 0..4 {
                let dd_a = dpa[qi];
                let da_w_i = da[qi];
                let term = cross3(&dd_a, &a_w)[comp] + cross3(&d, &da_w_i)[comp];
                j[(r, off_a + 3 + qi)] += term;
            }

            // Quaternion B: ∂r/∂q_i = cross(-∂p_b_w/∂q_i, a_w)
            let dpb = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, p_b);
            for qi in 0..4 {
                let dd_b = dpb[qi];
                let term_b = -cross3(&dd_b, &a_w)[comp];
                j[(r, off_b + 3 + qi)] += term_b;
            }
        }
    }

    /// Tangential Jacobian: uses finite-difference on the single residual.
    /// The Tangential residual formula switches surface types, so an analytic
    /// Jacobian is high-branch. FD for 1-residual mates is cheap.
    #[allow(clippy::too_many_arguments)]
    fn fill_tangential(
        &self,
        j: &mut DMatrix<f64>,
        row: usize,
        mi: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        _mate: &Mate,
        scratch: &mut [f64],
    ) {
        let eps = 1e-6;
        let xp = scratch;
        xp.clone_from_slice(x);

        // Body A params (translation + quaternion).
        for col in off_a..off_a + 7 {
            let orig = xp[col];
            xp[col] = orig + eps;
            let fp = self.residual_at_mate(mi, xp);
            xp[col] = orig - eps;
            let fm = self.residual_at_mate(mi, xp);
            xp[col] = orig;
            j[(row, col)] = (fp - fm) / (2.0 * eps);
        }
        // Body B params.
        for col in off_b..off_b + 7 {
            let orig = xp[col];
            xp[col] = orig + eps;
            let fp = self.residual_at_mate(mi, xp);
            xp[col] = orig - eps;
            let fm = self.residual_at_mate(mi, xp);
            xp[col] = orig;
            j[(row, col)] = (fp - fm) / (2.0 * eps);
        }
    }

    /// Absolute roll residual for mate `mi` at x (Fixed and Sliding both carry
    /// their target in `mate.angle`). Used by `fill_roll_fd` for finite
    /// differencing.
    pub(super) fn roll_residual_at_mate(&self, mi: usize, x: &[f64]) -> f64 {
        let mate = &self.mates[mi];
        let off_a = mate.a.body_index as usize * 7;
        let off_b = mate.b.body_index as usize * 7;
        self.abs_roll_residual(x, mi, off_a, off_b, mate.angle)
    }

    /// Finite-difference Jacobian for the absolute roll residual (Fixed and
    /// Sliding). The residual measures the dihedral about A's CURRENT world
    /// axis (see `abs_roll_residual`), so the axis itself moves with the
    /// quaternion; central differencing captures that coupling exactly, whereas
    /// the old analytic `fill_copy_rotation` filler linearised about a fixed
    /// seed axis and disagreed with the residual off the seed. Same trusted
    /// pattern as `fill_tangential`; the roll row is a single residual, so this
    /// is cheap.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn fill_roll_fd(
        &self,
        j: &mut DMatrix<f64>,
        row: usize,
        mi: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        scratch: &mut [f64],
    ) {
        let eps = 1e-6;
        let xp = scratch;
        xp.clone_from_slice(x);
        for &base in &[off_a, off_b] {
            for col in base..base + 7 {
                let orig = xp[col];
                xp[col] = orig + eps;
                let fp = self.roll_residual_at_mate(mi, xp);
                xp[col] = orig - eps;
                let fm = self.roll_residual_at_mate(mi, xp);
                xp[col] = orig;
                // Wrap the DIFFERENCE, not just the samples: when the pose sits
                // on the residual's +/-pi branch cut (a weld a full half-turn
                // from its authored roll), fp and fm land on opposite branches
                // and their raw difference reads ~2*pi -- a ~1e6 phantom slope
                // that swamps the normal equations and stalls LM on the spot.
                // The wrapped difference is the true local slope across the cut.
                //
                // `+=`: the loop covers both bodies' param blocks, and when
                // off_a == off_b (a same-body mate, guarded out upstream but the
                // filler must not assume distinct bodies) the two passes land in
                // the same column. `=` would let the second silently discard the
                // first; the cells start at zero, so summing is identical for
                // distinct bodies.
                j[(row, col)] += wrap_to_pi(fp - fm) / (2.0 * eps);
            }
        }
    }

    /// Compute only the tangential residual for mate `mi` at x.
    fn residual_at_mate(&self, mi: usize, x: &[f64]) -> f64 {
        let mate = &self.mates[mi];
        let off_a = mate.a.body_index as usize * 7;
        let off_b = mate.b.body_index as usize * 7;
        let pa = world_point(x, off_a, &mate.a.geometry.point);
        let pb = world_point(x, off_b, &mate.b.geometry.point);
        let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
        let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
        self.tangential_residual(
            mate.a.anchor_kind,
            mate.b.anchor_kind,
            &pa,
            &pb,
            &a_w,
            &b_w,
            mate.axial_offset(),
            mate.radius,
        )
    }

    /// CopyRotation Jacobian: d((twist_b - twist_b0) - ratio * (twist_a - twist_a0)) / d(q_a, q_b).
    /// Uses the SEED-frame world axes (`self.seed_axes[mi]`, constants fixed at
    /// problem build time), never the current quaternion's axis: as a body
    /// rotates away from its seed, the current axis drifts from the seed axis,
    /// and linearising about a moving target descends the gradient of a
    /// different function than the one being minimised. `jacobian_vs_fd_*`
    /// only catches this if evaluated away from the seed (where the two axes
    /// still coincide by construction) -- see the perturbation in
    /// `jacobian_vs_fd_copy_rotation`.
    #[allow(clippy::too_many_arguments)]
    fn fill_copy_rotation(
        &self,
        j: &mut DMatrix<f64>,
        row: usize,
        mi: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        ratio: f64,
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);

        let (seed_a_w, seed_b_w) = self.seed_axes[mi].unwrap_or(([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]));

        // twist_gradient computes ∂(2*atan2(dot(q_vec, axis), q_w))/∂q,
        // treating `axis` as constant.
        let da = twist_gradient(qa.0, qa.1, qa.2, qa.3, &seed_a_w);
        let db = twist_gradient(qb.0, qb.1, qb.2, qb.3, &seed_b_w);

        // r = (twist_b - twist_b0) - ratio * (twist_a - twist_a0); the twist0
        // constants are seed-pose values, so they drop out of d/dq.
        for qi in 0..4 {
            j[(row, off_a + 3 + qi)] += -ratio * da[qi];
            j[(row, off_b + 3 + qi)] += db[qi];
        }
    }

    /// ParallelPlaneDistance: `dot(p_b - p_a, a_w) - offset`.
    #[allow(clippy::too_many_arguments)]
    fn fill_parallel_plane_dist(
        &self,
        j: &mut DMatrix<f64>,
        row: usize,
        off_a: usize,
        off_b: usize,
        x: &[f64],
        p_a: &[f64; 3],
        p_b: &[f64; 3],
        axis_a: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let pa_w = world_point(x, off_a, p_a);
        let pb_w = world_point(x, off_b, p_b);
        let a_w = rotate_vec(qa.0, qa.1, qa.2, qa.3, axis_a);
        let dpa = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, p_a);
        let dpb = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, p_b);
        let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);

        // r = dot(p_b - p_a, a_w) - offset
        let d = [pb_w[0] - pa_w[0], pb_w[1] - pa_w[1], pb_w[2] - pa_w[2]];

        // ∂r/∂t_a_i = -a_w_i
        for comp in 0..3 {
            j[(row, off_a + comp)] += -a_w[comp];
            j[(row, off_b + comp)] += a_w[comp];
        }

        // ∂r/∂q_a_i = dot(-∂p_a/∂q_i, a_w) + dot(d, ∂a_w/∂q_i)
        for qi in 0..4 {
            let dot_neg_p = -(dpa[qi][0] * a_w[0] + dpa[qi][1] * a_w[1] + dpa[qi][2] * a_w[2]);
            let dot_d_a = d[0] * da[qi][0] + d[1] * da[qi][1] + d[2] * da[qi][2];
            j[(row, off_a + 3 + qi)] += dot_neg_p + dot_d_a;
        }

        // ∂r/∂q_b_i = dot(∂p_b/∂q_i, a_w)
        for qi in 0..4 {
            j[(row, off_b + 3 + qi)] +=
                dpb[qi][0] * a_w[0] + dpb[qi][1] * a_w[1] + dpb[qi][2] * a_w[2];
        }
    }
}

/// Multiply Jacobian rows `start..end` by a mate's weight. The identity
/// fast-path keeps unweighted mates (every real mate) at exactly the arithmetic
/// they had before the weighting existed.
fn scale_rows(j: &mut DMatrix<f64>, start: usize, end: usize, w: f64) {
    if w == 1.0 {
        return;
    }
    for r in start..end {
        for c in 0..j.ncols() {
            j[(r, c)] *= w;
        }
    }
}
