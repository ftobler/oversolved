use super::*;
use crate::constraints::{Constraint, PointSelector, Ref, RefRole};
use crate::{solve_sketch, ConstraintKind, Kind, Status};

/// One wire group constraint: `target` is the held member, `a` the anchor point
/// the translation is measured from.
fn group(member: u32, anchor: u32, anchor_point: PointSelector) -> Constraint {
    cons(
        ConstraintKind::Group,
        vec![
            target(member, PointSelector::Absent),
            (RefRole::A, e_ref(anchor, anchor_point)),
        ],
    )
}

/// One wire group constraint over a point member: only that point is held.
fn point_group(
    member: u32,
    member_point: PointSelector,
    anchor: u32,
    anchor_point: PointSelector,
) -> Constraint {
    cons(
        ConstraintKind::Group,
        vec![
            target(member, member_point),
            (RefRole::A, e_ref(anchor, anchor_point)),
        ],
    )
}

/// A line (anchor, params 0..4) and a circle (params 4..7) held as one group.
fn line_and_circle(params: Vec<f64>) -> Input {
    input(
        vec![line(0), ent(Kind::Circle, 4)],
        params,
        vec![
            group(0, 0, PointSelector::Start),
            group(1, 0, PointSelector::Start),
        ],
    )
}

#[test]
fn a_satisfied_group_solve_moves_nothing_and_leaves_two_dof() {
    let params = vec![0.0, 0.0, 10.0, 0.0, 4.0, 3.0, 2.5];
    let out = solve_sketch(&line_and_circle(params.clone()));
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    // Seven params minus the group's five rows: the whole group keeps only its
    // two translations.
    assert_eq!(out.diagnostics.dof, 2);
    for (got, want) in out.params_solved.iter().zip(&params) {
        assert!(
            (got - want).abs() < 1e-9,
            "group moved geometry: {got} vs {want}"
        );
    }
}

#[test]
fn a_coincident_pins_the_translation_and_the_group_moves_rigidly() {
    // The line starts at (2,3); the external point is (5,5). The group can only
    // translate, so the solve moves both entities by (3,2) and keeps every
    // length and radius.
    let params = vec![2.0, 3.0, 6.0, 3.0, 10.0, 3.0, 2.5];
    let mut inp = line_and_circle(params);
    inp.constraints.push(Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            e_ref(0, PointSelector::Start),
            Ref::External { x: 5.0, y: 5.0 },
        ),
        ..Default::default()
    });
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0);
    let p = &out.params_solved;
    assert!(
        (p[0] - 5.0).abs() < 1e-8 && (p[1] - 5.0).abs() < 1e-8,
        "anchor {p:?}"
    );
    assert!(
        (p[2] - 9.0).abs() < 1e-8 && (p[3] - 5.0).abs() < 1e-8,
        "line end {p:?}"
    );
    assert!(
        (p[4] - 13.0).abs() < 1e-8 && (p[5] - 5.0).abs() < 1e-8,
        "circle centre {p:?}"
    );
    assert!((p[6] - 2.5).abs() < 1e-8, "circle radius {p:?}");
}

/// One fixture: an anchor line (params 0..4) plus a member of `kind`.
fn member_fixture(kind: Kind, member_params: Vec<f64>, flags: u8) -> Input {
    let mut params = vec![1.0, 2.0, 5.0, 2.0];
    params.extend(&member_params);
    let member = crate::Entity {
        kind,
        param_offset: 4,
        param_count: member_params.len(),
        flags,
    };
    input(
        vec![line(0), member],
        params,
        vec![
            group(0, 0, PointSelector::Start),
            group(1, 0, PointSelector::Start),
        ],
    )
}

#[test]
fn every_member_kind_holds_its_shape_and_translates() {
    // (kind, params, the member-local slot to deform, how many leading member
    // params are coordinates). The slot is a shape scalar where the kind has
    // one, otherwise a point coordinate that is not shared by the whole member
    // (so the change is a deformation, not a translation).
    let fixtures: Vec<(Kind, Vec<f64>, usize, usize)> = vec![
        (Kind::Circle, vec![12.0, 4.0, 3.0], 2, 2),
        (Kind::Arc, vec![12.0, 4.0, 3.0, 20.0, 130.0], 2, 2),
        (Kind::Ellipse, vec![12.0, 4.0, 4.0, 2.0, 30.0], 4, 2),
        (Kind::Point, vec![12.0, 4.0], 1, 2),
        (
            Kind::Spline,
            vec![12.0, 4.0, 13.0, 5.0, 14.0, 4.0, 15.0, 3.0],
            5,
            8,
        ),
        (Kind::FitSpline, vec![12.0, 4.0, 13.0, 5.0, 14.0, 3.0], 5, 6),
    ];
    for (kind, member_params, local_slot, member_coords) in fixtures {
        let inp = member_fixture(kind, member_params, 0);
        let problem = Problem::new(&inp);
        assert_eq!(
            problem.constraints().len(),
            2,
            "{kind:?}: a group was dropped"
        );
        let x0 = problem.x0.clone();

        assert!(
            problem.residuals(&x0).iter().all(|r| r.abs() < 1e-12),
            "{kind:?}: the reference shape is not satisfied"
        );
        let out = solve_sketch(&inp);
        assert_eq!(out.diagnostics.dof, 2, "{kind:?}: a group must leave 2 DOF");

        // A rigid translation leaves every residual at zero: the anchor's four
        // coords and the member's coordinate scalars move, its shape scalars do
        // not.
        let mut moved = x0.clone();
        for value in moved.iter_mut().take(4) {
            *value += 2.5;
        }
        for value in moved[4..4 + member_coords].iter_mut() {
            *value += 2.5;
        }
        assert!(
            problem.residuals(&moved).iter().all(|r| r.abs() < 1e-12),
            "{kind:?}: the group is not translation-invariant"
        );

        // Deforming the member is what the group forbids.
        let mut deformed = x0.clone();
        deformed[4 + local_slot] += 1.0;
        assert!(
            problem.residuals(&deformed).iter().any(|r| r.abs() > 1e-6),
            "{kind:?}: a deformation was not held"
        );

        // The analytic Jacobian mirrors the residual rows exactly.
        let m = problem.residuals(&x0).len();
        let analytic = problem.jacobian(&x0, x0.len());
        let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| problem.residuals(xx), &x0, m);
        for r in 0..m {
            for col in 0..x0.len() {
                assert!(
                    (analytic[(r, col)] - fd[(r, col)]).abs() < 1e-6,
                    "{kind:?} ({r},{col}): analytic {} fd {}",
                    analytic[(r, col)],
                    fd[(r, col)],
                );
            }
        }
    }
}

#[test]
fn a_conflicting_length_on_a_grouped_member_is_overconstrained() {
    // The group holds the line at length 4; a length of 4.2 on the same line is
    // unsatisfiable, exactly like a length on a fixed line.
    let params = vec![0.0, 0.0, 4.0, 0.0, 10.0, 0.0, 2.5];
    let mut inp = line_and_circle(params);
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(4.2);
    inp.constraints.push(length);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
}

#[test]
fn a_length_equal_to_the_held_one_is_redundant_not_a_conflict() {
    let params = vec![0.0, 0.0, 4.0, 0.0, 10.0, 0.0, 2.5];
    let mut inp = line_and_circle(params);
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(4.0);
    inp.constraints.push(length);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 2);
    // The group already states the length, so the added dimension adds no rank.
    assert_eq!(
        out.constraint_flags[2] & crate::CONSTRAINT_FLAG_REDUNDANT,
        crate::CONSTRAINT_FLAG_REDUNDANT
    );
}

#[test]
fn an_explicit_reference_holds_the_authored_shape_while_the_seed_moves() {
    // The drag case: the seed already carries a deformed member, so `x0` is not
    // the shape to hold. The reference says what the group keeps, and the solve
    // comes back to it.
    let hold = vec![0.0, 0.0, 10.0, 0.0, 4.0, 3.0, 2.5];
    let mut seed = hold.clone();
    seed[3] = 4.0; // the dragged line end moved up by 4
    let inp = Input {
        params_reference: hold.clone(),
        ..line_and_circle(seed)
    };
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 2);
    // The whole group may translate, so the line end's displacement is shared:
    // the reference length is kept and both entities sit translated together.
    let p = &out.params_solved;
    let len = ((p[2] - p[0]).powi(2) + (p[3] - p[1]).powi(2)).sqrt();
    assert!((len - 10.0).abs() < 1e-8, "held length changed: {p:?}");
    assert!((p[6] - 2.5).abs() < 1e-8, "held radius changed: {p:?}");
    assert!((p[0] - 0.0).abs() < 1e-8, "anchor should not move: {p:?}");
}

// ─── Point members ───

/// One row of the "every pickable point is groupable" table: a member kind, the
/// point selectors it offers, the entity-local params that determine that point,
/// and the params a rigid translation moves.
struct PointRow {
    label: &'static str,
    kind: Kind,
    params: Vec<f64>,
    flags: u8,
    selector: PointSelector,
    deps: &'static [usize],
    translate: &'static [usize],
}

fn point_rows() -> Vec<PointRow> {
    let mut rows = Vec::new();
    for (label, selector, deps, translate) in [
        (
            "line start",
            PointSelector::Start,
            &[0usize, 1][..],
            &[0usize, 1, 2, 3][..],
        ),
        ("line end", PointSelector::End, &[2, 3], &[0, 1, 2, 3]),
    ] {
        rows.push(PointRow {
            label,
            kind: Kind::Line,
            params: vec![0.0, 0.0, 4.0, 0.0],
            flags: 0,
            selector,
            deps,
            translate,
        });
    }
    rows.push(PointRow {
        label: "circle center",
        kind: Kind::Circle,
        params: vec![0.0, 0.0, 2.5],
        flags: 0,
        selector: PointSelector::Center,
        deps: &[0, 1],
        translate: &[0, 1],
    });
    for (label, selector) in [
        ("arc center", PointSelector::Center),
        ("arc start", PointSelector::Start),
        ("arc end", PointSelector::End),
    ] {
        let deps = match selector {
            PointSelector::Center => &[0usize, 1][..],
            PointSelector::Start => &[0usize, 1, 2, 3][..],
            _ => &[0, 1, 2, 4],
        };
        rows.push(PointRow {
            label,
            kind: Kind::Arc,
            params: vec![0.0, 0.0, 2.0, 10.0, 130.0],
            flags: 0,
            selector,
            deps,
            translate: &[0, 1],
        });
    }
    for (label, selector, deps) in [
        ("ellipse center", PointSelector::Center, &[0usize, 1][..]),
        (
            "ellipse major1",
            PointSelector::Major,
            &[0usize, 1, 2, 4][..],
        ),
        (
            "ellipse major2",
            PointSelector::MajorNeg,
            &[0usize, 1, 2, 4][..],
        ),
        (
            "ellipse minor1",
            PointSelector::Minor,
            &[0usize, 1, 3, 4][..],
        ),
        (
            "ellipse minor2",
            PointSelector::MinorNeg,
            &[0usize, 1, 3, 4][..],
        ),
    ] {
        rows.push(PointRow {
            label,
            kind: Kind::Ellipse,
            params: vec![0.0, 0.0, 3.0, 1.5, 30.0],
            flags: 0,
            selector,
            deps,
            translate: &[0, 1],
        });
    }
    for (label, selector, deps) in [
        ("spline start", PointSelector::Start, &[0usize, 1][..]),
        ("spline end", PointSelector::End, &[6usize, 7][..]),
        ("spline c1", PointSelector::C1, &[2usize, 3][..]),
        ("spline c2", PointSelector::C2, &[4usize, 5][..]),
    ] {
        rows.push(PointRow {
            label,
            kind: Kind::Spline,
            params: vec![0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
            flags: 0,
            selector,
            deps,
            translate: &[0, 1, 2, 3, 4, 5, 6, 7],
        });
    }
    rows.push(PointRow {
        label: "fit spline fit1",
        kind: Kind::FitSpline,
        params: vec![0.0, 0.0, 2.0, 1.0, 4.0, 0.0],
        flags: 0,
        selector: PointSelector::Fit(1),
        deps: &[2, 3],
        translate: &[0, 1, 2, 3, 4, 5],
    });
    for (label, selector, deps) in [
        ("fit spline c1", PointSelector::C1, &[6usize, 7][..]),
        ("fit spline c2", PointSelector::C2, &[8usize, 9][..]),
    ] {
        rows.push(PointRow {
            label,
            kind: Kind::FitSpline,
            params: vec![0.0, 0.0, 2.0, 1.0, 4.0, 0.0, -1.0, -1.0, 5.0, 1.0],
            flags: 3,
            selector,
            deps,
            translate: &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        });
    }
    rows
}

/// Anchor point entity at params 0,1 plus the member entity at 2.., held as one
/// point member of the group.
fn point_member_input(row: &PointRow) -> Input {
    let mut params = vec![1.0, 2.0];
    params.extend(&row.params);
    let member = crate::Entity {
        kind: row.kind,
        param_offset: 2,
        param_count: row.params.len(),
        flags: row.flags,
    };
    input(
        vec![point(0), member],
        params,
        vec![point_group(1, row.selector, 0, PointSelector::Xy)],
    )
}

#[test]
fn every_pickable_point_holds_its_own_position_and_translates() {
    for row in point_rows() {
        let inp = point_member_input(&row);
        let problem = Problem::new(&inp);
        assert_eq!(
            problem.constraints().len(),
            1,
            "{}: group dropped",
            row.label
        );
        let x0 = problem.x0.clone();
        let m = problem.residuals(&x0).len();
        assert_eq!(m, 2, "{}: a point member is two rows", row.label);
        assert!(
            problem.residuals(&x0).iter().all(|r| r.abs() < 1e-12),
            "{}: the reference point is not satisfied",
            row.label
        );

        // Translating the anchor and every coordinate the member point rides on
        // leaves the point rows at zero.
        let mut moved = x0.clone();
        moved[0] += 2.5;
        moved[1] += 2.5;
        for &i in row.translate {
            moved[2 + i] += 2.5;
        }
        assert!(
            problem.residuals(&moved).iter().all(|r| r.abs() < 1e-12),
            "{}: a rigid translation moved the point off the group",
            row.label
        );

        // Moving the point itself (not the anchor) breaks the hold.
        let mut deformed = x0.clone();
        deformed[2 + row.deps[0]] += 1.0;
        assert!(
            problem.residuals(&deformed).iter().any(|r| r.abs() > 1e-6),
            "{}: the point was not held",
            row.label
        );

        let analytic = problem.jacobian(&x0, x0.len());
        let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| problem.residuals(xx), &x0, m);
        for r in 0..m {
            for col in 0..x0.len() {
                assert!(
                    (analytic[(r, col)] - fd[(r, col)]).abs() < 1e-6,
                    "{} ({r},{col}): analytic {} fd {}",
                    row.label,
                    analytic[(r, col)],
                    fd[(r, col)],
                );
            }
        }
    }
}

#[test]
fn a_point_member_translates_with_the_group_and_leaves_its_other_params_free() {
    for row in point_rows() {
        let inp = point_member_input(&row);
        let problem = Problem::new(&inp);
        let held = problem.point(&problem.reference, e_ref(1, row.selector));
        // The anchor moves the group, and a param the held point does not ride
        // on is seeded away from its reference: a group that held the whole
        // entity would pull it back.
        let free = (0..row.params.len())
            .find(|i| !row.deps.contains(i))
            .unwrap_or(0);
        let mut seed = inp.params_initial.clone();
        seed[0] += 2.0;
        seed[1] += 3.0;
        seed[2 + free] += 0.75;
        let seeded = Input {
            params_initial: seed.clone(),
            // The document's stored shape stays the reference while the seed
            // carries the drag, exactly as the drag frame sends it.
            params_reference: inp.params_initial.clone(),
            // A drag pins the point the user holds, so the group's shared
            // translation is the anchor's movement rather than a compromise
            // between the anchor and its members.
            pinned_mask: vec![0b0000_0011],
            ..inp.clone()
        };
        let out = solve_sketch(&seeded);
        assert_eq!(
            out.overall_status,
            Status::Underconstrained.to_u8(),
            "{}: mixed point group status",
            row.label
        );
        assert_eq!(
            out.diagnostics.dof,
            row.params.len() as u32 - 2,
            "{}: a point member must remove only its two DOF",
            row.label
        );
        let solved = problem.point(&out.params_solved, e_ref(1, row.selector));
        assert!(
            (solved[0] - held[0] - 2.0).abs() < 1e-6 && (solved[1] - held[1] - 3.0).abs() < 1e-6,
            "{}: held point {solved:?} did not follow {held:?}",
            row.label
        );
        assert!(
            (out.params_solved[2 + free] - seed[2 + free]).abs() < 1e-5,
            "{}: the free param was held",
            row.label
        );
    }
}

#[test]
fn a_whole_member_holds_against_a_point_anchor() {
    // The anchor is a spline control point, not the line's own start, so the
    // whole line's four coordinate rows all measure against `point_jac(anchor)`.
    let params = vec![0.0, 0.0, 4.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    let inp = input(
        vec![line(0), spline(4)],
        params,
        vec![point_group(0, PointSelector::Absent, 1, PointSelector::C1)],
    );
    let problem = Problem::new(&inp);
    let x0 = problem.x0.clone();
    assert!(
        problem.residuals(&x0).iter().all(|r| r.abs() < 1e-12),
        "the point anchor is not satisfied at the reference"
    );
    let mut moved = x0.clone();
    for value in moved.iter_mut().take(4) {
        *value += 2.5;
    }
    for value in moved[4..].iter_mut() {
        *value += 2.5;
    }
    assert!(
        problem.residuals(&moved).iter().all(|r| r.abs() < 1e-12),
        "the whole member is not translation-invariant under a point anchor"
    );
    let m = problem.residuals(&x0).len();
    assert_eq!(m, 4, "a whole line member is four rows");
    let analytic = problem.jacobian(&x0, x0.len());
    let fd = solver_core::lm::fd_jacobian(&|xx: &[f64]| problem.residuals(xx), &x0, m);
    for r in 0..m {
        for col in 0..x0.len() {
            assert!(
                (analytic[(r, col)] - fd[(r, col)]).abs() < 1e-6,
                "point anchor ({r},{col}): analytic {} fd {}",
                analytic[(r, col)],
                fd[(r, col)],
            );
        }
    }
    assert_eq!(solve_sketch(&inp).diagnostics.dof, 8);
}

#[test]
fn a_spline_grouped_by_two_control_points_keeps_its_endpoints_free() {
    // The group is the two off-curve controls only: the on-curve endpoints are
    // not members and must stay where the seed put them.
    let hold = vec![0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
    let constraints = vec![
        point_group(0, PointSelector::C1, 0, PointSelector::C1),
        point_group(0, PointSelector::C2, 0, PointSelector::C1),
    ];
    let mut seed = hold.clone();
    seed[2] += 2.0;
    seed[3] -= 1.0;
    let inp = Input {
        params_reference: hold.clone(),
        ..input(vec![spline(0)], seed.clone(), constraints.clone())
    };
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    // Eight params, two point rows: the translation is the anchor pair's own
    // two DOF, so exactly the two extra point params are held.
    assert_eq!(out.diagnostics.dof, 6);
    // The unpinned solve may split the translation between the two points; a
    // drag pins the anchor, and then the other point must follow it exactly.
    let pinned = Input {
        pinned_mask: vec![0b0000_1100],
        ..inp
    };
    let out = solve_sketch(&pinned);
    let p = &out.params_solved;
    assert!(
        (p[4] - hold[4] - 2.0).abs() < 1e-6 && (p[5] - hold[5] + 1.0).abs() < 1e-6,
        "c2 did not follow the c1 translation: {p:?}"
    );
    for i in [0, 1, 6, 7] {
        assert!(
            (p[i] - seed[i]).abs() < 1e-5,
            "an unheld endpoint moved: slot {i} {p:?}"
        );
    }
}
