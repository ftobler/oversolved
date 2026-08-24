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

use solver_core::lm;
use crate::mate::{
    AnchorKind, Mate, MateDiagnostics, MateInput, MateKind, MateOutput, MateStatus, RigidBody,
};

/// Pre-built problem: holds decodings from MateInput for fast residual/Jacobian eval.
pub struct MateProblem {
    /// Number of scalar params (n_bodies * 7).
    n: usize,
    /// Copy of the seed params widened to f64.
    x0: Vec<f64>,
    /// Mates with local geometry.
    mates: Vec<Mate>,
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
    /// `Sliding`'s absolute roll residual: `canonical_perp` of each anchor's
    /// LOCAL axis, so the frame is rigid to the part and independent of any
    /// pose. The editor's authoring capture derives its `angle` from the same
    /// frames (utils/mateOrientation.ts must mirror `canonical_perp` exactly).
    roll_frames: Vec<Option<([f64; 3], [f64; 3])>>,
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

impl MateProblem {
    pub fn new(input: &MateInput) -> Self {
        let n_bodies = input.bodies.len();
        let n = n_bodies * 7;
        let grounded: Vec<bool> = (0..n_bodies).map(|i| input.is_fixed(i)).collect();

        let x0: Vec<f64> = input.params_initial.iter().map(|&p| p as f64).collect();

        // Every mate residual and Jacobian row indexes `body_index * 7`, and the
        // index comes off the wire, so a stale mate (one authored against a body
        // that has since left the assembly) would run off the end of x. Drop the
        // whole mate: a half-applied mate is worse than an absent one, and the
        // solve still reports the remaining assembly honestly.
        let addressable = |bi: u32| {
            let bi = bi as usize;
            bi < n_bodies && (bi + 1) * 7 <= x0.len()
        };
        let mates: Vec<Mate> = input
            .mates
            .iter()
            .filter(|m| addressable(m.a.body_index) && addressable(m.b.body_index))
            .cloned()
            .collect();

        let mate_residual_total: usize = mates.iter().map(|m| mate_residual_count(m.kind)).sum();
        let m = mate_residual_total + n_bodies + 7 * grounded.iter().filter(|&&g| g).count();

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
                roll_frames[i] = Some((
                    canonical_perp(&m.a.geometry.axis),
                    canonical_perp(&m.b.geometry.axis),
                ));
            }
        }

        MateProblem {
            n,
            x0,
            mates,
            bodies: input.bodies.clone(),
            grounded,
            m,
            seed_axes,
            seed_twist,
            roll_frames,
        }
    }

    /// Absolute roll: the signed angle from A's canonical reference direction to
    /// B's, measured about A's current world axis, minus the authored `angle`.
    /// Shared by `Fixed` and `Sliding`. The reference directions are
    /// `canonical_perp` of each anchor's LOCAL axis carried into world space, so
    /// the residual is a pure function of the two poses and the authored target:
    /// zero seed dependence, hence re-solving from a baked (already-solved) doc
    /// changes nothing, and any rotational error a previous solve left behind is
    /// pulled back out instead of adopted as the new truth.
    ///
    /// `atan2(dot(cross(xa, xb), w), dot(xa, xb))` reads the angle of `xb`
    /// projected into the plane perpendicular to `w`; `xa` lies in that plane
    /// exactly (rigid rotation keeps it perpendicular to A's axis), and `xb`
    /// falls into it as the axis residuals align the axes, so near a solution
    /// this is the plain dihedral roll. The wrap keeps the residual in
    /// (-pi, pi]: a target of +179 deg and a pose at -179 deg are 2 deg apart,
    /// not 358.
    fn abs_roll_residual(&self, x: &[f64], mi: usize, off_a: usize, off_b: usize, target: f64) -> f64 {
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
            if self.grounded[bi] {
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

// ─── Quaternion / transform helpers ───

/// Quaternion to 3x3 rotation matrix.
/// Layout: [r00, r01, r02, r10, r11, r12, r20, r21, r22].
fn rot_matrix(qx: f64, qy: f64, qz: f64, qw: f64) -> [f64; 9] {
    let qx2 = qx * qx;
    let qy2 = qy * qy;
    let qz2 = qz * qz;
    [
        1.0 - 2.0 * (qy2 + qz2), 2.0 * (qx * qy - qz * qw), 2.0 * (qx * qz + qy * qw),
        2.0 * (qx * qy + qz * qw), 1.0 - 2.0 * (qx2 + qz2), 2.0 * (qy * qz - qx * qw),
        2.0 * (qx * qz - qy * qw), 2.0 * (qy * qz + qx * qw), 1.0 - 2.0 * (qx2 + qy2),
    ]
}

/// Rotate a 3-vector by a quaternion: R(q) * v.
fn rotate_vec(qx: f64, qy: f64, qz: f64, qw: f64, v: &[f64; 3]) -> [f64; 3] {
    let r = rot_matrix(qx, qy, qz, qw);
    [
        r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
        r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
        r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
    ]
}

/// Transform a local point to world space: R(q) * p + t.
fn world_point(x: &[f64], offset: usize, p: &[f64; 3]) -> [f64; 3] {
    let tx = x[offset];
    let ty = x[offset + 1];
    let tz = x[offset + 2];
    let qx = x[offset + 3];
    let qy = x[offset + 4];
    let qz = x[offset + 5];
    let qw = x[offset + 6];
    let r = rotate_vec(qx, qy, qz, qw, p);
    [r[0] + tx, r[1] + ty, r[2] + tz]
}

/// Transform a local direction to world space: R(q) * d (no translation).
fn world_direction(x: &[f64], offset: usize, d: &[f64; 3]) -> [f64; 3] {
    let qx = x[offset + 3];
    let qy = x[offset + 4];
    let qz = x[offset + 5];
    let qw = x[offset + 6];
    rotate_vec(qx, qy, qz, qw, d)
}

/// Normalise a direction vector to unit length (or return identity if zero).
fn normalise_axis(v: &[f64; 3]) -> [f64; 3] {
    let n2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if n2 < 1e-20 {
        return [0.0, 0.0, 1.0];
    }
    let inv = 1.0 / n2.sqrt();
    [v[0] * inv, v[1] * inv, v[2] * inv]
}

// ─── Derivatives of rotation with respect to quaternion components ───

/// Compute ∂(R(q)*v)/∂q_i. Returns array of 4 triplets (one per qi), each a 3-vector.
fn drot_vec_dq(qx: f64, qy: f64, qz: f64, qw: f64, v: &[f64; 3]) -> [[f64; 3]; 4] {
    let vx = v[0];
    let vy = v[1];
    let vz = v[2];
    // ∂R/∂qx * v
    let dqx = [
        0.0 * vx + 2.0 * qy * vy + 2.0 * qz * vz,
        2.0 * qy * vx + (-4.0 * qx) * vy + (-2.0 * qw) * vz,
        2.0 * qz * vx + 2.0 * qw * vy + (-4.0 * qx) * vz,
    ];
    // ∂R/∂qy * v
    let dqy = [
        (-4.0 * qy) * vx + 2.0 * qx * vy + 2.0 * qw * vz,
        2.0 * qx * vx + 0.0 * vy + 2.0 * qz * vz,
        (-2.0 * qw) * vx + 2.0 * qz * vy + (-4.0 * qy) * vz,
    ];
    // ∂R/∂qz * v
    let dqz = [
        (-4.0 * qz) * vx + (-2.0 * qw) * vy + 2.0 * qx * vz,
        2.0 * qw * vx + (-4.0 * qz) * vy + 2.0 * qy * vz,
        2.0 * qx * vx + 2.0 * qy * vy + 0.0 * vz,
    ];
    // ∂R/∂qw * v
    let dqw = [
        0.0 * vx + (-2.0 * qz) * vy + 2.0 * qy * vz,
        2.0 * qz * vx + 0.0 * vy + (-2.0 * qx) * vz,
        (-2.0 * qy) * vx + 2.0 * qx * vy + 0.0 * vz,
    ];
    [dqx, dqy, dqz, dqw]
}

// ─── Residuals ───

impl MateProblem {
    fn get_quat(&self, x: &[f64], body_idx: usize) -> (f64, f64, f64, f64) {
        let off = body_idx * 7;
        (x[off + 3], x[off + 4], x[off + 5], x[off + 6])
    }

    /// Compute the full residual vector at x.
    fn residuals(&self, x: &[f64]) -> Vec<f64> {
        let mut r = Vec::with_capacity(self.m);

        for (mi, mate) in self.mates.iter().enumerate() {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;

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
                        mate.a.anchor_kind, mate.b.anchor_kind,
                        &pa, &pb, &a_w, &b_w,
                        mate.axial_offset(), mate.radius,
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
                    let (qx_a, qy_a, qz_a, qw_a) = (x[off_a+3], x[off_a+4], x[off_a+5], x[off_a+6]);
                    let (qx_b, qy_b, qz_b, qw_b) = (x[off_b+3], x[off_b+4], x[off_b+5], x[off_b+6]);

                    let twist_a = twist_angle(qx_a, qy_a, qz_a, qw_a, &seed_a_w);
                    let twist_b = twist_angle(qx_b, qy_b, qz_b, qw_b, &seed_b_w);

                    r.push((twist_b - twist_b0) - mate.ratio * (twist_a - twist_a0));
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
        }

        // Quaternion unit-norm soft residuals (one per body).
        for bi in 0..self.bodies.len() {
            let (qx, qy, qz, qw) = self.get_quat(x, bi);
            r.push(qx * qx + qy * qy + qz * qz + qw * qw - 1.0);
        }

        // Grounded-body pin residuals (pull each param to x0).
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] {
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
        ka: AnchorKind, kb: AnchorKind,
        pa: &[f64; 3], pb: &[f64; 3],
        a_w: &[f64; 3], b_w: &[f64; 3],
        offset: f64, radius: f64,
    ) -> f64 {
        let d0 = pa[0] - pb[0];
        let d1 = pa[1] - pb[1];
        let d2 = pa[2] - pb[2];

        match (ka, kb) {
            (AnchorKind::Plane, AnchorKind::Plane) => {
                // Signed distance from a's point to b's plane.
                d0 * b_w[0] + d1 * b_w[1] + d2 * b_w[2] - offset
            }
            (AnchorKind::Plane, AnchorKind::Cylinder) |
            (AnchorKind::Plane, AnchorKind::Cone) => {
                // Distance from cylinder/cone point to plane minus radius.
                (d0 * a_w[0] + d1 * a_w[1] + d2 * a_w[2]).abs() - radius - offset
            }
            (AnchorKind::Cylinder, AnchorKind::Plane) |
            (AnchorKind::Cone, AnchorKind::Plane) => {
                (d0 * b_w[0] + d1 * b_w[1] + d2 * b_w[2]).abs() - radius - offset
            }
            (AnchorKind::Cylinder, AnchorKind::Cylinder) |
            (AnchorKind::Cylinder, AnchorKind::Cone) |
            (AnchorKind::Cone, AnchorKind::Cylinder) |
            (AnchorKind::Cone, AnchorKind::Cone) => {
                // Shortest distance between two axes minus sum of radii.
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
                // General fallback: point-to-point distance minus radius(es).
                let dist = (d0 * d0 + d1 * d1 + d2 * d2).sqrt();
                dist - radius - offset
            }
        }
    }
}

// ─── Jacobian ───

impl MateProblem {
    /// Build the full dense Jacobian (m × n) at x.
    fn jacobian(&self, x: &[f64]) -> DMatrix<f64> {
        let mut j = DMatrix::zeros(self.m, self.n);
        let mut row = 0usize;

        for (mi, mate) in self.mates.iter().enumerate() {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;

            match mate.kind {
                MateKind::Fixed => {
                    // Point coincidence with offset.
                    self.fill_point_coincidence_offset(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.offset,
                    );
                    row += 3;
                    // Signed axis difference: a_w - sign * b_w.
                    self.fill_axis_difference(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                    // Absolute roll about A's current world axis.
                    // Finite-differenced so the Jacobian tracks the moving axis
                    // the residual measures against (see fill_roll_fd).
                    self.fill_roll_fd(&mut j, row, mi, off_a, off_b, x);
                    row += 1;
                }
                MateKind::Spherical => {
                    self.fill_point_coincidence(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                    );
                    row += 3;
                }
                MateKind::Parallel => {
                    self.fill_axis_dot(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                    );
                    row += 1;
                }
                MateKind::Sliding => {
                    // Signed axis difference w/ flip.
                    self.fill_axis_difference(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                    // Perp displacement cross.
                    self.fill_perp_cross(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.a.geometry.axis,
                    );
                    row += 3;
                    // Absolute roll pin -- finite-differenced, same as Fixed's
                    // (see fill_roll_fd).
                    self.fill_roll_fd(&mut j, row, mi, off_a, off_b, x);
                    row += 1;
                }
                MateKind::Rotating => {
                    self.fill_point_coincidence(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                    );
                    row += 3;
                    self.fill_axis_difference(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                }
                MateKind::SlidingRotating => {
                    self.fill_axis_difference(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                        axis_sign(mate.flip),
                    );
                    row += 3;
                    self.fill_perp_cross(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.a.geometry.axis,
                    );
                    row += 3;
                }
                MateKind::Tangential => {
                    self.fill_tangential(
                        &mut j, row, mi, off_a, off_b, x, mate,
                    );
                    row += 1;
                }
                MateKind::CopyRotation => {
                    self.fill_copy_rotation(&mut j, row, mi, off_a, off_b, x, mate.ratio);
                    row += 1;
                }
                MateKind::ParallelPlaneDistance => {
                    self.fill_parallel_plane_dist(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                        &mate.a.geometry.axis,
                    );
                    row += 1;
                    self.fill_axis_dot(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                    );
                    row += 1;
                }
            }
        }

        // Quaternion norm residuals (1 per body).
        for bi in 0..self.bodies.len() {
            let off = bi * 7;
            j[(row, off + 3)] = 2.0 * x[off + 3];
            j[(row, off + 4)] = 2.0 * x[off + 4];
            j[(row, off + 5)] = 2.0 * x[off + 5];
            j[(row, off + 6)] = 2.0 * x[off + 6];
            row += 1;
        }

        // Grounded-body pin residuals (7 per grounded body).
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] {
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
        &self, j: &mut DMatrix<f64>, row0: usize,
        off_a: usize, off_b: usize, x: &[f64],
        pa: &[f64; 3], pb: &[f64; 3],
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
        &self, j: &mut DMatrix<f64>, row0: usize,
        off_a: usize, off_b: usize, x: &[f64],
        pa: &[f64; 3], pb: &[f64; 3],
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
        &self, j: &mut DMatrix<f64>, row0: usize,
        off_a: usize, off_b: usize, x: &[f64],
        axis_a: &[f64; 3], axis_b: &[f64; 3], sign: f64,
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
        &self, j: &mut DMatrix<f64>, row: usize,
        off_a: usize, off_b: usize, x: &[f64],
        axis_a: &[f64; 3], axis_b: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let a_w = rotate_vec(qa.0, qa.1, qa.2, qa.3, axis_a);
        let b_w = rotate_vec(qb.0, qb.1, qb.2, qb.3, axis_b);
        let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);
        let db = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, axis_b);

        for qi in 0..4 {
            j[(row, off_a + 3 + qi)] += da[qi][0] * b_w[0] + da[qi][1] * b_w[1] + da[qi][2] * b_w[2];
            j[(row, off_b + 3 + qi)] += a_w[0] * db[qi][0] + a_w[1] * db[qi][1] + a_w[2] * db[qi][2];
        }
    }

    /// Perpendicular displacement cross: `cross(p_a - p_b, a_w)` (3 residuals).
    /// Measures how far B's anchor point is from A's anchor axis.
    #[allow(clippy::too_many_arguments)]
    fn fill_perp_cross(
        &self, j: &mut DMatrix<f64>, row0: usize,
        off_a: usize, off_b: usize, x: &[f64],
        p_a: &[f64; 3], p_b: &[f64; 3],
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
        &self, j: &mut DMatrix<f64>, row: usize, mi: usize,
        off_a: usize, off_b: usize, x: &[f64],
        _mate: &Mate,
    ) {
        let eps = 1e-6;
        let mut xp = x.to_vec();

        // Body A params (translation + quaternion).
        for col in off_a..off_a + 7 {
            let orig = xp[col];
            xp[col] = orig + eps;
            let fp = self.residual_at_mate(mi, &xp);
            xp[col] = orig - eps;
            let fm = self.residual_at_mate(mi, &xp);
            xp[col] = orig;
            j[(row, col)] = (fp - fm) / (2.0 * eps);
        }
        // Body B params.
        for col in off_b..off_b + 7 {
            let orig = xp[col];
            xp[col] = orig + eps;
            let fp = self.residual_at_mate(mi, &xp);
            xp[col] = orig - eps;
            let fm = self.residual_at_mate(mi, &xp);
            xp[col] = orig;
            j[(row, col)] = (fp - fm) / (2.0 * eps);
        }
    }

    /// Absolute roll residual for mate `mi` at x (Fixed and Sliding both carry
    /// their target in `mate.angle`). Used by `fill_roll_fd` for finite
    /// differencing.
    fn roll_residual_at_mate(&self, mi: usize, x: &[f64]) -> f64 {
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
    fn fill_roll_fd(
        &self, j: &mut DMatrix<f64>, row: usize, mi: usize,
        off_a: usize, off_b: usize, x: &[f64],
    ) {
        let eps = 1e-6;
        let mut xp = x.to_vec();
        for &base in &[off_a, off_b] {
            for col in base..base + 7 {
                let orig = xp[col];
                xp[col] = orig + eps;
                let fp = self.roll_residual_at_mate(mi, &xp);
                xp[col] = orig - eps;
                let fm = self.roll_residual_at_mate(mi, &xp);
                xp[col] = orig;
                // Wrap the DIFFERENCE, not just the samples: when the pose sits
                // on the residual's +/-pi branch cut (a weld a full half-turn
                // from its authored roll), fp and fm land on opposite branches
                // and their raw difference reads ~2*pi -- a ~1e6 phantom slope
                // that swamps the normal equations and stalls LM on the spot.
                // The wrapped difference is the true local slope across the cut.
                j[(row, col)] = wrap_to_pi(fp - fm) / (2.0 * eps);
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
            mate.a.anchor_kind, mate.b.anchor_kind,
            &pa, &pb, &a_w, &b_w,
            mate.axial_offset(), mate.radius,
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
        &self, j: &mut DMatrix<f64>, row: usize, mi: usize,
        off_a: usize, off_b: usize, x: &[f64],
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
        &self, j: &mut DMatrix<f64>, row: usize,
        off_a: usize, off_b: usize, x: &[f64],
        p_a: &[f64; 3], p_b: &[f64; 3],
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
            j[(row, off_b + 3 + qi)] += dpb[qi][0] * a_w[0] + dpb[qi][1] * a_w[1] + dpb[qi][2] * a_w[2];
        }
    }
}

/// Cross product of two 3-vectors.
fn cross3(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Compute the signed twist (roll) angle of quaternion q around world axis w.
/// Returns 2 * atan2(dot(q_vec, w), q_w), in radians.
fn twist_angle(qx: f64, qy: f64, qz: f64, qw: f64, w: &[f64; 3]) -> f64 {
    let proj = qx * w[0] + qy * w[1] + qz * w[2];
    2.0 * proj.atan2(qw)
}

/// The axis-alignment sign an authored `flip` selects: parallel (+1) or
/// anti-parallel (-1). Authored data, never derived from the seed pose.
fn axis_sign(flip: bool) -> f64 {
    if flip { -1.0 } else { 1.0 }
}

/// Deterministic unit vector perpendicular to `a` (the anchor's LOCAL axis):
/// cross `a` with the world basis vector it is least aligned with. Pose-free,
/// so together with the axis it gives every anchor a full rigid frame to
/// measure roll against. The editor's authoring capture must agree on the same
/// direction -- utils/mateOrientation.ts `canonicalPerp` mirrors this branch
/// for branch, and `mateOrientation.test.ts` locks the shared fixtures.
fn canonical_perp(a: &[f64; 3]) -> [f64; 3] {
    let u = normalise_axis(a);
    let (ax, ay, az) = (u[0].abs(), u[1].abs(), u[2].abs());
    let e: [f64; 3] = if ax <= ay && ax <= az {
        [1.0, 0.0, 0.0]
    } else if ay <= az {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    normalise_axis(&cross3(&u, &e))
}

/// Wrap an angle difference into (-pi, pi].
fn wrap_to_pi(v: f64) -> f64 {
    use std::f64::consts::PI;
    let d = (v + PI).rem_euclid(2.0 * PI) - PI;
    // rem_euclid maps an exact +pi input to -pi; keep the closed end at +pi so
    // an authored 180 deg target is representable without a sign surprise.
    if d == -PI { PI } else { d }
}

/// Gradient of twist_angle w.r.t. quaternion components.
/// ∂(2 * atan2(a, b))/∂a = 2*b/(a²+b²), ∂/∂b = -2*a/(a²+b²)
/// where a = dot(q_vec, w), b = q_w.
/// Returns [∂f/∂qx, ∂f/∂qy, ∂f/∂qz, ∂f/∂qw].
fn twist_gradient(qx: f64, qy: f64, qz: f64, qw: f64, w: &[f64; 3]) -> [f64; 4] {
    let a = qx * w[0] + qy * w[1] + qz * w[2];
    let denom = a * a + qw * qw;
    if denom < 1e-20 {
        return [0.0; 4];
    }
    let dua = 2.0 * qw / denom;
    let dub = -2.0 * a / denom;
    [dua * w[0], dua * w[1], dua * w[2], dub]
}

/// `residual_norm` is an L2 norm over `m` residuals, so it grows with the
/// number of mates even when every individual residual is converged to the
/// same tolerance -- an absolute threshold here would flag a large,
/// correctly-solved assembly as overconstrained. Scale to an RMS-per-residual
/// figure so the threshold means the same thing regardless of problem size.
fn mate_status(residual_norm: f64, m: usize, dof: usize) -> MateStatus {
    // A non-finite norm means NaN reached the residuals (the wire codec gates
    // its floats, but a host can still seed an in-memory MateInput with one).
    // It must classify as the failing state and never as FullyConstrained:
    // that would tell the editor the assembly is solved and lock the UI on
    // garbage, while Underconstrained would invite dragging a pose the solver
    // knows nothing about. Overconstrained is the enum's only error-ish state.
    if !residual_norm.is_finite() {
        return MateStatus::Overconstrained;
    }
    let rms_residual = if m > 0 { residual_norm / (m as f64).sqrt() } else { 0.0 };
    if rms_residual > 1e-4 {
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
    solve_mate_with_budget(input, DENSE_CELL_BUDGET)
}

/// `solve_mate` with the dense-cell ceiling injected (test hook; production
/// always passes `DENSE_CELL_BUDGET`).
fn solve_mate_with_budget(input: &MateInput, budget: usize) -> MateOutput {
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

    // Rank analysis via SVD. Skipped when the residuals are poisoned:
    // nalgebra's SVD convergence test never fires on NaN, so this call would
    // spin forever and wedge the serialized worker. `mate_status` then reports
    // the failure instead of a rank that cannot be trusted.
    let poisoned = !lm_result.residual_norm.is_finite();
    let dof = if m == 0 || n == 0 || poisoned {
        0
    } else {
        let svd = lm_result.jacobian.svd(true, false);
        let tol = 1e-6;
        let rank = svd.singular_values.iter().filter(|&&s| s > tol).count();
        n.saturating_sub(rank)
    };
    let rank = (n - dof) as u32;

    let status = mate_status(lm_result.residual_norm, m, dof);

    let params_solved: Vec<f32> = lm_result.x.iter().map(|&v| v as f32).collect();

    MateOutput {
        params_solved,
        overall_status: status.to_u8(),
        diagnostics: MateDiagnostics {
            residual_norm: lm_result.residual_norm,
            rank,
            dof: dof as u32,
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
mod tests {
    use super::*;
    use crate::mate::{AnchorKind, MateGeometry, MateInput, MateKind, MateRef, RigidBody};

    fn mate_ref(body_index: u32, px: f64, py: f64, pz: f64, ax: f64, ay: f64, az: f64, ak: AnchorKind) -> MateRef {
        MateRef {
            body_index,
            geometry: MateGeometry {
                point: [px, py, pz],
                axis: [ax, ay, az],
            },
            anchor_kind: ak,
        }
    }

    /// Builds a mate from a SCALAR offset, the pre-vector authoring form: the
    /// scalar is expanded to `offset * axis_a` in A's local frame. Every test
    /// below that predates the vector widening still calls this, so they double
    /// as the back-compat guarantee -- if the vector semantics ever stopped
    /// collapsing onto the scalar ones, they would all move.
    fn mate(kind: MateKind, a: MateRef, b: MateRef, flip: bool, offset: f64, ratio: f64, radius: f64) -> Mate {
        mate_with_angle(kind, a, b, flip, offset, ratio, radius, 0.0)
    }

    fn mate_with_angle(
        kind: MateKind, a: MateRef, b: MateRef, flip: bool, offset: f64, ratio: f64, radius: f64, angle: f64,
    ) -> Mate {
        let ax = a.geometry.axis;
        let offset = [offset * ax[0], offset * ax[1], offset * ax[2]];
        Mate { kind, a, b, flip, offset, ratio, radius, angle }
    }

    /// Builds a mate from a full offset VECTOR in A's local frame.
    fn mate_with_offset_vec(
        kind: MateKind, a: MateRef, b: MateRef, flip: bool, offset: [f64; 3], ratio: f64, radius: f64,
    ) -> Mate {
        Mate { kind, a, b, flip, offset, ratio, radius, angle: 0.0 }
    }

    /// (qz, qw) for a pure roll of `deg` degrees about world Z, qx = qy = 0.
    fn quat_roll_z(deg: f64) -> (f32, f32) {
        let half = (deg.to_radians() / 2.0).sin();
        let cos_half = (deg.to_radians() / 2.0).cos();
        (half as f32, cos_half as f32)
    }

    /// Two bodies: body 0 at origin (grounded), body 1 at (5, 0, 0).
    /// One spherical mate at (0,0,0) should pull body 1 to body 0.
    fn two_body_input() -> MateInput {
        MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity, grounded
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: translated +x
            ],
            fixed_mask: vec![0b0000_0001], // body 0 is grounded
            mates: vec![mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false, 0.0, 1.0, 0.0,
            )],
        }
    }

    #[test]
    fn spherical_pulls_bodies_together() {
        let input = two_body_input();
        let out = solve_mate(&input);
        assert!(out.params_solved[7].abs() < 1e-3, "tx should be ~0, got {}", out.params_solved[7]);
        assert!(out.params_solved[8].abs() < 1e-3, "ty should be ~0, got {}", out.params_solved[8]);
        assert!(out.params_solved[9].abs() < 1e-3, "tz should be ~0, got {}", out.params_solved[9]);
        assert!(out.params_solved[0].abs() < 1e-3);
        assert!((out.params_solved[6] - 1.0).abs() < 1e-3, "qw should be ~1");
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn spherical_fully_constrained_with_three_mates() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 1.0, 2.0, 0.1, 0.2, 0.3, 0.927,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![
                mate(MateKind::Spherical,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    false, 0.0, 1.0, 0.0),
                mate(MateKind::Spherical,
                    mate_ref(0, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    mate_ref(1, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    false, 0.0, 1.0, 0.0),
                mate(MateKind::Spherical,
                    mate_ref(0, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    mate_ref(1, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    false, 0.0, 1.0, 0.0),
            ],
        };
        let out = solve_mate(&input);
        assert!((out.params_solved[6] - 1.0).abs() < 1e-3);
        assert!(out.params_solved[7].abs() < 5e-2, "tx={}", out.params_solved[7]);
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn parallel_aligns_axes_parallel() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, -0.707, 0.0, 0.0, 0.707,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Parallel,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        let qw = out.params_solved[13];
        assert!((qw.abs() - 1.0).abs() < 1e-2, "qw should be ~±1, got {}", qw);
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn parallel_flip_aligns_axes_anti_parallel() {
        let angle = 0.3;
        let half: f64 = angle / 2.0;
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, half.sin() as f32, 0.0, 0.0, half.cos() as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Parallel,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                true, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        let qx = out.params_solved[10];
        let qy = out.params_solved[11];
        let rot_mag = (qx as f64 * qx as f64 + qy as f64 * qy as f64).sqrt();
        assert!(rot_mag > 0.5, "should have significant rotation, q=({}, {}, {}, {})",
            qx, qy, out.params_solved[12], out.params_solved[13]);
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn fixed_mate_pins_all_dof() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                3.0, 4.0, 5.0, 0.0, 0.707, 0.0, 0.707,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Fixed,
                mate_ref(0, 2.0, 3.0, 4.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert!((out.params_solved[7] - 2.0).abs() < 1e-2, "tx={}", out.params_solved[7]);
        assert!((out.params_solved[8] - 3.0).abs() < 1e-2, "ty={}", out.params_solved[8]);
        assert!((out.params_solved[9] - 4.0).abs() < 1e-2, "tz={}", out.params_solved[9]);
        assert!(out.diagnostics.residual_norm < 1e-3);
        // The regression test for the whole feature: a single Fixed mate against a
        // grounded body must pin all 6 DOF, not 5. Before the roll residual this
        // reported Underconstrained with dof == 1 (the free roll about the shared
        // axis) even though the name promised otherwise.
        assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
        assert_eq!(out.diagnostics.dof, 0);
    }

    #[test]
    fn fixed_mate_corrects_seeded_roll_error_to_authored_angle() {
        // Body 1 seeded with a 30 degree roll about the shared Z axis but the
        // mate authors angle == 0. The old seed-relative residual HELD the 30
        // degrees ("whatever roll the seed had"), which is exactly how solver
        // rounding baked into the doc on drag pointer-up became permanent:
        // welded parts drifted apart rotationally and nothing ever pulled them
        // back. The absolute residual treats the 30 degrees as the error it is.
        let (qz, qw) = quat_roll_z(30.0);
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
                0.0, 0.0, 0.0, 0.0, 0.0, qz, qw, // body 1: 30 deg about Z
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
        assert_eq!(out.diagnostics.dof, 0);
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
        assert!(roll_deg.abs() < 1.0, "roll should snap to the authored 0 deg, got {}", roll_deg);
    }

    /// Re-solving from a solve's own output must change nothing. This is THE
    /// regression test for the drift/ratchet family of bugs: the editor bakes
    /// solved poses into the doc seeds on every drag pointer-up, so any
    /// seed-relative term in a mate residual turns the solve into an integrator
    /// -- an authored 30 deg angle re-applied itself per reseed (a ratchet),
    /// and rounding errors random-walked the weld. An absolute formulation is
    /// idempotent under reseeding.
    #[test]
    fn fixed_mate_solve_is_idempotent_under_reseed() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                3.0, 4.0, 5.0, 0.0, 0.707, 0.0, 0.707,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_angle(MateKind::Fixed,
                mate_ref(0, 2.0, 3.0, 4.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0, 30.0_f64.to_radians())],
        };
        let first = solve_mate(&input);

        let reseeded = MateInput {
            params_initial: first.params_solved.clone(),
            ..input
        };
        let second = solve_mate(&reseeded);

        for i in 0..14 {
            assert!(
                (second.params_solved[i] - first.params_solved[i]).abs() < 1e-3,
                "param {} moved on reseed: {} -> {} (the ratchet)",
                i, first.params_solved[i], second.params_solved[i],
            );
        }
    }

    #[test]
    fn overconstrained_threshold_scales_with_problem_size_not_absolute_residual() {
        // A residual_norm of 0.005 would trip the old absolute 1e-4 threshold
        // regardless of how many residuals it is spread across. For a "large
        // assembly" (m = 10_000) that is actually converged fine per-residual
        // (rms = 0.005 / sqrt(10_000) = 5e-5), the scaled threshold correctly
        // does not flag it -- the old absolute threshold would have.
        assert_eq!(mate_status(0.005, 10_000, 0), MateStatus::FullyConstrained);
        // Same absolute residual_norm, concentrated in a single residual
        // (m = 1): genuinely overconstrained, still flagged.
        assert_eq!(mate_status(0.005, 1, 0), MateStatus::Overconstrained);
    }

    #[test]
    fn fixed_mate_resists_torque_from_another_mate() {
        // Body 1 seeded at 30 deg roll about Z and also carrying a Parallel mate
        // between the same two axes -- a mate that on its own would happily leave
        // roll free. Before the roll residual the two mates together still left
        // roll undetermined (Parallel does not touch it either); after, Fixed pins
        // it and the combined system reports zero DOF with the roll held.
        let (qz, qw) = quat_roll_z(30.0);
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, 0.0, 0.0, qz, qw,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![
                mate(MateKind::Fixed,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    false, 0.0, 1.0, 0.0),
                mate(MateKind::Parallel,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    false, 0.0, 1.0, 0.0),
            ],
        };
        let out = solve_mate(&input);
        // The Parallel mate is redundant with Fixed's own axis-alignment residual
        // (both want the same two axes parallel), so the combined Jacobian's rank is
        // unchanged: FullyConstrained, not Overconstrained. Asserted strictly, not
        // as an either/or -- a regression that quietly flips this to Overconstrained
        // must fail here, not hide behind the other branch.
        assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
        assert_eq!(out.diagnostics.dof, 0);
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
        assert!(roll_deg.abs() < 1.0, "roll should land on the authored 0 deg, got {}", roll_deg);
    }

    #[test]
    fn rotating_keeps_one_free_dof() {
        // Rotating shares its residual prefix with Fixed (point coincidence +
        // signed axis difference); it must not pick up the roll residual by a
        // copy-paste into the wrong arm. A revolute joint's whole purpose is the
        // free roll.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Rotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert_eq!(out.diagnostics.dof, 1);
        assert_eq!(out.overall_status, MateStatus::Underconstrained.to_u8());
    }

    #[test]
    fn underconstrained_assembly_status() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0],
            mates: vec![mate(MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert_eq!(out.overall_status, MateStatus::Underconstrained.to_u8());
        assert!(out.diagnostics.dof > 0);
    }

    #[test]
    fn no_mates_returns_unchanged() {
        let input = MateInput {
            bodies: vec![RigidBody {}],
            params_initial: vec![1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0],
            fixed_mask: vec![0b0000_0001],
            mates: vec![],
        };
        let out = solve_mate(&input);
        assert!((out.params_solved[0] - 1.0).abs() < 1e-4);
        assert!((out.params_solved[1] - 2.0).abs() < 1e-4);
        assert!((out.params_solved[2] - 3.0).abs() < 1e-4);
    }

    #[test]
    fn quaternion_stays_near_unit_in_mate_solve() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.2,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert!(out.params_solved[7].abs() < 1e-2);
        let qx = out.params_solved[10] as f64;
        let qy = out.params_solved[11] as f64;
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let norm = (qx * qx + qy * qy + qz * qz + qw * qw).sqrt();
        assert!((norm - 1.0).abs() < 1e-2, "norm={}", norm);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn spherical_mate_accuracy_with_settled_body() {
        let input = two_body_input();
        let out = solve_mate(&input);
        let tx = out.params_solved[7] as f64;
        let ty = out.params_solved[8] as f64;
        let tz = out.params_solved[9] as f64;
        assert!(tx.abs() < 1e-4, "tx={}", tx);
        assert!(ty.abs() < 1e-4, "ty={}", ty);
        assert!(tz.abs() < 1e-4, "tz={}", tz);
    }

    // ─── New mate kind tests (Stage 4b) ───

    #[test]
    fn sliding_allows_translation_along_axis() {
        // Grounded body 0 at origin with axis Z. Body 1 starts at (5, 0, 0)
        // with Z axis. Sliding mate at anchor points along Z should pull
        // body 1's axis parallel and its anchor point onto body 0's axis,
        // but leave translation along Z free (Tikhonov keeps it near seed).
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
                3.0, 4.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1 at (3,4,0), Z axis
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Sliding,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        // Body 1's anchor should be pulled to body 0's axis (Z axis).
        // So body 1's x,y should be near 0.
        assert!(out.params_solved[7].abs() < 1e-2, "tx should be near 0, got {}", out.params_solved[7]);
        assert!(out.params_solved[8].abs() < 1e-2, "ty should be near 0, got {}", out.params_solved[8]);
        // Z translation is free, stays near seed (0).
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn rotating_keeps_point_coincident_allows_roll() {
        // Grounded body 0 at origin. Body 1's anchor point must stay
        // coincident with body 0's anchor, while axes align. Roll is free.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1 at (5,0,0)
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Rotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        // Point coincidence: body 1's anchor at local (0,0,0) must match
        // body 0's anchor at world (0,0,0). So body 1 must move to origin.
        assert!(out.params_solved[7].abs() < 1e-2, "tx should be ~0, got {}", out.params_solved[7]);
        assert!(out.params_solved[8].abs() < 1e-2, "ty should be ~0");
        assert!(out.params_solved[9].abs() < 1e-2, "tz should be ~0");
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn sliding_rotating_constrains_axis_only() {
        // Only axes must align. Both slide and roll are free.
        // Body 1 starts with X axis (after 90° about Y), body 0 has Z axis.
        // SlidingRotating constrains axes to be parallel.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: Z axis
                0.0, 0.0, 0.0, 0.0, 0.707, 0.0, 0.707, // body 1: X axis (90° about Y)
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::SlidingRotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        // Axes should be aligned. Body 1's local Z axis → world direction
        // should be parallel to body 0's Z axis. The 90° about Y should be corrected.
        let qw = out.params_solved[13];
        assert!((qw.abs() - 1.0).abs() < 1e-2, "qw should be ~±1, got {}", qw);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn parallel_plane_distance_holds_fixed_offset() {
        // Body 0 has a plane anchor at Z=0 with normal +Z.
        // Body 1's anchor should be offset by 5 units along body 0's normal.
        // Body 0 is grounded at origin.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, // body 1 at (1,2,3)
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::ParallelPlaneDistance,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 5.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        // dot(p_b - p_a, a_w) should be 5.0.
        // p_a = (0,0,0), a_w = (0,0,1). So p_b.z should be ~5.
        assert!((out.params_solved[9] - 5.0).abs() < 1e-2, "tz should be ~5, got {}", out.params_solved[9]);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn tangential_plane_plane_coincidence() {
        // Two planes should be coincident (offset=0). Body 0 plane at origin
        // with normal +Z. Body 1 point should lie on body 0's plane.
        // Add a parallel mate to prevent the quaternion from cheating by
        // rotating the plane normal away from Z.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                1.0, 2.0, 10.0, 0.0, 0.0, 0.0, 1.0, // body 1 above the plane
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![
                mate(MateKind::Parallel,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    false, 0.0, 1.0, 0.0),
                mate(MateKind::Tangential,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                    false, 0.0, 1.0, 0.0),
            ],
        };
        let out = solve_mate(&input);
        // Body 1 should move to Z=0 (onto body 0's plane, with axes kept parallel).
        assert!((out.params_solved[9] as f64).abs() < 5e-2, "tz should be ~0, got {}", out.params_solved[9]);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn tangential_plane_cylinder_clearance() {
        // Plane A at origin with normal +Z. Cylinder B should be tangent.
        // Point on cylinder is at B's anchor; distance from point to plane = radius.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: plane, grounded
                0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, // body 1: cylinder far away
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Tangential,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 2.5)],
        };
        let out = solve_mate(&input);
        // The cylinder point (at Z) should be 2.5 units from the plane (Z=0).
        // Since body 1's anchor point is at local origin, its world Z should be ~2.5.
        assert!((out.params_solved[9] - 2.5).abs() < 1e-2, "tz should be ~2.5, got {}", out.params_solved[9]);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn tangential_cylinder_cylinder_distance() {
        // Two cylinders with parallel axes. Distance between axes = 2*radius.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: cylinder at origin, Z axis, grounded
                10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: cylinder at (10,0,0), Z axis
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Tangential,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 3.0)],
        };
        let out = solve_mate(&input);
        // Axis distance should be 2*radius = 6.0. Body 0 at x=0, body 1 should be at x=6.
        let tx = out.params_solved[7] as f64;
        assert!((tx - 6.0).abs() < 0.1, "tx should be ~6, got {}", tx);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn copy_rotation_links_roll() {
        // Stage E behaviour change: body 0 (grounded) seeded with ~1 rad roll
        // about Z, body 1 seeded at no roll. Before Stage E the residual was
        // ABSOLUTE (twist_b - ratio*twist_a), so this snapped body 1 to body
        // 0's 1 rad roll on the very first solve. The seed-relative residual
        // instead holds `twist_b - twist_b0 = ratio * (twist_a - twist_a0)`;
        // body 0 is grounded so it never moves from its seed (twist_a ==
        // twist_a0 always), which makes the right side zero -- so body 1
        // holds ITS OWN seed (no roll) instead of snapping to body 0's.
        let half = 0.5_f64.sin(); // sin(0.5) for ~1 rad total
        let cos_half = 0.5_f64.cos();
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, half as f32, cos_half as f32, // body 0: ~1 rad about Z
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: no roll (identity)
            ],
            fixed_mask: vec![0b0000_0001], // body 0 grounded
            mates: vec![mate(MateKind::CopyRotation,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        let qz1 = out.params_solved[12] as f64;
        let qw1 = out.params_solved[13] as f64;
        let roll1 = 2.0 * qz1.atan2(qw1);
        assert!(roll1.abs() < 0.05, "body 1 should hold its own seed (no roll), got roll1={}", roll1);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn fixed_mate_with_angle_rolls_to_ninety_degrees() {
        // Both bodies start at identity (zero seed-relative roll). angle = pi/2
        // should solve body 1 to exactly 90 degrees of roll about the shared axis.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_angle(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0, std::f64::consts::FRAC_PI_2)],
        };
        let out = solve_mate(&input);
        assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
        assert_eq!(out.diagnostics.dof, 0);
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
        assert!((roll_deg - 90.0).abs() < 1.0, "roll should be ~90 deg, got {}", roll_deg);
    }

    #[test]
    fn fixed_with_offset() {
        // Fixed mate with linear offset. Body 0 grounded at origin with Z axis.
        // The residual is: p_a_w - p_b_w - offset * a_w = 0
        // So p_b_w = p_a_w - offset * a_w. With p_a=(0,0,0) and a_w=(0,0,1):
        // p_b_w = (0,0,-10). Body 1's anchor at local origin, so tz = -10.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0, // body 1
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 10.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        // Body 1's tz should be -10 (p_b_w = p_a_w - offset*a_w = (0,0,0) - 10*(0,0,1)).
        assert!((out.params_solved[9] - (-10.0)).abs() < 1e-2, "tz should be ~-10, got {}", out.params_solved[9]);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    /// The legacy authoring form -- a bare scalar offset along A's axis -- must
    /// still land in exactly the place it did before `offset` became a vector.
    /// Written against the vector constructor with the scalar expanded by hand,
    /// so it pins the equivalence rather than inheriting it from the `mate`
    /// helper the older tests share.
    #[test]
    fn scalar_offset_and_its_axial_vector_agree() {
        let build = |offset: [f64; 3]| MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_offset_vec(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, offset, 1.0, 0.0)],
        };
        // `offset: 7` on a Z axis is the vector (0, 0, 7).
        let legacy = solve_mate(&build([0.0, 0.0, 7.0]));
        assert!((legacy.params_solved[9] - (-7.0)).abs() < 1e-2,
            "tz should be ~-7, got {}", legacy.params_solved[9]);
        assert!(legacy.diagnostics.residual_norm < 1e-2);
    }

    /// An offset with components off A's axis translates the weld sideways --
    /// the whole point of the widening. p_b = p_a - R_a * offset, and with A at
    /// identity that is just the negated offset.
    #[test]
    fn fixed_with_off_axis_offset_vector() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_offset_vec(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, [3.0, 4.0, 2.0], 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        for (i, want) in [-3.0, -4.0, -2.0].into_iter().enumerate() {
            assert!((out.params_solved[7 + i] as f64 - want).abs() < 1e-2,
                "body 1 t[{}] should be ~{}, got {}", i, want, out.params_solved[7 + i]);
        }
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    /// The frame decision, pinned: the offset lives in body A's LOCAL frame, so
    /// rotating A rotates the applied offset with it. Body 0 is grounded a
    /// quarter turn about Z, which maps the local offset (3, 4, 0) to the world
    /// (-4, 3, 0); body 1 must therefore land at (4, -3, 0), not (-3, -4, 0).
    /// Switching to a world-frame offset moves this assertion.
    #[test]
    fn fixed_offset_vector_rotates_with_body_a() {
        let (qz, qw) = quat_roll_z(90.0);
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, qz, qw,
                5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_offset_vec(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, [3.0, 4.0, 0.0], 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert!((out.params_solved[7] as f64 - 4.0).abs() < 1e-2,
            "tx should be ~4, got {}", out.params_solved[7]);
        assert!((out.params_solved[8] as f64 - (-3.0)).abs() < 1e-2,
            "ty should be ~-3, got {}", out.params_solved[8]);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    /// ParallelPlaneDistance reads only the axial component: an offset with the
    /// same axial part but arbitrary in-plane components must solve to the same
    /// separation, because sliding within the plane is the mate's free DOF.
    #[test]
    fn parallel_plane_distance_ignores_the_in_plane_offset() {
        let build = |offset: [f64; 3]| MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_offset_vec(MateKind::ParallelPlaneDistance,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, offset, 1.0, 0.0)],
        };
        let axial = solve_mate(&build([0.0, 0.0, 6.0]));
        let with_slide = solve_mate(&build([9.0, -9.0, 6.0]));
        assert!((axial.params_solved[9] - 6.0).abs() < 1e-2,
            "tz should be ~6, got {}", axial.params_solved[9]);
        assert!((with_slide.params_solved[9] - axial.params_solved[9]).abs() < 1e-3,
            "in-plane offset must not change the separation");
    }

    // ─── Jacobian vs finite-difference cross-checks ───

    #[test]
    fn jacobian_vs_fd_spherical() {
        let input = two_body_input();
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    // A mate whose two refs point at the SAME body. `solveAssembly.ts` rejects
    // this upstream (a mate needs two different parts), but the filler itself
    // must not rely on that: with off_a == off_b, A's and B's Jacobian writes
    // land in the same cells, and `=` instead of `+=` would let B's write
    // silently discard A's, so `solve_lm` would descend a fabricated gradient
    // instead of the sum of both contributions. Fails before the `+=` fix.
    #[test]
    fn jacobian_vs_fd_spherical_self_mate() {
        let input = MateInput {
            bodies: vec![RigidBody {}],
            params_initial: vec![
                1.0, 2.0, 3.0, 0.1, 0.2, 0.3, f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
            ],
            fixed_mask: vec![0],
            mates: vec![mate(MateKind::Spherical,
                mate_ref(0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false, 0.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_fixed() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                3.0, 4.0, 5.0, 0.1, 0.2, 0.3, f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Fixed,
                mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    /// The offset-vector term enters the analytic Jacobian through
    /// `drot_vec_dq(q_a, offset)`; evaluated at a rotated, off-axis pose so a
    /// wrong derivative cannot hide behind an offset that happens to be axial.
    #[test]
    fn jacobian_vs_fd_fixed_with_offset_vector() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.1, -0.2, 0.3, f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
                3.0, 4.0, 5.0, 0.1, 0.2, 0.3, f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_offset_vec(MateKind::Fixed,
                mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, [2.0, -3.0, 1.5], 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_parallel() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, -0.5, 0.1, 0.2, f64::sqrt(1.0 - 0.25 - 0.01 - 0.04) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Parallel,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_sliding() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                3.0, 2.0, 1.0, -0.3, 0.1, 0.4, f64::sqrt(1.0 - 0.09 - 0.01 - 0.16) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Sliding,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_rotating() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                2.0, 3.0, 4.0, 0.2, -0.1, 0.5, f64::sqrt(1.0 - 0.04 - 0.01 - 0.25) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Rotating,
                mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_sliding_rotating() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, -0.5, 0.2, 0.1, f64::sqrt(1.0 - 0.25 - 0.04 - 0.01) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::SlidingRotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_parallel_plane_distance() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                1.0, 2.0, 7.0, 0.1, 0.3, 0.2, f64::sqrt(1.0 - 0.01 - 0.09 - 0.04) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::ParallelPlaneDistance,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 5.0, 1.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_copy_rotation() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.9539, // body 0: some roll about Z
                0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.9949, // body 1: less roll about Z
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::CopyRotation,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 2.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    // Every `jacobian_vs_fd_*` test above evaluates at x == x0 (the seed),
    // where CopyRotation's bug (fill_copy_rotation recomputing the axis from
    // the CURRENT quaternion instead of `self.seed_axes[mi]`) was invisible:
    // at the seed the current axis and the seed axis coincide by construction.
    // Evaluating away from the seed is the only way to catch it. Fails before
    // the fix (Stage E).
    #[test]
    fn jacobian_vs_fd_copy_rotation_away_from_seed() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.9539, // body 0: some roll about Z
                0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.9949, // body 1: less roll about Z
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::CopyRotation,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 2.0, 0.0)],
        };
        let p = MateProblem::new(&input);
        let mut x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        // Rotate body 1 an extra 40 degrees about Z away from its seed roll.
        let extra = 40.0_f64.to_radians();
        let old_angle = 2.0 * x[12].atan2(x[13]);
        let new_angle = old_angle + extra;
        x[12] = (new_angle / 2.0).sin();
        x[13] = (new_angle / 2.0).cos();

        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn copy_rotation_ratio_one_leaves_bodies_seeded_at_different_rolls_untouched() {
        // Absolute residual (the old bug) would snap these together immediately.
        // The seed-relative residual is zero at the seed regardless of how far
        // apart the two rolls started, so nothing should move.
        let half_a = 20.0_f64.to_radians() / 2.0;
        let half_b = 50.0_f64.to_radians() / 2.0;
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, half_a.sin() as f32, half_a.cos() as f32,
                0.0, 0.0, 0.0, 0.0, 0.0, half_b.sin() as f32, half_b.cos() as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::CopyRotation,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        // Body 0 (offset 0): qz at index 5, qw at index 6. Body 1 (offset 7):
        // qz at index 12, qw at index 13.
        assert!((out.params_solved[5] as f64 - half_a.sin()).abs() < 1e-3);
        assert!((out.params_solved[6] as f64 - half_a.cos()).abs() < 1e-3);
        assert!((out.params_solved[12] as f64 - half_b.sin()).abs() < 1e-3);
        assert!((out.params_solved[13] as f64 - half_b.cos()).abs() < 1e-3);
    }

    #[test]
    fn copy_rotation_ratio_two_links_future_rotation_not_absolute_value() {
        // Body 0 seeded at 10 degrees roll, body 1 at 0, ratio=2. Tests the
        // residual formula directly (no iterative solve): it must be zero when
        // A has moved 20 deg from ITS seed and B has moved 40 (= ratio * 20)
        // from ITS OWN seed -- and clearly nonzero for the absolute-residual
        // reading the old bug computed (twist_b - ratio*twist_a with no seed
        // subtraction), which would demand B move to an absolute 40 measured
        // from zero, not to 40 past its own 0-degree seed. Here those two
        // readings happen to coincide (B's seed is 0), so also check a case
        // where they diverge: A's seed nonzero, B's seed nonzero too.
        let half_seed_a = 10.0_f64.to_radians() / 2.0;
        let half_seed_b = 5.0_f64.to_radians() / 2.0;
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, half_seed_a.sin() as f32, half_seed_a.cos() as f32,
                0.0, 0.0, 0.0, 0.0, 0.0, half_seed_b.sin() as f32, half_seed_b.cos() as f32,
            ],
            fixed_mask: vec![0],
            mates: vec![mate(MateKind::CopyRotation,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 2.0, 0.0)],
        };
        let p = MateProblem::new(&input);

        // A driven to seed+20deg, B driven to seed+40deg (relative link holds).
        let half_a_rel = (10.0 + 20.0_f64).to_radians() / 2.0;
        let half_b_rel = (5.0 + 40.0_f64).to_radians() / 2.0;
        let x_relative = vec![
            0.0, 0.0, 0.0, 0.0, 0.0, half_a_rel.sin(), half_a_rel.cos(),
            0.0, 0.0, 0.0, 0.0, 0.0, half_b_rel.sin(), half_b_rel.cos(),
        ];
        let r_relative = p.residuals(&x_relative);
        assert!(r_relative[0].abs() < 1e-6, "relative link should be satisfied, residual = {}", r_relative[0]);

        // Same A, but B driven to an ABSOLUTE 40deg (measured from zero, ignoring
        // its own 5deg seed) -- the old bug's target. Must NOT be zero.
        let half_b_absolute = 40.0_f64.to_radians() / 2.0;
        let x_absolute = vec![
            0.0, 0.0, 0.0, 0.0, 0.0, half_a_rel.sin(), half_a_rel.cos(),
            0.0, 0.0, 0.0, 0.0, 0.0, half_b_absolute.sin(), half_b_absolute.cos(),
        ];
        let r_absolute = p.residuals(&x_absolute);
        assert!(r_absolute[0].abs() > 0.01, "absolute-target reading should NOT satisfy the relative residual, got {}", r_absolute[0]);
    }

    /// A quaternion's rotated local Z axis, for checking alignment without
    /// depending on how the solver happened to spell the rotation.
    fn rotated_z(qx: f64, qy: f64, qz: f64, qw: f64) -> [f64; 3] {
        rotate_vec(qx, qy, qz, qw, &[0.0, 0.0, 1.0])
    }

    #[test]
    fn sliding_rotating_pulls_anchor_onto_axis_of_offset_bodies() {
        // Body 0 grounded at the origin, Z axis. Body 1 starts at (5,0,0),
        // also Z axis (parallel already, but off-axis by 5 in X). Stage D:
        // sliding_rotating now gains the perp-displacement-cross residual
        // (previously axis-cross only), so it pulls B's anchor point onto A's
        // anchor axis. Cylindrical joint: slide + roll stay free -> dof == 2.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::SlidingRotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert!(out.params_solved[7].abs() < 1e-3, "tx should be pulled to ~0, got {}", out.params_solved[7]);
        assert!(out.params_solved[8].abs() < 1e-3, "ty should be pulled to ~0, got {}", out.params_solved[8]);
        assert_eq!(out.diagnostics.dof, 2);
    }

    #[test]
    fn sliding_reports_dof_one_and_holds_authored_roll() {
        // Body 1 seeded with a 30 degree roll about the shared Z axis and the
        // mate authored with the same 30 degrees (what the editor's capture
        // writes when the refs are picked at this pose). The roll pin holds it
        // -- as authored data, not as seed memory -- and only the slide (tz)
        // stays free.
        let half: f64 = 30.0_f64.to_radians() / 2.0;
        let seed_qz = half.sin();
        let seed_qw = half.cos();
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 3.0, 0.0, 0.0, seed_qz as f32, seed_qw as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_angle(MateKind::Sliding,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false, 0.0, 1.0, 0.0, 30.0_f64.to_radians())],
        };
        let out = solve_mate(&input);
        assert_eq!(out.diagnostics.dof, 1);
        assert!((out.params_solved[12] as f64 - seed_qz).abs() < 1e-3, "qz should hold the authored roll, got {}", out.params_solved[12]);
        assert!((out.params_solved[13] as f64 - seed_qw).abs() < 1e-3, "qw should hold the authored roll, got {}", out.params_solved[13]);
    }

    #[test]
    fn parallel_plane_distance_aligns_normals_and_holds_the_offset() {
        // Stage D: parallel_plane_distance gains the Parallel axis-dot residual,
        // so it now actually aligns the normals (previously only the distance
        // along A's axis was constrained; nothing stopped the planes fanning
        // apart). flip=false -> parallel; the distance-along-axis residual is
        // unaffected by flip, so the offset holds regardless.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                1.0, 2.0, 7.0, 0.3, 0.1, 0.2, 0.9,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::ParallelPlaneDistance,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 5.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        let p = &out.params_solved;
        let z = rotated_z(p[10] as f64, p[11] as f64, p[12] as f64, p[13] as f64);
        assert!((z[2] - 1.0).abs() < 1e-2, "B's axis should align parallel to A's (+Z), got {:?}", z);
        assert!((p[9] as f64 - 5.0).abs() < 1e-2, "tz should hold the 5-unit offset, got {}", p[9]);
        // Parallelism pins 2 more rotational DOF than the distance-only formula did.
        assert_eq!(out.diagnostics.dof, 4);
    }

    #[test]
    fn parallel_plane_distance_flip_aligns_normals_anti_parallel() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                1.0, 2.0, 7.0, 0.3, 0.1, 0.2, 0.9,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::ParallelPlaneDistance,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                true, 5.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        let p = &out.params_solved;
        let z = rotated_z(p[10] as f64, p[11] as f64, p[12] as f64, p[13] as f64);
        assert!((z[2] - (-1.0)).abs() < 1e-2, "B's axis should align anti-parallel to A's (-Z), got {:?}", z);
        assert!((p[9] as f64 - 5.0).abs() < 1e-2, "tz should still hold the 5-unit offset, got {}", p[9]);
    }

    #[test]
    fn mate_residual_count_matches_actual_residuals_pushed() {
        // Guards against a future arm bumping mate_residual_count without
        // bumping the matching residuals() push count (or the reverse), which
        // would otherwise write a residual row into another mate's block
        // instead of failing loudly.
        let expected: &[(MateKind, usize)] = &[
            (MateKind::Fixed, 7),
            (MateKind::Spherical, 3),
            (MateKind::Parallel, 1),
            (MateKind::Sliding, 7),
            (MateKind::Rotating, 6),
            (MateKind::SlidingRotating, 6),
            (MateKind::Tangential, 1),
            (MateKind::CopyRotation, 1),
            (MateKind::ParallelPlaneDistance, 2),
        ];
        for &(kind, want) in expected {
            assert_eq!(mate_residual_count(kind), want, "mate_residual_count({:?})", kind);

            let input = MateInput {
                bodies: vec![RigidBody {}, RigidBody {}],
                params_initial: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                fixed_mask: vec![0],
                mates: vec![mate(kind,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                    false, 0.0, 1.0, 0.0)],
            };
            let p = MateProblem::new(&input);
            let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
            let pushed = p.residuals(&x).len();
            // Total = per-mate residuals + n_bodies (unit-norm) + 0 grounded.
            assert_eq!(pushed - 2, want, "kind {:?} pushed {} mate residuals, want {}", kind, pushed - 2, want);
            assert_eq!(p.m, pushed, "MateProblem.m disagrees with residuals().len() for {:?}", kind);
        }
    }

    #[test]
    fn mate_naming_a_body_outside_the_assembly_is_dropped() {
        // Body index 5 in a two-body assembly: a stale mate the host never
        // pruned. It must contribute no rows instead of indexing off x.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![
                mate(MateKind::Spherical,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    mate_ref(5, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    false, 0.0, 1.0, 0.0),
            ],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        // Only the two quaternion-norm rows and the grounded body's 7 pins remain.
        assert_eq!(p.residuals(&x).len(), 9);
        assert_eq!(p.m, 9);

        // The whole solve survives and leaves the free body where it was.
        let out = solve_mate(&input);
        assert!((out.params_solved[7] - 5.0).abs() < 1e-3);
    }

    #[test]
    fn mate_whose_body_block_overruns_the_params_is_dropped() {
        // Two declared bodies but only one body's worth of params: body 1's
        // block is not in the buffer, so any mate touching it goes.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            fixed_mask: vec![0],
            mates: vec![
                mate(MateKind::Spherical,
                    mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                    false, 0.0, 1.0, 0.0),
            ],
        };
        let p = MateProblem::new(&input);
        assert!(p.mates.is_empty());
    }

    #[test]
    fn rotation_damp_scale_stiffens_only_free_body_rotation() {
        // body 0 grounded, body 1 free. The damping scale must lift the four
        // rotation params of the free body and leave translation (and the whole
        // grounded body) at 1.0.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001], // body 0 grounded
            mates: vec![],
        };
        let p = MateProblem::new(&input);
        let scale = p.rotation_damp_scale();
        assert_eq!(scale.len(), 14);
        assert!(scale[0..7].iter().all(|&s| s == 1.0), "grounded body stays at 1.0");
        assert!(scale[7..10].iter().all(|&s| s == 1.0), "free-body translation stays at 1.0");
        assert!(scale[10..14].iter().all(|&s| s == ROT_DAMP_SCALE), "free-body rotation is stiffened");
        assert!(ROT_DAMP_SCALE > 1.0);
    }

    #[test]
    fn free_body_reaches_point_more_by_translating_than_rotating() {
        // A single spherical coincidence a free body could satisfy by either
        // translating or turning 90 deg (its anchor is offset from its origin).
        // The rotation damping tips LM toward the slide: it ends far closer to the
        // pure-translation solution (q ~ identity) than to the 90 deg turn
        // (qz ~ -0.707), while still meeting the coincidence exactly.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded at origin
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1 free, seed identity
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(
                MateKind::Spherical,
                mate_ref(0, 3.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point), // world target (3,0,0)
                mate_ref(1, 0.0, 3.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point), // body-local (0,3,0)
                false, 0.0, 1.0, 0.0,
            )],
        };
        let out = solve_mate(&input);
        // A pure 90 deg turn would read qw = 0.707, qz = -0.707, tx = 0.
        // With stronger rotation damping the solve stays close to the
        // pure-translation solution, carrying the required coincidence nearly
        // entirely through tx/ty.
        assert!(out.params_solved[13] > 0.95, "qw near 1 (little rotation), got {}", out.params_solved[13]);
        assert!(out.params_solved[12].abs() < 0.2, "qz well short of the -0.707 turn, got {}", out.params_solved[12]);
        assert!(out.params_solved[7] > 2.5, "tx carried most of the motion, got {}", out.params_solved[7]);
        assert!(out.diagnostics.residual_norm < 1e-3, "coincidence met, got {}", out.diagnostics.residual_norm);
    }

    fn compare_jacobians(analytical: &DMatrix<f64>, fd: &DMatrix<f64>, tol: f64) {
        for r in 0..analytical.nrows() {
            for c in 0..analytical.ncols() {
                let a = analytical[(r, c)];
                let f = fd[(r, c)];
                let diff = (a - f).abs();
                let denom = f.abs().max(1e-12);
                assert!(
                    diff < tol * denom.max(1.0) || diff < tol,
                    "row={}, col={}, analytic={}, fd={}, diff={}",
                    r, c, a, f, diff
                );
            }
        }
    }

    #[test]
    fn fixed_mate_applies_authored_angle() {
        // Aligned Z axes at seed, body 1 at identity. Author angle = 45 deg.
        // The solved roll of body 1 should be 45 deg about Z.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: identity
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_angle(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0, 45.0_f64.to_radians())],
        };
        let out = solve_mate(&input);
        assert_eq!(out.diagnostics.dof, 0);
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
        assert!((roll_deg - 45.0).abs() < 1.0, "roll should be 45 deg, got {}", roll_deg);
    }

    #[test]
    fn fixed_mate_locks_roll_when_axes_not_prealigned() {
        // The reported bug: body 1 seeded rotated 90 deg about Y, so its local Z
        // axis points along world +X at seed -- NOT parallel to body 0's world Z.
        // This is the ordinary case of welding two arbitrarily placed parts. The
        // fixed mate must swing body 1 to align the axes AND still lock roll
        // fully (dof == 0). Measuring twist about the stale seed axis left dof 1
        // here (roll free), so the weld "did not lock the angle".
        let h = 45.0_f64.to_radians().sin();
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
                0.0, 0.0, 0.0, 0.0, h as f32, 0.0, h as f32, // body 1: 90 deg about Y
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
        assert_eq!(out.diagnostics.dof, 0, "fixed mate must lock all DOF even when axes need to swing");
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn fixed_mate_locks_roll_and_applies_angle_not_prealigned() {
        // Same not-pre-aligned setup as above, but now author a 60 deg roll. The
        // weld must both align the swung axes and impose the authored roll about
        // the shared axis, leaving zero DOF.
        let h = 45.0_f64.to_radians().sin();
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, 0.0, h as f32, 0.0, h as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_angle(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0, 60.0_f64.to_radians())],
        };
        let out = solve_mate(&input);
        assert_eq!(out.diagnostics.dof, 0);
        assert!(out.diagnostics.residual_norm < 1e-3);
        // Body 1's Z axis ends aligned with world Z; its roll about that axis
        // should read 60 deg relative to the grounded body 0.
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
        assert!((roll_deg - 60.0).abs() < 1.5, "roll should be ~60 deg, got {}", roll_deg);
    }

    #[test]
    fn fixed_mate_flip_true_holds_anti_parallel_weld() {
        // Body 1's anchor axis points opposite body 0's at the seed (its local +Z
        // maps to world -Z via a 180 deg roll about X) -- a face-to-face weld. The
        // side is AUTHORED: flip=true (with the 180 deg roll the editor's capture
        // records for this pose) holds the anti-parallel alignment. The old
        // cross-product axis residual was blind to the sign and could settle
        // either way; the old seed-derived sign flipped when a drag swung the
        // axes past perpendicular.
        let h = 90.0_f64.to_radians().sin(); // sin(90) = 1 -> 180 deg rotation quat
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, +Z axis
                0.0, 0.0, 0.0, h as f32, 0.0, 0.0, 0.0, // body 1: 180 deg about X -> axis -Z
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate_with_angle(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                true, 0.0, 1.0, 0.0, std::f64::consts::PI)],
        };
        let out = solve_mate(&input);
        assert_eq!(out.diagnostics.dof, 0);
        assert!(out.diagnostics.residual_norm < 1e-3);
        // Body 1's world axis stays -Z: it did not flip to +Z. Rotating its local
        // +Z by the solved quaternion must land near (0, 0, -1).
        let q = (
            out.params_solved[10] as f64, out.params_solved[11] as f64,
            out.params_solved[12] as f64, out.params_solved[13] as f64,
        );
        let axis_w = rotate_vec(q.0, q.1, q.2, q.3, &[0.0, 0.0, 1.0]);
        assert!(axis_w[2] < -0.9, "axis should stay anti-parallel (-Z), got {:?}", axis_w);
    }

    #[test]
    fn fixed_mate_authored_side_beats_seed_side() {
        // Nearly anti-parallel seed (175 deg about X -- not exactly 180, which
        // is a stationary point of the axis residual where every descent
        // direction is flat), but the mate authors flip=false (parallel). The
        // old seed-derived sign read dot < 0 and would have "helpfully" welded
        // the anti-parallel side; the authored side must win, swinging body 1
        // back through perpendicular to parallel. This is what makes the weld
        // side a stable, user-visible property instead of a solver mood.
        let h = 87.5_f64.to_radians();
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, h.sin() as f32, 0.0, 0.0, h.cos() as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert!(out.diagnostics.residual_norm < 1e-3);
        let q = (
            out.params_solved[10] as f64, out.params_solved[11] as f64,
            out.params_solved[12] as f64, out.params_solved[13] as f64,
        );
        let axis_w = rotate_vec(q.0, q.1, q.2, q.3, &[0.0, 0.0, 1.0]);
        assert!(axis_w[2] > 0.9, "axis should swing to the authored parallel side (+Z), got {:?}", axis_w);
    }

    #[test]
    fn rotating_flip_true_holds_anti_parallel_axis() {
        // A hinge authored on anti-parallel axes (flip=true) must hold that side
        // while leaving roll free. With the old cross-product residual both
        // sides were solutions, so which one the joint landed on was seed luck.
        let h = 90.0_f64.to_radians().sin();
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody {}).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                1.0, 0.0, 0.0, h as f32, 0.0, 0.0, 0.0, // 180 deg about X -> axis -Z
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(MateKind::Rotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                true, 0.0, 1.0, 0.0)],
        };
        let out = solve_mate(&input);
        assert!(out.diagnostics.residual_norm < 1e-3);
        assert_eq!(out.diagnostics.dof, 1, "hinge roll stays free");
        let q = (
            out.params_solved[10] as f64, out.params_solved[11] as f64,
            out.params_solved[12] as f64, out.params_solved[13] as f64,
        );
        let axis_w = rotate_vec(q.0, q.1, q.2, q.3, &[0.0, 0.0, 1.0]);
        assert!(axis_w[2] < -0.9, "axis should hold anti-parallel (-Z), got {:?}", axis_w);
    }

    #[test]
    fn canonical_perp_is_unit_and_perpendicular() {
        // The frame the roll residual measures against. Fixture values are
        // shared with utils/mateOrientation.test.ts (the TS twin): if either
        // side changes its branch rule, both tests must be updated together or
        // the editor's captured angle stops matching the solver's measurement.
        let cases: [([f64; 3], [f64; 3]); 4] = [
            ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),   // z crossed with x
            ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),   // x crossed with y
            ([0.0, 1.0, 0.0], [0.0, 0.0, -1.0]),  // y crossed with x
            ([0.6, 0.0, 0.8], [-0.8, 0.0, 0.6]),  // tilted, crossed with y
        ];
        for (axis, want) in cases {
            let p = canonical_perp(&axis);
            let dot = p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
            assert!(dot.abs() < 1e-12, "perp not perpendicular for {:?}", axis);
            for c in 0..3 {
                assert!((p[c] - want[c]).abs() < 1e-12, "canonical_perp({:?}) = {:?}, want {:?}", axis, p, want);
            }
        }
    }

    #[test]
    fn nan_seed_reports_the_failing_status_never_fully_constrained() {
        // The codec rejects non-finite floats on the wire, but solve_mate also
        // accepts an in-memory MateInput a host can seed directly. A NaN seed
        // poisons the Jacobian, and the rank pass must not run on it: this is
        // the belt behind the codec's braces. Before the gate the solve either
        // hung in nalgebra's SVD or classified NaN as FullyConstrained and
        // locked the UI on garbage.
        let mut input = two_body_input();
        input.params_initial[7] = f32::NAN;
        let out = solve_mate(&input);
        assert_ne!(
            out.overall_status,
            MateStatus::FullyConstrained.to_u8(),
            "a poisoned solve must never read as solved"
        );
        let all_finite = out.params_solved.iter().all(|p| p.is_finite());
        assert!(
            all_finite || out.overall_status == MateStatus::Overconstrained.to_u8(),
            "expected finite params or an error status, got status={} params={:?}",
            out.overall_status, out.params_solved,
        );
    }

    #[test]
    fn dense_cell_guard_flags_products_over_budget_and_overflow() {
        // Tiny numbers stand in for the real 2e8-cell budget so the gate is
        // exercisable in microseconds.
        let tiny_budget = 100;
        assert!(!dense_cells_over_budget(10, 10, tiny_budget));
        assert!(dense_cells_over_budget(11, 11, tiny_budget));
        // A count pair whose product cannot even be represented must read as
        // over budget rather than wrapping back under the ceiling.
        assert!(dense_cells_over_budget(usize::MAX, 2, tiny_budget));
    }

    #[test]
    fn solve_mate_refuses_an_assembly_past_the_dense_budget_without_allocating() {
        // The two-body fixture is 12x14 = 168 cells, so a budget of 100 refuses
        // it before the first Jacobian allocation: the seed passes through
        // untouched and the failing status comes back instead of the worker
        // dying inside a dense factorization it can never finish.
        let input = two_body_input();
        let out = solve_mate_with_budget(&input, 100);
        assert_eq!(out.overall_status, MateStatus::Overconstrained.to_u8());
        assert_eq!(out.params_solved, input.params_initial);
        assert_eq!(out.diagnostics.iters, 0);
        assert_eq!(out.diagnostics.dof, 0);
        assert!(out.diagnostics.residual_norm.is_infinite());

        // The same assembly at the real budget still solves normally.
        let out = solve_mate(&input);
        assert!(out.diagnostics.residual_norm.is_finite());
    }
}

