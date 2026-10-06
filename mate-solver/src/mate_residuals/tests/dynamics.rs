//! Dropped-mate bookkeeping, rotation damping and the authored-roll guards.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

#[test]
fn sliding_rotating_pulls_anchor_onto_axis_of_offset_bodies() {
    // Body 0 grounded at the origin, Z axis. Body 1 starts at (5,0,0),
    // also Z axis (parallel already, but off-axis by 5 in X). Stage D:
    // sliding_rotating now gains the perp-displacement-cross residual
    // (previously axis-cross only), so it pulls B's anchor point onto A's
    // anchor axis. Cylindrical joint: slide + roll stay free -> dof == 2.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
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
    assert!(
        out.params_solved[7].abs() < 1e-3,
        "tx should be pulled to ~0, got {}",
        out.params_solved[7]
    );
    assert!(
        out.params_solved[8].abs() < 1e-3,
        "ty should be pulled to ~0, got {}",
        out.params_solved[8]
    );
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
            3.0,
            0.0,
            0.0,
            seed_qz as f32,
            seed_qw as f32,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_angle(
            MateKind::Sliding,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
            30.0_f64.to_radians(),
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.diagnostics.dof, 1);
    assert!(
        (out.params_solved[12] as f64 - seed_qz).abs() < 1e-3,
        "qz should hold the authored roll, got {}",
        out.params_solved[12]
    );
    assert!(
        (out.params_solved[13] as f64 - seed_qw).abs() < 1e-3,
        "qw should hold the authored roll, got {}",
        out.params_solved[13]
    );
}

#[test]
fn parallel_plane_distance_aligns_normals_and_holds_the_offset() {
    // Stage D: parallel_plane_distance gains the Parallel axis-dot residual,
    // so it now actually aligns the normals (previously only the distance
    // along A's axis was constrained; nothing stopped the planes fanning
    // apart). flip=false -> parallel; the distance-along-axis residual is
    // unaffected by flip, so the offset holds regardless.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 2.0, 7.0, 0.3, 0.1, 0.2, 0.9,
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
    let p = &out.params_solved;
    let z = rotated_z(p[10] as f64, p[11] as f64, p[12] as f64, p[13] as f64);
    assert!(
        (z[2] - 1.0).abs() < 1e-2,
        "B's axis should align parallel to A's (+Z), got {:?}",
        z
    );
    assert!(
        (p[9] as f64 - 5.0).abs() < 1e-2,
        "tz should hold the 5-unit offset, got {}",
        p[9]
    );
    // Parallelism pins 2 more rotational DOF than the distance-only formula did.
    assert_eq!(out.diagnostics.dof, 4);
}

#[test]
fn parallel_plane_distance_flip_aligns_normals_anti_parallel() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 2.0, 7.0, 0.3, 0.1, 0.2, 0.9,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::ParallelPlaneDistance,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            true,
            5.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    let p = &out.params_solved;
    let z = rotated_z(p[10] as f64, p[11] as f64, p[12] as f64, p[13] as f64);
    assert!(
        (z[2] - (-1.0)).abs() < 1e-2,
        "B's axis should align anti-parallel to A's (-Z), got {:?}",
        z
    );
    assert!(
        (p[9] as f64 - 5.0).abs() < 1e-2,
        "tz should still hold the 5-unit offset, got {}",
        p[9]
    );
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
        assert_eq!(
            mate_residual_count(kind),
            want,
            "mate_residual_count({:?})",
            kind
        );

        let input = MateInput {
            bodies: vec![RigidBody, RigidBody],
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0],
            mates: vec![mate(
                kind,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false,
                0.0,
                1.0,
                0.0,
            )],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let pushed = p.residuals(&x).len();
        // Total = per-mate residuals + n_bodies (unit-norm) + 0 grounded.
        assert_eq!(
            pushed - 2,
            want,
            "kind {:?} pushed {} mate residuals, want {}",
            kind,
            pushed - 2,
            want
        );
        assert_eq!(
            p.m, pushed,
            "MateProblem.m disagrees with residuals().len() for {:?}",
            kind
        );
    }
}

#[test]
fn mate_naming_a_body_outside_the_assembly_is_dropped() {
    // Body index 5 in a two-body assembly: a stale mate the host never
    // pruned. It must contribute no rows instead of indexing off x.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Spherical,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            mate_ref(5, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            false,
            0.0,
            1.0,
            0.0,
        )],
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
fn dropped_mate_keeps_its_residual_slot() {
    // Three mates with the middle one naming a body the assembly does not
    // have. The wire must still report three residuals, the dropped one a
    // sentinel, or the host's positional fold would attribute the third
    // mate's residual to the second.
    let mut input = two_body_input();
    input.mates.push(mate(
        MateKind::Spherical,
        mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
        mate_ref(9, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
        false,
        0.0,
        1.0,
        0.0,
    ));
    input.mates.push(mate(
        MateKind::Spherical,
        mate_ref(0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
        mate_ref(1, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
        false,
        0.0,
        1.0,
        0.0,
    ));

    let out = solve_mate(&input);
    assert_eq!(out.mate_residuals.len(), 3);
    assert!(out.mate_residuals[0].is_finite());
    assert!(
        out.mate_residuals[1].is_nan(),
        "a dropped mate keeps its slot"
    );
    assert!(out.mate_residuals[2].is_finite());
}

#[test]
fn mate_whose_body_block_overruns_the_params_is_dropped() {
    // Two declared bodies but only one body's worth of params: body 1's
    // block is not in the buffer, so any mate touching it goes.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
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
    let p = MateProblem::new(&input);
    assert!(p.mates.is_empty());

    // The quaternion-norm loop used to panic right here: body 1's unit-
    // norm row indexed its missing block off the end of x. The dropped
    // body contributes no rows and m tracks exactly what survives (one
    // row for body 0), so residuals, Jacobian and a full solve all stay
    // panic-free.
    let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
    assert_eq!(p.m, 1);
    assert_eq!(p.residuals(&x).len(), p.m);
    let j = p.jacobian(&x);
    assert_eq!(j.nrows(), p.m);
    let out = solve_mate(&input);
    assert_eq!(out.params_solved.len(), input.params_initial.len());
    assert_ne!(
        out.overall_status,
        MateStatus::Overconstrained.to_u8(),
        "a truncated buffer is malformed input, not a failed constraint set"
    );

    // Same overrun with the MISSING body grounded: this is the path that
    // panicked inside the grounded-pin loop (x[off + j] past the buffer).
    // It must degrade identically.
    let mut input = input;
    input.fixed_mask = vec![0b0000_0010];
    let p = MateProblem::new(&input);
    assert_eq!(p.m, 1);
    assert_eq!(p.residuals(&x).len(), p.m);
    assert_eq!(p.jacobian(&x).nrows(), p.m);
    let out = solve_mate(&input);
    assert_eq!(out.params_solved.len(), input.params_initial.len());
}

#[test]
fn rotation_damp_scale_stiffens_only_free_body_rotation() {
    // body 0 grounded, body 1 free. The damping scale must lift the four
    // rotation params of the free body and leave translation (and the whole
    // grounded body) at 1.0.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001], // body 0 grounded
        mates: vec![],
    };
    let p = MateProblem::new(&input);
    let scale = p.rotation_damp_scale();
    assert_eq!(scale.len(), 14);
    assert!(
        scale[0..7].iter().all(|&s| s == 1.0),
        "grounded body stays at 1.0"
    );
    assert!(
        scale[7..10].iter().all(|&s| s == 1.0),
        "free-body translation stays at 1.0"
    );
    assert!(
        scale[10..14].iter().all(|&s| s == ROT_DAMP_SCALE),
        "free-body rotation is stiffened"
    );
    const { assert!(ROT_DAMP_SCALE > 1.0) };
}

#[test]
fn free_body_reaches_point_more_by_translating_than_rotating() {
    // A single spherical coincidence a free body could satisfy by either
    // translating or turning 90 deg (its anchor is offset from its origin).
    // The rotation damping tips LM toward the slide: it ends far closer to the
    // pure-translation solution (q ~ identity) than to the 90 deg turn
    // (qz ~ -0.707), while still meeting the coincidence exactly.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded at origin
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1 free, seed identity
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Spherical,
            mate_ref(0, 3.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point), // world target (3,0,0)
            mate_ref(1, 0.0, 3.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point), // body-local (0,3,0)
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    // A pure 90 deg turn would read qw = 0.707, qz = -0.707, tx = 0.
    // With stronger rotation damping the solve stays close to the
    // pure-translation solution, carrying the required coincidence nearly
    // entirely through tx/ty.
    assert!(
        out.params_solved[13] > 0.95,
        "qw near 1 (little rotation), got {}",
        out.params_solved[13]
    );
    assert!(
        out.params_solved[12].abs() < 0.2,
        "qz well short of the -0.707 turn, got {}",
        out.params_solved[12]
    );
    assert!(
        out.params_solved[7] > 2.5,
        "tx carried most of the motion, got {}",
        out.params_solved[7]
    );
    assert!(
        out.diagnostics.residual_norm < 1e-3,
        "coincidence met, got {}",
        out.diagnostics.residual_norm
    );
}

#[test]
fn fixed_mate_applies_authored_angle() {
    // Aligned Z axes at seed, body 1 at identity. Author angle = 45 deg.
    // The solved roll of body 1 should be 45 deg about Z.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: identity
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_angle(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
            45.0_f64.to_radians(),
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.diagnostics.dof, 0);
    let qz = out.params_solved[12] as f64;
    let qw = out.params_solved[13] as f64;
    let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
    assert!(
        (roll_deg - 45.0).abs() < 1.0,
        "roll should be 45 deg, got {}",
        roll_deg
    );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, Z axis
            0.0, 0.0, 0.0, 0.0, h as f32, 0.0, h as f32, // body 1: 90 deg about Y
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
    assert_eq!(
        out.diagnostics.dof, 0,
        "fixed mate must lock all DOF even when axes need to swing"
    );
    assert!(out.diagnostics.residual_norm < 1e-3);
}

#[test]
fn fixed_mate_locks_roll_and_applies_angle_not_prealigned() {
    // Same not-pre-aligned setup as above, but now author a 60 deg roll. The
    // weld must both align the swung axes and impose the authored roll about
    // the shared axis, leaving zero DOF.
    let h = 45.0_f64.to_radians().sin();
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, h as f32, 0.0, h as f32,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_angle(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
            60.0_f64.to_radians(),
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.diagnostics.dof, 0);
    assert!(out.diagnostics.residual_norm < 1e-3);
    // Body 1's Z axis ends aligned with world Z; its roll about that axis
    // should read 60 deg relative to the grounded body 0.
    let qz = out.params_solved[12] as f64;
    let qw = out.params_solved[13] as f64;
    let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
    assert!(
        (roll_deg - 60.0).abs() < 1.5,
        "roll should be ~60 deg, got {}",
        roll_deg
    );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded, +Z axis
            0.0, 0.0, 0.0, h as f32, 0.0, 0.0, 0.0, // body 1: 180 deg about X -> axis -Z
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_angle(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            true,
            0.0,
            1.0,
            0.0,
            std::f64::consts::PI,
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.diagnostics.dof, 0);
    assert!(out.diagnostics.residual_norm < 1e-3);
    // Body 1's world axis stays -Z: it did not flip to +Z. Rotating its local
    // +Z by the solved quaternion must land near (0, 0, -1).
    let q = (
        out.params_solved[10] as f64,
        out.params_solved[11] as f64,
        out.params_solved[12] as f64,
        out.params_solved[13] as f64,
    );
    let axis_w = rotate_vec(q.0, q.1, q.2, q.3, &[0.0, 0.0, 1.0]);
    assert!(
        axis_w[2] < -0.9,
        "axis should stay anti-parallel (-Z), got {:?}",
        axis_w
    );
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
            h.sin() as f32,
            0.0,
            0.0,
            h.cos() as f32,
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
    assert!(out.diagnostics.residual_norm < 1e-3);
    let q = (
        out.params_solved[10] as f64,
        out.params_solved[11] as f64,
        out.params_solved[12] as f64,
        out.params_solved[13] as f64,
    );
    let axis_w = rotate_vec(q.0, q.1, q.2, q.3, &[0.0, 0.0, 1.0]);
    assert!(
        axis_w[2] > 0.9,
        "axis should swing to the authored parallel side (+Z), got {:?}",
        axis_w
    );
}

#[test]
fn rotating_flip_true_holds_anti_parallel_axis() {
    // A hinge authored on anti-parallel axes (flip=true) must hold that side
    // while leaving roll free. With the old cross-product residual both
    // sides were solutions, so which one the joint landed on was seed luck.
    let h = 90.0_f64.to_radians().sin();
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, h as f32, 0.0, 0.0,
            0.0, // 180 deg about X -> axis -Z
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Rotating,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            true,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    assert!(out.diagnostics.residual_norm < 1e-3);
    assert_eq!(out.diagnostics.dof, 1, "hinge roll stays free");
    let q = (
        out.params_solved[10] as f64,
        out.params_solved[11] as f64,
        out.params_solved[12] as f64,
        out.params_solved[13] as f64,
    );
    let axis_w = rotate_vec(q.0, q.1, q.2, q.3, &[0.0, 0.0, 1.0]);
    assert!(
        axis_w[2] < -0.9,
        "axis should hold anti-parallel (-Z), got {:?}",
        axis_w
    );
}

#[test]
fn supplied_perp_drives_the_roll() {
    // The roll frame now comes off the wire (`MateGeometry.perp`), not from
    // a solver-side re-derivation of the axis. Two inputs with identical
    // axes and seeds but different perps must measure different rolls, which
    // proves the wire value is the one in force.
    let problem_with_perp = |perp_b: [f64; 3]| {
        let mut b = mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane);
        b.geometry.perp = perp_b;
        let input = MateInput {
            bodies: (0..2).map(|_| RigidBody).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity, grounded
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: identity
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate(
                MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                b,
                false,
                0.0,
                1.0,
                0.0,
            )],
        };
        MateProblem::new(&input)
    };

    // Same axis (+Z) on both sides; only B's wire perp changes.
    let aligned = problem_with_perp([0.0, 1.0, 0.0]);
    let quarter = problem_with_perp([1.0, 0.0, 0.0]);
    let x = aligned.x0.clone();

    assert!(aligned.abs_roll_residual(&x, 0, 0, 7, 0.0).abs() < 1e-12);
    let roll = quarter.abs_roll_residual(&x, 0, 0, 7, 0.0);
    assert!(
        (roll + std::f64::consts::FRAC_PI_2).abs() < 1e-12,
        "the supplied perp must set the frame, got {roll}"
    );
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
        out.overall_status,
        out.params_solved,
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
    let out = solve_mate_impl(&input, 100, false);
    assert_eq!(out.overall_status, MateStatus::Overconstrained.to_u8());
    assert_eq!(out.params_solved, input.params_initial);
    assert_eq!(out.diagnostics.iters, 0);
    assert_eq!(out.diagnostics.dof, 0);
    assert!(out.diagnostics.residual_norm.is_infinite());

    // The same assembly at the real budget still solves normally.
    let out = solve_mate(&input);
    assert!(out.diagnostics.residual_norm.is_finite());
}
