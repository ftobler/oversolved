//! Whole-solve behaviour per mate kind (spherical, parallel, fixed, sliding,
//! rotating, tangential and friends) and the status they report.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

#[test]
fn spherical_pulls_bodies_together() {
    let input = two_body_input();
    let out = solve_mate(&input);
    // One solved mate, so the output wire carries exactly one residual and
    // it is converged on this trivially satisfiable fixture.
    assert_eq!(out.mate_residuals.len(), 1);
    assert!(
        out.mate_residuals[0] < 1e-3,
        "residual={}",
        out.mate_residuals[0]
    );
    assert!(
        out.params_solved[7].abs() < 1e-3,
        "tx should be ~0, got {}",
        out.params_solved[7]
    );
    assert!(
        out.params_solved[8].abs() < 1e-3,
        "ty should be ~0, got {}",
        out.params_solved[8]
    );
    assert!(
        out.params_solved[9].abs() < 1e-3,
        "tz should be ~0, got {}",
        out.params_solved[9]
    );
    assert!(out.params_solved[0].abs() < 1e-3);
    assert!((out.params_solved[6] - 1.0).abs() < 1e-3, "qw should be ~1");
    assert!(out.diagnostics.residual_norm < 1e-3);
}

#[test]
fn spherical_fully_constrained_with_three_mates() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 1.0, 2.0, 0.1, 0.2, 0.3, 0.927,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Spherical,
                mate_ref(0, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    };
    let out = solve_mate(&input);
    assert!((out.params_solved[6] - 1.0).abs() < 1e-3);
    assert!(
        out.params_solved[7].abs() < 5e-2,
        "tx={}",
        out.params_solved[7]
    );
    assert!(out.diagnostics.residual_norm < 1e-3);
}

#[test]
fn parallel_aligns_axes_parallel() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, -0.707, 0.0, 0.0, 0.707,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Parallel,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    let qw = out.params_solved[13];
    assert!(
        (qw.abs() - 1.0).abs() < 1e-2,
        "qw should be ~±1, got {}",
        qw
    );
    assert!(out.diagnostics.residual_norm < 1e-3);
}

#[test]
fn parallel_flip_aligns_axes_anti_parallel() {
    let angle = 0.3;
    let half: f64 = angle / 2.0;
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            half.sin() as f32,
            0.0,
            0.0,
            half.cos() as f32,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Parallel,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            true,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    let qx = out.params_solved[10];
    let qy = out.params_solved[11];
    let rot_mag = (qx as f64 * qx as f64 + qy as f64 * qy as f64).sqrt();
    assert!(
        rot_mag > 0.5,
        "should have significant rotation, q=({}, {}, {}, {})",
        qx,
        qy,
        out.params_solved[12],
        out.params_solved[13]
    );
    assert!(out.diagnostics.residual_norm < 1e-3);
}

#[test]
fn fixed_mate_pins_all_dof() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 3.0, 4.0, 5.0, 0.0, 0.707, 0.0, 0.707,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Fixed,
            mate_ref(0, 2.0, 3.0, 4.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    assert!(
        (out.params_solved[7] - 2.0).abs() < 1e-2,
        "tx={}",
        out.params_solved[7]
    );
    assert!(
        (out.params_solved[8] - 3.0).abs() < 1e-2,
        "ty={}",
        out.params_solved[8]
    );
    assert!(
        (out.params_solved[9] - 4.0).abs() < 1e-2,
        "tz={}",
        out.params_solved[9]
    );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
            0.0, 0.0, 0.0, 0.0, 0.0, qz, qw, // body 1: 30 deg about Z
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0);
    let qz = out.params_solved[12] as f64;
    let qw = out.params_solved[13] as f64;
    let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
    assert!(
        roll_deg.abs() < 1.0,
        "roll should snap to the authored 0 deg, got {}",
        roll_deg
    );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 3.0, 4.0, 5.0, 0.0, 0.707, 0.0, 0.707,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_angle(
            MateKind::Fixed,
            mate_ref(0, 2.0, 3.0, 4.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
            30.0_f64.to_radians(),
        )],
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
            i,
            first.params_solved[i],
            second.params_solved[i],
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
    assert_eq!(
        mate_status(0.005, 10_000, 0, 1.0),
        MateStatus::FullyConstrained
    );
    // Same absolute residual_norm, concentrated in a single residual
    // (m = 1): genuinely overconstrained, still flagged.
    assert_eq!(mate_status(0.005, 1, 0, 1.0), MateStatus::Overconstrained);
}

#[test]
fn overconstrained_threshold_scales_with_drawing_scale_not_absolute_residual() {
    // The threshold is relative to the drawing's characteristic length:
    // the same residual that fails at unit scale passes once the model is
    // large enough that the residual is small against the geometry.
    assert_eq!(mate_status(9.9, 1, 0, 1.0), MateStatus::Overconstrained);
    assert_eq!(mate_status(9.9, 1, 0, 1e6), MateStatus::FullyConstrained);
    // The concrete wire case: the f32 quantum at a 1e4-unit layout is
    // about 6e-4, so the old absolute 1e-4 threshold flagged a correctly
    // solved assembly as Overconstrained. Relative to the drawing it
    // passes.
    assert_eq!(mate_status(6e-4, 1, 0, 1.0), MateStatus::Overconstrained);
    assert_eq!(mate_status(6e-4, 1, 0, 1e4), MateStatus::FullyConstrained);
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, qz, qw,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate(
                MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Parallel,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
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
    assert!(
        roll_deg.abs() < 1.0,
        "roll should land on the authored 0 deg, got {}",
        roll_deg
    );
}

#[test]
fn rotating_keeps_one_free_dof() {
    // Rotating shares its residual prefix with Fixed (point coincidence +
    // signed axis difference); it must not pick up the roll residual by a
    // copy-paste into the wrong arm. A revolute joint's whole purpose is the
    // free roll.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Rotating,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.diagnostics.dof, 1);
    assert_eq!(out.overall_status, MateStatus::Underconstrained.to_u8());
}

#[test]
fn underconstrained_assembly_status() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0],
        mates: vec![mate(
            MateKind::Spherical,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::Underconstrained.to_u8());
    assert!(out.diagnostics.dof > 0);
}

#[test]
fn no_mates_returns_unchanged() {
    let input = MateInput {
        bodies: vec![RigidBody],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.2,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Spherical,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            false,
            0.0,
            1.0,
            0.0,
        )],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
            3.0, 4.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1 at (3,4,0), Z axis
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Sliding,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    // Body 1's anchor should be pulled to body 0's axis (Z axis).
    // So body 1's x,y should be near 0.
    assert!(
        out.params_solved[7].abs() < 1e-2,
        "tx should be near 0, got {}",
        out.params_solved[7]
    );
    assert!(
        out.params_solved[8].abs() < 1e-2,
        "ty should be near 0, got {}",
        out.params_solved[8]
    );
    // Z translation is free, stays near seed (0).
    assert!(out.diagnostics.residual_norm < 1e-2);
}

#[test]
fn rotating_keeps_point_coincident_allows_roll() {
    // Grounded body 0 at origin. Body 1's anchor point must stay
    // coincident with body 0's anchor, while axes align. Roll is free.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
            5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1 at (5,0,0)
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Rotating,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    // Point coincidence: body 1's anchor at local (0,0,0) must match
    // body 0's anchor at world (0,0,0). So body 1 must move to origin.
    assert!(
        out.params_solved[7].abs() < 1e-2,
        "tx should be ~0, got {}",
        out.params_solved[7]
    );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: Z axis
            0.0, 0.0, 0.0, 0.0, 0.707, 0.0, 0.707, // body 1: X axis (90° about Y)
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::SlidingRotating,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    // Axes should be aligned. Body 1's local Z axis → world direction
    // should be parallel to body 0's Z axis. The 90° about Y should be corrected.
    let qw = out.params_solved[13];
    assert!(
        (qw.abs() - 1.0).abs() < 1e-2,
        "qw should be ~±1, got {}",
        qw
    );
    assert!(out.diagnostics.residual_norm < 1e-2);
}

#[test]
fn parallel_plane_distance_holds_fixed_offset() {
    // Body 0 has a plane anchor at Z=0 with normal +Z.
    // Body 1's anchor should be offset by 5 units along body 0's normal.
    // Body 0 is grounded at origin.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
            1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, // body 1 at (1,2,3)
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::ParallelPlaneDistance,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            5.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    // dot(p_b - p_a, a_w) should be 5.0.
    // p_a = (0,0,0), a_w = (0,0,1). So p_b.z should be ~5.
    assert!(
        (out.params_solved[9] - 5.0).abs() < 1e-2,
        "tz should be ~5, got {}",
        out.params_solved[9]
    );
    assert!(out.diagnostics.residual_norm < 1e-2);
}

#[test]
fn tangential_plane_plane_coincidence() {
    // Two planes should be coincident (offset=0). Body 0 plane at origin
    // with normal +Z. Body 1 point should lie on body 0's plane.
    // Add a parallel mate to prevent the quaternion from cheating by
    // rotating the plane normal away from Z.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
            1.0, 2.0, 10.0, 0.0, 0.0, 0.0, 1.0, // body 1 above the plane
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate(
                MateKind::Parallel,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Tangential,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    };
    let out = solve_mate(&input);
    // Body 1 should move to Z=0 (onto body 0's plane, with axes kept parallel).
    assert!(
        (out.params_solved[9] as f64).abs() < 5e-2,
        "tz should be ~0, got {}",
        out.params_solved[9]
    );
    assert!(out.diagnostics.residual_norm < 1e-2);
}

#[test]
fn tangential_plane_cylinder_clearance() {
    // Plane A at origin with normal +Z. Cylinder B should be tangent.
    // Point on cylinder is at B's anchor; distance from point to plane = radius.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: plane, grounded
            0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, // body 1: cylinder far away
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Tangential,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            2.5,
        )],
    };
    let out = solve_mate(&input);
    // The cylinder point (at Z) should be 2.5 units from the plane (Z=0).
    // Since body 1's anchor point is at local origin, its world Z should be ~2.5.
    assert!(
        (out.params_solved[9] - 2.5).abs() < 1e-2,
        "tz should be ~2.5, got {}",
        out.params_solved[9]
    );
    assert!(out.diagnostics.residual_norm < 1e-2);
}

#[test]
fn tangential_cylinder_cylinder_distance() {
    // Two cylinders with parallel axes. Distance between axes = 2*radius.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: cylinder at origin, Z axis, grounded
            10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: cylinder at (10,0,0), Z axis
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Tangential,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            3.0,
        )],
    };
    let out = solve_mate(&input);
    // Axis distance should be 2*radius = 6.0. Body 0 at x=0, body 1 should be at x=6.
    let tx = out.params_solved[7] as f64;
    assert!((tx - 6.0).abs() < 0.1, "tx should be ~6, got {}", tx);
    assert!(out.diagnostics.residual_norm < 1e-2);
}
