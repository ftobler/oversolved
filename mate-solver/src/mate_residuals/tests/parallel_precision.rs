//! Exactness of the two face-parallel kinds, `Parallel` and
//! `ParallelPlaneDistance`. Both once aligned their axes through the cosine
//! row `dot(a_w, b_w) - sign`, whose slope vanishes at the solution: LM crept
//! toward parallel at a linear rate, the absolute gradient test fired about a
//! milliradian short, and a 500-unit bar settled visibly tilted while the
//! verdict read satisfied. Re-solving from that pose moved it again, so every
//! bake crept the assembly. These tests pin the exact landing, the idempotent
//! re-solve, the true joint DOF and the antiparallel seed.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::math::{quat_exp, quat_mul, quat_normalize, rotate_vec};
use crate::mate_residuals::*;

/// Quaternion for extrinsic XYZ Euler degrees, the editor's RX/RY/RZ boxes.
fn euler_xyz_deg(rx: f64, ry: f64, rz: f64) -> [f64; 4] {
    let r = |axis: [f64; 3], deg: f64| {
        let a = deg.to_radians();
        quat_exp(&[axis[0] * a, axis[1] * a, axis[2] * a])
    };
    let qx = r([1.0, 0.0, 0.0], rx);
    let qy = r([0.0, 1.0, 0.0], ry);
    let qz = r([0.0, 0.0, 1.0], rz);
    quat_normalize(&quat_mul(&qz, &quat_mul(&qy, &qx)))
}

/// The measured bug fixture: a grounded plate whose top face (+Z at z = 10)
/// is A, and a free 500-long bar whose bottom face (outward -Z) is B, its
/// anchor 250 from the body origin so a tilt has a long lever. Seeded at a
/// compound [20, 15, 30] degree tilt, flip true for face-to-face contact.
fn plate_bar_input(kind: MateKind) -> MateInput {
    let q = euler_xyz_deg(20.0, 15.0, 30.0);
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // plate, grounded
            10.0, 20.0, 40.0, q[0], q[1], q[2], q[3],
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            kind,
            mate_ref(0, 50.0, 50.0, 10.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 250.0, 10.0, 0.0, 0.0, 0.0, -1.0, AnchorKind::Plane),
            true,
            0.0,
            1.0,
            0.0,
        )],
    }
}

/// Angle between A's world normal and the reversed world normal of B: zero
/// when the faces are exactly face to face.
fn face_tilt(params: &[f64]) -> f64 {
    // Body 1's block starts at 7: translation 7..10, quaternion 10..14.
    let q = &params[10..14];
    let b_w = rotate_vec(q[0], q[1], q[2], q[3], &[0.0, 0.0, -1.0]);
    // A is grounded at identity, so its normal is +Z; face to face is b_w = -Z.
    let dot = (-b_w[2]).clamp(-1.0, 1.0);
    let cross = (b_w[0] * b_w[0] + b_w[1] * b_w[1]).sqrt();
    cross.atan2(dot)
}

/// Signed height of B's anchor above A's plane, along A's +Z.
fn plane_gap(params: &[f64]) -> f64 {
    let q = &params[10..14];
    let p = rotate_vec(q[0], q[1], q[2], q[3], &[250.0, 10.0, 0.0]);
    params[9] + p[2] - 10.0
}

#[test]
fn ppd_converges_to_exact_parallel_from_tilted_seed() {
    let out = solve_mate(&plate_bar_input(MateKind::ParallelPlaneDistance));
    let tilt = face_tilt(&out.params_solved);
    assert!(tilt < 1e-9, "bar left tilted by {tilt} rad");
    let gap = plane_gap(&out.params_solved);
    assert!(gap.abs() < 1e-9, "plane gap {gap}");
    // No iteration bound here, unlike Parallel's: this fixture's free spin
    // drifts during the anchored phase, which then runs to its 200-step cap
    // before the polish lands it exactly. That is the separate free-DOF plan
    // (feature/bug-mate-free-spin-drift.md), not this row's convergence.
}

#[test]
fn parallel_converges_to_exact_parallel_from_tilted_seed() {
    let out = solve_mate(&plate_bar_input(MateKind::Parallel));
    let tilt = face_tilt(&out.params_solved);
    assert!(tilt < 1e-9, "bar left tilted by {tilt} rad");
    assert!(
        out.diagnostics.iters < 30,
        "took {} iterations",
        out.diagnostics.iters
    );
}

#[test]
fn ppd_resolve_from_own_output_is_noop() {
    // The editor bakes a solved pose into the seed and solves again on every
    // drag pointer-up, fix toggle and delete. That second solve must keep
    // every body where the first put it, or the assembly creeps.
    let first = solve_mate(&plate_bar_input(MateKind::ParallelPlaneDistance));
    let mut again = plate_bar_input(MateKind::ParallelPlaneDistance);
    again.params_initial = first.params_solved.clone();
    let second = solve_mate(&again);
    assert_eq!(second.moved, vec![0, 0], "re-solve moved a body");
    for (i, (a, b)) in first
        .params_solved
        .iter()
        .zip(&second.params_solved)
        .enumerate()
    {
        assert!((a - b).abs() < 1e-9, "param {i} drifted {a} -> {b}");
    }
}

#[test]
fn ppd_reports_true_joint_dof() {
    // A plane-on-plane contact removes the normal translation and the two
    // tilts: rank 3, leaving the two in-plane slides and the spin.
    let out = solve_mate(&plate_bar_input(MateKind::ParallelPlaneDistance));
    assert_eq!(out.diagnostics.rank, 3);
    assert_eq!(out.diagnostics.dof, 3);
}

#[test]
fn parallel_reports_true_joint_dof() {
    // Parallel removes the two tilts only.
    let out = solve_mate(&plate_bar_input(MateKind::Parallel));
    assert_eq!(out.diagnostics.rank, 2);
    assert_eq!(out.diagnostics.dof, 4);
}

#[test]
fn ppd_antiparallel_seed_swings_round() {
    // Seeded exactly back to back (B's outward normal along +Z, the very
    // opposite of what flip asks): the symmetry-break nudge must still give
    // the axis rows a gradient to swing the bar round.
    let mut input = plate_bar_input(MateKind::ParallelPlaneDistance);
    let half = quat_exp(&[std::f64::consts::PI, 0.0, 0.0]);
    input.params_initial[10..14].copy_from_slice(&half);
    let out = solve_mate(&input);
    let tilt = face_tilt(&out.params_solved);
    assert!(tilt < 1e-9, "bar left tilted by {tilt} rad");
}

#[test]
fn ppd_conflicting_half_degree_reads_overconstrained() {
    // A second grounded face half a degree off the plate asks the bar to be
    // parallel to both; the verdict must call that a conflict. Least squares
    // splits it a quarter degree each way, which the cosine row read as
    // 1 - cos = 1e-5, a tenth of its width, so the conflict passed as solved.
    // The chord reads the angle itself, 4e-3.
    let mut input = plate_bar_input(MateKind::ParallelPlaneDistance);
    input.bodies.push(RigidBody);
    let tilt = quat_exp(&[0.5f64.to_radians(), 0.0, 0.0]);
    input
        .params_initial
        .extend_from_slice(&[0.0, 0.0, 0.0, tilt[0], tilt[1], tilt[2], tilt[3]]);
    input.fixed_mask = vec![0b0000_0101];
    input.mates.push(mate(
        MateKind::Parallel,
        mate_ref(2, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
        mate_ref(1, 250.0, 10.0, 0.0, 0.0, 0.0, -1.0, AnchorKind::Plane),
        true,
        0.0,
        1.0,
        0.0,
    ));
    let out = solve_mate(&input);
    // The compromise sits between the two faces. The cosine rows stalled
    // with the bar stood on end (tilt pi/2), which reads as a conflict too,
    // so the verdict alone would not tell a real one from a stuck descent.
    let tilt = face_tilt(&out.params_solved);
    assert!(tilt < 0.5f64.to_radians(), "bar stalled at tilt {tilt} rad");
    assert_ne!(
        out.overall_status,
        MateStatus::FullyConstrained.to_u8(),
        "half a degree of conflict read as satisfied"
    );
    assert_ne!(
        out.overall_status,
        MateStatus::Underconstrained.to_u8(),
        "half a degree of conflict read as satisfied"
    );
}
