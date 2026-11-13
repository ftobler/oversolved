//! Regression guards for the two solver inputs the enclosure practice run
//! captured: a filleted rectangle whose stale side lengths the old applier left
//! on the trimmed lines, plus the two re-anchor dimensions. The first traps the
//! wasm build (`unreachable`) once the area builder runs, the second hangs it
//! past its watchdog. Both are re-created here from the finding text, never
//! copied from the example document: a 101 x 151 rounded rectangle (r9), the
//! four dimensioned circles the practice sketch anchored, and a projected line
//! pair replaced by two pinned lines.

use sketch_solver::api::detect_topology_bytes;
use sketch_solver::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use sketch_solver::{solve_sketch, Entity, Input, Kind, Options};

fn target(index: u32, point: PointSelector) -> (RefRole, Ref) {
    (RefRole::Target, Ref::Entity { index, point })
}
fn a(index: u32, point: PointSelector) -> (RefRole, Ref) {
    (RefRole::A, Ref::Entity { index, point })
}
fn b(index: u32, point: PointSelector) -> (RefRole, Ref) {
    (RefRole::B, Ref::Entity { index, point })
}
fn c(kind: ConstraintKind, refs: Vec<(RefRole, Ref)>, value: Option<f64>) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs,
        value,
        ..Default::default()
    }
}

/// The re-created sketch. Entity order mirrors a lowered sketch: six lines
/// (two projected-and-pinned, four rect sides already trimmed), four circles,
/// four arcs, and the injected origin point.
fn recreated_sketch() -> Input {
    let kinds = [
        Kind::Line,
        Kind::Line,
        Kind::Line,
        Kind::Line,
        Kind::Line,
        Kind::Line,
        Kind::Circle,
        Kind::Circle,
        Kind::Circle,
        Kind::Circle,
        Kind::Arc,
        Kind::Arc,
        Kind::Arc,
        Kind::Arc,
        Kind::Point,
    ];
    let params = vec![
        -62.5, 75.5, -62.5, -75.5, // pl: the projected vertical edge
        -50.5, -87.5, 50.5, -87.5, // pb: the projected horizontal edge
        -50.5, -84.5, 50.5, -84.5, // rb, trimmed to 101
        59.5, -75.5, 59.5, 75.5, // rr, trimmed to 151
        50.5, 84.5, -50.5, 84.5, // rt
        -59.5, 75.5, -59.5, -75.5, // rl
        -49.5, -74.5, 7.0, // b1
        49.5, -74.5, 7.0, // b2
        -49.5, 74.5, 7.0, // b3
        49.5, 74.5, 7.0, // b4
        -50.5, -75.5, 9.0, 180.0, 270.0, // a1
        50.5, -75.5, 9.0, 270.0, 360.0, // a2
        50.5, 75.5, 9.0, 0.0, 90.0, // a3
        -50.5, 75.5, 9.0, 90.0, 180.0, // a4
        0.0, 0.0, // origin
    ];
    let mut entities = Vec::new();
    let mut offset = 0;
    for kind in kinds {
        entities.push(Entity::new(kind, offset));
        offset += kind.fixed_param_count().unwrap();
    }

    use ConstraintKind::*;
    use PointSelector::*;
    let constraints = vec![
        c(EqualLength, vec![a(2, Absent), b(4, Absent)], None),
        c(EqualLength, vec![a(3, Absent), b(5, Absent)], None),
        c(Horizontal, vec![target(2, Absent)], None),
        c(Vertical, vec![target(3, Absent)], None),
        // The stale side lengths the old fillet_corners left behind: the
        // straight runs are 101 and 151.
        c(Length, vec![target(2, Absent)], Some(119.0)),
        c(Length, vec![target(3, Absent)], Some(169.0)),
        c(Radius, vec![target(6, Absent)], Some(7.0)),
        c(Radius, vec![target(7, Absent)], Some(7.0)),
        c(Radius, vec![target(8, Absent)], Some(7.0)),
        c(Radius, vec![target(9, Absent)], Some(7.0)),
        c(LineDistance, vec![a(0, Absent), b(6, Center)], Some(13.0)),
        c(LineDistance, vec![a(1, Absent), b(6, Center)], Some(13.0)),
        c(LineDistance, vec![a(0, Absent), b(7, Center)], Some(112.0)),
        c(LineDistance, vec![a(1, Absent), b(7, Center)], Some(13.0)),
        c(LineDistance, vec![a(0, Absent), b(8, Center)], Some(13.0)),
        c(LineDistance, vec![a(1, Absent), b(8, Center)], Some(162.0)),
        c(LineDistance, vec![a(0, Absent), b(9, Center)], Some(112.0)),
        c(LineDistance, vec![a(1, Absent), b(9, Center)], Some(162.0)),
        c(Coincident, vec![a(2, Start), b(10, End)], None),
        c(Coincident, vec![a(10, Start), b(5, End)], None),
        c(Tangent, vec![a(2, Absent), b(10, Absent)], None),
        c(Tangent, vec![a(10, Absent), b(5, Absent)], None),
        c(Coincident, vec![a(2, End), b(11, Start)], None),
        c(Coincident, vec![a(11, End), b(3, Start)], None),
        c(Tangent, vec![a(2, Absent), b(11, Absent)], None),
        c(Tangent, vec![a(11, Absent), b(3, Absent)], None),
        c(Coincident, vec![a(3, End), b(12, Start)], None),
        c(Coincident, vec![a(12, End), b(4, Start)], None),
        c(Tangent, vec![a(3, Absent), b(12, Absent)], None),
        c(Tangent, vec![a(12, Absent), b(4, Absent)], None),
        c(Coincident, vec![a(4, End), b(13, Start)], None),
        c(Coincident, vec![a(13, End), b(5, Start)], None),
        c(Tangent, vec![a(4, Absent), b(13, Absent)], None),
        c(Tangent, vec![a(13, Absent), b(5, Absent)], None),
        c(LineDistance, vec![a(0, Absent), b(5, Start)], Some(3.0)),
        c(LineDistance, vec![a(1, Absent), b(2, Start)], Some(3.0)),
        Constraint {
            kind_code: Fixed.to_u8(),
            refs: vec![target(14, Xy)],
            xy: Some((0.0, 0.0)),
            ..Default::default()
        },
    ];

    Input {
        entities,
        params_initial: params,
        params_reference: Vec::new(),
        // pl and pb are projected entities: every param pinned to its seed.
        pinned_mask: vec![0xff, 0, 0, 0, 0, 0, 0, 0],
        equality_pins: Vec::new(),
        constraints,
        seed_quantum: 1e-6,
        options: Options::default(),
    }
}

/// The two dense LM phases (MAX_ITERS + POLISH_ITERS in solver-core). A solve
/// that spends more than this is a loop that never converged, not a verdict.
const ITERATION_BUDGET: u32 = 250;

fn assert_normal_verdict(input: &Input) -> sketch_solver::Output {
    let out = solve_sketch(input);
    assert!(
        out.params_solved.iter().all(|v| v.is_finite()),
        "the solve returned a non-finite param"
    );
    assert!(
        out.diagnostics.iters <= ITERATION_BUDGET,
        "the solve spent {} iterations, past the {} cap",
        out.diagnostics.iters,
        ITERATION_BUDGET
    );
    assert_eq!(
        out.overall_status,
        sketch_solver::Status::Overconstrained.to_u8(),
        "the degenerate radius must be a red sketch, not a silent underconstrained one"
    );
    out
}

#[test]
fn stale_lengths_on_a_filleted_rect_are_an_overconstrained_verdict() {
    let input = recreated_sketch();
    let out = assert_normal_verdict(&input);

    // The solve found the constraints satisfiable with an arc driven through
    // zero; that is exactly the invalid geometry the gate must catch.
    let bad: Vec<usize> = input
        .entities
        .iter()
        .enumerate()
        .filter(|(index, entity)| {
            input.entity_params_in_range(*index)
                && matches!(entity.kind, Kind::Circle | Kind::Arc)
                && out.params_solved[entity.param_offset + 2] <= 0.0
        })
        .map(|(index, _)| index)
        .collect();
    assert!(
        !bad.is_empty(),
        "the fixture stopped producing a degenerate radius"
    );

    // The constraints that touch the degenerate entity are the causally honest
    // ones the residual stack can name; a zero miss everywhere would leave the
    // host's culprit selection with nothing to paint.
    let touched: Vec<usize> = input
        .constraints
        .iter()
        .enumerate()
        .filter(|(_, constraint)| {
            constraint.refs.iter().any(|(_, r)| match r {
                Ref::Entity { index, .. } => bad.contains(&(*index as usize)),
                Ref::External { .. } => false,
            })
        })
        .map(|(index, _)| index)
        .collect();
    assert!(!touched.is_empty());
    assert!(
        touched.iter().all(|&i| out.constraint_miss[i] > 0.0),
        "a degenerate-radius culprit has no miss: {:?}",
        out.constraint_miss
    );
}

#[test]
fn the_enc_c_variant_with_only_the_pb_anchor_is_also_a_verdict() {
    let mut input = recreated_sketch();
    // Drop the pl -> rl:start anchor; the practice run's enc-c script kept only
    // the pb anchor and the CLI never returned.
    input.constraints.remove(34);
    assert_normal_verdict(&input);
}

#[test]
fn the_degenerate_solve_feeds_the_area_builder_without_wedging_it() {
    let input = recreated_sketch();
    let out = solve_sketch(&input);

    // Mirror `enrichSketchEntity` for the solved params: the topology receives
    // the signed radius it must interpret as a magnitude.
    let mut payload = Vec::new();
    for (index, entity) in input.entities.iter().enumerate() {
        if !input.entity_params_in_range(index) {
            continue;
        }
        let p = &out.params_solved[entity.param_offset..entity.param_offset + entity.param_count];
        let value = match entity.kind {
            Kind::Line => serde_json::json!({ "start": [p[0], p[1]], "end": [p[2], p[3]] }),
            Kind::Circle => serde_json::json!({ "center": [p[0], p[1]], "radius": p[2] }),
            Kind::Arc => {
                let rad = |deg: f64| deg * std::f64::consts::PI / 180.0;
                serde_json::json!({
                    "center": [p[0], p[1]],
                    "radius": p[2],
                    "angle_start": p[3],
                    "angle_end": p[4],
                    "start": [p[0] + p[2] * rad(p[3]).cos(), p[1] + p[2] * rad(p[3]).sin()],
                    "end": [p[0] + p[2] * rad(p[4]).cos(), p[1] + p[2] * rad(p[4]).sin()],
                })
            }
            // The injected origin point contributes no area geometry.
            _ => continue,
        };
        payload.push(serde_json::json!([format!("e{index}"), value]));
    }
    let bytes = serde_json::to_vec(&payload).expect("encode topology input");
    let out = detect_topology_bytes(&bytes).expect("the area builder must answer");
    assert!(!out.is_empty());
}
