use super::*;

#[test]
fn coincident_point_point_residual() {
    // Two points: (1,2) and (4,6). Coincident residual = (dx, dy) = (-3,-4).
    let c = vec![Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 0,
                point: PointSelector::Xy,
            },
            Ref::Entity {
                index: 1,
                point: PointSelector::Xy,
            },
        ),
        ..Default::default()
    }];
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![1.0, 2.0, 4.0, 6.0],
        c,
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    assert!((r[0] - (-3.0)).abs() < 1e-12);
    assert!((r[1] - (-4.0)).abs() < 1e-12);
}

#[test]
fn point_on_circle_coincident_symmetric_residual() {
    // Circle at (0,0) r=5, point at (8,0).
    // Residual = dist((8,0), (0,0)) - 5 = 8 - 5 = 3.
    // Circle in role A (Absent/locus), point in role B (Xy).
    let c = vec![Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 0,
                point: PointSelector::Absent,
            },
            Ref::Entity {
                index: 1,
                point: PointSelector::Xy,
            },
        ),
        ..Default::default()
    }];
    let inp = input(
        vec![ent(Kind::Circle, 0), ent(Kind::Point, 3)],
        vec![0.0, 0.0, 5.0, 8.0, 0.0],
        c,
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - 3.0).abs() < 1e-12, "residual: {}", r[0]);
}

#[test]
fn point_on_line_coincident_with_external_point() {
    // A line locus (role A, Absent) coincident with an EXTERNAL point (the
    // document origin form) must read as point-on-line, not pin the line's
    // start. Vertical line x=0 from (0,0) to (0,10); external point (3,5).
    // Signed perpendicular distance = -3 -> a SINGLE residual row.
    let c = vec![Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 0,
                point: PointSelector::Absent,
            },
            Ref::External { x: 3.0, y: 5.0 },
        ),
        ..Default::default()
    }];
    let inp = input(vec![ent(Kind::Line, 0)], vec![0.0, 0.0, 0.0, 10.0], c);
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(
        r.len(),
        1,
        "point-on-line is one row, not point-to-point's two"
    );
    assert!((r[0] - (-3.0)).abs() < 1e-12, "residual: {}", r[0]);
}

#[test]
fn line_circle_tangent_residual() {
    // Line from (0,0) to (3,1), circle at (2,3) r=2.5.
    // Perpendicular distance from center to line = |2*1 - 3*3| / sqrt(10)
    // = 7 / sqrt(10). Residual = 7/sqrt(10) - 2.5.
    let abs = PointSelector::Absent;
    let c = vec![Constraint {
        kind_code: ConstraintKind::Tangent.to_u8(),
        refs: vec![
            (
                RefRole::Line,
                Ref::Entity {
                    index: 0,
                    point: abs,
                },
            ),
            (
                RefRole::Arc,
                Ref::Entity {
                    index: 1,
                    point: abs,
                },
            ),
        ],
        ..Default::default()
    }];
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
        vec![0.0, 0.0, 3.0, 1.0, 2.0, 3.0, 2.5],
        c,
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    let expected = 7.0 / (10.0_f64).sqrt() - 2.5;
    assert!(
        (r[0] - expected).abs() < 1e-12,
        "residual: {}, expected: {}",
        r[0],
        expected
    );
}

/// Normal between a line and a circle goes through `radius_dir` at the line
/// endpoint: the residual is the cross product of the line direction with
/// the unit radial direction there, and the FD-fallback Jacobian has a
/// matching row. No other test covers the mixed line/curve form.
#[test]
fn normal_between_line_and_circle_contributes_one_row() {
    // Line along +x from origin to (4,0); circle center (8,8) r=2. Contact
    // is the line end (4,0), radial direction (-4,-8)/sqrt(80), so the
    // residual is 4 * (-8/sqrt(80)).
    let absent = PointSelector::Absent;
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
        vec![0.0, 0.0, 4.0, 0.0, 8.0, 8.0, 2.0],
        vec![cons(
            ConstraintKind::Normal,
            ab(e_ref(0, absent), e_ref(1, absent)),
        )],
    );
    let p = Problem::new(&inp);
    let x = p.x0.clone();
    let n = x.len();
    let r = p.residuals(&x);
    assert_eq!(r.len(), 1);
    let expected = -32.0 / (80.0_f64).sqrt();
    assert!(
        (r[0] - expected).abs() < 1e-12,
        "normal line/circle: {}",
        r[0]
    );
    // The FD fallback for this kind must mirror the row count.
    assert_eq!(p.jacobian(&x, n).nrows(), 1);
}

/// Normal between a line and an ARC is keyed to the actual contact (the
/// line endpoint), not the arc's own angle params. Pinned at a
/// configuration where the two readings disagree on purpose: with start/end
/// angles 0..90deg an angle-keyed radial would be (1,0) and the residual a
/// false zero, while the contact-keyed radial is (0,-1).
#[test]
fn normal_between_line_and_arc_is_keyed_to_the_contact() {
    // Line along +x ending at (4,0); arc centre (4,8). The radial from the
    // centre to that contact is (0,-1), so cross(line_dir, radial) = -4.
    let absent = PointSelector::Absent;
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
        vec![0.0, 0.0, 4.0, 0.0, 4.0, 8.0, 2.0, 0.0, 90.0],
        vec![cons(
            ConstraintKind::Normal,
            ab(e_ref(0, absent), e_ref(1, absent)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - (-4.0)).abs() < 1e-12, "normal line/arc: {}", r[0]);
}

/// The contact collapsed onto the arc centre: `radius_dir` cannot divide,
/// so an arc falls back to the parametric radial named by its angle params.
/// With selector Absent that is the start angle; here 0deg means (1,0) and
/// the diagonal line direction gives cross = -5.
#[test]
fn normal_line_arc_degenerate_contact_uses_the_parametric_radial() {
    let absent = PointSelector::Absent;
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
        vec![0.0, 0.0, 5.0, 5.0, 5.0, 5.0, 2.0, 0.0, 90.0],
        vec![cons(
            ConstraintKind::Normal,
            ab(e_ref(0, absent), e_ref(1, absent)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!(r[0].is_finite(), "no NaN out of the degenerate contact");
    assert!((r[0] - (-5.0)).abs() < 1e-12, "normal degenerate: {}", r[0]);
}

// ─── line-arc tangent tests ───

/// Unpinned line-arc tangent: the line is nowhere near the arc's start/end
/// angles, but it IS tangent to the arc's underlying circle. The correct
/// residual is the perpendicular distance of the arc centre to the line
/// minus the arc radius -- identical to the unpinned line-circle case.
#[test]
fn line_arc_tangent_unpinned() {
    // Arc at (0,0) r=2, angles 0..180 (upper half). Horizontal line y=2
    // from (0,2) to (10,2): distance centre->line = 2 = radius -> tangent.
    let abs = PointSelector::Absent;
    let c = vec![Constraint {
        kind_code: ConstraintKind::Tangent.to_u8(),
        refs: vec![
            (
                RefRole::Line,
                Ref::Entity {
                    index: 0,
                    point: abs,
                },
            ),
            (
                RefRole::Arc,
                Ref::Entity {
                    index: 1,
                    point: abs,
                },
            ),
        ],
        ..Default::default()
    }];
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
        vec![0.0, 2.0, 10.0, 2.0, 0.0, 0.0, 2.0, 0.0, 180.0],
        c,
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    // centre (0,0) to horizontal line y=2: distance = 2, radius = 2 => zero
    assert!(
        r[0].abs() < 1e-12,
        "horizontal line y=2 tangent to arc r=2: {}",
        r[0]
    );
}

/// A line that is NOT tangent to the arc's circle yields a non-zero
/// residual. Uses a vertical line so the broken arc-start-angle path
/// cannot produce the correct result by accident.
#[test]
fn line_arc_tangent_not_tangent() {
    let abs = PointSelector::Absent;
    let c = vec![Constraint {
        kind_code: ConstraintKind::Tangent.to_u8(),
        refs: vec![
            (
                RefRole::Line,
                Ref::Entity {
                    index: 0,
                    point: abs,
                },
            ),
            (
                RefRole::Arc,
                Ref::Entity {
                    index: 1,
                    point: abs,
                },
            ),
        ],
        ..Default::default()
    }];
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
        // vertical line x=0, arc at (3,0) r=2: centre->line = 3, radius = 2 => offset 1
        vec![0.0, 0.0, 0.0, 10.0, 3.0, 0.0, 2.0, 0.0, 180.0],
        c,
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - 1.0).abs() < 1e-12, "offset 1: {}", r[0]);
}

/// Pinned line-circle tangency must measure the radial at whichever line
/// endpoint the coincident constraint actually pinned. Here that is the END,
/// so a correctly-tangent seed reads exactly 0; the inverted-selector bug
/// read the START instead (-3/sqrt(34) ~ -0.51 here) and drove LM off a
/// feasible pose.
#[test]
fn line_circle_tangent_honors_the_pinned_end() {
    // Circle at origin r=5; line from (5,-3) up to (5,0): its END sits on
    // the circle and the direction is vertical, i.e. perpendicular to the
    // radial at (5,0).
    let absent = PointSelector::Absent;
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
        vec![5.0, -3.0, 5.0, 0.0, 0.0, 0.0, 5.0],
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::End), e_ref(1, absent)),
            ),
            cons(
                ConstraintKind::Tangent,
                vec![
                    (RefRole::Line, e_ref(0, absent)),
                    (RefRole::Arc, e_ref(1, absent)),
                ],
            ),
        ],
    );
    let p = Problem::new(&inp);
    assert_eq!(
        p.line_circle_coincident.get(&(0, 1)),
        Some(&PointSelector::End)
    );
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    assert!(r[0].abs() < 1e-12, "coincident: {}", r[0]);
    assert!(r[1].abs() < 1e-12, "tangent at pinned END: {}", r[1]);
}

/// The mirrored pin side: the START endpoint is the one tied to the circle.
/// Reading the opposite foot again produced a phantom -3/sqrt(34).
#[test]
fn line_circle_tangent_honors_the_pinned_start() {
    // Same circle; the line runs DOWN from (5,0) so its START sits on it.
    let absent = PointSelector::Absent;
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Circle, 4)],
        vec![5.0, 0.0, 5.0, -3.0, 0.0, 0.0, 5.0],
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::Start), e_ref(1, absent)),
            ),
            cons(
                ConstraintKind::Tangent,
                vec![
                    (RefRole::Line, e_ref(0, absent)),
                    (RefRole::Arc, e_ref(1, absent)),
                ],
            ),
        ],
    );
    let p = Problem::new(&inp);
    assert_eq!(
        p.line_circle_coincident.get(&(0, 1)),
        Some(&PointSelector::Start)
    );
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    assert!(r[0].abs() < 1e-12, "coincident: {}", r[0]);
    assert!(r[1].abs() < 1e-12, "tangent at pinned START: {}", r[1]);
}

/// Pinned line-arc tangency with the contact MID-SWEEP (45 deg of a 0..90
/// arc): the radial there comes from the contact itself. The old arc arm
/// keyed the direction off the arc's stored start angle instead, ignoring
/// the contact entirely and reading -sqrt(2)/2 for this exact geometry.
#[test]
fn line_arc_tangent_honors_the_pinned_contact_mid_sweep() {
    let absent = PointSelector::Absent;
    let (c45, s45) = (45.0_f64.to_radians().cos(), 45.0_f64.to_radians().sin());
    // Arc centre origin r=5 sweeping 0..90 deg; the line's END is pinned at
    // the 45 deg point and the line runs along the tangent there.
    let end = [5.0 * c45, 5.0 * s45];
    let start = [end[0] + 3.0 * s45, end[1] - 3.0 * c45];
    let inp = input(
        vec![ent(Kind::Line, 0), ent(Kind::Arc, 4)],
        vec![
            start[0] as f32,
            start[1] as f32,
            end[0] as f32,
            end[1] as f32,
            0.0,
            0.0,
            5.0,
            0.0,
            90.0,
        ],
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::End), e_ref(1, absent)),
            ),
            cons(
                ConstraintKind::Tangent,
                vec![
                    (RefRole::Line, e_ref(0, absent)),
                    (RefRole::Arc, e_ref(1, absent)),
                ],
            ),
        ],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2);
    // The 45 deg contact only survives the f32 param buffer to ~1e-9.
    assert!(r[0].abs() < 1e-7, "coincident: {}", r[0]);
    assert!(r[1].abs() < 1e-7, "tangent at mid-sweep contact: {}", r[1]);
}

/// End-to-end shape of the bug: a sketch already satisfying its pinned
/// tangency must solve as a no-op. Driving away (or reporting
/// Overconstrained from a phantom residual) locked a correct drawing.
#[test]
fn solve_from_a_pinned_tangent_seed_stays_put() {
    let absent = PointSelector::Absent;
    let mk = |line_params: [f32; 4], curve_params: Vec<f32>, curve: Kind| {
        input(
            vec![ent(Kind::Line, 0), ent(curve, 4)],
            [line_params.as_slice(), &curve_params].concat(),
            vec![
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(0, PointSelector::End), e_ref(1, absent)),
                ),
                cons(
                    ConstraintKind::Tangent,
                    vec![
                        (RefRole::Line, e_ref(0, absent)),
                        (RefRole::Arc, e_ref(1, absent)),
                    ],
                ),
            ],
        )
    };
    let circle_case = mk([5.0, -3.0, 5.0, 0.0], vec![0.0, 0.0, 5.0], Kind::Circle);
    let arc_case = mk(
        [
            (5.0 * 45.0_f64.to_radians().cos() + 3.0 * 45.0_f64.to_radians().sin()) as f32,
            (5.0 * 45.0_f64.to_radians().sin() - 3.0 * 45.0_f64.to_radians().cos()) as f32,
            (5.0 * 45.0_f64.to_radians().cos()) as f32,
            (5.0 * 45.0_f64.to_radians().sin()) as f32,
        ],
        vec![0.0, 0.0, 5.0, 0.0, 90.0],
        Kind::Arc,
    );
    for (name, inp) in [("circle", circle_case), ("arc", arc_case)] {
        let out = solve_sketch(&inp);
        assert_ne!(
            out.overall_status,
            Status::Overconstrained.to_u8(),
            "{name}: a tangent seed must not read overconstrained"
        );
        assert!(
            out.diagnostics.residual_norm < 1e-6,
            "{name}: residual {} at an already-feasible seed",
            out.diagnostics.residual_norm
        );
        for (i, (got, want)) in out
            .params_solved
            .iter()
            .zip(&inp.params_initial)
            .enumerate()
        {
            assert!(
                (*got as f64 - *want as f64).abs() < 1e-3,
                "{name}: param {i} moved from {want} to {got}"
            );
        }
    }
}

#[test]
fn arc_endpoint_get_point_uses_radius_and_angle() {
    // Arc center (0,0) r=2, start angle 90deg -> start point (0,2).
    let inp = input(
        vec![ent(Kind::Arc, 0)],
        vec![0.0, 0.0, 2.0, 90.0, 180.0],
        vec![],
    );
    let p = Problem::new(&inp);
    let pt = p.point(
        &p.x0.clone(),
        Ref::Entity {
            index: 0,
            point: PointSelector::Start,
        },
    );
    assert!((pt[0] - 0.0).abs() < 1e-9, "x={}", pt[0]);
    assert!((pt[1] - 2.0).abs() < 1e-9, "y={}", pt[1]);
}
