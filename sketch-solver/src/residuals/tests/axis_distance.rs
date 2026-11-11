use super::*;

// A point measured from a fixed origin literal: the row carries the point's
// own parameter and nothing else, so a full-rank row is one non-zero entry.
fn origin_axis(kind: ConstraintKind, value: f64, sign: Option<f64>) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs: ab(
            Ref::External { x: 0.0, y: 0.0 },
            e_ref(0, PointSelector::Xy),
        ),
        value: Some(value),
        sign,
        ..Default::default()
    }
}

fn point_input(constraint: Constraint, px: f64, py: f64) -> Input {
    input(vec![point(0)], vec![px, py], vec![constraint])
}

#[test]
fn an_unsigned_zero_x_distance_keeps_a_row_on_the_point_x_param() {
    // |x - 0| has a kink at 0: the derivative is one of its two sides, never
    // zero, so the dimension must keep removing its degree of freedom.
    let inp = point_input(
        origin_axis(ConstraintKind::PointDistanceX, 0.0, None),
        0.0,
        1.5,
    );
    let p = Problem::new(&inp);
    let j = p.jacobian(&p.x0, 2);
    assert_eq!(j.nrows(), 1);
    assert!(
        j[(0, 0)].abs() > 0.5,
        "the unsigned zero x row is empty: {j:?}"
    );
    assert_eq!(j[(0, 1)], 0.0);
}

#[test]
fn an_unsigned_zero_y_distance_keeps_a_row_on_the_point_y_param() {
    let inp = point_input(
        origin_axis(ConstraintKind::PointDistanceY, 0.0, None),
        1.5,
        0.0,
    );
    let p = Problem::new(&inp);
    let j = p.jacobian(&p.x0, 2);
    assert_eq!(j.nrows(), 1);
    assert!(
        j[(0, 1)].abs() > 0.5,
        "the unsigned zero y row is empty: {j:?}"
    );
    assert_eq!(j[(0, 0)], 0.0);
}

#[test]
fn a_signed_zero_axis_distance_keeps_its_full_row() {
    // The side sign scales the target, not the derivative: d - s * 0 still has
    // slope +1 on the measured coordinate whichever side was authored.
    for sign in [1.0, -1.0] {
        let inp = point_input(
            origin_axis(ConstraintKind::PointDistanceX, 0.0, Some(sign)),
            0.0,
            1.5,
        );
        let p = Problem::new(&inp);
        let j = p.jacobian(&p.x0, 2);
        assert_eq!(j[(0, 0)], 1.0, "sign {sign} row {j:?}");
        assert_eq!(j[(0, 1)], 0.0, "sign {sign} row {j:?}");
    }
}

#[test]
fn the_axis_derivative_matches_finite_difference_away_from_zero() {
    // Both sides and the unsigned (absolute) form, on points either side of
    // the origin, so the derivative sign is the residual's own, not a guess.
    for sign in [None, Some(1.0), Some(-1.0)] {
        for px in [3.0, -3.0] {
            let inp = point_input(
                origin_axis(ConstraintKind::PointDistanceX, 3.0, sign),
                px,
                0.7,
            );
            let p = Problem::new(&inp);
            let x = p.x0.clone();
            let n = x.len();
            let analytic = p.jacobian(&x, n);
            let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| p.residuals(xx), &x, 1);
            for col in 0..n {
                assert!(
                    (analytic[(0, col)] - fd[(0, col)]).abs() < 1e-5,
                    "sign {sign:?} at x = {px}: col {col} analytic {} fd {}",
                    analytic[(0, col)],
                    fd[(0, col)],
                );
            }
        }
    }
}

fn two_circles(ra: f64, rb: f64, value: f64) -> Input {
    input(
        vec![ent(Kind::Circle, 0), ent(Kind::Circle, 3)],
        vec![0.0, 0.0, ra, 1.0, 0.0, rb],
        vec![cons_v(
            ConstraintKind::RadiusDifference,
            ab(
                e_ref(0, PointSelector::Absent),
                e_ref(1, PointSelector::Absent),
            ),
            value,
        )],
    )
}

#[test]
fn a_zero_radius_gap_keeps_a_row_on_both_radii() {
    // The same kink at ra == rb: a zero gap must still pin b's radius to a's.
    let inp = two_circles(1.0, 1.0, 0.0);
    let p = Problem::new(&inp);
    let j = p.jacobian(&p.x0, 6);
    assert_eq!(j.nrows(), 1);
    assert!(
        j[(0, 2)].abs() > 0.5 && j[(0, 5)].abs() > 0.5,
        "the zero radius gap row is empty: {j:?}"
    );
    // A gap is a difference: the two entries point opposite ways.
    assert!((j[(0, 2)] + j[(0, 5)]).abs() < 1e-12, "row {j:?}");
}

#[test]
fn the_radius_gap_derivative_matches_finite_difference_on_either_side() {
    for (ra, rb) in [(2.5, 1.0), (1.0, 2.5)] {
        let inp = two_circles(ra, rb, 1.5);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        let analytic = p.jacobian(&x, n);
        let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| p.residuals(xx), &x, 1);
        for col in 0..n {
            assert!(
                (analytic[(0, col)] - fd[(0, col)]).abs() < 1e-5,
                "ra {ra} rb {rb}: col {col} analytic {} fd {}",
                analytic[(0, col)],
                fd[(0, col)],
            );
        }
    }
}
