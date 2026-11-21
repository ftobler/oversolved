use super::*;
use crate::fit_spline::{FLAG_HANDLE_END, FLAG_HANDLE_START, HANDLE_FLAGS};

/// A `fit_spline` entity record with the layout its params imply.
fn fit_entity(off: usize, points: usize, flags: u8) -> Entity {
    let handles = (flags & 1 != 0) as usize + (flags & 2 != 0) as usize;
    Entity {
        kind: Kind::FitSpline,
        param_offset: off,
        param_count: 2 * points + 2 * handles,
        flags,
    }
}

fn abs() -> PointSelector {
    PointSelector::Absent
}

fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn unit(v: [f64; 2]) -> [f64; 2] {
    let n = v[0].hypot(v[1]).max(1e-12);
    [v[0] / n, v[1] / n]
}

#[test]
fn r1_arc_end_tangent_to_a_fit_spline_start_rotates_the_handle() {
    // Arc centre origin r5 ending at (0,5); the fit spline starts there with a
    // start handle pointing (1,1). Everything but the handle is pinned, so the
    // only way to satisfy the tangent is to rotate the handle onto the arc's
    // horizontal tangent at that point.
    let mut params = vec![
        0.0, 5.0, // fit start
        1.0, 6.0, // fit point
        2.0, 7.0, // fit point
        3.0, 8.0, // fit end
        3.0, 8.0, // start handle
    ];
    params.extend_from_slice(&[0.0, 0.0, 5.0, 0.0, 90.0]);
    let fit = fit_entity(0, 4, FLAG_HANDLE_START);
    let arc = ent(Kind::Arc, 10);
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::Start), e_ref(1, PointSelector::End)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(1, abs()), e_ref(0, PointSelector::Start)),
        ),
    ];
    let mut inp = input(vec![fit, arc], params, constraints);
    // Pin params 0..8 (fit points) and 10..15 (the whole arc); only the start
    // handle at 8..10 is free.
    let mut mask = vec![0u8; inp.params_initial.len().div_ceil(8)];
    for i in (0..8).chain(10..15) {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "tangent not satisfied: {}",
        out.diagnostics.residual_norm
    );
    // The fit points held, and the handle turned from (1,1) to horizontal.
    for (i, want) in [0.0, 5.0, 1.0, 6.0, 2.0, 7.0, 3.0, 8.0].iter().enumerate() {
        assert!(
            (out.params_solved[i] - want).abs() < 1e-6,
            "fit point {i} moved to {}",
            out.params_solved[i]
        );
    }
    assert!(
        (out.params_solved[9] - 8.0).abs() > 1e-6,
        "the start handle did not rotate: {:?}",
        &out.params_solved[8..10]
    );
    let start = [out.params_solved[0], out.params_solved[1]];
    let handle = [out.params_solved[8], out.params_solved[9]];
    let tan = unit([handle[0] - start[0], handle[1] - start[1]]);
    // Arc radial at its end (0,5) is (0,1); the tangent must be perpendicular.
    assert!(
        dot(tan, [0.0, 1.0]).abs() < 1e-6,
        "spline start tangent {tan:?} is not perpendicular to the radial"
    );
}

#[test]
fn r2_spline_end_into_an_arc_start_solves_the_same_joint() {
    // The mirrored joint: the spline END is the contact, the arc START is the
    // other operand, and the constraint is written spline-first.
    let mut params = vec![
        -2.0, -1.0, // fit start
        -1.0, -2.0, // fit point
        -0.5, -3.0, // fit point
        0.0, 0.0, // fit end
        3.0, 3.0, // end handle
    ];
    // Arc centre (5,0) r5 starting at (0,0) with start angle 180.
    params.extend_from_slice(&[5.0, 0.0, 5.0, 180.0, 270.0]);
    let fit = fit_entity(0, 4, FLAG_HANDLE_END);
    let arc = ent(Kind::Arc, 10);
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(1, PointSelector::Start), e_ref(0, PointSelector::End)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, abs()), e_ref(1, abs())),
        ),
    ];
    let mut inp = input(vec![fit, arc], params, constraints);
    let mut mask = vec![0u8; inp.params_initial.len().div_ceil(8)];
    // Fit points 0..8 and the whole arc 10..15 are pinned; 8..10 is the handle.
    for i in (0..8).chain(10..15) {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "tangent not satisfied: {}",
        out.diagnostics.residual_norm
    );
    let end = [out.params_solved[6], out.params_solved[7]];
    let handle = [out.params_solved[8], out.params_solved[9]];
    let tan = unit([handle[0] - end[0], handle[1] - end[1]]);
    // The arc start (0,0) has radial (-1,0), so the spline tangent is vertical.
    assert!(
        dot(tan, [-1.0, 0.0]).abs() < 1e-6,
        "spline end tangent {tan:?} is not perpendicular to the radial"
    );
    assert!(
        (out.params_solved[8] - 3.0).abs() > 1e-6 || (out.params_solved[9] - 3.0).abs() > 1e-6,
        "the end handle did not rotate: {:?}",
        &out.params_solved[8..10]
    );
}

#[test]
fn r3_a_cubic_spline_start_tangent_to_an_arc() {
    // Bezier arm: P2 - P1 is horizontal, so the start tangent is perpendicular
    // to the arc's radial at the shared point. Moving P2 off the axis breaks it.
    let mut params = vec![0.0, 0.0, 5.0, 0.0, 90.0];
    params.extend_from_slice(&[0.0, 5.0, 3.0, 5.0, 3.0, 8.0, 0.0, 8.0]);
    let arc = ent(Kind::Arc, 0);
    let spline = spline(5);
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(1, PointSelector::Start), e_ref(0, PointSelector::End)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, abs()), e_ref(1, PointSelector::Start)),
        ),
    ];
    let inp = input(vec![arc, spline], params, constraints);
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 3, "coincident 2 rows, tangent 1");
    assert!(r[2].abs() < 1e-12, "seed tangent row: {}", r[2]);

    let mut x = p.x0.clone();
    x[8] = 6.0; // P2 y
    let r = p.residuals(&x);
    assert!(
        r[2].abs() > 1e-3,
        "moving P2 off the tangent left the row at {}",
        r[2]
    );
}

#[test]
fn r4_two_fit_splines_at_a_shared_endpoint_are_g1() {
    // A's end handle is pinned at (2,1); B's start handle is free, so the row
    // must turn B's handle until the two end tangents are parallel.
    let mut params = vec![
        -2.0, -1.0, // A start
        -1.0, -2.0, // A fit
        0.0, 0.0, // A end
        2.0, 1.0, // A end handle
    ];
    params.extend_from_slice(&[
        0.0, 0.0, // B start
        1.0, 2.0, // B fit
        2.0, 1.0, // B end
        3.0, 3.0, // B start handle
    ]);
    let a = fit_entity(0, 3, FLAG_HANDLE_END);
    let b = fit_entity(8, 3, FLAG_HANDLE_START);
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::End), e_ref(1, PointSelector::Start)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, abs()), e_ref(1, abs())),
        ),
    ];
    let mut inp = input(vec![a, b], params, constraints);
    let mut mask = vec![0u8; inp.params_initial.len().div_ceil(8)];
    // Everything pinned except B's start handle (params 14..16).
    for i in 0..14 {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "G1 not satisfied: {}",
        out.diagnostics.residual_norm
    );
    let a_end = [out.params_solved[4], out.params_solved[5]];
    let a_handle = [out.params_solved[6], out.params_solved[7]];
    let b_start = [out.params_solved[8], out.params_solved[9]];
    let b_handle = [out.params_solved[14], out.params_solved[15]];
    let ta = unit([a_handle[0] - a_end[0], a_handle[1] - a_end[1]]);
    let tb = unit([b_handle[0] - b_start[0], b_handle[1] - b_start[1]]);
    assert!(
        cross(ta, tb).abs() < 1e-6,
        "end tangents {ta:?} and {tb:?} are not parallel"
    );
    assert!(
        (out.params_solved[14] - 3.0).abs() > 1e-6 || (out.params_solved[15] - 3.0).abs() > 1e-6,
        "B's handle did not rotate: {:?}",
        &out.params_solved[14..16]
    );
}

#[test]
fn r5_a_fit_spline_end_on_a_circle_locus_tangent() {
    // The spline end sits on the circle r5 at (5,0) with a handle pointing
    // (1,1); the solve turns it onto the circle's vertical tangent there.
    let mut params = vec![
        -2.0, 0.0, // fit start
        -1.0, 0.0, // fit point
        5.0, 0.0, // fit end
        7.0, 2.0, // end handle
    ];
    params.extend_from_slice(&[0.0, 0.0, 5.0]);
    let fit = fit_entity(0, 3, FLAG_HANDLE_END);
    let circle = ent(Kind::Circle, 8);
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::End), e_ref(1, abs())),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, abs()), e_ref(1, abs())),
        ),
    ];
    let mut inp = input(vec![fit, circle], params, constraints);
    let mut mask = vec![0u8; inp.params_initial.len().div_ceil(8)];
    for i in (0..6).chain(8..11) {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "tangent not satisfied: {}",
        out.diagnostics.residual_norm
    );
    let end = [out.params_solved[4], out.params_solved[5]];
    let handle = [out.params_solved[6], out.params_solved[7]];
    let tan = unit([handle[0] - end[0], handle[1] - end[1]]);
    let radial = unit([end[0] - out.params_solved[8], end[1] - out.params_solved[9]]);
    assert!(
        dot(radial, tan).abs() < 1e-6,
        "end tangent {tan:?} is not perpendicular to the radial {radial:?}"
    );
}

#[test]
fn r6_a_near_tangent_seed_settles_g1_not_a_cusp() {
    // Ten degrees off the circle tangent, on the up side: the row must settle
    // the same sense, not turn the handle through 90 degrees onto the cusp.
    let (s, c) = 10.0_f64.to_radians().sin_cos();
    let mut params = vec![
        -2.0,
        0.0,
        -1.0,
        0.0,
        5.0,
        0.0,
        5.0 + 2.0 * c,
        2.0 * s, // end handle, 10 degrees off vertical
    ];
    params.extend_from_slice(&[0.0, 0.0, 5.0]);
    let fit = fit_entity(0, 3, FLAG_HANDLE_END);
    let circle = ent(Kind::Circle, 8);
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::End), e_ref(1, abs())),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, abs()), e_ref(1, abs())),
        ),
    ];
    let mut inp = input(vec![fit, circle], params, constraints);
    let mut mask = vec![0u8; inp.params_initial.len().div_ceil(8)];
    for i in (0..6).chain(8..11) {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
    let out = solve_sketch(&inp);
    assert!(out.diagnostics.residual_norm < 1e-8);
    let end = [out.params_solved[4], out.params_solved[5]];
    let handle = [out.params_solved[6], out.params_solved[7]];
    let tan = unit([handle[0] - end[0], handle[1] - end[1]]);
    assert!(
        dot(tan, [1.0, 0.0]).abs() < 1e-6,
        "tangent {tan:?} is not vertical"
    );
    assert!(
        tan[1] > 0.0,
        "the solve flipped the handle into a cusp: {tan:?}"
    );
}

/// R7's shared profile: a line from the origin, an r50 arc from its end, and a
/// four-point fit spline from the arc end with both handles.
fn vase_profile() -> (Vec<Entity>, Vec<f64>) {
    let params = vec![
        0.0, 0.0, // 0: origin point
        0.0, 0.0, 10.0, 0.0, // 2: line
        10.0, 50.0, 50.0, 270.0, 0.0, // 6: arc, start (10,0), end (60,50)
        60.0, 50.0, // 11: fit start
        65.0, 55.0, // 13: fit interior
        70.0, 52.0, // 15: fit interior
        75.0, 45.0, // 17: fit end
        55.0, 45.0, // 19: start handle
        80.0, 40.0, // 21: end handle
    ];
    (
        vec![
            ent(Kind::Point, 0),
            ent(Kind::Line, 2),
            ent(Kind::Arc, 6),
            fit_entity(11, 4, HANDLE_FLAGS),
        ],
        params,
    )
}

fn dimension_to_origin(index: u32, point: PointSelector, x: f64, y: f64) -> Vec<Constraint> {
    let origin = e_ref(0, PointSelector::Xy);
    vec![
        cons_vs(
            ConstraintKind::PointDistanceX,
            ab(origin, e_ref(index, point)),
            x,
            1.0,
        ),
        cons_vs(
            ConstraintKind::PointDistanceY,
            ab(origin, e_ref(index, point)),
            y,
            1.0,
        ),
    ]
}

fn vase_constraints() -> Vec<Constraint> {
    let mut c = vec![
        c_target(ConstraintKind::Fixed, 0, PointSelector::Xy),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(1, PointSelector::Start), e_ref(0, PointSelector::Xy)),
        ),
        c_target(ConstraintKind::Horizontal, 1, PointSelector::Absent),
        cons_v(
            ConstraintKind::Length,
            vec![(RefRole::Target, e_ref(1, abs()))],
            10.0,
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(1, PointSelector::End), e_ref(2, PointSelector::Start)),
        ),
        cons_v(
            ConstraintKind::Radius,
            vec![(RefRole::Target, e_ref(2, abs()))],
            50.0,
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(2, PointSelector::End), e_ref(3, PointSelector::Start)),
        ),
    ];
    c.extend(dimension_to_origin(3, PointSelector::Start, 60.0, 50.0));
    c.extend(dimension_to_origin(3, PointSelector::Fit(1), 65.0, 55.0));
    c.extend(dimension_to_origin(3, PointSelector::Fit(2), 70.0, 52.0));
    c.extend(dimension_to_origin(3, PointSelector::End, 75.0, 45.0));
    c
}

fn vase_with(constraints: Vec<Constraint>) -> Input {
    let (entities, params) = vase_profile();
    input(entities, params, constraints)
}

#[test]
fn r7_a_tangent_plus_handle_dimensions_close_the_vase_joint() {
    let tangent = cons(
        ConstraintKind::Tangent,
        ab(e_ref(2, abs()), e_ref(3, abs())),
    );
    let handle_len = cons_v(
        ConstraintKind::PointDistance,
        ab(e_ref(3, PointSelector::Start), e_ref(3, PointSelector::C1)),
        5.0,
    );

    let base = vase_constraints();
    let out = solve_sketch(&vase_with(base.clone()));
    assert_eq!(
        out.diagnostics.dof, 4,
        "before the tangent the two handles hold four DOF, got {}",
        out.diagnostics.dof
    );

    let mut cs = base.clone();
    cs.push(tangent.clone());
    let out = solve_sketch(&vase_with(cs.clone()));
    assert_eq!(out.diagnostics.dof, 3, "the tangent removes one DOF");

    cs.push(handle_len.clone());
    let out = solve_sketch(&vase_with(cs.clone()));
    assert_eq!(out.diagnostics.dof, 2, "the handle length removes one DOF");

    cs.extend(dimension_to_origin(3, PointSelector::C2, 80.0, 40.0));
    let out = solve_sketch(&vase_with(cs));
    assert_eq!(
        out.diagnostics.dof, 0,
        "the profile should be fully constrained"
    );
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(
        out.constraint_flags
            .iter()
            .filter(|f| **f & crate::CONSTRAINT_FLAG_REDUNDANT != 0)
            .count(),
        0,
        "no row should be redundant"
    );
}

#[test]
fn r8_dimensioning_a_tangent_pinned_handle_is_reported() {
    // The tangent fixes c1's direction and the handle-length dimension fixes its
    // scalars, so absolute x/y dimensions on c1 have no independent row. They
    // must be named as redundant or conflicting, not silently satisfied.
    let mut cs = vase_constraints();
    cs.push(cons(
        ConstraintKind::Tangent,
        ab(e_ref(2, abs()), e_ref(3, abs())),
    ));
    cs.push(cons_v(
        ConstraintKind::PointDistance,
        ab(e_ref(3, PointSelector::Start), e_ref(3, PointSelector::C1)),
        5.0,
    ));
    let c1 = cons_vs(
        ConstraintKind::PointDistanceX,
        ab(e_ref(0, PointSelector::Xy), e_ref(3, PointSelector::C1)),
        60.0,
        1.0,
    );
    cs.push(c1.clone());
    let out = solve_sketch(&vase_with(cs.clone()));
    assert_ne!(
        out.overall_status,
        Status::Overconstrained.to_u8(),
        "one absolute c1 x leaves the end handle free"
    );
    cs.push(cons_vs(
        ConstraintKind::PointDistanceY,
        ab(e_ref(0, PointSelector::Xy), e_ref(3, PointSelector::C1)),
        55.0,
        1.0,
    ));
    let out = solve_sketch(&vase_with(cs));
    let later = out.constraint_flags.last().copied().unwrap_or(0);
    assert!(
        out.overall_status == Status::Overconstrained.to_u8()
            || later & crate::CONSTRAINT_FLAG_REDUNDANT != 0,
        "the later c1 dimension vanished: status {}, flags {:?}",
        out.overall_status,
        out.constraint_flags
    );
}

#[test]
fn r9_the_spline_tangent_row_is_a_length() {
    // Same joint at 1x and 10x: the row is a sine times the seed length, so it
    // scales with the sketch exactly as the circle/arc contact row does.
    let build = |s: f64| {
        let mut params = vec![-2.0 * s, 0.0, -s, 0.0, 5.0 * s, 0.0, 7.0 * s, 2.0 * s];
        params.extend_from_slice(&[0.0, 0.0, 5.0 * s]);
        input(
            vec![fit_entity(0, 3, FLAG_HANDLE_END), ent(Kind::Circle, 8)],
            params,
            vec![
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(0, PointSelector::End), e_ref(1, abs())),
                ),
                cons(
                    ConstraintKind::Tangent,
                    ab(e_ref(0, abs()), e_ref(1, abs())),
                ),
            ],
        )
    };
    let row = |s: f64| {
        let inp = build(s);
        let p = Problem::new(&inp);
        let r = p.residuals(&p.x0);
        assert_eq!(r.len(), 2, "locus coincident 1 row, tangent 1");
        r[1]
    };
    let base = row(1.0);
    assert!(base.abs() > 0.1, "unexpectedly zero seed row: {base}");
    let scaled = row(10.0);
    assert!(
        (scaled - 10.0 * base).abs() < 1e-6,
        "scaled row {scaled} from {base}"
    );
}

#[test]
fn r10_a_spline_tangent_without_a_contact_is_dropped() {
    let mut params = vec![-2.0, 0.0, -1.0, 0.0, 5.0, 0.0, 7.0, 2.0];
    params.extend_from_slice(&[0.0, 0.0, 5.0]);
    let inp = input(
        vec![fit_entity(0, 3, FLAG_HANDLE_END), ent(Kind::Circle, 8)],
        params,
        vec![cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, abs()), e_ref(1, abs())),
        )],
    );
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 0, "a free spline tangent has no row");
    assert!(p.residuals(&p.x0).is_empty());

    let out = solve_sketch(&inp);
    assert_ne!(
        out.overall_status,
        Status::Overconstrained.to_u8(),
        "a dropped tangent must not fail the solve"
    );
    assert_ne!(
        out.constraint_flags[0] & crate::CONSTRAINT_FLAG_DROPPED,
        0,
        "the drop must be reported"
    );
}

#[test]
fn the_admitted_tangent_pairs_match_the_frontend_table() {
    // Keep this literal table in step with TANGENT_KIND_PAIRS in
    // frontend/src/utils/constraintApplicability.ts.
    let admitted = [
        (Kind::Line, Kind::Circle),
        (Kind::Line, Kind::Arc),
        (Kind::Line, Kind::Ellipse),
        (Kind::Line, Kind::Spline),
        (Kind::Line, Kind::FitSpline),
        (Kind::Circle, Kind::Arc),
        (Kind::Circle, Kind::Circle),
        (Kind::Arc, Kind::Arc),
        (Kind::Circle, Kind::Spline),
        (Kind::Circle, Kind::FitSpline),
        (Kind::Arc, Kind::Spline),
        (Kind::Arc, Kind::FitSpline),
        (Kind::Spline, Kind::Spline),
        (Kind::Spline, Kind::FitSpline),
        (Kind::FitSpline, Kind::FitSpline),
    ];
    for (a, b) in admitted {
        assert!(
            tangent_pair_kinds_admitted(a, b),
            "{a:?} x {b:?} should be admitted"
        );
        assert!(
            tangent_pair_kinds_admitted(b, a),
            "{b:?} x {a:?} should be admitted"
        );
    }
    for (a, b) in [
        (Kind::Ellipse, Kind::Circle),
        (Kind::Ellipse, Kind::Arc),
        (Kind::Ellipse, Kind::Spline),
        (Kind::Point, Kind::Line),
    ] {
        assert!(
            !tangent_pair_kinds_admitted(a, b),
            "{a:?} x {b:?} should be refused"
        );
    }
}
