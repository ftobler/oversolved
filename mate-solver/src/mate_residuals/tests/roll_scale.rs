//! Roll wraparound, rank cutoffs across drawing scales and the tangential cone
//! branches.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

#[test]
fn rank_and_status_survive_tiny_scale_drawing_units() {
    // Same weld at 1 m and at micrometre/nanometre drawing units must read
    // identically. Under the old absolute 1e-6 cutoff the 1e-9 row here
    // reported rank 11 / dof 3 / Underconstrained -- three phantom degrees
    // of freedom purely from the drawing unit.
    for scale in [1.0_f64, 1e-7, 1e-9] {
        let out = solve_mate(&three_spherical_weld_input(scale));
        assert_eq!(
            out.diagnostics.dof, 0,
            "scale {scale:e}: dof must not depend on units"
        );
        assert_eq!(
            out.overall_status,
            MateStatus::FullyConstrained.to_u8(),
            "scale {scale:e}: status must not depend on units"
        );
    }
}

#[test]
fn status_survives_large_scale_drawing_units() {
    // A large drawing (span ~1e4) carrying a one-unit conflict between two
    // fixed mates. The least-squares residual is well above the old absolute
    // 1e-4 threshold, so the pre-fix code read this solve as Overconstrained;
    // relative to the drawing's own characteristic length the conflict is
    // within tolerance and it reports FullyConstrained. A satisfiable weld
    // would not make a scale-sensitive integration test: the solve runs in
    // f64 and drives its residual to ~zero regardless of threshold, which is
    // why the direct `mate_status` cases above pin the threshold itself.
    let conflicting = |span: f64| MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            (span) as f32,
            (0.75 * span) as f32,
            (0.5 * span) as f32,
            0.0,
            0.0,
            0.0,
            1.0,
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
                MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
                false,
                1.0,
                1.0,
                0.0,
            ),
        ],
    };
    let out = solve_mate(&conflicting(1e4));
    assert!(
        out.diagnostics.residual_norm > 1e-4,
        // Measured ~0.7: six orders above the old absolute threshold, so the
        // pre-fix code unambiguously classified this as Overconstrained.
        "the fixture must exceed the old absolute threshold to be a scale test; residual was {}",
        out.diagnostics.residual_norm,
    );
    assert_eq!(out.diagnostics.dof, 0);
    assert_eq!(out.overall_status, MateStatus::FullyConstrained.to_u8());
}

#[test]
fn copy_rotation_ratio_one_wraps_across_the_full_turn_branch_cut() {
    // Hold A at its seed and drive B forward; the residual must read the
    // SHORT way around once the raw twist passes 180 or 360 degrees. The
    // old unwrapped value at 350 deg read +350-degree-equivalent (+6.11
    // rad), a full-turn error that stalled descent on the cut.
    let p = MateProblem::new(&copy_rotation_input(1.0, 0.0, 0.0));
    let pose = |b_deg: f64| {
        let half = b_deg.to_radians() / 2.0;
        vec![
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
            0.0,
            0.0,
            half.sin(),
            half.cos(),
        ]
    };
    let r_at = |deg: f64| p.residuals(&pose(deg))[0];

    // Continuity across the former +/-pi jump: symmetric poses read as
    // symmetric residuals of OPPOSITE sign.
    assert!((r_at(190.0) + r_at(170.0)).abs() < 1e-9);
    // 350 deg past the seed is a -10 degree error, not +350.
    assert!((r_at(350.0) - (-10.0_f64).to_radians()).abs() < 1e-9);

    // And therefore |residual| decreases monotonically along the forward
    // path through the former branch cut -- the descent LM will follow.
    let path = [340.0, 345.0, 350.0, 355.0, 359.0];
    for w in path.windows(2) {
        assert!(
            r_at(w[1]).abs() < r_at(w[0]).abs(),
            "|r| increased from {} to {} deg along the forward path",
            w[0],
            w[1]
        );
    }
}

#[test]
fn copy_rotation_ratio_one_descends_the_short_way_through_a_full_turn() {
    // Problem authored at zero/zero, but LM restarts from B parked 340 deg
    // away (what a drag leaves behind when the solve reruns). The wrapped
    // residual points B forward through the former branch cut to the
    // nearest representative of its seed orientation; before the wrap the
    // raw 340-degree-equivalent error dragged it the long way around.
    let input = copy_rotation_input(1.0, 0.0, 0.0);
    let p = MateProblem::new(&input);
    let res = p.residuals_fn();
    let jac = p.jacobian_fn();
    let damp = p.rotation_damp_scale();
    let half = 340.0_f64.to_radians() / 2.0;
    let x_start = vec![
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
        0.0,
        0.0,
        half.sin(),
        half.cos(),
    ];
    let out = lm::solve_lm_damped(&x_start, &res, &jac, &damp);
    assert!(out.residual_norm < 1e-3, "rn={}", out.residual_norm);
    let qz = out.x[12];
    let qw = out.x[13];
    let roll_mod = (2.0 * qz.atan2(qw)).rem_euclid(2.0 * std::f64::consts::PI);
    assert!(
        !(0.05..=2.0 * std::f64::consts::PI - 0.05).contains(&roll_mod),
        "B should land back on its seed orientation modulo a full turn, got {roll_mod} rad"
    );
}

#[test]
fn copy_rotation_ratio_two_stays_raw_and_unwrapped() {
    // Locks today's numbers for ratio != 1: seeds A=10/B=5 deg, driven to
    // abs 30/abs 340 (deltas +20/+335). The raw formula reads exactly
    // delta_b - ratio*delta_a with NO wrapping; a future silent wrap would
    // turn this 5.15 rad into -1.13 rad and fail here. Both driven poses
    // stay inside (0, 360) so the twist angles themselves are unambiguous.
    let input = copy_rotation_input(2.0, 10.0, 5.0);
    let p = MateProblem::new(&input);
    let half_a = 30.0_f64.to_radians() / 2.0;
    let half_b = 340.0_f64.to_radians() / 2.0;
    let x = vec![
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        half_a.sin(),
        half_a.cos(),
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        half_b.sin(),
        half_b.cos(),
    ];
    let r = p.residuals(&x)[0];
    let expected = 335.0_f64.to_radians() - 2.0 * 20.0_f64.to_radians();
    // 1e-6: the sin/cos/atan2 chain through the quaternion loses a few
    // ulps; a wrapping regression would move r by 2*pi, not by this much.
    assert!((r - expected).abs() < 1e-6, "r={r}, expected={expected}");
}

#[test]
fn singular_value_cutoff_is_relative_with_a_legacy_zero_spectrum_floor() {
    // smax == 0 keeps the legacy absolute cutoff; anything else scales
    // with it.
    assert_eq!(singular_value_cutoff(0.0), 1e-6);
    assert!((singular_value_cutoff(40.0) - 40.0 * RANK_REL_TOL).abs() < 1e-18);
    assert!((singular_value_cutoff(2.558) - 2.558 * RANK_REL_TOL).abs() < 1e-18);
}

#[test]
fn cutoff_rescues_collapsed_geometry_values_but_not_true_zeros() {
    // Spectra measured from real fixtures (see the scale-invariance test):
    // a 1e-9-scale weld carries genuine constraints at ~1e-8, while a
    // hinge's genuinely free roll direction reads ~1e-18. The cutoff must
    // separate those two classes at comparable smax.
    let tol = singular_value_cutoff(2.558);
    let collapsed_weld = [2.6, 2.2, 2.3e-8, 2.0e-8, 1.2e-8];
    assert_eq!(collapsed_weld.iter().filter(|&&s| s > tol).count(), 5);

    let tol_hinge = singular_value_cutoff(2.921);
    let hinge_free_roll = [2.9, 2.2, 6.5e-18];
    assert_eq!(
        hinge_free_roll.iter().filter(|&&s| s > tol_hinge).count(),
        2
    );
}

#[test]
fn tangential_cone_branches_use_the_plane_and_axis_formulas() {
    // Cone shares its arms with Cylinder, but those arms are selected by
    // distinct match patterns; a drifting pattern list would silently drop
    // the cone pairs into the non-finite fallback. Drive `tangential_residual`
    // directly with concrete geometry so each cone branch has a pinned value.
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![0.0; 14],
        fixed_mask: vec![0],
        mates: vec![],
    };
    let problem = MateProblem::new(&input);
    let z = [0.0, 0.0, 1.0];
    let x = [1.0, 0.0, 0.0];
    let y = [0.0, 1.0, 0.0];

    // (Plane, Cone): |d . a_w| - radius - offset, with d = pa - pb.
    let r = problem.tangential_residual(
        AnchorKind::Plane,
        AnchorKind::Cone,
        &[0.0, 0.0, 0.0],
        &[0.0, 0.0, 5.0],
        &z,
        &z,
        0.0,
        2.0,
    );
    assert!((r - 3.0).abs() < 1e-12, "plane/cone: {r}");

    // (Cone, Plane): the mirrored arm measures against B's normal.
    let r = problem.tangential_residual(
        AnchorKind::Cone,
        AnchorKind::Plane,
        &[0.0, 0.0, 6.0],
        &[0.0, 0.0, 0.0],
        &z,
        &z,
        0.5,
        1.0,
    );
    assert!((r - 4.5).abs() < 1e-12, "cone/plane: {r}");

    // (Cylinder, Cone): shortest skew-axis distance minus both radii. The
    // perpendicular axes put the common normal along z at distance 5.
    let r = problem.tangential_residual(
        AnchorKind::Cylinder,
        AnchorKind::Cone,
        &[0.0, 0.0, 0.0],
        &[3.0, 0.0, 5.0],
        &x,
        &y,
        0.0,
        0.5,
    );
    assert!((r - 4.0).abs() < 1e-12, "cylinder/cone: {r}");

    // (Cone, Cylinder): the swapped axis pair shares the same formula.
    let r = problem.tangential_residual(
        AnchorKind::Cone,
        AnchorKind::Cylinder,
        &[0.0, 0.0, 0.0],
        &[3.0, 0.0, 5.0],
        &x,
        &y,
        0.0,
        0.5,
    );
    assert!((r - 4.0).abs() < 1e-12, "cone/cylinder: {r}");

    // (Cone, Cone) with parallel axes: the parallel fallback takes the
    // perpendicular distance (here 5), minus twice the radius and the offset.
    let r = problem.tangential_residual(
        AnchorKind::Cone,
        AnchorKind::Cone,
        &[0.0, 0.0, 0.0],
        &[3.0, 4.0, 0.0],
        &z,
        &z,
        1.0,
        2.0,
    );
    assert!(r.abs() < 1e-12, "cone/cone parallel: {r}");
}
