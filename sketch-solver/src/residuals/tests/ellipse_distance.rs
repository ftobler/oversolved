use super::*;
use crate::residuals::geom::ellipse_point_residual;

#[test]
fn point_on_ellipse_coincident_residual() {
    // Axis-aligned ellipse: center (1,2), a=4, b=2, theta=0.
    // The point (5,2) sits on the major-axis vertex -> residual 0.
    // The point (1,4) sits on the minor-axis vertex -> residual 0.
    // The center (1,2) is fully inside -> residual -1.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Ellipse, 2)],
        vec![5.0, 2.0, 1.0, 2.0, 4.0, 2.0, 0.0],
        vec![cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].abs() < 1e-12, "major vertex on ellipse: {}", r[0]);

    // Move the point to the minor vertex (1,4): still on the curve.
    let mut x = p.x0.clone();
    x[0] = 1.0;
    x[1] = 4.0;
    let r = p.residuals(&x);
    assert!(r[0].abs() < 1e-12, "minor vertex on ellipse: {}", r[0]);

    // Move the point to the center: residual -1 (fully inside).
    x[0] = 1.0;
    x[1] = 2.0;
    let r = p.residuals(&x);
    assert!((r[0] + 1.0).abs() < 1e-12, "center inside: {}", r[0]);
}

#[test]
fn rotated_ellipse_point_residual() {
    // Center (0,0), a=2, b=1, rotated 90deg: the major axis points along +y.
    // So (0,2) is the major vertex and lands on the curve.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Ellipse, 2)],
        vec![0.0, 2.0, 0.0, 0.0, 2.0, 1.0, 90.0],
        vec![cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert!(r[0].abs() < 1e-12, "rotated major vertex: {}", r[0]);
}

#[test]
fn collapsed_ellipse_semi_axis_stays_finite() {
    // A semi-axis dragged (or decoded) to zero must not divide the conic
    // residual by zero: one NaN row makes every later LM step NaN and the
    // whole sketch stops converging with nothing reported.
    for ep in [
        [0.0, 0.0, 0.0, 1.0, 0.0], // a collapsed
        [0.0, 0.0, 2.0, 0.0, 0.0], // b collapsed
        [0.0, 0.0, 0.0, 0.0, 0.0], // both
    ] {
        let r = ellipse_point_residual([1.0, 1.0], &ep);
        assert!(r.is_finite(), "residual for {ep:?} was {r}");
    }
}

#[test]
fn collapsed_ellipse_keeps_the_stacked_residual_finite() {
    // The same degeneracy through the real constraint path: a point-on-
    // ellipse row over an ellipse whose minor axis has collapsed.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Ellipse, 2)],
        vec![3.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0],
        vec![cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].is_finite(), "point-on-collapsed-ellipse row: {}", r[0]);
}

#[test]
fn ellipse_axis_endpoints_resolve_from_params() {
    // Center (1,2), a=4, b=2, theta=0: major axis along +x, minor along +y.
    let inp = input(
        vec![ent(Kind::Ellipse, 0)],
        vec![1.0, 2.0, 4.0, 2.0, 0.0],
        vec![],
    );
    let p = Problem::new(&inp);
    let x = p.x0.clone();
    let pt = |sel| {
        p.point(
            &x,
            Ref::Entity {
                index: 0,
                point: sel,
            },
        )
    };
    assert_eq!(pt(PointSelector::Center), [1.0, 2.0]);
    let maj = pt(PointSelector::Major);
    assert!(
        (maj[0] - 5.0).abs() < 1e-9 && (maj[1] - 2.0).abs() < 1e-9,
        "major+ {:?}",
        maj
    );
    let majn = pt(PointSelector::MajorNeg);
    assert!(
        (majn[0] - (-3.0)).abs() < 1e-9 && (majn[1] - 2.0).abs() < 1e-9,
        "major- {:?}",
        majn
    );
    let min = pt(PointSelector::Minor);
    assert!(
        (min[0] - 1.0).abs() < 1e-9 && (min[1] - 4.0).abs() < 1e-9,
        "minor+ {:?}",
        min
    );
    let minn = pt(PointSelector::MinorNeg);
    assert!(
        (minn[0] - 1.0).abs() < 1e-9 && (minn[1] - 0.0).abs() < 1e-9,
        "minor- {:?}",
        minn
    );

    // Rotated 90deg: major axis now along +y.
    let inp2 = input(
        vec![ent(Kind::Ellipse, 0)],
        vec![0.0, 0.0, 4.0, 2.0, 90.0],
        vec![],
    );
    let p2 = Problem::new(&inp2);
    let maj2 = p2.point(
        &p2.x0.clone(),
        Ref::Entity {
            index: 0,
            point: PointSelector::Major,
        },
    );
    assert!(
        (maj2[0]).abs() < 1e-9 && (maj2[1] - 4.0).abs() < 1e-9,
        "rotated major+ {:?}",
        maj2
    );
}

#[test]
fn concentric_ellipse_and_circle_residual() {
    // Ellipse center (1,2), circle center (4,6): concentric residual (-3,-4).
    let inp = input(
        vec![ent(Kind::Ellipse, 0), ent(Kind::Circle, 5)],
        vec![1.0, 2.0, 3.0, 1.0, 0.0, 4.0, 6.0, 2.0],
        vec![cons(
            ConstraintKind::Concentric,
            ab(
                e_ref(0, PointSelector::Absent),
                e_ref(1, PointSelector::Absent),
            ),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    assert!((r[0] - (-3.0)).abs() < 1e-12);
    assert!((r[1] - (-4.0)).abs() < 1e-12);
}

#[test]
fn point_distance_x_residual_constrains_x_distance() {
    // Two points at (0,0) and (10,5) with value = 10:
    // point_distance_x residual = |10-0| - 10 = 0
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 10.0, 5.0],
        vec![cons_v(
            ConstraintKind::PointDistanceX,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            10.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].abs() < 1e-12, "point_distance_x residual {}", r[0]);
}

#[test]
fn point_distance_x_residual_nonzero_when_wrong() {
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 10.0, 5.0],
        vec![cons_v(
            ConstraintKind::PointDistanceX,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            7.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - 3.0).abs() < 1e-12, "expected 3, got {}", r[0]);
}

#[test]
fn point_distance_y_residual_constrains_y_distance() {
    // Two points at (0,0) and (10,5) with value = 5:
    // point_distance_y residual = |5-0| - 5 = 0
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 10.0, 5.0],
        vec![cons_v(
            ConstraintKind::PointDistanceY,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            5.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].abs() < 1e-12, "point_distance_y residual {}", r[0]);
}

#[test]
fn point_distance_y_residual_nonzero_when_wrong() {
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 10.0, 5.0],
        vec![cons_v(
            ConstraintKind::PointDistanceY,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            3.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - 2.0).abs() < 1e-12, "expected 2, got {}", r[0]);
}

#[test]
fn point_distance_x_signed_pins_b_to_the_right() {
    // pb is +10 to the right of pa. sign +1, value 10 -> (10-0) - 1*10 = 0.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 10.0, 5.0],
        vec![cons_vs(
            ConstraintKind::PointDistanceX,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            10.0,
            1.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].abs() < 1e-12, "signed +1 same side: {}", r[0]);
}

#[test]
fn point_distance_x_signed_wrong_side_is_nonzero_not_satisfied_by_abs() {
    // pb sits to the right (+10) but sign -1 demands the left side. The abs
    // residual would read 0 here (bistable); the signed one reads 20, so the
    // solver is pushed to actually move pb to the other side.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 10.0, 5.0],
        vec![cons_vs(
            ConstraintKind::PointDistanceX,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            10.0,
            -1.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert!(
        (r[0] - 20.0).abs() < 1e-12,
        "signed -1 wrong side: {}",
        r[0]
    );
}

#[test]
fn point_distance_x_signed_negative_side_satisfied_when_b_is_left() {
    // pb is -10 (left of pa). sign -1, value 10 -> (-10-0) - (-1*10) = 0.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, -10.0, 5.0],
        vec![cons_vs(
            ConstraintKind::PointDistanceX,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            10.0,
            -1.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert!(
        r[0].abs() < 1e-12,
        "signed -1 correct (left) side: {}",
        r[0]
    );
}

#[test]
fn point_distance_x_without_sign_keeps_legacy_abs_bistability() {
    // No sign: pb on the left still satisfies value 10 via the absolute
    // residual (|-10| - 10 = 0). Pins that the legacy path is untouched.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, -10.0, 5.0],
        vec![cons_v(
            ConstraintKind::PointDistanceX,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
            10.0,
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert!(r[0].abs() < 1e-12, "legacy abs both sides: {}", r[0]);
}

#[test]
fn point_distance_y_signed_picks_the_side() {
    // pb is +5 above pa; sign +1 satisfies, sign -1 reads 10.
    let mk = |sign: f64| {
        input(
            vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
            vec![0.0, 0.0, 10.0, 5.0],
            vec![cons_vs(
                ConstraintKind::PointDistanceY,
                ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
                5.0,
                sign,
            )],
        )
    };
    let up = mk(1.0);
    let pu = Problem::new(&up);
    assert!(pu.residuals(&pu.x0)[0].abs() < 1e-12);
    let down = mk(-1.0);
    let pd = Problem::new(&down);
    assert!((pd.residuals(&pd.x0)[0] - 10.0).abs() < 1e-12);
}

#[test]
fn line_distance_signed_selects_side_and_defaults_to_legacy() {
    // Line A along +x through origin; point b 5 above it. Normal is (0,1),
    // so the signed perpendicular offset is +5.
    let mk = |by: f32, sign: Option<f64>| {
        let c = Constraint {
            kind_code: ConstraintKind::LineDistance.to_u8(),
            refs: ab(e_ref(0, PointSelector::Absent), e_ref(1, PointSelector::Xy)),
            value: Some(5.0),
            sign,
            ..Default::default()
        };
        input(
            vec![ent(Kind::Line, 0), ent(Kind::Point, 4)],
            vec![0.0, 0.0, 10.0, 0.0, 3.0, by],
            vec![c],
        )
    };
    // No sign -> legacy signed residual against +value: b above satisfies.
    let none = mk(5.0, None);
    let pn = Problem::new(&none);
    assert!(pn.residuals(&pn.x0)[0].abs() < 1e-12, "legacy +1 default");
    // sign -1 wants b below; b above reads 10.
    let wrong = mk(5.0, Some(-1.0));
    let pw = Problem::new(&wrong);
    assert!(
        (pw.residuals(&pw.x0)[0] - 10.0).abs() < 1e-12,
        "signed -1 wrong side"
    );
    // sign -1 with b below is satisfied.
    let right = mk(-5.0, Some(-1.0));
    let pr = Problem::new(&right);
    assert!(
        pr.residuals(&pr.x0)[0].abs() < 1e-12,
        "signed -1 correct side"
    );
}

#[test]
fn angle_signed_pins_handedness_legacy_is_side_agnostic() {
    // Line A along +x (dir 0). Line B is either +y (dir +90, cross>0) or
    // -y (dir -90, cross<0). value 90 in all cases.
    let mk = |by_end: f32, sign: Option<f64>| {
        let c = Constraint {
            kind_code: ConstraintKind::Angle.to_u8(),
            refs: ab(
                e_ref(0, PointSelector::Absent),
                e_ref(1, PointSelector::Absent),
            ),
            value: Some(90.0),
            sign,
            ..Default::default()
        };
        input(
            vec![ent(Kind::Line, 0), ent(Kind::Line, 4)],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, by_end],
            vec![c],
        )
    };
    // Legacy (no sign): both handedness configs satisfy the unsigned angle.
    let lpos = mk(1.0, None);
    let lp = Problem::new(&lpos);
    assert!(lp.residuals(&lp.x0)[0].abs() < 1e-12, "legacy +y");
    let lneg = mk(-1.0, None);
    let ln = Problem::new(&lneg);
    assert!(ln.residuals(&ln.x0)[0].abs() < 1e-12, "legacy -y");
    // sign +1 wants the +90 (CCW) handedness: +y satisfies, -y reads pi.
    let spos = mk(1.0, Some(1.0));
    let sp = Problem::new(&spos);
    assert!(sp.residuals(&sp.x0)[0].abs() < 1e-12, "signed +1 with +y");
    let sneg = mk(-1.0, Some(1.0));
    let sn = Problem::new(&sneg);
    assert!(
        (sn.residuals(&sn.x0)[0].abs() - std::f64::consts::PI).abs() < 1e-12,
        "signed +1 with -y must be off by a half turn: {}",
        sn.residuals(&sn.x0)[0]
    );
    // sign -1 flips it: -y now satisfies.
    let smneg = mk(-1.0, Some(-1.0));
    let smn = Problem::new(&smneg);
    assert!(smn.residuals(&smn.x0)[0].abs() < 1e-12, "signed -1 with -y");
}
