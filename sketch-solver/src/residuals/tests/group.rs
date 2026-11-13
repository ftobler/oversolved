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
