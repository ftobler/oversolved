//! Weak (second-order) constraints: a dimension that holds a direction only to
//! first order and ships a visible offset as `dof 0`.
//!
//! The fixture is the report sketch `bugreports/20261123_2307_solver_accuracy.md`
//! (extrude 2 followed a cap face tilted 0.044 deg). Its mechanism is one
//! dimension, `point_distance_x` from the inner arc's start to the outer arc's
//! centre, whose residual is `r * cos(theta) - r`: a double root at `theta = 0`,
//! where the arc start sits at its extreme. The report sketch is transcribed row
//! for row below; the projection of a point onto the origin is replaced by a
//! `fixed` on the arc centre, which pins the same two params without the
//! projection machinery.
//!
//! The tilt is real geometry, not a rotated seed: only the right branch (both
//! arcs' start angles, `l2`, `eFn`, `cap2`) turns by `theta`; `l1`, `leg4` and
//! `cap1` stay horizontal/vertical, which is what makes the sketch read fully
//! constrained while the right side is tilted.

use super::*;
use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref};
use crate::test_util::*;
use crate::Entity;

/// The report's seed tilt: 0.044038 deg, i.e. 7.7e-4 rad.
const REPORT_TILT: f64 = 7.686e-4;

/// One report-shaped U profile, appended at entity index `base` and translated
/// by `centre`. Returns the wire index of its `point_distance_x` dimension
/// inside `constraints`, or `None` when the variant omits it.
///
/// Every quantity is the report's: legs 7, cap 1, outer radius 3, inner radius
/// 2 (forced by the cap), cap1/cap2 normal to their legs, the arcs concentric
/// and tangent to the legs at the shared angles.
fn push_unit(
    entities: &mut Vec<Entity>,
    params: &mut Vec<f64>,
    constraints: &mut Vec<Constraint>,
    base: u32,
    centre: [f64; 2],
    tilt: f64,
) -> Option<usize> {
    let at = |p: [f64; 2]| [centre[0] + p[0], centre[1] + p[1]];
    // A point on a circle about the unit centre, at angle `angle`.
    let on =
        |radius: f64, angle: f64| -> [f64; 2] { at([radius * angle.cos(), radius * angle.sin()]) };
    // The downward tangent of a circle at angle `angle`, length `len`.
    let down = |radius: f64, angle: f64, len: f64| -> [f64; 2] {
        let p = on(radius, angle);
        [p[0] + len * angle.sin(), p[1] - len * angle.cos()]
    };
    let l1_start = at([-7.0, 3.0]);
    let l1_end = at([0.0, 3.0]);
    let l2_start = on(3.0, tilt);
    let l2_end = down(3.0, tilt, 7.0);
    let arc_a = [centre[0], centre[1], 3.0, tilt.to_degrees(), 90.0];
    let leg4_start = at([-7.0, 2.0]);
    let leg4_end = at([0.0, 2.0]);
    let arc_b = [centre[0], centre[1], 2.0, tilt.to_degrees(), 90.0];
    let efn_start = on(2.0, tilt);
    let efn_end = down(2.0, tilt, 7.0);
    let cap1_start = at([-7.0, 2.0]);
    let cap1_end = at([-7.0, 3.0]);
    let cap2_start = l2_end;
    let cap2_end = efn_end;

    for (kind, block) in [
        (
            Kind::Line,
            l1_start
                .iter()
                .chain(l1_end.iter())
                .copied()
                .collect::<Vec<_>>(),
        ),
        (
            Kind::Line,
            l2_start.iter().chain(l2_end.iter()).copied().collect(),
        ),
        (Kind::Arc, arc_a.to_vec()),
        (
            Kind::Line,
            leg4_start.iter().chain(leg4_end.iter()).copied().collect(),
        ),
        (Kind::Arc, arc_b.to_vec()),
        (
            Kind::Line,
            efn_start.iter().chain(efn_end.iter()).copied().collect(),
        ),
        (
            Kind::Line,
            cap1_start.iter().chain(cap1_end.iter()).copied().collect(),
        ),
        (
            Kind::Line,
            cap2_start.iter().chain(cap2_end.iter()).copied().collect(),
        ),
    ] {
        entities.push(ent(kind, params.len()));
        params.extend(block);
    }
    let (l1, l2, arc_a_id, leg4, arc_b_id, efn, cap1, cap2) = (
        base,
        base + 1,
        base + 2,
        base + 3,
        base + 4,
        base + 5,
        base + 6,
        base + 7,
    );
    let absent = PointSelector::Absent;

    let coincident = |a: Ref, b: Ref| cons(ConstraintKind::Coincident, ab(a, b));
    constraints.push(coincident(
        e_ref(l1, PointSelector::End),
        e_ref(arc_a_id, PointSelector::End),
    ));
    constraints.push(coincident(
        e_ref(arc_a_id, PointSelector::Start),
        e_ref(l2, PointSelector::Start),
    ));
    constraints.push(cons(
        ConstraintKind::Tangent,
        ab(e_ref(l1, absent), e_ref(arc_a_id, absent)),
    ));
    constraints.push(cons(
        ConstraintKind::Tangent,
        ab(e_ref(arc_a_id, absent), e_ref(l2, absent)),
    ));
    constraints.push(cons(
        ConstraintKind::Parallel,
        ab(e_ref(l1, absent), e_ref(leg4, absent)),
    ));
    constraints.push(cons(
        ConstraintKind::Concentric,
        ab(e_ref(arc_a_id, absent), e_ref(arc_b_id, absent)),
    ));
    constraints.push(cons(
        ConstraintKind::Parallel,
        ab(e_ref(l2, absent), e_ref(efn, absent)),
    ));
    constraints.push(cons(
        ConstraintKind::Tangent,
        ab(e_ref(leg4, absent), e_ref(arc_b_id, absent)),
    ));
    constraints.push(cons(
        ConstraintKind::Tangent,
        ab(e_ref(arc_b_id, absent), e_ref(efn, absent)),
    ));
    // The report's one dimension on the mechanism: the inner arc's start is 2
    // from the outer arc's centre in x, which is exactly `r * cos(theta)` with
    // `r = 2`. Its row is stationary at the intended `theta = 0`.
    constraints.push(Constraint {
        kind_code: ConstraintKind::PointDistanceX.to_u8(),
        refs: ab(
            e_ref(arc_b_id, PointSelector::Start),
            e_ref(arc_a_id, PointSelector::Center),
        ),
        value: Some(2.0),
        sign: Some(-1.0),
        ..Default::default()
    });
    let x_dim = constraints.len() - 1;
    let mut length = |index: u32, value: f64| {
        let mut c = c_target(ConstraintKind::Length, index, absent);
        c.value = Some(value);
        constraints.push(c);
    };
    length(efn, 7.0);
    length(leg4, 7.0);
    length(cap2, 1.0);
    let mut radius = c_target(ConstraintKind::Radius, arc_a_id, absent);
    radius.value = Some(3.0);
    constraints.push(radius);
    constraints.push(coincident(
        e_ref(cap1, PointSelector::End),
        e_ref(l1, PointSelector::Start),
    ));
    constraints.push(coincident(
        e_ref(cap1, PointSelector::Start),
        e_ref(leg4, PointSelector::Start),
    ));
    constraints.push(cons(
        ConstraintKind::Normal,
        ab(e_ref(leg4, absent), e_ref(cap1, absent)),
    ));
    constraints.push(coincident(
        e_ref(leg4, PointSelector::End),
        e_ref(arc_b_id, PointSelector::End),
    ));
    constraints.push(coincident(
        e_ref(efn, PointSelector::End),
        e_ref(cap2, PointSelector::End),
    ));
    constraints.push(coincident(
        e_ref(efn, PointSelector::Start),
        e_ref(arc_b_id, PointSelector::Start),
    ));
    constraints.push(coincident(
        e_ref(l2, PointSelector::End),
        e_ref(cap2, PointSelector::Start),
    ));
    constraints.push(cons(
        ConstraintKind::Normal,
        ab(e_ref(cap2, absent), e_ref(efn, absent)),
    ));
    constraints.push(c_target(ConstraintKind::Horizontal, leg4, absent));
    // The report's projected origin point: it pins the outer arc's centre to
    // (0,0). A `fixed` on the centre is the same two rows without a projection.
    let mut fixed_centre = c_target(ConstraintKind::Fixed, arc_a_id, PointSelector::Center);
    fixed_centre.xy = Some((centre[0], centre[1]));
    constraints.push(fixed_centre);
    Some(x_dim)
}

/// The report's sketch with its tilt baked into the seed, exactly as the
/// document stores it after the first solve. `tilt` is in radians.
fn report_sketch(tilt: f64) -> (Input, usize) {
    let mut entities = Vec::new();
    let mut params = Vec::new();
    let mut constraints = Vec::new();
    let x_dim = push_unit(
        &mut entities,
        &mut params,
        &mut constraints,
        0,
        [0.0, 0.0],
        tilt,
    )
    .expect("the fixture always carries the x dimension");
    (input(entities, params, constraints), x_dim)
}

/// The same sketch with a `vertical` on `eFn` and no x dimension: the
/// orientation is held by a first-order row, so the double root is gone.
fn report_sketch_vertical(tilt: f64) -> Input {
    let mut entities = Vec::new();
    let mut params = Vec::new();
    let mut constraints = Vec::new();
    // Build the report unit, then drop its x dimension and add the vertical.
    // `push_unit` always appends the dimension, so pop it by known position:
    // rebuild and keep only the constraints before the dimension plus those
    // after it.
    let x_dim = push_unit(
        &mut entities,
        &mut params,
        &mut constraints,
        0,
        [0.0, 0.0],
        tilt,
    )
    .expect("the fixture always carries the x dimension");
    constraints.remove(x_dim);
    constraints.push(c_target(ConstraintKind::Vertical, 5, PointSelector::Absent));
    input(entities, params, constraints)
}

fn weak_index(out: &Output) -> Vec<u32> {
    out.weak_constraints
        .iter()
        .map(|w| w.constraint_index)
        .collect()
}

fn report_sketch_seeded() -> (Input, usize) {
    report_sketch(REPORT_TILT)
}

#[test]
fn the_report_sketch_names_its_extreme_dimension_as_weak() {
    let (inp, x_dim) = report_sketch_seeded();
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "the report sketch's verdict moved: norm {}",
        out.diagnostics.residual_norm
    );
    assert_eq!(
        weak_index(&out),
        vec![x_dim as u32],
        "the weak report named {:?}, expected the x dimension at {x_dim}",
        out.weak_constraints
    );
    let estimate = out.weak_constraints[0].move_estimate;
    let seed = REPORT_TILT.to_degrees();
    assert!(
        estimate >= 0.5 * seed && estimate <= 2.0 * seed,
        "move estimate {estimate} deg is not within 2x of the {seed} deg seed tilt"
    );
    // The diagnostic is why the row can be a warning: the verdict itself stays
    // fully constrained, and the geometry is the seed's tilt.
    assert_eq!(out.diagnostics.dof, 0);
}

#[test]
fn a_zero_tilt_seed_leaves_the_rank_short_instead() {
    // Exactly at the double root the Jacobian column is 0, so the rank pass
    // sees the rotation as free: the honest reading there is underconstrained
    // (one free DOF), not a weak constraint. The rank-deficient side is pinned
    // rather than both outcomes being tolerated.
    let (inp, _) = report_sketch(0.0);
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::Underconstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    assert_eq!(out.diagnostics.dof, 1);
    assert!(out.weak_constraints.is_empty());
}

#[test]
fn a_vertical_row_replaces_the_weak_dimension() {
    let inp = report_sketch_vertical(REPORT_TILT);
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    assert!(out.weak_constraints.is_empty());
    assert!(
        out.diagnostics.angular_miss <= crate::tolerance::OCC_ANGULAR,
        "the finish did not reach the angular contract: {:e}",
        out.diagnostics.angular_miss
    );
}

#[test]
fn a_clean_sketch_reports_no_weak_constraint() {
    // The crate's finished fixtures, plus the finished parallel chain at every
    // scale: none of them has a second-order row, so none may carry the
    // diagnostic. This stands in for the fuzz invariant the plan asks for (the
    // crate has no sketch-solve fuzz; its only fuzz is the area builder).
    for inp in [
        super::precision::rotated_half_cube(1e-6),
        super::precision::tight_parallel_chain(1e-2),
        super::precision::tight_parallel_chain(1.0),
        super::precision::tight_parallel_chain(100.0),
    ] {
        let out = solve_sketch(&inp);
        assert!(
            out.weak_constraints.is_empty(),
            "a clean sketch reported {:?}",
            out.weak_constraints
        );
    }
}

/// Two independent copies of the report's mechanism, translated apart, so each
/// has its own free rotation and its own weak dimension. A strong dimension
/// beside them (the leg length) is not named.
#[test]
fn two_weak_dimensions_are_both_named() {
    let mut entities = Vec::new();
    let mut params = Vec::new();
    let mut constraints = Vec::new();
    let first = push_unit(
        &mut entities,
        &mut params,
        &mut constraints,
        0,
        [0.0, 0.0],
        REPORT_TILT,
    )
    .expect("first unit");
    let second = push_unit(
        &mut entities,
        &mut params,
        &mut constraints,
        8,
        [100.0, 0.0],
        REPORT_TILT,
    )
    .expect("second unit");
    let out = solve_sketch(&input(entities, params, constraints.clone()));
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    let named = weak_index(&out);
    assert_eq!(named.len(), 2, "weak set {:?}", out.weak_constraints);
    assert!(named.contains(&(first as u32)) && named.contains(&(second as u32)));
    // The strong dimensions of both units stay unnamed: the leg lengths and the
    // outer radius are first-order drivers.
    for weak in &out.weak_constraints {
        let index = weak.constraint_index as usize;
        let kind = out_kind(&constraints, index);
        assert_ne!(
            kind,
            Some(ConstraintKind::Length),
            "a length dimension was blamed: {weak:?}"
        );
        assert_ne!(kind, Some(ConstraintKind::Radius));
    }
}

/// The kind of a constraint at wire index `index`, for the blame assertion.
fn out_kind(constraints: &[Constraint], index: usize) -> Option<ConstraintKind> {
    constraints.get(index).and_then(|c| c.kind())
}

/// The sigma test fires on its own: with the finish's refused step taken away
/// entirely, the smallest-singular-value test still names the dimension. This
/// is the guarantee that a change to the finish cap cannot retire the
/// diagnostic, and it pins the second test in isolation rather than through the
/// combined report.
#[test]
fn the_singular_value_test_names_the_dimension_without_the_finish() {
    let (inp, x_dim) = report_sketch_seeded();
    let out = solve_sketch(&inp);
    let problem = Problem::new(&inp);
    let n = inp.params_initial.len();
    let jac = problem.jacobian(&out.params_solved, n);
    let spectrum = Spectrum::of(&jac, n, true);
    let layout = row_layout(&problem, &out.params_solved);
    let sigma = weak_constraints(
        &problem,
        &jac,
        &spectrum,
        &layout,
        None,
        out.diagnostics.linear_miss,
    );
    assert_eq!(
        sigma.iter().map(|w| w.constraint_index).collect::<Vec<_>>(),
        vec![x_dim as u32],
        "the sigma test alone named {:?}",
        sigma
    );
    // And the estimate is the uncertainty read over the sketch scale, in
    // degrees: within 2x of the seed tilt.
    let seed = REPORT_TILT.to_degrees();
    let estimate = sigma[0].move_estimate;
    assert!(
        estimate >= 0.5 * seed && estimate <= 2.0 * seed,
        "sigma estimate {estimate} deg is not within 2x of the {seed} deg seed tilt"
    );
}

/// The finish's own half, producer side: solving the report fixture and running
/// the contract finish refuses the tilt's step, and that refusal records the
/// weak direction with the seeded estimate and the x dimension's row. Deleting
/// the `WeakDirection` record in `finish_contract` fails here.
#[test]
fn the_finish_records_the_refused_step_that_names_the_weak_row() {
    let (inp, x_dim) = report_sketch_seeded();
    let problem = Problem::new(&inp);
    let n = inp.params_initial.len();
    let mut x = inp.params_initial.clone();
    let finish = finish_contract(&inp, &problem, &mut x);
    let weak = finish
        .weak
        .as_ref()
        .expect("the finish refused the tilt's step without recording it");
    let seed = REPORT_TILT.to_degrees();
    assert!(
        weak.estimate >= 0.5 * seed && weak.estimate <= 2.0 * seed,
        "finish estimate {} deg is not within 2x of the {seed} deg seed tilt",
        weak.estimate
    );
    let jac = problem.jacobian(&x, n);
    let layout = row_layout(&problem, &x);
    let owners = constraint_row_wires(&layout, jac.nrows());
    assert!(
        weak.rows
            .iter()
            .any(|&row| owners.get(row) == Some(&Some(x_dim))),
        "the refused step did not blame the x dimension: rows {:?}, owners {:?}",
        weak.rows,
        owners
    );
}

/// The finish half's consumer side: a hand-built refused step names its row and
/// carries its estimate through `weak_constraints` even when the
/// singular-value test cannot fire. The producer is pinned above; this guards
/// the merge and the axis narrowing.
#[test]
fn the_finish_branch_names_its_blamed_row_without_the_sigma_test() {
    let (inp, x_dim) = report_sketch_seeded();
    let out = solve_sketch(&inp);
    let problem = Problem::new(&inp);
    let n = inp.params_initial.len();
    let jac = problem.jacobian(&out.params_solved, n);
    let spectrum = Spectrum::of(&jac, n, true);
    let layout = row_layout(&problem, &out.params_solved);
    let owners = constraint_row_wires(&layout, jac.nrows());
    let row = owners
        .iter()
        .position(|owner| *owner == Some(x_dim))
        .expect("the x dimension owns a row in the solved Jacobian");
    // A zero measured miss is not wide: the sigma test cannot fire, so whatever
    // the report names below came from the finish half alone.
    assert!(
        sigma_blame(
            &jac,
            spectrum.weakest_sv,
            &spectrum.weakest_dir,
            0.0,
            problem.scale(),
        )
        .is_none(),
        "the sigma test fired on a zero miss"
    );
    let refused = WeakDirection {
        estimate: 0.05,
        rows: vec![row],
    };
    let weak = weak_constraints(&problem, &jac, &spectrum, &layout, Some(&refused), 0.0);
    assert_eq!(
        weak,
        vec![WeakConstraint {
            constraint_index: x_dim as u32,
            move_estimate: 0.05,
        }]
    );
}
