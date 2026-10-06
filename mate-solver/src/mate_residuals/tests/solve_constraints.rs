//! Solve tests for offset semantics, dropped mates and the unsupported
//! tangential pair.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

// A Point/Point tangential has no dedicated formula. The old fallback
// computed a point-to-point distance and converged on it silently; the
// non-finite backstop makes the solve report Overconstrained instead.
#[test]
fn tangential_unsupported_pair_fails_loud() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Tangential,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            false,
            0.0,
            1.0,
            1.0,
        )],
    };
    let out = solve_mate(&input);
    assert!(
        !out.diagnostics.residual_norm.is_finite(),
        "a non-finite residual must survive to the diagnostics, got {}",
        out.diagnostics.residual_norm
    );
    assert_eq!(out.overall_status, MateStatus::Overconstrained.to_u8());
}

// A same-body mate must contribute no residual row and must not corrupt the
// Jacobian; the valid mate beside it still solves on its own.
#[test]
fn same_body_mate_is_dropped_and_contributes_no_row() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate(
                MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    };
    let problem = MateProblem::new(&input);
    assert_eq!(problem.mates.len(), 1, "the same-body mate must be dropped");
    assert_eq!(problem.kept_input_indices, vec![1]);

    let out = solve_mate(&input);
    assert!(
        out.mate_residuals[0].is_nan(),
        "a dropped mate keeps its NaN sentinel"
    );
    assert!(out.mate_residuals[1].is_finite() && out.mate_residuals[1] < 1e-3);
    assert!(
        out.diagnostics.residual_norm < 1e-3,
        "the valid mate alone solves"
    );
    assert!(
        (out.params_solved[7] as f64).abs() < 1e-2,
        "body 1 pulled to body 0"
    );
}

// `MateProblem::new` drops same-body mates, so this can only arise for a raw
// caller; build one by hand with off_a == off_b and prove the roll row is the
// SUM of both finite-difference passes, not the second one overwriting.
#[test]
fn roll_jacobian_sums_both_passes_for_a_self_mate() {
    let a = mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane);
    let b = mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane);
    let problem = MateProblem {
        n: 7,
        x0: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        mates: vec![mate(MateKind::Fixed, a, b, false, 0.0, 1.0, 0.0)],
        input_mate_count: 1,
        kept_input_indices: vec![0],
        bodies: vec![RigidBody],
        grounded: vec![false],
        m: 1,
        seed_axes: vec![None],
        seed_twist: vec![(0.0, 0.0)],
        roll_frames: vec![Some(([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]))],
        scale: 1.0,
    };
    let x = problem.x0.clone();
    let mut j = DMatrix::zeros(1, 7);
    let mut scratch = x.clone();
    problem.fill_roll_fd(&mut j, 0, 0, 0, 0, &x, &mut scratch);

    let eps = 1e-6;
    for col in 0..7 {
        let orig = x[col];
        let mut xp = x.clone();
        xp[col] = orig + eps;
        let fp = problem.roll_residual_at_mate(0, &xp);
        xp[col] = orig - eps;
        let fm = problem.roll_residual_at_mate(0, &xp);
        let single = wrap_to_pi(fp - fm) / (2.0 * eps);
        assert!(
            (j[(0, col)] - 2.0 * single).abs() < 1e-9,
            "col {col}: cell {} should be the sum 2*{}",
            j[(0, col)],
            single,
        );
    }
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            half as f32,
            cos_half as f32, // body 0: ~1 rad about Z
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0, // body 1: no roll (identity)
        ],
        fixed_mask: vec![0b0000_0001], // body 0 grounded
        mates: vec![mate(
            MateKind::CopyRotation,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    let qz1 = out.params_solved[12] as f64;
    let qw1 = out.params_solved[13] as f64;
    let roll1 = 2.0 * qz1.atan2(qw1);
    assert!(
        roll1.abs() < 0.05,
        "body 1 should hold its own seed (no roll), got roll1={}",
        roll1
    );
    assert!(out.diagnostics.residual_norm < 1e-2);
}

#[test]
fn fixed_mate_with_angle_rolls_to_ninety_degrees() {
    // Both bodies start at identity (zero seed-relative roll). angle = pi/2
    // should solve body 1 to exactly 90 degrees of roll about the shared axis.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
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
            std::f64::consts::FRAC_PI_2,
        )],
    };
    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0);
    let qz = out.params_solved[12] as f64;
    let qw = out.params_solved[13] as f64;
    let roll_deg = (2.0 * qz.atan2(qw)).to_degrees();
    assert!(
        (roll_deg - 90.0).abs() < 1.0,
        "roll should be ~90 deg, got {}",
        roll_deg
    );
}

#[test]
fn fixed_with_offset() {
    // Fixed mate with linear offset. Body 0 grounded at origin with Z axis.
    // The residual is: p_a_w - p_b_w - offset * a_w = 0
    // So p_b_w = p_a_w - offset * a_w. With p_a=(0,0,0) and a_w=(0,0,1):
    // p_b_w = (0,0,-10). Body 1's anchor at local origin, so tz = -10.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
            5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0, // body 1
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            10.0,
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    // Body 1's tz should be -10 (p_b_w = p_a_w - offset*a_w = (0,0,0) - 10*(0,0,1)).
    assert!(
        (out.params_solved[9] - (-10.0)).abs() < 1e-2,
        "tz should be ~-10, got {}",
        out.params_solved[9]
    );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_offset_vec(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            offset,
            1.0,
            0.0,
        )],
    };
    // `offset: 7` on a Z axis is the vector (0, 0, 7).
    let legacy = solve_mate(&build([0.0, 0.0, 7.0]));
    assert!(
        (legacy.params_solved[9] - (-7.0)).abs() < 1e-2,
        "tz should be ~-7, got {}",
        legacy.params_solved[9]
    );
    assert!(legacy.diagnostics.residual_norm < 1e-2);
}

/// An offset with components off A's axis translates the weld sideways --
/// the whole point of the widening. p_b = p_a - R_a * offset, and with A at
/// identity that is just the negated offset.
#[test]
fn fixed_with_off_axis_offset_vector() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_offset_vec(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            [3.0, 4.0, 2.0],
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    for (i, want) in [-3.0, -4.0, -2.0].into_iter().enumerate() {
        assert!(
            (out.params_solved[7 + i] as f64 - want).abs() < 1e-2,
            "body 1 t[{}] should be ~{}, got {}",
            i,
            want,
            out.params_solved[7 + i]
        );
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, qz, qw, 5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_offset_vec(
            MateKind::Fixed,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            [3.0, 4.0, 0.0],
            1.0,
            0.0,
        )],
    };
    let out = solve_mate(&input);
    assert!(
        (out.params_solved[7] as f64 - 4.0).abs() < 1e-2,
        "tx should be ~4, got {}",
        out.params_solved[7]
    );
    assert!(
        (out.params_solved[8] as f64 - (-3.0)).abs() < 1e-2,
        "ty should be ~-3, got {}",
        out.params_solved[8]
    );
    assert!(out.diagnostics.residual_norm < 1e-2);
}

/// ParallelPlaneDistance reads only the axial component: an offset with the
/// same axial part but arbitrary in-plane components must solve to the same
/// separation, because sliding within the plane is the mate's free DOF.
#[test]
fn parallel_plane_distance_ignores_the_in_plane_offset() {
    let build = |offset: [f64; 3]| MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_offset_vec(
            MateKind::ParallelPlaneDistance,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            offset,
            1.0,
            0.0,
        )],
    };
    let axial = solve_mate(&build([0.0, 0.0, 6.0]));
    let with_slide = solve_mate(&build([9.0, -9.0, 6.0]));
    assert!(
        (axial.params_solved[9] - 6.0).abs() < 1e-2,
        "tz should be ~6, got {}",
        axial.params_solved[9]
    );
    assert!(
        (with_slide.params_solved[9] - axial.params_solved[9]).abs() < 1e-3,
        "in-plane offset must not change the separation"
    );
}
