use super::*;

#[test]
fn horizontal_and_length_residuals_on_known_line() {
    // Line from (0,0) to (10,1).
    let c = vec![
        Constraint {
            kind_code: ConstraintKind::Horizontal.to_u8(),
            refs: vec![target(0, PointSelector::Absent)],
            ..Default::default()
        },
        Constraint {
            kind_code: ConstraintKind::Length.to_u8(),
            refs: vec![target(0, PointSelector::Absent)],
            value: Some(10.0),
            ..Default::default()
        },
    ];
    let inp = input(vec![ent(Kind::Line, 0)], vec![0.0, 0.0, 10.0, 1.0], c);
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert!((r[0] - 1.0).abs() < 1e-12, "horizontal: {}", r[0]);
    assert!(
        (r[1] - (101.0_f64.sqrt() - 10.0)).abs() < 1e-12,
        "length: {}",
        r[1]
    );
}

#[test]
fn constraint_with_out_of_range_entity_ref_is_dropped() {
    // A stale index the host never revoked: index 3 with one entity. The
    // constraint contributes no rows instead of panicking the Worker.
    let inp = input(
        vec![ent(Kind::Line, 0)],
        vec![0.0, 0.0, 10.0, 1.0],
        vec![
            cons(
                ConstraintKind::Horizontal,
                vec![target(0, PointSelector::Absent)],
            ),
            cons(
                ConstraintKind::Horizontal,
                vec![target(3, PointSelector::Absent)],
            ),
        ],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(
        r.len(),
        1,
        "only the addressable constraint contributes a row"
    );
    assert!((r[0] - 1.0).abs() < 1e-12);
}

#[test]
fn r_coincident_with_a_non_entity_ref_does_not_panic() {
    // A role that is not an entity ref leaves the index/kind option empty;
    // the builder must fall through to the point-point arm rather than
    // unwrap, even when called directly with an unfiltered constraint.
    let inp = input(vec![ent(Kind::Point, 0)], vec![3.0, 4.0], vec![]);
    let p = Problem::new(&inp);
    let c = cons(
        ConstraintKind::Coincident,
        ab(
            Ref::External { x: 1.0, y: 2.0 },
            e_ref(0, PointSelector::Absent),
        ),
    );
    let mut r = Vec::new();
    p.r_coincident(&c, &p.x0, &mut r);
    assert_eq!(r.len(), 2, "one x and one y residual row");
}

#[test]
fn constraint_on_entity_whose_params_overrun_the_buffer_is_dropped() {
    // The index resolves but the entity's 4 line params run past the 3-param
    // buffer: the params slice would panic, so the constraint goes too.
    let inp = input(
        vec![ent(Kind::Line, 0)],
        vec![0.0, 0.0, 10.0],
        vec![cons(
            ConstraintKind::Horizontal,
            vec![target(0, PointSelector::Absent)],
        )],
    );
    let p = Problem::new(&inp);
    assert!(p.residuals(&p.x0).is_empty());
}

/// A well-formed but wrong-kind operand reaches the worker verbatim from
/// postMessage (decode_input does not kind-check). Each payload below made
/// its builder index past a short param block before the centralized
/// eligibility filter existed; each must now be dropped whole: no residual
/// rows and, because both analytic and finite-difference Jacobians are
/// built from the same filtered list, no Jacobian rows either.
#[test]
fn constraints_whose_operand_kind_lacks_the_read_slots_are_dropped() {
    use RefRole::{Arc as ArcR, Line as LineR};
    let absent = PointSelector::Absent;
    // Shared fixture: point P0 [0..2], circle C1 [2..5], line L2 [5..9].
    let entities = || {
        vec![
            ent(Kind::Point, 0),
            ent(Kind::Circle, 2),
            ent(Kind::Line, 5),
        ]
    };
    let params = || vec![1.0, 2.0, 5.0, 5.0, 1.0, 0.0, 0.0, 4.0, 0.0];
    let payloads: Vec<(&str, Constraint)> = vec![
        (
            "horizontal target point",
            cons(ConstraintKind::Horizontal, vec![target(0, absent)]),
        ),
        (
            "length target point",
            cons_v(ConstraintKind::Length, vec![target(0, absent)], 3.0),
        ),
        (
            "radius target point",
            cons_v(ConstraintKind::Radius, vec![target(0, absent)], 1.0),
        ),
        (
            "diameter target point",
            cons_v(ConstraintKind::Diameter, vec![target(0, absent)], 2.0),
        ),
        (
            "line_distance circle as line",
            cons_v(
                ConstraintKind::LineDistance,
                ab(e_ref(1, absent), e_ref(0, PointSelector::Xy)),
                1.0,
            ),
        ),
        (
            "angle circle vs point",
            cons_v(
                ConstraintKind::Angle,
                ab(e_ref(1, absent), e_ref(0, absent)),
                30.0,
            ),
        ),
        (
            "midpoint point in line role",
            cons(
                ConstraintKind::Midpoint,
                vec![
                    (LineR, e_ref(0, absent)),
                    (RefRole::Point, e_ref(2, PointSelector::Start)),
                ],
            ),
        ),
        // The reported trigger: A=Point is not a line, so dispatch falls
        // through to curve/curve and reads the point's slot-2 radius.
        (
            "tangent point circle",
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(0, absent), e_ref(1, absent)),
            ),
        ),
        (
            "tangent explicit roles on wrong kinds",
            cons(
                ConstraintKind::Tangent,
                vec![(LineR, e_ref(1, absent)), (ArcR, e_ref(0, absent))],
            ),
        ),
        (
            "normal point line",
            cons(
                ConstraintKind::Normal,
                ab(e_ref(0, absent), e_ref(2, absent)),
            ),
        ),
        (
            "normal two circles",
            cons(
                ConstraintKind::Normal,
                ab(e_ref(1, absent), e_ref(1, absent)),
            ),
        ),
    ];
    for (name, c) in payloads {
        let inp = input(entities(), params(), vec![c]);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        assert!(
            p.residuals(&x).is_empty(),
            "{name}: wrong-kind operand must drop the whole constraint"
        );
        assert_eq!(
            p.jacobian(&x, n).nrows(),
            0,
            "{name}: Jacobian rows must match the dropped residual"
        );
    }
}

/// The count check alone is not enough: an arc or ellipse supplies the
/// slots a line/curve builder reads but the values mean something else (an
/// arc's slot 2 is its radius, not an endpoint x). These payloads have
/// enough params and are dropped only by the kind-aware pass.
#[test]
fn constraints_with_wrong_kind_but_enough_slots_are_dropped() {
    use RefRole::Line as LineR;
    let absent = PointSelector::Absent;
    // line [0..4], arc [4..9], circle [9..12], ellipse [12..17].
    let entities = || {
        vec![
            ent(Kind::Line, 0),
            ent(Kind::Arc, 4),
            ent(Kind::Circle, 9),
            ent(Kind::Ellipse, 12),
        ]
    };
    let params = || {
        vec![
            0.0, 0.0, 4.0, 0.0, // line
            0.0, 0.0, 3.0, 0.0, 90.0, // arc
            0.0, 0.0, 2.0, // circle
            0.0, 0.0, 5.0, 3.0, 0.0, // ellipse
        ]
    };
    let payloads: Vec<(&str, Constraint)> = vec![
        (
            "radius on a line reads end.x",
            cons_v(ConstraintKind::Radius, vec![target(0, absent)], 1.0),
        ),
        (
            "diameter on a line reads end.x",
            cons_v(ConstraintKind::Diameter, vec![target(0, absent)], 2.0),
        ),
        (
            "length on an ellipse reads a and b",
            cons_v(ConstraintKind::Length, vec![target(3, absent)], 3.0),
        ),
        (
            "angle with an arc operand reads radius and angle",
            cons_v(
                ConstraintKind::Angle,
                ab(e_ref(0, absent), e_ref(1, absent)),
                30.0,
            ),
        ),
        (
            "tangent ellipse and circle reads the semi-major axis as radius",
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(3, absent), e_ref(2, absent)),
            ),
        ),
        (
            "line_distance with an arc in the line role",
            cons_v(
                ConstraintKind::LineDistance,
                ab(e_ref(1, absent), e_ref(2, PointSelector::Center)),
                1.0,
            ),
        ),
        (
            "midpoint with an arc in the line role",
            cons(
                ConstraintKind::Midpoint,
                vec![
                    (LineR, e_ref(1, absent)),
                    (RefRole::Point, e_ref(2, PointSelector::Center)),
                ],
            ),
        ),
    ];
    for (name, c) in payloads {
        let inp = input(entities(), params(), vec![c]);
        let p = Problem::new(&inp);
        let x = p.x0.clone();
        let n = x.len();
        assert!(
            p.residuals(&x).is_empty(),
            "{name}: wrong-kind operand must drop the whole constraint"
        );
        assert_eq!(
            p.jacobian(&x, n).nrows(),
            0,
            "{name}: Jacobian rows must match the dropped residual"
        );
    }
}

/// The end-to-end shape of the bug: one postMessage carrying wrong-kind
/// operands must not trap the wasm worker; the sketch solves with those
/// constraints silently dropped.
#[test]
fn wrong_kind_payload_solves_instead_of_panicking() {
    let absent = PointSelector::Absent;
    let inp = input(
        vec![
            ent(Kind::Point, 0),
            ent(Kind::Circle, 2),
            ent(Kind::Line, 5),
        ],
        vec![1.0, 2.0, 5.0, 5.0, 1.0, 0.0, 0.0, 4.0, 0.0],
        vec![
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(0, absent), e_ref(1, absent)),
            ),
            cons(
                ConstraintKind::Normal,
                ab(e_ref(0, absent), e_ref(2, absent)),
            ),
            cons_v(ConstraintKind::Length, vec![target(0, absent)], 3.0),
            cons_v(
                ConstraintKind::Angle,
                ab(e_ref(1, absent), e_ref(0, absent)),
                30.0,
            ),
        ],
    );
    let out = solve_sketch(&inp);
    // Every constraint was dropped, so nothing is constrained at all and
    // the stacked residual is exactly empty.
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.diagnostics.residual_norm, 0.0);
}

#[test]
fn equality_pin_past_the_param_buffer_is_dropped() {
    let mut inp = input(vec![ent(Kind::Point, 0)], vec![1.0, 2.0], vec![]);
    inp.equality_pins = vec![
        EqualityPin {
            param_index: 1,
            target: 5.0,
        },
        EqualityPin {
            param_index: 9,
            target: 5.0,
        },
    ];
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1, "only the in-range pin contributes a row");
    assert!((r[0] - (2.0 - 5.0)).abs() < 1e-12);
}

#[test]
fn horizontal_a_b_equalizes_y_of_two_points() {
    // Two points at (0,0) and (5,3). Horizontal a/b residual = pa.y - pb.y = -3.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 5.0, 3.0],
        vec![cons(
            ConstraintKind::Horizontal,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - (-3.0)).abs() < 1e-12, "horizontal a/b: {}", r[0]);
}

#[test]
fn vertical_a_b_equalizes_x_of_two_points() {
    // Two points at (0,0) and (5,3). Vertical a/b residual = pa.x - pb.x = -5.
    let inp = input(
        vec![ent(Kind::Point, 0), ent(Kind::Point, 2)],
        vec![0.0, 0.0, 5.0, 3.0],
        vec![cons(
            ConstraintKind::Vertical,
            ab(e_ref(0, PointSelector::Xy), e_ref(1, PointSelector::Xy)),
        )],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 1);
    assert!((r[0] - (-5.0)).abs() < 1e-12, "vertical a/b: {}", r[0]);
}
