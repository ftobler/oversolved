//! Mate residual builders and analytic Jacobian for the 3D rigid-body solver.
//!
//! Each rigid body carries 7 params: translation (tx, ty, tz) followed by a
//! unit quaternion (qx, qy, qz, qw). The solver reuses `solve_lm` (`lm.rs`) via
//! the closures `residuals(x)` and `jacobian(x, n)` built by `MateProblem`.
//!
//! Residuals per mate kind:
//! - Fixed:              point coincidence + offset vector in A's frame (3) + signed axis difference w/ flip (3) + absolute roll to authored angle (1)
//! - Spherical:          point coincidence (3)
//! - Parallel:           dot product of axes minus sign (1)
//! - Sliding:            signed axis difference w/ flip (3) + perp displacement cross (3) + absolute roll to authored angle (1)
//!   -- prismatic: slide is the only free DOF
//! - Rotating:           point coincidence (3) + signed axis difference w/ flip (3)
//! - SlidingRotating:    signed axis difference w/ flip (3) + perp displacement cross (3)
//!   -- cylindrical: slide + roll are free DOF
//! - Tangential:         signed-distance formula (1), surface-pair dependent
//! - CopyRotation:       roll_b - ratio * roll_a around seed-frame axes (1)
//! - ParallelPlaneDistance: dot(diff, normal) - offset (1) + axis-dot parallelism w/ flip (1)
//!
//! Orientation is authored data, never seed state: every orientation target
//! above comes off the wire (`flip`, `angle`), so a solve is a pure function of
//! the document and re-solving from its own output is a no-op. The one
//! exception is CopyRotation, whose whole point is linking FUTURE rotation, so
//! it alone keeps a seed-relative twist. The editor captures `flip`/`angle`
//! from the on-screen pose when the mate's references are picked, which is how
//! "hold what I placed" still works without the solver remembering anything:
//! deriving these from the seed instead made every solve inherit the last
//! solve's rounding error (baked into the doc on drag pointer-up) -- welded
//! parts drifted apart rotationally, an authored angle re-applied itself on
//! every reseed (a ratchet), and the weld side flipped when a drag swung the
//! axes past perpendicular.
//!
//! Global soft residuals:
//! - Quaternion unit-norm per body (1 residual each)
//! - Grounded-body pin per param (7 residuals each)

use nalgebra::DMatrix;

use crate::mate::{
    AnchorKind, Mate, MateDiagnostics, MateInput, MateKind, MateOutput, MateStatus, RigidBody,
};
use solver_core::lm;

/// Pre-built problem: holds decodings from MateInput for fast residual/Jacobian eval.
pub struct MateProblem {
    /// Number of scalar params (n_bodies * 7).
    n: usize,
    /// Copy of the seed params widened to f64.
    x0: Vec<f64>,
    /// Mates with local geometry, after the stale/dropped filter.
    mates: Vec<Mate>,
    /// Mate count as it arrived on the wire, before the filter above. The
    /// per-mate residual wire reports one entry per INPUT mate so the host's
    /// positional fold cannot shift when a mate is dropped.
    input_mate_count: usize,
    /// For each surviving mate in `mates`, its index in the input list. Dropped
    /// mates hold their slot in the output (a sentinel) instead of closing the
    /// gap and mis-attributing every later residual.
    kept_input_indices: Vec<usize>,
    /// Per-body param offsets.
    bodies: Vec<RigidBody>,
    /// Which bodies are grounded (grounded = not movable).
    grounded: Vec<bool>,
    /// Total residual count m.
    m: usize,
    /// Seed-frame world axes for CopyRotation (fixed at problem build time).
    /// `fill_copy_rotation` linearises about THESE, never the current
    /// quaternion's axis -- the current axis drifts as the body rotates away
    /// from its seed, and `jacobian_vs_fd_copy_rotation` only evaluates at the
    /// seed, which made a seed-vs-current mismatch invisible.
    seed_axes: Vec<Option<([f64; 3], [f64; 3])>>,
    /// `(twist_a(x0), twist_b(x0))`, measured about `seed_axes`. CopyRotation
    /// holds each body's twist relative to ITS OWN half of the pair
    /// (`twist_b - twist_b0 = ratio * (twist_a - twist_a0)`), so authoring a
    /// gear mate on two already-rotated bodies links their FUTURE rotation
    /// instead of snapping them together.
    seed_twist: Vec<(f64, f64)>,
    /// Canonical in-plane reference direction per side, for `Fixed`'s and
    /// `Sliding`'s absolute roll residual. Carried on the wire as
    /// `MateGeometry.perp` (the editor's canonicalPerp of each anchor's LOCAL
    /// axis, utils/mateOrientation.ts), so the frame is rigid to the part and
    /// the solver measures the exact direction the authored `angle` was captured
    /// against.
    roll_frames: Vec<Option<([f64; 3], [f64; 3])>>,
    /// Characteristic drawing length: the AABB diagonal over the seed body
    /// translations and the mate anchors' local points, floored at 1.0. See
    /// `geometry_scale`.
    scale: f64,
}

/// How much stiffer the LM step damps a body's rotation params than its
/// translation params. It weights only the Marquardt damping term (which shapes
/// each step, not the residual), so an underdetermined solve descends toward
/// sliding a part rather than spinning it, while a mate that genuinely needs a
/// rotation still converges to it -- the damping never enters the convergence
/// condition. See `rotation_damp_scale` and `lm::solve_lm_damped`.
const ROT_DAMP_SCALE: f64 = 500.0;

/// Cell ceiling on the dense Jacobian this solver will allocate.
///
/// The dense LM driver materialises the m*n Jacobian plus a J^T J of n*n and
/// LU workspaces alongside it, so memory scales as several multiples of m*n
/// f64s. A well-formed but oversized header (say 1000 bodies x 500k spherical
/// mates) would otherwise trap the wasm heap mid-allocation, and the resulting
/// OOM abort kills the worker outright instead of returning anything. Solves
/// above the budget are refused up front with the failing status until the
/// sparse-LM migration replaces the dense path; 2e8 cells (~1.6 GB of f64) sits
/// far above every legitimate assembly yet far below what aborts the heap.
const DENSE_CELL_BUDGET: usize = 200_000_000;

/// The budget gate behind `solve_mate`, parameterised so tests can drive it
/// with tiny numbers instead of reserving a real one. An m*n that overflows
/// usize counts as over budget: wrapping it back under would defeat the check.
fn dense_cells_over_budget(m: usize, n: usize, budget: usize) -> bool {
    match m.checked_mul(n) {
        Some(cells) => cells > budget,
        None => true,
    }
}

/// Residual count contributed by one mate of `kind`. A standalone function (not
/// inlined into `MateProblem::new`) so `mate_residual_count_matches_actual_residuals_pushed`
/// can drive it directly: a future arm that bumps this without bumping the
/// matching `residuals()` push count -- or the reverse -- fails that test
/// loudly instead of writing a residual row into another mate's block.
fn mate_residual_count(kind: MateKind) -> usize {
    match kind {
        MateKind::Fixed => 7,
        MateKind::Spherical => 3,
        MateKind::Parallel => 1,
        MateKind::Sliding => 7,
        MateKind::Rotating => 6,
        MateKind::SlidingRotating => 6,
        MateKind::Tangential => 1,
        MateKind::CopyRotation => 1,
        MateKind::ParallelPlaneDistance => 2,
    }
}

/// Characteristic drawing length for the relative `mate_status` threshold.
///
/// Built from the AABB diagonal over the seed body translations and the mate
/// anchors' local points. The wire carries anchor points as f32, so the f32
/// quantum is proportional to the drawing size; scaling the threshold with the
/// geometry keeps a correctly solved 1e4 mm assembly from reading as
/// overconstrained purely from rounding. The floor at 1.0 preserves the
/// historical absolute 1e-4 behaviour for models under one unit.
fn geometry_scale(x0: &[f64], mates: &[Mate]) -> f64 {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut add = |p: [f64; 3]| {
        for i in 0..3 {
            if p[i] < min[i] {
                min[i] = p[i];
            }
            if p[i] > max[i] {
                max[i] = p[i];
            }
        }
    };
    for bi in 0..(x0.len() / 7) {
        let off = bi * 7;
        add([x0[off], x0[off + 1], x0[off + 2]]);
    }
    for m in mates {
        add(m.a.geometry.point);
        add(m.b.geometry.point);
    }
    if !min[0].is_finite() {
        return 1.0;
    }
    let dx = max[0] - min[0];
    let dy = max[1] - min[1];
    let dz = max[2] - min[2];
    (dx * dx + dy * dy + dz * dz).sqrt().max(1.0)
}

impl MateProblem {
    pub fn new(input: &MateInput) -> Self {
        let n_bodies = input.bodies.len();
        let grounded: Vec<bool> = (0..n_bodies).map(|i| input.is_fixed(i)).collect();

        let x0: Vec<f64> = input.params_initial.iter().map(|&p| p as f64).collect();
        // The param dimension the solver optimizes IS the seed buffer: every
        // LM-side slice (step vector, J^T J diagonal, damping scale) is sized
        // from x0's length, so reporting bodies*7 here would desync the
        // Jacobian's columns from the state vector and panic inside nalgebra.
        // Well-formed inputs carry exactly bodies*7 entries; an in-memory
        // caller can hand us fewer or more, and bodies whose block falls
        // outside the buffer simply contribute no rows (same drop-don't-panic
        // posture as the stale-mate filter below).
        let n = x0.len();

        // Every mate residual and Jacobian row indexes `body_index * 7`, and the
        // index comes off the wire, so a stale mate (one authored against a body
        // that has since left the assembly) would run off the end of x. Drop the
        // whole mate: a half-applied mate is worse than an absent one, and the
        // solve still reports the remaining assembly honestly. The block end is
        // computed checked: on wasm32 an unchecked `(bi + 1) * 7` wraps for
        // absurd counts, and the wrapped compare would keep a body or mate that
        // indexes off the end.
        let block_within = |bi: usize| {
            bi.checked_add(1)
                .and_then(|next| next.checked_mul(7))
                .is_some_and(|end| end <= x0.len())
        };
        let addressable = |bi: u32| (bi as usize) < n_bodies && block_within(bi as usize);
        let mut mates: Vec<Mate> = Vec::new();
        let mut kept_input_indices: Vec<usize> = Vec::new();
        for (input_index, m) in input.mates.iter().enumerate() {
            // A mate needs two different parts. The host refuses this at the pick
            // (and solveAssembly.ts guards it), but the headless api.rs entry
            // point accepts an arbitrary wire, and a same-body mate reaches the
            // Jacobian fillers where off_a == off_b makes both sides write the
            // same cells. Drop it here, matching the stale-mate posture: it
            // contributes no row and the rest of the assembly solves honestly.
            let same_body = m.a.body_index == m.b.body_index;
            if addressable(m.a.body_index) && addressable(m.b.body_index) && !same_body {
                kept_input_indices.push(input_index);
                mates.push(m.clone());
            }
        }

        let mate_residual_total: usize = mates.iter().map(|m| mate_residual_count(m.kind)).sum();
        // The per-body residual loops index body_index * 7 against x/x0, so a
        // body whose full 7-param block is not in the seed buffer cannot
        // contribute any row. The wire path validates the counts; an
        // in-memory caller does not, and matching the stale-mate filter's
        // drop-don't-panic posture above, the missing body is skipped here
        // rather than indexed off the end mid-solve.
        let block_present = block_within;
        let quat_rows = (0..n_bodies).filter(|&bi| block_present(bi)).count();
        let grounded_rows = (0..n_bodies)
            .filter(|&bi| grounded[bi] && block_present(bi))
            .count();
        let m = mate_residual_total + quat_rows + 7 * grounded_rows;

        // Precompute seed-frame world axes for CopyRotation mates plus each
        // body's twist at the seed pose about those axes, and the pose-free
        // canonical roll frames for Fixed and Sliding.
        let mut seed_axes: Vec<Option<([f64; 3], [f64; 3])>> = vec![None; mates.len()];
        let mut seed_twist: Vec<(f64, f64)> = vec![(0.0, 0.0); mates.len()];
        let mut roll_frames: Vec<Option<([f64; 3], [f64; 3])>> = vec![None; mates.len()];
        for (i, m) in mates.iter().enumerate() {
            if m.kind == MateKind::CopyRotation {
                let off_a = m.a.body_index as usize * 7;
                let off_b = m.b.body_index as usize * 7;
                let a_w = world_direction(&x0, off_a, &m.a.geometry.axis);
                let b_w = world_direction(&x0, off_b, &m.b.geometry.axis);
                let seed_a = normalise_axis(&a_w);
                let seed_b = normalise_axis(&b_w);
                seed_axes[i] = Some((seed_a, seed_b));

                let qa = (x0[off_a + 3], x0[off_a + 4], x0[off_a + 5], x0[off_a + 6]);
                let qb = (x0[off_b + 3], x0[off_b + 4], x0[off_b + 5], x0[off_b + 6]);
                let twist_a0 = twist_angle(qa.0, qa.1, qa.2, qa.3, &seed_a);
                let twist_b0 = twist_angle(qb.0, qb.1, qb.2, qb.3, &seed_b);
                seed_twist[i] = (twist_a0, twist_b0);
            }
            if matches!(m.kind, MateKind::Fixed | MateKind::Sliding) {
                roll_frames[i] = Some((m.a.geometry.perp, m.b.geometry.perp));
            }
        }

        let scale = geometry_scale(&x0, &mates);

        MateProblem {
            n,
            x0,
            mates,
            input_mate_count: input.mates.len(),
            kept_input_indices,
            bodies: input.bodies.clone(),
            grounded,
            m,
            seed_axes,
            seed_twist,
            roll_frames,
            scale,
        }
    }

    /// Characteristic length of the drawing, floored at 1.0. `mate_status`
    /// multiplies its relative residual tolerance by this so the threshold
    /// tracks the model rather than an absolute distance in the wire's units.
    pub fn geometry_scale(&self) -> f64 {
        self.scale
    }

    /// Absolute roll: the signed angle from A's canonical reference direction to
    /// B's, measured about A's current world axis, minus the authored `angle`.
    /// Shared by `Fixed` and `Sliding`. The reference directions are the wire
    /// perps (`MateGeometry.perp`) carried into world space, so the residual is
    /// a pure function of the two poses and the authored target: zero seed
    /// dependence, hence re-solving from a baked (already-solved) doc changes
    /// nothing, and any rotational error a previous solve left behind is pulled
    /// back out instead of adopted as the new truth.
    ///
    /// `atan2(dot(cross(xa, xb), w), dot(xa, xb))` reads the angle of `xb`
    /// projected into the plane perpendicular to `w`; `xa` lies in that plane
    /// exactly (rigid rotation keeps it perpendicular to A's axis), and `xb`
    /// falls into it as the axis residuals align the axes, so near a solution
    /// this is the plain dihedral roll. The wrap keeps the residual in
    /// (-pi, pi]: a target of +179 deg and a pose at -179 deg are 2 deg apart,
    /// not 358.
    fn abs_roll_residual(
        &self,
        x: &[f64],
        mi: usize,
        off_a: usize,
        off_b: usize,
        target: f64,
    ) -> f64 {
        let mate = &self.mates[mi];
        let (xa_l, xb_l) = self.roll_frames[mi].unwrap_or(([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]));
        let w = normalise_axis(&world_direction(x, off_a, &mate.a.geometry.axis));
        let xa_w = world_direction(x, off_a, &xa_l);
        let xb_w = world_direction(x, off_b, &xb_l);
        let cr = cross3(&xa_w, &xb_w);
        let sin_r = cr[0] * w[0] + cr[1] * w[1] + cr[2] * w[2];
        let cos_r = xa_w[0] * xb_w[0] + xa_w[1] * xb_w[1] + xa_w[2] * xb_w[2];
        wrap_to_pi(sin_r.atan2(cos_r) - target)
    }

    /// Per-param multiplier on the LM Marquardt damping term: rotation params of
    /// ungrounded bodies are damped `ROT_DAMP_SCALE` times stiffer than their
    /// translation, so a step trades a spin for a slide where the constraints
    /// leave the choice open. Grounded bodies are pinned regardless, so their
    /// scale is left at 1.0.
    fn rotation_damp_scale(&self) -> Vec<f64> {
        let mut scale = vec![1.0; self.n];
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] || !self.body_block_present(bi, self.n) {
                continue;
            }
            let off = bi * 7;
            for j in 3..7 {
                scale[off + j] = ROT_DAMP_SCALE;
            }
        }
        scale
    }

    /// Build the residuals closure for `solve_lm`.
    pub fn residuals_fn(&self) -> impl Fn(&[f64]) -> Vec<f64> + '_ {
        |x: &[f64]| self.residuals(x)
    }

    /// Build the dense Jacobian closure for `solve_lm`.
    pub fn jacobian_fn(&self) -> impl Fn(&[f64]) -> DMatrix<f64> + '_ {
        |x: &[f64]| self.jacobian(x)
    }
}

mod jacobian;
mod math;

use math::*;

// ─── Residuals ───

impl MateProblem {
    fn get_quat(&self, x: &[f64], body_idx: usize) -> (f64, f64, f64, f64) {
        let off = body_idx * 7;
        (x[off + 3], x[off + 4], x[off + 5], x[off + 6])
    }

    /// True while body `bi`'s full 7-param block fits in the buffer. The two
    /// global residual loops (quaternion norm, grounded pins) index
    /// `bi * 7` unconditionally; a body past the buffer must contribute no
    /// rows instead of panicking the worker. `m` was computed with exactly
    /// this filter in `new`, so row counts stay consistent.
    fn body_block_present(&self, bi: usize, len: usize) -> bool {
        debug_assert_eq!(
            len,
            self.x0.len(),
            "param buffer drifted from the seed length"
        );
        // Checked to match `new`'s block filter: an unchecked `(bi + 1) * 7`
        // wraps on wasm32 for absurd body counts.
        bi.checked_add(1)
            .and_then(|next| next.checked_mul(7))
            .is_some_and(|end| end <= self.x0.len().min(len))
    }

    /// Compute the full residual vector at x.
    fn residuals(&self, x: &[f64]) -> Vec<f64> {
        let mut r = Vec::with_capacity(self.m);

        for (mi, mate) in self.mates.iter().enumerate() {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;
            let start = r.len();

            match mate.kind {
                MateKind::Fixed => {
                    // Point coincidence with a 3D offset carried in A's frame:
                    // p_a - p_b - R_a * offset. The offset rotates with A, so a
                    // weld holds the same relative placement however the pair is
                    // oriented -- a world-frame offset would slide the parts
                    // apart the moment A turned.
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let off_w = world_direction(x, off_a, &mate.offset);
                    r.push(pa[0] - pb[0] - off_w[0]);
                    r.push(pa[1] - pb[1] - off_w[1]);
                    r.push(pa[2] - pb[2] - off_w[2]);
                    // Axis alignment with a DEFINITE sign: a_w - sign * b_w.
                    // cross(a_w, b_w) vanishes for both parallel and anti-parallel
                    // b_w, so the weld could settle either way and flip a part
                    // normal-to-antinormal between solves. The sign is the
                    // authored `flip` (captured by the editor when the refs are
                    // picked), never re-derived from the seed dot: a seed-derived
                    // sign flipped the weld the moment a drag swung the axes past
                    // perpendicular.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                    // Absolute roll: the axis difference above is rank 2 (both
                    // are unit vectors), so rolling body B about the shared axis
                    // leaves it at zero. This 7th residual is the missing rank.
                    r.push(self.abs_roll_residual(x, mi, off_a, off_b, mate.angle));
                }
                MateKind::Spherical => {
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    r.push(pa[0] - pb[0]);
                    r.push(pa[1] - pb[1]);
                    r.push(pa[2] - pb[2]);
                }
                MateKind::Parallel => {
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let dot = a_w[0] * b_w[0] + a_w[1] * b_w[1] + a_w[2] * b_w[2];
                    let sign = if mate.flip { -1.0 } else { 1.0 };
                    r.push(dot - sign);
                }
                MateKind::Sliding => {
                    // Prismatic: signed axis difference + perp displacement cross
                    // plus a roll pin, so slide along the shared axis is the only
                    // free DOF. The sign is the authored flip, same as Fixed's:
                    // the cross-product form this replaced was zero for parallel
                    // AND anti-parallel axes, so the joint could flip sides.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                    // Perp displacement cross: cross(p_a - p_b, a_w).
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let d0 = pa[0] - pb[0];
                    let d1 = pa[1] - pb[1];
                    let d2 = pa[2] - pb[2];
                    r.push(d1 * a_w[2] - d2 * a_w[1]);
                    r.push(d2 * a_w[0] - d0 * a_w[2]);
                    r.push(d0 * a_w[1] - d1 * a_w[0]);
                    // Absolute roll pin to the authored angle, same as Fixed's.
                    r.push(self.abs_roll_residual(x, mi, off_a, off_b, mate.angle));
                }
                MateKind::Rotating => {
                    // Point coincidence.
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    r.push(pa[0] - pb[0]);
                    r.push(pa[1] - pb[1]);
                    r.push(pa[2] - pb[2]);
                    // Signed axis difference w/ flip (see Fixed's arm).
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                }
                MateKind::SlidingRotating => {
                    // Cylindrical: signed axis difference + perp displacement
                    // cross, so slide along the shared axis and roll about it are
                    // the free DOF.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let d0 = pa[0] - pb[0];
                    let d1 = pa[1] - pb[1];
                    let d2 = pa[2] - pb[2];
                    r.push(d1 * a_w[2] - d2 * a_w[1]);
                    r.push(d2 * a_w[0] - d0 * a_w[2]);
                    r.push(d0 * a_w[1] - d1 * a_w[0]);
                }
                MateKind::Tangential => {
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    r.push(self.tangential_residual(
                        mate.a.anchor_kind,
                        mate.b.anchor_kind,
                        &pa,
                        &pb,
                        &a_w,
                        &b_w,
                        mate.axial_offset(),
                        mate.radius,
                    ));
                }
                MateKind::CopyRotation => {
                    // Relative, not absolute: (twist_b - twist_b0) = ratio *
                    // (twist_a - twist_a0). A gear mate authored while both
                    // bodies are already rotated must LINK their future
                    // rotation, not snap them to an absolute relationship they
                    // never had.
                    let (seed_a_w, seed_b_w) = match &self.seed_axes[mi] {
                        Some(v) => *v,
                        None => ([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]),
                    };
                    let (twist_a0, twist_b0) = self.seed_twist[mi];
                    let (qx_a, qy_a, qz_a, qw_a) =
                        (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
                    let (qx_b, qy_b, qz_b, qw_b) =
                        (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);

                    let twist_a = twist_angle(qx_a, qy_a, qz_a, qw_a, &seed_a_w);
                    let twist_b = twist_angle(qx_b, qy_b, qz_b, qw_b, &seed_b_w);

                    // Ratio 1 is a rigid roll link whose target lives on the
                    // same circle `abs_roll_residual` wraps: `twist_angle`
                    // spans (-2pi, 2pi], so driving the pair past +/-2pi (or a
                    // quaternion sign flip) jumps the raw delta by a full turn
                    // and stalls LM on the branch cut -- the same trap
                    // `fill_roll_fd`'s wrap_to_pi(fp - fm) handles. Ratio != 1
                    // stays unwrapped DELIBERATELY: its target manifold
                    // repeats every 2*pi/ratio, so which representative is
                    // "nearest" depends on a design decision this fix does not
                    // make, and a silent wrap there would change behaviour
                    // under a fixture that locks today's numbers.
                    if mate.ratio == 1.0 {
                        r.push(wrap_to_pi((twist_b - twist_b0) - (twist_a - twist_a0)));
                    } else {
                        r.push((twist_b - twist_b0) - mate.ratio * (twist_a - twist_a0));
                    }
                }
                MateKind::ParallelPlaneDistance => {
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let d0 = pb[0] - pa[0];
                    let d1 = pb[1] - pa[1];
                    let d2 = pb[2] - pa[2];
                    let dist = d0 * a_w[0] + d1 * a_w[1] + d2 * a_w[2];
                    // Only the axial component can act here: this residual
                    // measures the plane separation along A's normal, and the
                    // offset's in-plane part points along the two DOF the mate
                    // deliberately leaves free. See `Mate::axial_offset`.
                    r.push(dist - mate.axial_offset());
                    // Parallelism: nothing above aligns the normals -- the name and
                    // the Flip checkbox both promised it. Same formula as `Parallel`.
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let dot = a_w[0] * b_w[0] + a_w[1] * b_w[1] + a_w[2] * b_w[2];
                    let sign = if mate.flip { -1.0 } else { 1.0 };
                    r.push(dot - sign);
                }
            }

            // The mate's own rows carry its weight, so an under-weighted drag
            // objective yields to a real mate in the same least-squares sum. The
            // global rows (quaternion norm, grounded pin) that follow are never
            // scaled: they hold the parameterization, not a mate.
            if mate.weight != 1.0 {
                for v in &mut r[start..] {
                    *v *= mate.weight;
                }
            }
        }

        // Quaternion unit-norm soft residuals (one per body whose full block
        // is in the buffer).
        for bi in 0..self.bodies.len() {
            if !self.body_block_present(bi, x.len()) {
                continue;
            }
            let (qx, qy, qz, qw) = self.get_quat(x, bi);
            r.push(qx * qx + qy * qy + qz * qz + qw * qw - 1.0);
        }

        // Grounded-body pin residuals (pull each param to x0).
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] && self.body_block_present(bi, x.len()) {
                let off = bi * 7;
                for j in 0..7 {
                    r.push(x[off + j] - self.x0[off + j]);
                }
            }
        }

        r
    }

    /// Tangential signed-distance residual, formula selected by anchor kind pair.
    #[allow(clippy::too_many_arguments)]
    fn tangential_residual(
        &self,
        ka: AnchorKind,
        kb: AnchorKind,
        pa: &[f64; 3],
        pb: &[f64; 3],
        a_w: &[f64; 3],
        b_w: &[f64; 3],
        offset: f64,
        radius: f64,
    ) -> f64 {
        let d0 = pa[0] - pb[0];
        let d1 = pa[1] - pb[1];
        let d2 = pa[2] - pb[2];

        match (ka, kb) {
            (AnchorKind::Plane, AnchorKind::Plane) => {
                // Signed distance from a's point to b's plane.
                d0 * b_w[0] + d1 * b_w[1] + d2 * b_w[2] - offset
            }
            (AnchorKind::Plane, AnchorKind::Cylinder) | (AnchorKind::Plane, AnchorKind::Cone) => {
                // Distance from cylinder/cone point to plane minus radius. A
                // cone is approximated by a cylinder of the wire's single
                // Mate.radius: the real radius varies along the cone axis, so
                // this matches the contact only at whichever station that
                // radius corresponds to. See the AnchorKind doc.
                (d0 * a_w[0] + d1 * a_w[1] + d2 * a_w[2]).abs() - radius - offset
            }
            (AnchorKind::Cylinder, AnchorKind::Plane) | (AnchorKind::Cone, AnchorKind::Plane) => {
                (d0 * b_w[0] + d1 * b_w[1] + d2 * b_w[2]).abs() - radius - offset
            }
            (AnchorKind::Cylinder, AnchorKind::Cylinder)
            | (AnchorKind::Cylinder, AnchorKind::Cone)
            | (AnchorKind::Cone, AnchorKind::Cylinder)
            | (AnchorKind::Cone, AnchorKind::Cone) => {
                // Shortest distance between two axes minus the radii. Each cone
                // is again the cylinder of the single Mate.radius, so a
                // cone/cone or cylinder/cone tangency is only exact where the
                // cone's true radius equals that value; a cone whose radius
                // changes over the contact cannot be represented by this wire
                // (one radius per mate). See the AnchorKind doc.
                let n0 = a_w[1] * b_w[2] - a_w[2] * b_w[1];
                let n1 = a_w[2] * b_w[0] - a_w[0] * b_w[2];
                let n2 = a_w[0] * b_w[1] - a_w[1] * b_w[0];
                let n_norm2 = n0 * n0 + n1 * n1 + n2 * n2;
                let axis_dist = if n_norm2 > 1e-24 {
                    (d0 * n0 + d1 * n1 + d2 * n2).abs() / n_norm2.sqrt()
                } else {
                    // Parallel axes: use perp distance.
                    let perp0 = d1 * a_w[2] - d2 * a_w[1];
                    let perp1 = d2 * a_w[0] - d0 * a_w[2];
                    let perp2 = d0 * a_w[1] - d1 * a_w[0];
                    (perp0 * perp0 + perp1 * perp1 + perp2 * perp2).sqrt()
                };
                axis_dist - 2.0 * radius - offset
            }
            _ => {
                // Unsupported anchor pair: every pair containing a Sphere, Line,
                // Circle, Point or Torus on either side (those five against
                // anything: each other, Point, Plane, Cylinder, Cone). The
                // point-to-point fallback this used to compute is geometrically
                // WRONG unless both anchor points happen to be surface centres
                // (a Sphere's centre, say): an anchor picked mid-line or on a
                // circle's rim measures an unrelated distance, and the solve
                // quietly converged on whatever that number asked for. Return a
                // non-finite residual so a headless `api.rs` caller can never
                // converge on it; `mate_status` classifies a non-finite residual
                // norm as `Overconstrained`. A real per-side radius (and
                // `Anchor.radius`) is what would make one of these pairs valid
                // again, and that is deliberately out of scope here.
                f64::NAN
            }
        }
    }
}

/// Relative factor for the SVD rank cutoff (see `singular_value_cutoff`).
const RANK_REL_TOL: f64 = 1e-10;

/// Rank cutoff for a Jacobian whose largest singular value is `smax`.
///
/// The naive form from the review, `1e-6 * smax`, does not work on THIS
/// matrix and was rejected on measured spectra: the Jacobian mixes units, so
/// grounded-body pins, quaternion-norm rows and translation columns stay
/// dimensionless O(1) however small the model is drawn. `smax` therefore
/// never shrinks with geometry, and `1e-6 * smax` can sit above the very
/// singular values that must keep counting -- a 1e-7-scale triple spherical
/// weld measured sigma = {2.3e-6, 2.0e-6, 1.2e-6} against a proposed cutoff
/// of 2.6e-6, demoting it from rank 14 to rank 11 (the exact bug class this
/// fix exists to remove). `1e-10 * smax` keeps the relative spirit with real
/// margins on both sides: four-plus orders above the finite-difference noise
/// of the roll/tangential filler rows (measured junk at ~1e-12 and below),
/// and well below the smallest genuine geometric direction for any sane
/// modelling scale down to nanometres (measured 1.2e-8 at 1e-9). A true zero
/// direction (a hinge's free roll measured 6.5e-18) stays excluded. An
/// all-zero spectrum falls back to the legacy absolute cutoff; every
/// direction is rank-deficient there under any positive tolerance anyway.
fn singular_value_cutoff(smax: f64) -> f64 {
    if smax > 0.0 {
        RANK_REL_TOL * smax
    } else {
        1e-6
    }
}

/// Relative factor for the `mate_status` residual tolerance. The RMS residual
/// threshold is `RESIDUAL_REL_TOL * scale`, so the same assembly reads the same
/// regardless of the drawing unit.
const RESIDUAL_REL_TOL: f64 = 1e-4;

/// `residual_norm` is an L2 norm over `m` residuals, so it grows with the
/// number of mates even when every individual residual is converged to the
/// same tolerance -- an absolute threshold here would flag a large,
/// correctly-solved assembly as overconstrained. Scale to an RMS-per-residual
/// figure so the threshold means the same thing regardless of problem size,
/// then compare against the tolerance relative to the drawing's characteristic
/// length `scale` so it also means the same thing regardless of unit.
fn mate_status(residual_norm: f64, m: usize, dof: usize, scale: f64) -> MateStatus {
    // A non-finite norm means NaN reached the residuals (the wire codec gates
    // its floats, but a host can still seed an in-memory MateInput with one).
    // It must classify as the failing state and never as FullyConstrained:
    // that would tell the editor the assembly is solved and lock the UI on
    // garbage, while Underconstrained would invite dragging a pose the solver
    // knows nothing about. Overconstrained is the enum's only error-ish state.
    if !residual_norm.is_finite() {
        return MateStatus::Overconstrained;
    }
    let rms_residual = if m > 0 {
        residual_norm / (m as f64).sqrt()
    } else {
        0.0
    };
    if rms_residual > RESIDUAL_REL_TOL * scale {
        MateStatus::Overconstrained
    } else if dof > 0 {
        MateStatus::Underconstrained
    } else {
        MateStatus::FullyConstrained
    }
}

// ─── Solve entry point ───

/// Run the mate solver: build a Problem, call solve_lm, compute status, build output.
pub fn solve_mate(input: &MateInput) -> MateOutput {
    solve_mate_impl(input, DENSE_CELL_BUDGET, false)
}

/// Live-drag variant of `solve_mate`: identical solve and pose, but the dense
/// rank/dof analysis (a full SVD of the Jacobian) is skipped and both are
/// reported as 0. A live drag tick reads only the pose and discards the
/// diagnostics, so the SVD is pure per-frame cost. Kept as a separate entry
/// point rather than a wire/record flag so the mate record layout, and the
/// `MATE_MAGIC` bump a width change needs, stay untouched.
pub fn solve_mate_live(input: &MateInput) -> MateOutput {
    solve_mate_impl(input, DENSE_CELL_BUDGET, true)
}

/// `solve_mate` with the dense-cell ceiling injected (test hook; production
/// always passes `DENSE_CELL_BUDGET`) and the live fast-path selected.
fn solve_mate_impl(input: &MateInput, budget: usize, live: bool) -> MateOutput {
    let problem = MateProblem::new(input);
    let n = problem.n;
    let m = problem.m;

    // Refuse before the first dense allocation: past this point every step
    // reserves matrices proportional to m*n, and an OOM there aborts the
    // worker instead of returning the failing status below.
    if dense_cells_over_budget(m, n, budget) {
        return MateOutput {
            params_solved: input.params_initial.clone(),
            overall_status: MateStatus::Overconstrained.to_u8(),
            mate_residuals: Vec::new(),
            diagnostics: MateDiagnostics {
                // Infinity reads as "no convergence measurement exists", which
                // is exactly the truth for a solve that never ran.
                residual_norm: f64::INFINITY,
                rank: 0,
                dof: 0,
                iters: 0,
                ms: 0.0,
            },
        };
    }

    let x0_f64: Vec<f64> = input.params_initial.iter().map(|&p| p as f64).collect();

    let residuals_fn = problem.residuals_fn();
    let jacobian_fn = problem.jacobian_fn();

    // Rotation params are damped stiffer than translation so an underdetermined
    // solve slides a part rather than spinning it (ROT_DAMP_SCALE). This weights
    // only the LM step, never the residual, so the reported diagnostics below are
    // untouched and a mate that needs a rotation still reaches it.
    let damp_scale = problem.rotation_damp_scale();
    let lm_result = lm::solve_lm_damped(&x0_f64, &residuals_fn, &jacobian_fn, &damp_scale);

    // Rank analysis via SVD. Skipped on a live drag tick, which reads only the
    // pose and discards the verdict: the SVD is pure per-frame cost there, and
    // the full solve on pointer-up is what owns the rank/dof the editor shows.
    // Also skipped when the residuals are poisoned: nalgebra's SVD convergence
    // test never fires on NaN, so this call would spin forever and wedge the
    // serialized worker. `mate_status` then reports the failure instead of a
    // rank that cannot be trusted.
    let poisoned = !lm_result.residual_norm.is_finite();
    let (rank, dof) = if live {
        (0u32, 0u32)
    } else {
        let dof = if m == 0 || n == 0 || poisoned {
            0usize
        } else {
            let svd = lm_result.jacobian.svd(true, false);
            // The rank cutoff must scale with the drawing unit: an assembly laid
            // out at 1e-9 m has exactly the same DOF as the same assembly at 1 m,
            // but its geometry-proportional singular values shrink linearly with
            // the unit and a fixed absolute cutoff misreads them as rank loss
            // (measured: three spherical mates at 1e-9 reported 3 phantom DOF).
            // See `singular_value_cutoff` for why the factor is what it is.
            let smax = svd.singular_values.iter().copied().fold(0.0_f64, f64::max);
            let tol = singular_value_cutoff(smax);
            let rank = svd.singular_values.iter().filter(|&&s| s > tol).count();
            n.saturating_sub(rank)
        };
        ((n - dof) as u32, dof as u32)
    };

    let status = mate_status(
        lm_result.residual_norm,
        m,
        dof as usize,
        problem.geometry_scale(),
    );

    let params_solved: Vec<f32> = lm_result.x.iter().map(|&v| v as f32).collect();

    // Per-mate residual norms at the solved pose, one per INPUT mate. Kept
    // mates are sliced by the per-kind counts `residuals()` pushed them in; a
    // dropped mate keeps its slot as NaN so a later residual cannot shift under
    // the host's positional fold. The host reads a non-finite value as "no
    // residual".
    let solved_residuals = problem.residuals(&lm_result.x);
    let mut block_start = 0usize;
    let mut mate_residuals = vec![f64::NAN; problem.input_mate_count];
    for (kept_pos, &input_index) in problem.kept_input_indices.iter().enumerate() {
        let m = &problem.mates[kept_pos];
        let count = mate_residual_count(m.kind);
        mate_residuals[input_index] = solved_residuals[block_start..block_start + count]
            .iter()
            .map(|v| v * v)
            .sum::<f64>()
            .sqrt();
        block_start += count;
    }

    MateOutput {
        params_solved,
        overall_status: status.to_u8(),
        mate_residuals,
        diagnostics: MateDiagnostics {
            residual_norm: lm_result.residual_norm,
            rank,
            dof,
            iters: lm_result.iters,
            // Wall-clock is measured by the JS host (it has performance.now());
            // the crate has no portable clock on wasm32-unknown-unknown. An
            // `Instant::now()` here panics the moment a mate reaches a browser,
            // and `solve.rs` avoids it for the same reason.
            ms: 0.0,
        },
    }
}

// ─── Tests ───

#[cfg(test)]
mod tests;
