//! Cross-checks of the analytic Jacobian against finite differences, plus the
//! weighted and self-mate cases.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

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

// A soft mate must yield to a stiff one. Both pull the same free body's
// anchor to different targets; with equal rows the body lands at the
// midpoint, and only a row scale makes it land on the stiff target. Fails
// before `residuals()`/`jacobian()` apply `Mate::weight`.
#[test]
fn softer_mate_yields_to_stiffer_mate() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: grounded at the origin
            5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: seeded between the targets
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            // Stiff: body 1's origin must sit on body 0's origin.
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            // Soft drag-like target far away: it must not pull the body off
            // the stiff target.
            mate_weighted(
                MateKind::Spherical,
                mate_ref(0, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
                0.0,
                1e-4,
            ),
        ],
    };
    let out = solve_mate(&input);
    let tx = out.params_solved[7] as f64;
    assert!(
        tx.abs() < 1e-4,
        "the stiff target must win; body 1 landed at tx={tx} (midpoint would be ~5)"
    );
}

// The analytic weighted Jacobian must equal the finite difference of the
// weighted residual, so LM descends the same function the residual defines
// rather than an unscaled gradient.
#[test]
fn jacobian_vs_fd_spherical_weighted() {
    let mut input = two_body_input();
    input.mates[0].weight = 1e-4;
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
        bodies: vec![RigidBody],
        params_initial: vec![
            1.0,
            2.0,
            3.0,
            0.1,
            0.2,
            0.3,
            f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
        ],
        fixed_mask: vec![0],
        mates: vec![mate(
            MateKind::Spherical,
            mate_ref(0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            mate_ref(0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            false,
            0.0,
            1.0,
            0.0,
        )],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            3.0,
            4.0,
            5.0,
            0.1,
            0.2,
            0.3,
            f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Fixed,
            mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            0.0,
            1.0,
            0.0,
        )],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.1,
            -0.2,
            0.3,
            f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
            3.0,
            4.0,
            5.0,
            0.1,
            0.2,
            0.3,
            f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_offset_vec(
            MateKind::Fixed,
            mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
            false,
            [2.0, -3.0, 1.5],
            1.0,
            0.0,
        )],
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
            -0.5,
            0.1,
            0.2,
            f64::sqrt(1.0 - 0.25 - 0.01 - 0.04) as f32,
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
    let p = MateProblem::new(&input);
    let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
    let j_analytic = p.jacobian(&x);
    let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
    compare_jacobians(&j_analytic, &j_fd, 1e-3);
}

#[test]
fn jacobian_vs_fd_sliding() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0, // body 0 grounded
            3.0,
            2.0,
            1.0,
            -0.3,
            0.1,
            0.4,
            f64::sqrt(1.0 - 0.09 - 0.01 - 0.16) as f32,
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
    let p = MateProblem::new(&input);
    let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
    let j_analytic = p.jacobian(&x);
    let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
    compare_jacobians(&j_analytic, &j_fd, 1e-3);
}

#[test]
fn jacobian_vs_fd_rotating() {
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
            2.0,
            3.0,
            4.0,
            0.2,
            -0.1,
            0.5,
            f64::sqrt(1.0 - 0.04 - 0.01 - 0.25) as f32,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Rotating,
            mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            1.0,
            0.0,
        )],
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
            -0.5,
            0.2,
            0.1,
            f64::sqrt(1.0 - 0.25 - 0.04 - 0.01) as f32,
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
    let p = MateProblem::new(&input);
    let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
    let j_analytic = p.jacobian(&x);
    let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
    compare_jacobians(&j_analytic, &j_fd, 1e-3);
}

#[test]
fn jacobian_vs_fd_parallel_plane_distance() {
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
            1.0,
            2.0,
            7.0,
            0.1,
            0.3,
            0.2,
            f64::sqrt(1.0 - 0.01 - 0.09 - 0.04) as f32,
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
    let p = MateProblem::new(&input);
    let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
    let j_analytic = p.jacobian(&x);
    let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
    compare_jacobians(&j_analytic, &j_fd, 1e-3);
}

#[test]
fn jacobian_vs_fd_copy_rotation() {
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.9539, // body 0: some roll about Z
            0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.9949, // body 1: less roll about Z
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::CopyRotation,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            2.0,
            0.0,
        )],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.9539, // body 0: some roll about Z
            0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.9949, // body 1: less roll about Z
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::CopyRotation,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            2.0,
            0.0,
        )],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            half_a.sin() as f32,
            half_a.cos() as f32,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            half_b.sin() as f32,
            half_b.cos() as f32,
        ],
        fixed_mask: vec![0b0000_0001],
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
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            half_seed_a.sin() as f32,
            half_seed_a.cos() as f32,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            half_seed_b.sin() as f32,
            half_seed_b.cos() as f32,
        ],
        fixed_mask: vec![0],
        mates: vec![mate(
            MateKind::CopyRotation,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            2.0,
            0.0,
        )],
    };
    let p = MateProblem::new(&input);

    // A driven to seed+20deg, B driven to seed+40deg (relative link holds).
    let half_a_rel = (10.0 + 20.0_f64).to_radians() / 2.0;
    let half_b_rel = (5.0 + 40.0_f64).to_radians() / 2.0;
    let x_relative = vec![
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        half_a_rel.sin(),
        half_a_rel.cos(),
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        half_b_rel.sin(),
        half_b_rel.cos(),
    ];
    let r_relative = p.residuals(&x_relative);
    assert!(
        r_relative[0].abs() < 1e-6,
        "relative link should be satisfied, residual = {}",
        r_relative[0]
    );

    // Same A, but B driven to an ABSOLUTE 40deg (measured from zero, ignoring
    // its own 5deg seed) -- the old bug's target. Must NOT be zero.
    let half_b_absolute = 40.0_f64.to_radians() / 2.0;
    let x_absolute = vec![
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        half_a_rel.sin(),
        half_a_rel.cos(),
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        half_b_absolute.sin(),
        half_b_absolute.cos(),
    ];
    let r_absolute = p.residuals(&x_absolute);
    assert!(
        r_absolute[0].abs() > 0.01,
        "absolute-target reading should NOT satisfy the relative residual, got {}",
        r_absolute[0]
    );
}
