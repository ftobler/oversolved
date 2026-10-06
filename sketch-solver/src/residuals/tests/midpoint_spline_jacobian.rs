use super::*;
use crate::residuals::geom::ellipse_point_residual;

#[test]
fn midpoint_line_form_constrains_point_to_segment_center() {
    // Line [0,0 -> 4,2] has midpoint (2,1). A point sitting there is feasible
    // in both axes; the big-jac test only checks this branch's derivative, not
    // the residual value, so this pins the formula direction (pt - mid).
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Point, 4)],
        vec![0.0, 0.0, 4.0, 2.0, 2.0, 1.0],
        vec![cons(
            ConstraintKind::Midpoint,
            vec![
                (RefRole::Line, e_ref(0, PointSelector::Absent)),
                (RefRole::Point, e_ref(1, PointSelector::Xy)),
            ],
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    assert!(
        r[0].abs() < 1e-12 && r[1].abs() < 1e-12,
        "on-center {:?}",
        r
    );

    // Move the point to (5,7): residual = (5-2, 7-1) = (3, 6).
    let mut x = p.x0.clone();
    x[4] = 5.0;
    x[5] = 7.0;
    let r = p.residuals(&x);
    assert!(
        (r[0] - 3.0).abs() < 1e-12 && (r[1] - 6.0).abs() < 1e-12,
        "off-center {:?}",
        r
    );
}

#[test]
fn midpoint_point_pair_form_uses_average_of_two_points() {
    // PointA (0,0) + PointB (10,4) -> midpoint (5,2). The point-pair branch
    // (RefRole::PointA/PointB) is exercised by no other test.
    let inp = input(
        vec![
            ent(Kind::Point, 0),
            ent(Kind::Point, 2),
            ent(Kind::Point, 4),
        ],
        vec![0.0, 0.0, 10.0, 4.0, 5.0, 5.0],
        vec![cons(
            ConstraintKind::Midpoint,
            vec![
                (RefRole::PointA, e_ref(0, PointSelector::Xy)),
                (RefRole::PointB, e_ref(1, PointSelector::Xy)),
                (RefRole::Point, e_ref(2, PointSelector::Xy)),
            ],
        )],
    );
    let p = Problem::new(&inp);
    // Point is at (5,5); midpoint is (5,2) -> residual (0, 3).
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    assert!(
        r[0].abs() < 1e-12 && (r[1] - 3.0).abs() < 1e-12,
        "point-pair {:?}",
        r
    );
}

#[test]
fn midpoint_axis_filter_emits_only_the_selected_component() {
    // Line midpoint (2,1), point at (5,7). Axis::X keeps only the x row (3),
    // Axis::Y keeps only the y row (6). The axis-restricted branches have no
    // other coverage.
    let make = |axis: Axis| Constraint {
        kind_code: ConstraintKind::Midpoint.to_u8(),
        refs: vec![
            (RefRole::Line, e_ref(0, PointSelector::Absent)),
            (RefRole::Point, e_ref(1, PointSelector::Xy)),
        ],
        axis: Some(axis),
        ..Default::default()
    };
    let entities = vec![ent(Kind::Line, 0), ent(Kind::Point, 4)];
    let params = vec![0.0, 0.0, 4.0, 2.0, 5.0, 7.0];

    let inp_x = input(entities.clone(), params.clone(), vec![make(Axis::X)]);
    let px = Problem::new(&inp_x);
    let rx = px.residuals(&px.x0.clone());
    assert_eq!(rx.len(), 1);
    assert!((rx[0] - 3.0).abs() < 1e-12, "axis-x {:?}", rx);

    let inp_y = input(entities, params, vec![make(Axis::Y)]);
    let py = Problem::new(&inp_y);
    let ry = py.residuals(&py.x0.clone());
    assert_eq!(ry.len(), 1);
    assert!((ry[0] - 6.0).abs() < 1e-12, "axis-y {:?}", ry);
}

#[test]
fn spline_point_resolves_start_end_midpoint() {
    // Cubic Bezier P1(0,0) P2(0,3) P3(3,3) P4(3,0).
    let inp = input(
        vec![ent(Kind::Spline, 0)],
        vec![0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0],
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
    assert_eq!(pt(PointSelector::Start), [0.0, 0.0]);
    assert_eq!(pt(PointSelector::End), [3.0, 0.0]);
    // C1/C2 resolve to the off-curve control points P2/P3.
    assert_eq!(pt(PointSelector::C1), [0.0, 3.0]);
    assert_eq!(pt(PointSelector::C2), [3.0, 3.0]);
    // B(0.5) = (P1 + 3P2 + 3P3 + P4)/8 = (1.5, 2.25).
    let mid = pt(PointSelector::Center);
    assert!(
        (mid[0] - 1.5).abs() < 1e-9 && (mid[1] - 2.25).abs() < 1e-9,
        "mid {:?}",
        mid
    );
}

#[test]
fn point_on_spline_coincident_residual() {
    // A point sitting exactly on B(0.5)=(1.5,2.25) -> residual ~0.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Spline, 2)],
        vec![1.5, 2.25, 0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0],
        vec![cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Absent)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].abs() < 1e-6, "on-curve residual {}", r[0]);

    // Move the point off the curve -> nonzero perpendicular distance.
    let mut x = p.x0.clone();
    x[1] = 0.5;
    let r = p.residuals(&x);
    assert!(r[0].abs() > 1e-3, "off-curve residual {}", r[0]);
}

/// Exercise both the analytic point_jac spline arm (point_distance on
/// start + midpoint, coincident point-point) and the FD fallback branches
/// (point-on-spline coincident, line-spline tangent) against full FD.
#[test]
fn spline_jacobian_matches_finite_difference() {
    use PointSelector::{Absent, Start, Xy, C1, C2};
    use RefRole::{Arc as ArcR, Line as LineR, A, B};

    let entities = vec![
        ent(Kind::Spline, 0), // 0 [0..8]
        ent(Kind::Point, 8),  // 1 [8..10]
        ent(Kind::Line, 10),  // 2 [10..14]
    ];
    let params = vec![
        0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 4.0, 0.0, // spline
        2.0, 1.0, // point
        0.0, 0.0, 1.0, 0.5, // line
    ];
    let constraints = vec![
        cons_v(
            ConstraintKind::PointDistance,
            vec![(A, e_ref(0, Start)), (B, e_ref(1, Xy))],
            2.0,
        ),
        cons_v(
            ConstraintKind::PointDistance,
            vec![(A, e_ref(0, Absent)), (B, e_ref(1, Xy))],
            1.0,
        ),
        // C1/C2 control-point selectors through the analytic point_jac.
        cons_v(
            ConstraintKind::PointDistance,
            vec![(A, e_ref(0, C1)), (B, e_ref(1, Xy))],
            1.5,
        ),
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(0, C2)), (B, e_ref(1, Xy))],
        ),
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(0, Start)), (B, e_ref(1, Xy))],
        ),
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(1, Xy)), (B, e_ref(0, Absent))],
        ),
        cons(
            ConstraintKind::Tangent,
            vec![(LineR, e_ref(2, Absent)), (ArcR, e_ref(0, Start))],
        ),
    ];
    let inp = input(entities, params, constraints);
    let p = Problem::new(&inp);
    let x: Vec<f64> = inp
        .params_initial
        .iter()
        .enumerate()
        .map(|(i, &v)| v as f64 + 0.21 * ((i as f64) * 1.7).sin())
        .collect();
    let n = x.len();

    let analytic = p.jacobian(&x, n);
    let residual_fn = |xx: &[f64]| p.residuals(xx);
    let m = residual_fn(&x).len();
    let fd = solver_core::lm::fd_jacobian(&residual_fn, &x, m);
    for r in 0..m {
        for col in 0..n {
            let diff = (analytic[(r, col)] - fd[(r, col)]).abs();
            assert!(
                diff < 1e-4,
                "row {r} col {col}: analytic={} fd={} (diff {diff})",
                analytic[(r, col)],
                fd[(r, col)],
            );
        }
    }
}

#[test]
fn pinned_mask_and_equality_pins_add_rows() {
    let mut inp = input(vec![ent(Kind::Point, 0)], vec![3.0, 7.0], vec![]);
    inp.pinned_mask = vec![0b01]; // pin param 0 to its initial (3.0)
    inp.equality_pins = vec![EqualityPin {
        param_index: 1,
        target: 5.0,
    }];
    let p = Problem::new(&inp);
    let r = p.residuals(&[3.0, 9.0]);
    // pin row: x[0]-x0[0] = 3-3 = 0 ; equality row: x[1]-target = 9-5 = 4
    assert_eq!(r.len(), 2);
    assert!((r[0]).abs() < 1e-12);
    assert!((r[1] - 4.0).abs() < 1e-12);
}

/// A parallel constraint between non-line entities (hand-edited or legacy
/// docs; the UI refuses to author them) must contribute zero rows in both
/// the residual and the Jacobian: a circle operand would otherwise read
/// out of bounds (3-param block) and an arc operand would steer toward a
/// garbage direction built from its radius and angles.
#[test]
fn parallel_skips_non_line_entities() {
    let abs = PointSelector::Absent;
    let entities = vec![
        ent(Kind::Circle, 0), // C1 [0..3]
        ent(Kind::Arc, 3),    // A1 [3..8]
        ent(Kind::Arc, 8),    // A2 [8..13]
        ent(Kind::Line, 13),  // L1 [13..17]
        ent(Kind::Line, 17),  // L2 [17..21]
    ];
    let params = vec![
        1.0, 2.0, 0.5, // C1
        0.0, 0.0, 2.0, 10.0, 80.0, // A1
        5.0, 5.0, 1.0, 200.0, 300.0, // A2
        0.0, 0.0, 3.0, 1.0, // L1
        1.0, 2.0, 4.0, 5.0, // L2
    ];
    let constraints = vec![
        cons(ConstraintKind::Parallel, ab(e_ref(0, abs), e_ref(1, abs))), // circle/arc
        cons(ConstraintKind::Parallel, ab(e_ref(1, abs), e_ref(2, abs))), // arc/arc
        cons(ConstraintKind::Parallel, ab(e_ref(0, abs), e_ref(3, abs))), // circle/line
        cons(ConstraintKind::Parallel, ab(e_ref(3, abs), e_ref(4, abs))), // line/line
    ];
    let inp = input(entities, params, constraints);
    let p = Problem::new(&inp);
    let x = p.x0.clone();
    let n = x.len();
    // Only the line/line pairing contributes a row; the rest are skipped.
    let r = p.residuals(&x);
    assert_eq!(r.len(), 1);
    let j = p.jacobian(&x, n);
    assert_eq!(j.nrows(), 1);
}

/// Equal between two circles compares radii, and tangent between two circles
/// drives the centers apart by rA+rB (external) or |rA-rB| (internal). Both
/// used to misread a circle's 3-param block as a line and produce garbage;
/// now they have proper curve/curve residuals.
#[test]
fn equal_radius_and_circle_tangent() {
    let abs = PointSelector::Absent;
    // C1 center (0,0) r=2; C2 center (10,0) r=3.
    let make = || vec![ent(Kind::Circle, 0), ent(Kind::Circle, 3)];
    let params = || vec![0.0, 0.0, 2.0, 10.0, 0.0, 3.0];

    // Equal radius: residual = rA - rB = 2 - 3 = -1, and the analytic
    // Jacobian agrees with finite differences.
    {
        let cons_eq = cons(
            ConstraintKind::EqualLength,
            ab(e_ref(0, abs), e_ref(1, abs)),
        );
        let inp = input(make(), params(), vec![cons_eq]);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        let r = p.residuals(&x);
        assert_eq!(r.len(), 1);
        assert!((r[0] - (2.0 - 3.0)).abs() < 1e-12, "equal radius: {}", r[0]);
        let analytic = p.jacobian(&x, n);
        let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| p.residuals(xx), &x, 1);
        for col in 0..n {
            assert!(
                (analytic[(0, col)] - fd[(0, col)]).abs() < 1e-5,
                "equal jac col {col}: analytic={} fd={}",
                analytic[(0, col)],
                fd[(0, col)],
            );
        }
    }

    // Tangent: d=10, rA+rB=5, |rA-rB|=1. External (10-5=5) is nearer than
    // internal (10-1=9), so the residual is the external one.
    {
        let cons_tan = cons(ConstraintKind::Tangent, ab(e_ref(0, abs), e_ref(1, abs)));
        let inp = input(make(), params(), vec![cons_tan]);
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 1);
        assert!((r[0] - 5.0).abs() < 1e-12, "circle tangent: {}", r[0]);
    }
}

/// A radius-difference dimension between two concentric circles drives the
/// gap |rA - rB| to the target value.
#[test]
fn radius_difference_dimension() {
    let abs = PointSelector::Absent;
    // Concentric circles at the origin: rA=2, rB=5 -> current gap 3.
    let entities = vec![ent(Kind::Circle, 0), ent(Kind::Circle, 3)];
    let params = vec![0.0, 0.0, 2.0, 0.0, 0.0, 5.0];
    let c = cons_v(
        ConstraintKind::RadiusDifference,
        ab(e_ref(0, abs), e_ref(1, abs)),
        4.0,
    );
    let inp = input(entities, params, vec![c]);
    let p = Problem::new(&inp);
    let x = p.x0.clone();
    let n = x.len();
    // residual = |2 - 5| - 4 = 3 - 4 = -1.
    let r = p.residuals(&x);
    assert_eq!(r.len(), 1);
    assert!((r[0] - (-1.0)).abs() < 1e-12, "radius diff: {}", r[0]);
    // The finite-difference Jacobian is well-defined away from rA == rB.
    let analytic = p.jacobian(&x, n);
    assert_eq!(analytic.nrows(), 1);
}

/// Build the full entities/params/constraints for the all-constraints Jacobian
/// coverage test, then assert the analytic Jacobian matches FD. The FD is the
/// trusted oracle (it is finite differences of the residual itself), so this
/// gate catches any hand-derivative mistake.
///
/// Extracted to a helper so the bigger problem (with RadiusDifference,
/// PointDistanceX/Y) stays manageable.
fn check_big_jac_problem(
    entities: Vec<Entity>,
    params: Vec<f32>,
    constraints: Vec<Constraint>,
    pinned_mask: Vec<u8>,
    equality_pins: Vec<EqualityPin>,
) {
    let inp = Input {
        entities,
        params_initial: params,
        pinned_mask,
        equality_pins,
        constraints,
        options: Options::default(),
    };
    let p = Problem::new(&inp);
    // Perturb away from seed so derivatives are exercised at a generic point.
    let x: Vec<f64> = inp
        .params_initial
        .iter()
        .enumerate()
        .map(|(i, &v)| v as f64 + 0.37 * ((i as f64) * 1.3).sin())
        .collect();
    let n = x.len();
    let analytic = p.jacobian(&x, n);
    let residual_fn = |xx: &[f64]| p.residuals(xx);
    let m = residual_fn(&x).len();
    let fd = solver_core::lm::fd_jacobian(&residual_fn, &x, m);
    assert_eq!(analytic.nrows(), m);
    assert_eq!(fd.nrows(), m);
    for r in 0..m {
        for col in 0..n {
            let diff = (analytic[(r, col)] - fd[(r, col)]).abs();
            assert!(
                diff < 1e-4,
                "row {r} col {col}: analytic={} fd={} (diff {diff})",
                analytic[(r, col)],
                fd[(r, col)],
            );
        }
    }
}

#[test]
fn analytic_jacobian_matches_finite_difference() {
    use PointSelector::{Absent, Center, End, Major, Minor, Start, Xy};
    use RefRole::{Arc as ArcR, Line as LineR, Point as PointR, Target, A, B};

    let entities = vec![
        ent(Kind::Line, 0),     // 0  L1 [0..4]
        ent(Kind::Line, 4),     // 1  L2 [4..8]
        ent(Kind::Circle, 8),   // 2  C1 [8..11]
        ent(Kind::Arc, 11),     // 3  A1 [11..16]
        ent(Kind::Point, 16),   // 4  P1 [16..18]
        ent(Kind::Point, 18),   // 5  P2 [18..20]
        ent(Kind::Ellipse, 20), // 6  E1 [20..25]
        ent(Kind::Circle, 25),  // 7  C2 [25..28]
    ];
    let params = vec![
        0.0, 0.0, 3.0, 1.0, // L1
        1.0, 2.0, 4.0, 5.0, // L2
        2.0, 3.0, 2.5, // C1
        1.0, 1.0, 2.0, 30.0, 120.0, // A1
        5.0, 6.0, // P1
        7.0, 2.0, // P2
        2.5, 3.5, 4.0, 2.0, 25.0, // E1 (cx, cy, a, b, theta_deg)
        10.0, -5.0, 1.5, // C2
    ];

    let constraints = vec![
        cons(ConstraintKind::Horizontal, vec![(Target, e_ref(0, Absent))]),
        cons(
            ConstraintKind::Horizontal,
            vec![(A, e_ref(0, Start)), (B, e_ref(4, End))],
        ),
        cons(ConstraintKind::Vertical, vec![(Target, e_ref(1, Absent))]),
        cons(
            ConstraintKind::Vertical,
            vec![(A, e_ref(4, Xy)), (B, e_ref(5, Xy))],
        ),
        cons_v(
            ConstraintKind::Length,
            vec![(Target, e_ref(0, Absent))],
            5.0,
        ),
        cons_v(
            ConstraintKind::Radius,
            vec![(Target, e_ref(2, Absent))],
            4.0,
        ),
        cons_v(
            ConstraintKind::Diameter,
            vec![(Target, e_ref(2, Absent))],
            8.0,
        ),
        cons(
            ConstraintKind::Parallel,
            vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))],
        ),
        cons(
            ConstraintKind::Concentric,
            vec![(A, e_ref(2, Absent)), (B, e_ref(3, Absent))],
        ),
        cons(
            ConstraintKind::EqualLength,
            vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))],
        ),
        cons_v(
            ConstraintKind::PointDistance,
            vec![(A, e_ref(4, Xy)), (B, e_ref(5, Xy))],
            3.0,
        ),
        // coincident: analytic point-point (incl. arc endpoint point_jac)
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(4, Xy)), (B, e_ref(5, Xy))],
        ),
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(3, Start)), (B, e_ref(5, Xy))],
        ),
        // coincident fallback branches
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(4, Xy)), (B, e_ref(1, Absent))],
        ),
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(4, Xy)), (B, e_ref(2, Absent))],
        ),
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))],
        ),
        // point-on-ellipse (FD fallback branch) and concentric ellipse+circle
        cons(
            ConstraintKind::Coincident,
            vec![(A, e_ref(5, Xy)), (B, e_ref(6, Absent))],
        ),
        cons(
            ConstraintKind::Concentric,
            vec![(A, e_ref(6, Absent)), (B, e_ref(2, Absent))],
        ),
        // ellipse axis-endpoint point_distance (exercises the endpoint point_jac)
        cons_v(
            ConstraintKind::PointDistance,
            vec![(A, e_ref(6, Center)), (B, e_ref(6, Major))],
            4.0,
        ),
        cons_v(
            ConstraintKind::PointDistance,
            vec![(A, e_ref(6, Center)), (B, e_ref(6, Minor))],
            2.0,
        ),
        // direction-normalizing / atan2 fallbacks
        cons(
            ConstraintKind::Normal,
            vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))],
        ),
        cons_v(
            ConstraintKind::Angle,
            vec![(A, e_ref(0, Absent)), (B, e_ref(1, Absent))],
            30.0,
        ),
        cons(
            ConstraintKind::Tangent,
            vec![(LineR, e_ref(0, Absent)), (ArcR, e_ref(2, Absent))],
        ),
        cons(
            ConstraintKind::Tangent,
            vec![(LineR, e_ref(0, Absent)), (ArcR, e_ref(3, Start))],
        ),
        cons(
            ConstraintKind::Midpoint,
            vec![(LineR, e_ref(0, Absent)), (PointR, e_ref(4, Xy))],
        ),
        cons_v(
            ConstraintKind::LineDistance,
            vec![(A, e_ref(0, Absent)), (B, e_ref(5, Xy))],
            1.0,
        ),
        // radius-difference dimension between C1 and C2
        cons_v(
            ConstraintKind::RadiusDifference,
            ab(e_ref(2, Absent), e_ref(7, Absent)),
            1.0,
        ),
        // point-distance-x/y between P1 and P2
        cons_v(
            ConstraintKind::PointDistanceX,
            ab(e_ref(4, Xy), e_ref(5, Xy)),
            2.0,
        ),
        cons_v(
            ConstraintKind::PointDistanceY,
            ab(e_ref(4, Xy), e_ref(5, Xy)),
            4.0,
        ),
        // fixed: explicit-xy point, point+xy, and full-entity
        Constraint {
            kind_code: ConstraintKind::Fixed.to_u8(),
            refs: vec![(Target, e_ref(4, Absent))],
            xy: Some((1.0, 1.0)),
            ..Default::default()
        },
        Constraint {
            kind_code: ConstraintKind::Fixed.to_u8(),
            refs: vec![(Target, e_ref(0, Start))],
            xy: Some((0.0, 0.0)),
            ..Default::default()
        },
        cons(ConstraintKind::Fixed, vec![(Target, e_ref(1, Absent))]),
        // arc center selector through fixed (exercises Center point_jac)
        Constraint {
            kind_code: ConstraintKind::Fixed.to_u8(),
            refs: vec![(Target, e_ref(3, Center))],
            xy: Some((1.0, 1.0)),
            ..Default::default()
        },
    ];

    check_big_jac_problem(
        entities,
        params,
        constraints,
        vec![0b0000_0010], // pin param 1
        vec![EqualityPin {
            param_index: 9,
            target: 2.0,
        }],
    );
}

/// The sparse Jacobian is the drag fast path's only derivative source, and
/// unlike the dense one it had no cross-check against the residual at all.
/// It must be the dense matrix with exact zeros dropped: reconstructing the
/// sparse rows must reproduce the dense entry in every column, and at least
/// one row must actually be sparse (otherwise the filter is a no-op).
#[test]
fn jacobian_sparse_matches_dense_jacobian() {
    use PointSelector::{Absent, Start, Xy};
    use RefRole::{Arc as ArcR, Line as LineR, Target};

    // Mixed analytic and finite-difference rows so both derivative paths
    // feed the sparse conversion.
    let entities = vec![
        ent(Kind::Line, 0),   // L1 [0..4]
        ent(Kind::Line, 4),   // L2 [4..8]
        ent(Kind::Circle, 8), // C1 [8..11]
        ent(Kind::Point, 11), // P1 [11..13]
    ];
    let params = vec![
        0.0, 0.0, 3.0, 1.0, // L1
        1.0, 2.0, 4.0, 5.0, // L2
        2.0, 3.0, 2.5, // C1
        5.0, 6.0, // P1
    ];
    let constraints = vec![
        cons(ConstraintKind::Horizontal, vec![(Target, e_ref(0, Absent))]),
        cons_v(
            ConstraintKind::Length,
            vec![(Target, e_ref(0, Absent))],
            5.0,
        ),
        cons(
            ConstraintKind::Parallel,
            ab(e_ref(0, Absent), e_ref(1, Absent)),
        ),
        cons_v(
            ConstraintKind::Radius,
            vec![(Target, e_ref(2, Absent))],
            4.0,
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(3, Xy), e_ref(1, Absent)),
        ),
        cons_v(
            ConstraintKind::Angle,
            ab(e_ref(0, Absent), e_ref(1, Absent)),
            30.0,
        ),
        cons_v(
            ConstraintKind::PointDistance,
            ab(e_ref(3, Xy), e_ref(0, Start)),
            1.0,
        ),
        cons(
            ConstraintKind::Tangent,
            vec![(LineR, e_ref(0, Absent)), (ArcR, e_ref(2, Absent))],
        ),
    ];
    let inp = input(entities, params, constraints);
    let p = Problem::new(&inp);
    let x: Vec<f64> = inp
        .params_initial
        .iter()
        .enumerate()
        .map(|(i, &v)| v as f64 + 0.13 * ((i as f64) * 0.9).cos())
        .collect();
    let n = x.len();

    let dense = p.jacobian(&x, n);
    let sparse = p.jacobian_sparse(&x, n);

    assert_eq!(sparse.len(), dense.nrows());
    assert!(
        sparse.iter().any(|row| row.len() < n),
        "expected the zero-stripping to drop columns from at least one row"
    );
    for (r, row) in sparse.iter().enumerate() {
        let mut reconstructed = vec![0.0; n];
        for &(c, v) in row {
            assert_ne!(v, 0.0, "row {r} col {c} stored an explicit zero");
            reconstructed[c] = v;
        }
        for c in 0..n {
            assert!(
                (reconstructed[c] - dense[(r, c)]).abs() < 1e-15,
                "row {r} col {c}: sparse={} dense={}",
                reconstructed[c],
                dense[(r, c)],
            );
        }
    }
}

#[test]
fn ellipse_point_residual_floors_a_nan_semi_axis() {
    // `f64::max` ignores a NaN operand (IEEE maxNum), so a NaN semi-axis
    // falls back to the floor instead of poisoning the row. The reported
    // concern that the floor does not apply to NaN does not hold in Rust.
    let nan_major = [0.0, 0.0, f64::NAN, 2.0, 0.0];
    let v = ellipse_point_residual([1.0, 0.5], &nan_major);
    assert!(v.is_finite(), "NaN semi-axis produced {v}");
    let nan_minor = [0.0, 0.0, 4.0, f64::NAN, 0.0];
    let v = ellipse_point_residual([1.0, 0.5], &nan_minor);
    assert!(v.is_finite(), "NaN semi-minor produced {v}");
}
