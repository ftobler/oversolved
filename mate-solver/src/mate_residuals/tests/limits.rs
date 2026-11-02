//! One-sided joint ranges on rotating and sliding mates: inside the range the
//! bound contributes a zero row, past it the row is the overshoot and the solve
//! pulls the joint back or reports the contradiction.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

/// Body 0 grounded at the origin, body 1 free. Both anchors are cylinders on
/// the world +Z axis at their body origins, so the only joint coordinates that
/// can move are the axial separation (sliding) and the roll (rotating).
fn axial_pair(seed: [f64; 7]) -> MateInput {
    let mut params = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    params.extend_from_slice(&seed);
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: params,
        fixed_mask: vec![0b0000_0001],
        mates: Vec::new(),
    }
}

fn sliding_mate() -> Mate {
    mate(
        MateKind::Sliding,
        mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
        mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
        false,
        0.0,
        1.0,
        0.0,
    )
}

fn rotating_mate() -> Mate {
    mate(
        MateKind::Rotating,
        mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
        mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
        false,
        0.0,
        1.0,
        0.0,
    )
}

fn at_z(z: f64) -> [f64; 7] {
    [0.0, 0.0, z, 0.0, 0.0, 0.0, 1.0]
}

/// A pure roll of `deg` about world Z, body 1 at the origin.
fn rolled(deg: f64) -> [f64; 7] {
    let (qz, qw) = quat_roll_z(deg);
    [0.0, 0.0, 0.0, 0.0, 0.0, qz, qw]
}

fn roll_deg(x: &[f64]) -> f64 {
    let qz = x[12];
    let qw = x[13];
    (2.0 * qz.atan2(qw)).to_degrees()
}

#[test]
fn sliding_maximum_pulls_a_seeded_part_back_to_the_stop() {
    let mut input = axial_pair(at_z(20.0));
    let mut m = sliding_mate();
    m.limit_max = 10.0;
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        (out.params_solved[9] - 10.0).abs() < 1e-2,
        "the slide should stop at 10, got {}",
        out.params_solved[9]
    );
    assert!(
        out.limit_flags[0] & LIMIT_MAX_HIT != 0,
        "the reply must name the maximum"
    );
    assert_eq!(out.limit_flags[0] & LIMIT_MIN_HIT, 0);
    assert!(
        out.diagnostics.residual_norm < 1e-2,
        "a reached stop is not a conflict, residual {}",
        out.diagnostics.residual_norm
    );
}

#[test]
fn sliding_minimum_pulls_a_seeded_part_back_to_the_stop() {
    let mut input = axial_pair(at_z(-20.0));
    let mut m = sliding_mate();
    m.limit_min = -5.0;
    m.limit_min_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        (out.params_solved[9] + 5.0).abs() < 1e-2,
        "the slide should stop at -5, got {}",
        out.params_solved[9]
    );
    assert!(out.limit_flags[0] & LIMIT_MIN_HIT != 0);
    assert_eq!(out.limit_flags[0] & LIMIT_MAX_HIT, 0);
}

#[test]
fn a_slide_inside_its_range_is_inactive_and_stays_where_seeded() {
    let mut input = axial_pair(at_z(20.0));
    let mut m = sliding_mate();
    m.limit_min = 0.0;
    m.limit_min_set = true;
    m.limit_max = 30.0;
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        (out.params_solved[9] - 20.0).abs() < 1e-3,
        "an inactive range must not move the joint, got {}",
        out.params_solved[9]
    );
    assert_eq!(out.limit_flags[0], 0);
    // The slide is still the prismatic joint's free DOF.
    assert_eq!(out.diagnostics.dof, 1);
}

#[test]
fn rotating_maximum_holds_the_authored_angle() {
    let mut input = axial_pair(rolled(45.0));
    let mut m = rotating_mate();
    m.limit_max = 30.0_f64.to_radians();
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        (roll_deg(&out.params_solved) - 30.0).abs() < 1.0,
        "the hinge should stop at 30 degrees, got {}",
        roll_deg(&out.params_solved)
    );
    assert!(out.limit_flags[0] & LIMIT_MAX_HIT != 0);
}

#[test]
fn a_rotating_pair_pushes_across_the_cut_to_the_nearer_stop() {
    // A pose one degree past a 180 degree ceiling reads as -179 on the signed
    // coordinate. The pair is a circular arc, so the row must measure the one
    // degree back to 180, not 179 degrees forward to 0, and the reply must name
    // the maximum.
    let mut input = axial_pair(rolled(181.0));
    let mut m = rotating_mate();
    m.limit_min = 0.0;
    m.limit_min_set = true;
    m.limit_max = 180.0_f64.to_radians();
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        roll_deg(&out.params_solved).abs() > 179.0,
        "the hinge should rest at 180 (either sign), got {}",
        roll_deg(&out.params_solved)
    );
    assert!(
        out.limit_flags[0] & LIMIT_MAX_HIT != 0,
        "the reply must name the maximum"
    );
    assert_eq!(out.limit_flags[0] & LIMIT_MIN_HIT, 0);
}

#[test]
fn rotating_minimum_holds_the_authored_angle() {
    let mut input = axial_pair(rolled(-60.0));
    let mut m = rotating_mate();
    m.limit_min = -45.0_f64.to_radians();
    m.limit_min_set = true;
    m.limit_max = -10.0_f64.to_radians();
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        (roll_deg(&out.params_solved) + 45.0).abs() < 1.0,
        "the hinge should stop at -45 degrees, got {}",
        roll_deg(&out.params_solved)
    );
    assert!(out.limit_flags[0] & LIMIT_MIN_HIT != 0);
}

#[test]
fn a_hinge_inside_its_range_keeps_its_free_roll() {
    let mut input = axial_pair(rolled(20.0));
    let mut m = rotating_mate();
    m.limit_min = 0.0;
    m.limit_min_set = true;
    m.limit_max = 30.0_f64.to_radians();
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert!(
        (roll_deg(&out.params_solved) - 20.0).abs() < 1e-3,
        "an inactive range must leave the free roll alone, got {}",
        roll_deg(&out.params_solved)
    );
    assert_eq!(out.limit_flags[0], 0);
    // A free hinge has its one rotational DOF.
    assert_eq!(out.diagnostics.dof, 1);
}

#[test]
fn an_unsatisfiable_limit_pair_is_overconstrained_not_silently_ignored() {
    // A plane separation of 30 and a slide ceiling of 20 demand different
    // stations for the same pair, so no pose satisfies every limit. This is the
    // reserved meaning of overconstrained: a real conflict, not a joint resting
    // on its stop.
    let mut input = axial_pair(at_z(25.0));
    let mut slide = sliding_mate();
    slide.limit_max = 20.0;
    slide.limit_max_set = true;
    input.mates.push(slide);
    input.mates.push(mate(
        MateKind::ParallelPlaneDistance,
        mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
        mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Plane),
        false,
        30.0,
        1.0,
        0.0,
    ));

    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::Overconstrained.to_u8());
    assert!(out.diagnostics.residual_norm > 1e-2);
}

#[test]
fn an_inverted_range_has_no_satisfying_pose() {
    // min > max is not a wrap-around range: the coordinate would have to be
    // both above the minimum and below the maximum. The two one-sided rows
    // leave no reachable zero, so the verdict is overconstrained.
    let mut input = axial_pair(at_z(5.0));
    let mut m = sliding_mate();
    m.limit_min = 10.0;
    m.limit_min_set = true;
    m.limit_max = 0.0;
    m.limit_max_set = true;
    input.mates.push(m);

    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::Overconstrained.to_u8());
}

#[test]
fn an_undefined_rotating_roll_has_no_bound_row_and_no_flag() {
    // B's canonical perp leans onto A's axis (the axes are perpendicular), so
    // the dihedral has no honest angle. The authored maximum must still hold
    // its row slot, but the row and the report stay zero rather than inventing
    // a bound from an arbitrary atan2.
    let mut m = rotating_mate();
    m.limit_max = 10.0_f64.to_radians();
    m.limit_max_set = true;
    let half = std::f64::consts::FRAC_1_SQRT_2;
    let input = MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            // +90 degrees about X: B's +Y perp points along A's +Z axis.
            0.0, 0.0, 0.0, half, 0.0, 0.0, half,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![m],
    };
    let p = MateProblem::new(&input);
    let x = input.params_initial.clone();
    let rows = p.residuals(&x);
    assert_eq!(rows.len(), mate_residual_count(&input.mates[0]));
    assert_eq!(rows[6], 0.0, "the undefined roll must not invent a bound");
    assert_eq!(p.limit_hit_flags(&x, 0), 0);
}

#[test]
fn limit_hit_flags_are_per_input_mate_and_zero_for_a_dropped_one() {
    // Two mates, the first naming a body that does not exist: the dropped mate
    // keeps its slot in the report so the second mate's flag cannot shift onto
    // it, the same positional contract the residual block follows.
    let mut input = axial_pair(at_z(20.0));
    let mut stale = sliding_mate();
    stale.b.body_index = 9;
    stale.limit_max = 10.0;
    stale.limit_max_set = true;
    input.mates.push(stale);
    let mut live = sliding_mate();
    live.limit_max = 10.0;
    live.limit_max_set = true;
    input.mates.push(live);

    let out = solve_mate(&input);
    assert_eq!(out.limit_flags.len(), 2);
    assert_eq!(out.limit_flags[0], 0, "a dropped mate reports no limit");
    assert!(out.limit_flags[1] & LIMIT_MAX_HIT != 0);
}
