use super::*;

/// A small ellipse with a short line touching its rim, plus a line a thousand
/// units away: the sketch scale is ~1000 while every param the Normal touches
/// lives at ~5e-3.
fn tiny_feature_in_a_big_sketch() -> Input {
    // The far line sets the sketch scale; the ellipse and the short line,
    // whose end sits on the rim, live at 5e-3.
    let params = vec![
        0.0, 0.0, 1000.0, 0.0, 0.004, 0.005, 0.0005, 0.00025, 20.0, 0.00435, 0.00518, 0.00515,
        0.00458,
    ];
    let normal = Constraint {
        kind_code: ConstraintKind::Normal.to_u8(),
        refs: ab(
            e_ref(1, PointSelector::Absent),
            e_ref(2, PointSelector::Absent),
        ),
        ..Default::default()
    };
    input(
        vec![line(0), ent(Kind::Ellipse, 4), line(9)],
        params,
        vec![normal],
    )
}

#[test]
fn the_finite_difference_step_follows_the_touched_feature_not_the_sketch() {
    // The Normal row is the finite-difference fallback and its ellipse normal
    // is sharply curved at this radius. A step taken from the whole sketch
    // (this crate before the per-constraint floor) or from the old unit floor
    // samples across the ellipse and returns a different derivative, so the
    // probe must match a step taken below the feature and both larger floors
    // must visibly miss it.
    let inp = tiny_feature_in_a_big_sketch();
    let problem = Problem::new(&inp);
    assert_eq!(problem.constraints().len(), 1, "the Normal was dropped");
    assert!(
        problem.scale() > 900.0,
        "the fixture must have a sketch scale of ~1000, got {}",
        problem.scale()
    );
    let x = problem.x0.clone();
    let m = problem.residuals(&x).len();
    let analytic = problem.jacobian(&x, x.len());

    // A reference differenced far below the feature (a 1e-6-floor step is
    // still governed by each param's own magnitude above that).
    let reference =
        solver_core::lm::fd_jacobian_scaled(&|xx: &[f64]| problem.residuals(xx), &x, m, 1e-6);
    for r in 0..m {
        for col in 0..x.len() {
            let a = analytic[(r, col)];
            let want = reference[(r, col)];
            assert!(
                (a - want).abs() <= 1e-5 * want.abs().max(1.0),
                "({r},{col}): analytic {a} != reference {want}"
            );
        }
    }

    // The fixture's teeth: the floors this probe replaced must differ from the
    // reference by far more than the tolerance above, or the test could pass
    // on either older step.
    let worst = |j: &nalgebra::DMatrix<f64>| {
        j.iter()
            .zip(reference.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f64, f64::max)
    };
    let unit = solver_core::lm::fd_jacobian(&|xx: &[f64]| problem.residuals(xx), &x, m);
    let whole = solver_core::lm::fd_jacobian_scaled(
        &|xx: &[f64]| problem.residuals(xx),
        &x,
        m,
        problem.scale(),
    );
    assert!(
        worst(&unit) > 1e-3,
        "the unit floor no longer misses this fixture: {:e}",
        worst(&unit)
    );
    assert!(
        worst(&whole) > 1.0,
        "the sketch floor no longer misses this fixture: {:e}",
        worst(&whole)
    );
}
