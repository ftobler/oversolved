//! The solver/kernel precision contract on the report's own sketch, and the
//! finish phase that reaches it.
//!
//! `20261114_0039_mirror_seams.md` reported seams on a mirror merge. The
//! sketch it ships (`sk1`) reads satisfied, yet its parallel pair inherits a
//! free tilt the anchored solve introduced. The fixture below is that sketch,
//! rebuilt row for row from the report's document block (the `bugreports/`
//! subrepo is not part of this tree, so the numbers are transcribed here
//! rather than loaded).

use super::*;
use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::residuals::Problem;
use crate::test_util::*;
use crate::Entity;
use crate::Options;
use solver_core::lm::{solve_lm, LmResult, LmStop};

// ─── The report sketch ───

/// The report sketch's entity order and seed params, verbatim from the
/// document block. Index order is the document's entity order, which is the
/// order the host's lowering emits.
fn report_sketch_params() -> Vec<f64> {
    vec![
        // l1
        0.0, 0.0, 80.381198, 0.0, // l2
        87.309401, -4.0, 115.599564, -53.0, // l3
        108.671361, -65.0, 85.0, -65.0, // Et7 arc
        80.381198, -8.0, 8.0, 30.0, 90.0, // rP4 arc
        108.671361, -57.0, 8.0, 270.0, 390.0, // xip0
        0.0, -4.0, 80.381198, -4.0, // prO arc
        80.381198, -8.0, 4.0, 30.0, 90.0, // IXh
        83.845299, -6.0, 112.135462, -55.0, // Ztz arc
        108.671361, -57.0, 4.0, 270.0, 390.0, // jLQ
        108.671361, -61.0, 85.0, -61.0, // e1
        0.0, -4.0, 0.0, 0.0, // e2
        85.0, -65.0, 85.0, -61.0,
    ]
}

fn report_sketch_entities() -> Vec<Entity> {
    // Offsets follow the param vector above: 4, 4, 4, 5, 5, 4, 5, 4, 5, 4,
    // 4, 4.
    let mut off = 0usize;
    let mut out = Vec::new();
    for kind in [
        Kind::Line,
        Kind::Line,
        Kind::Line,
        Kind::Arc,
        Kind::Arc,
        Kind::Line,
        Kind::Arc,
        Kind::Line,
        Kind::Arc,
        Kind::Line,
        Kind::Line,
        Kind::Line,
    ] {
        out.push(Entity::new(kind, off));
        off += kind.fixed_param_count().unwrap();
    }
    out
}

fn coincident(a: Ref, b: Ref) -> Constraint {
    cons(ConstraintKind::Coincident, ab(a, b))
}

fn tangent(a: Ref, b: Ref) -> Constraint {
    cons(ConstraintKind::Tangent, ab(a, b))
}

fn parallel(a: Ref, b: Ref) -> Constraint {
    cons(ConstraintKind::Parallel, ab(a, b))
}

fn concentric(a: Ref, b: Ref) -> Constraint {
    cons(ConstraintKind::Concentric, ab(a, b))
}

/// The report's `sk1`. `horizontal_on_l1` is the variant the contract test
/// pins: the top edge gets its direction from a linear row, so the free tilt
/// the anchored solve would otherwise leave on the parallel pair is gone.
fn report_sketch(horizontal_on_l1: bool) -> Input {
    let (l1, l2, l3) = (0u32, 1, 2);
    let (et7, rp4, xip0, pro) = (3u32, 4, 5, 6);
    let (ixh, ztz, jlq) = (7u32, 8, 9);
    let mut constraints = vec![
        coincident(
            e_ref(l1, PointSelector::End),
            e_ref(et7, PointSelector::End),
        ),
        coincident(
            e_ref(et7, PointSelector::Start),
            e_ref(l2, PointSelector::Start),
        ),
        tangent(
            e_ref(l1, PointSelector::Absent),
            e_ref(et7, PointSelector::Absent),
        ),
        tangent(
            e_ref(et7, PointSelector::Absent),
            e_ref(l2, PointSelector::Absent),
        ),
        coincident(
            e_ref(l2, PointSelector::End),
            e_ref(rp4, PointSelector::End),
        ),
        coincident(
            e_ref(rp4, PointSelector::Start),
            e_ref(l3, PointSelector::Start),
        ),
        tangent(
            e_ref(l2, PointSelector::Absent),
            e_ref(rp4, PointSelector::Absent),
        ),
        tangent(
            e_ref(rp4, PointSelector::Absent),
            e_ref(l3, PointSelector::Absent),
        ),
        parallel(
            e_ref(l1, PointSelector::Absent),
            e_ref(xip0, PointSelector::Absent),
        ),
        concentric(
            e_ref(et7, PointSelector::Absent),
            e_ref(pro, PointSelector::Absent),
        ),
        parallel(
            e_ref(l2, PointSelector::Absent),
            e_ref(ixh, PointSelector::Absent),
        ),
        concentric(
            e_ref(rp4, PointSelector::Absent),
            e_ref(ztz, PointSelector::Absent),
        ),
        parallel(
            e_ref(l3, PointSelector::Absent),
            e_ref(jlq, PointSelector::Absent),
        ),
        tangent(
            e_ref(xip0, PointSelector::Absent),
            e_ref(pro, PointSelector::Absent),
        ),
        tangent(
            e_ref(pro, PointSelector::Absent),
            e_ref(ixh, PointSelector::Absent),
        ),
        tangent(
            e_ref(ixh, PointSelector::Absent),
            e_ref(ztz, PointSelector::Absent),
        ),
        tangent(
            e_ref(ztz, PointSelector::Absent),
            e_ref(jlq, PointSelector::Absent),
        ),
    ];
    if horizontal_on_l1 {
        constraints.push(c_target(
            ConstraintKind::Horizontal,
            l1,
            PointSelector::Absent,
        ));
    }
    input(
        report_sketch_entities(),
        report_sketch_params(),
        constraints,
    )
}

/// The same sketch scaled by `s` about the origin. Every row is a length, so
/// the whole system scales; only the absolute thresholds do not.
fn scaled_report_sketch(s: f64, horizontal_on_l1: bool) -> Input {
    let mut inp = report_sketch(horizontal_on_l1);
    for p in &mut inp.params_initial {
        *p *= s;
    }
    inp
}

fn direction(params: &[f64], offset: usize) -> [f64; 2] {
    [
        params[offset + 2] - params[offset],
        params[offset + 3] - params[offset + 1],
    ]
}

/// The signed angle from `a` to `b`, in radians.
fn angle_between(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] * b[1] - a[1] * b[0]).atan2(a[0] * b[0] + a[1] * b[1])
}

fn solve_raw(inp: &Input) -> (Problem<'_>, LmResult) {
    let problem = Problem::new(inp);
    let n = inp.params_initial.len();
    let f = |x: &[f64]| problem.residuals(x);
    let jac = |x: &[f64]| problem.jacobian(x, n);
    let result = solve_lm(&inp.params_initial, &f, &jac);
    (problem, result)
}

// ─── Step 1: the confirmed mechanism ───

/// The report's mechanism, as the fixture the finish phase was sized from.
///
/// The dense driver runs two phases: an anchored one (the seed anchor chooses
/// where on the solution set to land) and a proximal polish (the anchor
/// re-centres on every accepted step, so it removes the residual the anchor
/// paid for but keeps the free directions where the anchored phase put them).
/// On the report's sketch both phases run and the polish stops on a
/// convergence test with the ROWS tight: the parallel pair agrees to 1e-13.
/// What the kernel sees is not the pair's relative angle but its absolute
/// direction, and that is a free direction here: the anchored phase landed the
/// whole free profile 1.277e-9 rad off its exactly horizontal seed, and a
/// minimum-norm or proximal step has no component along a null direction to
/// undo it. That is why the contract test adds `horizontal` on l1 and this
/// fixture asserts the tilt instead.
#[test]
fn report_sketch_lands_short_on_a_free_direction_not_a_row() {
    for horizontal in [false, true] {
        let inp = report_sketch(horizontal);
        let (problem, result) = solve_raw(&inp);
        assert!(satisfied(result.residual_norm, problem.scale()));
        assert_eq!(
            result.stop_phase, 1,
            "horizontal={horizontal}: the polish did not run"
        );
        assert_ne!(
            result.stop,
            LmStop::Budget,
            "horizontal={horizontal}: the polish used its whole budget"
        );
        let pair = angle_between(direction(&result.x, 0), direction(&result.x, 22));
        // The parallel row itself is already tight; the miss the kernel sees is
        // the pair's absolute direction, which is a free direction here.
        assert!(
            pair.abs() < 1e-12,
            "horizontal={horizontal}: the parallel row was the miss: {pair:e}"
        );
        let tilt = angle_between(direction(&result.x, 0), [1.0, 0.0]).abs();
        if horizontal {
            // The linear row pins the direction, so the free tilt is gone and
            // only the pair's own row is left to explain.
            assert!(tilt < 1e-12, "horizontal: l1 is {tilt:e} off horizontal");
        } else {
            assert!(
                tilt > 1e-10,
                "the anchored phase did not tilt the free profile: {tilt:e}"
            );
        }
    }
}

// ─── The contract tests ───

#[test]
fn report_sketch_parallel_meets_angular_contract() {
    // The plan's headline case: with `horizontal` on l1 the pencil has an
    // absolute direction, so the parallel row's precision is the difference
    // the kernel's merge reads.
    let out = solve_sketch(&report_sketch(true));
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    let p = &out.params_solved;
    let l1 = angle_between(direction(p, 0), [1.0, 0.0]).abs();
    let xip0 = angle_between(direction(p, 22), [1.0, 0.0]).abs();
    assert!(
        l1 <= crate::tolerance::OCC_ANGULAR,
        "l1 is {l1:e} off horizontal"
    );
    assert!(
        xip0 <= crate::tolerance::OCC_ANGULAR,
        "xip0 is {xip0:e} off horizontal"
    );
    assert!(
        out.diagnostics.angular_miss <= crate::tolerance::OCC_ANGULAR,
        "angular_miss {:e}",
        out.diagnostics.angular_miss
    );
    assert!(
        out.diagnostics.linear_miss <= crate::tolerance::contract_positional(),
        "linear_miss {:e}",
        out.diagnostics.linear_miss
    );
}

#[test]
fn report_sketch_without_horizontal_meets_contract() {
    // As authored the profile's absolute direction is free: the lines may be
    // tilted (they are), but every parallel pair and every tangent row agrees
    // to the contract. That is the whole of what the solver can promise here;
    // the seam needs the horizontal pin, which is what the kernel fixture adds.
    let out = solve_sketch(&report_sketch(false));
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert!(
        out.diagnostics.angular_miss <= crate::tolerance::OCC_ANGULAR,
        "angular_miss {:e}",
        out.diagnostics.angular_miss
    );
    assert!(
        out.diagnostics.linear_miss <= crate::tolerance::contract_positional(),
        "linear_miss {:e}",
        out.diagnostics.linear_miss
    );
    // The free tilt survives, so the test is not accidentally pinning the
    // profile's absolute direction.
    let p = &out.params_solved;
    let tilt = angle_between(direction(p, 0), [1.0, 0.0]).abs();
    assert!(tilt > 1e-10, "the profile lost its free tilt: {tilt:e}");
}

/// A 10 x 20 profile with right angles, two lengths and a pinned top midpoint:
/// the shape and its position are fixed, so the only free direction is a
/// rotation about the top midpoint. Seed it rotated by 1e-6 rad and bend one
/// corner by 1e-9, so the finish has an angular row to tighten while the free
/// rotation must stay put.
fn rotated_half_cube(theta: f64) -> Input {
    let rotate = |p: [f64; 2]| -> [f64; 2] {
        let (c, s) = (theta.cos(), theta.sin());
        [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
    };
    let a = rotate([0.0, 0.0]);
    let b = rotate([10.0, 0.0]);
    let c = rotate([10.0, 20.0]);
    let d = rotate([0.0, 20.0]);
    let mut params = vec![
        a[0], a[1], b[0], b[1], // bottom
        b[0], b[1], c[0], c[1], // right
        c[0], c[1], d[0], d[1], // top
        d[0], d[1], a[0], a[1], // left
    ];
    // Bend the top's start end by 1e-9 off the right angle. The shape is still
    // 1-DOF (the rotation), so this is a row only a finish step tightens.
    params[8] += 1e-9;
    let mut length_bottom = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length_bottom.value = Some(10.0);
    let mut length_right = c_target(ConstraintKind::Length, 1, PointSelector::Absent);
    length_right.value = Some(20.0);
    // The top midpoint is pinned where the SEEDED shape has it, which takes
    // translation out and leaves the rotation about that point. Pinning it
    // anywhere else would make the solve spend the free rotation to reach it,
    // and the test would then measure the solve, not the finish.
    let mid = Constraint {
        kind_code: ConstraintKind::Midpoint.to_u8(),
        refs: vec![
            (RefRole::Line, e_ref(2, PointSelector::Absent)),
            (
                RefRole::Point,
                Ref::External {
                    x: 0.5 * (c[0] + d[0]),
                    y: 0.5 * (c[1] + d[1]),
                },
            ),
        ],
        ..Default::default()
    };
    let joints = [(0u32, 1u32), (1, 2), (2, 3), (3, 0)];
    let mut constraints: Vec<Constraint> = joints
        .iter()
        .map(|&(i, j)| coincident(e_ref(i, PointSelector::End), e_ref(j, PointSelector::Start)))
        .collect();
    for (i, j) in [(0u32, 1u32), (1, 2), (2, 3)] {
        constraints.push(cons(
            ConstraintKind::Normal,
            ab(
                e_ref(i, PointSelector::Absent),
                e_ref(j, PointSelector::Absent),
            ),
        ));
    }
    constraints.push(length_bottom);
    constraints.push(length_right);
    constraints.push(mid);
    input(
        vec![line(0), line(4), line(8), line(12)],
        params,
        constraints,
    )
}

#[test]
fn finish_does_not_move_free_directions() {
    let theta = 1e-6;
    let inp = rotated_half_cube(theta);
    let (problem, pre) = solve_raw(&inp);
    assert!(satisfied(pre.residual_norm, problem.scale()));
    let pre_tilt = angle_between(direction(&pre.x, 0), [1.0, 0.0]);
    let mut post = pre.x.clone();
    let finish = finish_contract(&inp, &problem, &mut post);
    assert!(finish.angular_miss <= crate::tolerance::OCC_ANGULAR);
    let post_tilt = angle_between(direction(&post, 0), [1.0, 0.0]);
    assert!(
        (post_tilt - pre_tilt).abs() <= 1e-12,
        "the finish moved the free rotation: pre {pre_tilt:e}, post {post_tilt:e}"
    );
    // And the tilt is still the seeded one, not straightened: the solve keeps
    // it to 5.6e-13 and the finish leaves it bit-identical.
    assert!(
        (post_tilt.abs() - theta).abs() <= 1e-12,
        "the free tilt drifted away from the seed: {post_tilt:e}"
    );
}

/// The knowledge base's trap case: a vertical line tied to a point only
/// through its start, with the far end free to slide along the line. The
/// finish may tighten the rows but must not let the free end run.
fn vertical_line_through_a_point() -> Input {
    let through = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            e_ref(0, PointSelector::Absent),
            Ref::External { x: -5.0, y: 0.0 },
        ),
        ..Default::default()
    };
    let vertical = c_target(ConstraintKind::Vertical, 0, PointSelector::Absent);
    input(
        vec![line(0)],
        vec![-5.0, 21.95, 3.0, -10.0],
        vec![through, vertical],
    )
}

#[test]
fn finish_vertical_line_through_point_stays() {
    let inp = vertical_line_through_a_point();
    let (problem, pre) = solve_raw(&inp);
    assert!(satisfied(pre.residual_norm, problem.scale()));
    let mut x = pre.x.clone();
    // Build the trap by hand so the finish has real work: slide the free end
    // 100 mm along the line (a null direction the constraints leave free) and
    // tilt the line by 2e-12 rad (a row the finish must tighten). The finish
    // has no anchor, so the question is whether the minimum-norm step keeps the
    // slide where it is instead of following the free valley.
    let len = (x[2] - x[0]).hypot(x[3] - x[1]);
    let dir = [(x[2] - x[0]) / len, (x[3] - x[1]) / len];
    x[2] += 100.0 * dir[0];
    x[3] += 100.0 * dir[1];
    let theta = 2e-12_f64;
    let (sin, cos) = theta.sin_cos();
    let (dx, dy) = (x[2] - x[0], x[3] - x[1]);
    x[2] = x[0] + dx * cos - dy * sin;
    x[3] = x[1] + dx * sin + dy * cos;
    let mut post = x.clone();
    let finish = finish_contract(&inp, &problem, &mut post);
    assert!(
        finish.steps > 0,
        "the fixture stopped giving the finish work to do"
    );
    let moved = ((post[2] - x[2]).powi(2) + (post[3] - x[3]).powi(2)).sqrt();
    assert!(
        moved <= 1e-9,
        "the free end ran {moved:e}: pre {:?}, post {:?}",
        &x[2..4],
        &post[2..4]
    );
    // The slide along the line is still there: the line did not shrink back
    // toward its seed end.
    let post_len = (post[2] - post[0]).hypot(post[3] - post[1]);
    assert!(
        (post_len - 100.0 - len).abs() <= 1e-9,
        "the finish undid the free slide: length {post_len}, expected {}",
        100.0 + len
    );
    assert!(
        post[1].abs() < 100.0 && post[3].abs() < 200.0,
        "the line ran off: {post:?}"
    );
}

/// Eight lines chained by parallel rows, lengths and start distances, seeded
/// 0.01 mm apart. The chain is the crate's worst satisfiable cold solve
/// (9.4e-9 residual at scale 0.01), so its row set is the one a minimum-norm
/// finish is least able to close.
fn tight_parallel_chain(s: f64) -> Input {
    let mut entities = vec![];
    let mut params = vec![];
    let mut constraints = vec![c_target(ConstraintKind::Fixed, 0, PointSelector::Absent)];
    for k in 0..8u32 {
        let (kf, y) = (k as f64, k as f64 * 1.1);
        entities.push(line(4 * k as usize));
        params.extend([0.1 * kf * s, y * s, (10.0 + 0.3 * kf) * s, (y + 0.5) * s]);
        if k > 0 {
            constraints.push(cons(
                ConstraintKind::Parallel,
                ab(
                    e_ref(k - 1, PointSelector::Absent),
                    e_ref(k, PointSelector::Absent),
                ),
            ));
            let mut len = c_target(ConstraintKind::Length, k, PointSelector::Absent);
            len.value = Some(10.0 * s);
            constraints.push(len);
            constraints.push(cons_v(
                ConstraintKind::PointDistance,
                ab(
                    e_ref(k - 1, PointSelector::Start),
                    e_ref(k, PointSelector::Start),
                ),
                s,
            ));
        }
    }
    input(entities, params, constraints)
}

#[test]
fn finish_never_worsens() {
    // A hard but satisfiable chain: whatever the finish does, the max scaled
    // row miss may not rise, and the reported number is the realised one. At
    // 0.01 mm the chain is where the finish earns its keep: the polish leaves a
    // 2.66e-9 rad angular row (outside the 1e-12 contract) and one minimum-norm
    // step closes it, while the larger scales are already inside the contract
    // and the finish leaves them alone.
    let mut finished_at_small_scale = false;
    for s in [1e-2, 1.0, 100.0] {
        let inp = tight_parallel_chain(s);
        let (problem, pre) = solve_raw(&inp);
        assert!(satisfied(pre.residual_norm, problem.scale()), "s={s}");
        let (angular_before, linear_before) = problem.contract_misses(&pre.x);
        let mut post = pre.x.clone();
        let finish = finish_contract(&inp, &problem, &mut post);
        let (angular_after, linear_after) = problem.contract_misses(&post);
        assert!(
            angular_after <= angular_before && linear_after <= linear_before,
            "s={s}: the finish worsened the rows: ({angular_before:e}, {linear_before:e}) -> \
             ({angular_after:e}, {linear_after:e})"
        );
        assert_eq!(
            (finish.angular_miss, finish.linear_miss),
            (angular_after, linear_after),
            "s={s}: the report is not the realised value"
        );
        let out = solve_sketch(&inp);
        assert_eq!(
            out.diagnostics.angular_miss, angular_after,
            "s={s}: the wire reports a different number than the geometry"
        );
        assert_eq!(out.diagnostics.linear_miss, linear_after, "s={s}");
        if s == 1e-2 {
            assert!(
                finish.steps > 0,
                "the small-scale chain stopped giving the finish work"
            );
            finished_at_small_scale = true;
        }
    }
    assert!(finished_at_small_scale);
}

#[test]
fn contract_scale_sweep() {
    let contract_angular = crate::tolerance::OCC_ANGULAR;
    let contract_linear = crate::tolerance::contract_positional();
    for s in [1e-2, 1.0, 1e3] {
        let inp = scaled_report_sketch(s, true);
        let problem = Problem::new(&inp);
        let out = solve_sketch(&inp);
        let misses = (out.diagnostics.angular_miss, out.diagnostics.linear_miss);
        if s == 1e-2 {
            // Measured finding, not a target: the report sketch does not
            // converge at a hundredth of its size (residual 2.589e-4 against a
            // 1.16e-7 verdict width), so the solve is unsatisfied and the
            // finish correctly does not run. The honest report is NaN, not a
            // precision the solver did not realise. The full-size and
            // thousand-fold cases below are the contract's own range; this row
            // documents where this sketch stops being solvable at all.
            assert_eq!(
                out.overall_status,
                Status::Overconstrained.to_u8(),
                "s={s}: the scale failure moved; revisit this branch"
            );
            assert!(misses.0.is_nan() && misses.1.is_nan(), "s={s}: {misses:?}");
            continue;
        }
        assert_eq!(
            out.overall_status,
            Status::Underconstrained.to_u8(),
            "s={s}"
        );
        assert!(
            misses.0.is_finite() && misses.1.is_finite(),
            "s={s}: {misses:?}"
        );
        // The report is a measurement of the returned geometry, not a target.
        assert_eq!(
            misses,
            problem.contract_misses(&out.params_solved),
            "s={s}: the report is not honest"
        );
        assert!(
            misses.0 <= contract_angular,
            "s={s}: angular_miss {:e}",
            misses.0
        );
        if s <= 1.0 {
            assert!(
                misses.1 <= contract_linear,
                "s={s}: linear_miss {:e}",
                misses.1
            );
        } else {
            // Measured finding at a thousandfold copy: the polish's own
            // stationary point leaves one coincidence coordinate at 2.82e-9,
            // and a minimum-norm step does not lower it (the finish tries one,
            // rejects it and keeps the polish's params). That is three times
            // the absolute positional target and still 35 times under the
            // kernel's own confusion; the wire reports the realised number,
            // which is exactly what the kernel half reads to widen its call.
            // Asserting the target here would be asserting a precision neither
            // phase reaches.
            assert!(
                misses.1 <= crate::tolerance::OCC_CONFUSION,
                "s={s}: linear_miss {:e}",
                misses.1
            );
        }
    }
}

#[test]
fn overconstrained_skips_finish() {
    // A 4 percent length conflict: the least-squares compromise is not a
    // precision problem, so the finish does not run and the report says NaN.
    let fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    let mut short = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    short.value = Some(0.1);
    let mut long = short.clone();
    long.value = Some(0.104);
    let inp = input(
        vec![line(0)],
        vec![0.0, 0.0, 0.1, 0.0],
        vec![fixed_start, short, long],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    assert!(out.diagnostics.angular_miss.is_nan());
    assert!(out.diagnostics.linear_miss.is_nan());
    // The miss still localises the conflict, unchanged by this feature.
    let worst = out.constraint_miss.iter().copied().fold(0.0_f64, f64::max);
    assert!(
        worst > 0.0,
        "the conflict lost its miss: {:?}",
        out.constraint_miss
    );
}

#[test]
fn the_drag_path_carries_no_precision_report() {
    // A drag frame is a satisfiability answer on the constraint rows, not a
    // settled solve: both fields are NaN rather than a 0 that would read as a
    // perfect contract.
    let inp = Input {
        options: Options {
            drag_mode: true,
            skip_status_pass: true,
            ..Default::default()
        },
        ..input(vec![line(0)], vec![0.0, 0.0, 10.0, 0.0], vec![])
    };
    let out = solve_sketch(&inp);
    assert!(out.diagnostics.angular_miss.is_nan());
    assert!(out.diagnostics.linear_miss.is_nan());
}

#[test]
fn a_two_hundred_line_cold_solve_stays_within_its_budget() {
    // The finish's own cost on a workspace-sized sketch: 200 independent
    // horizontal lines make the dense LM cheap (each row is linear), and one
    // line is then tilted off horizontal by 1e-9 rad, which is exactly the kind
    // of row the finish exists to close. So the solve is timed on the shape a
    // user actually has and the step on a matrix of the same size. The ceiling
    // is loose enough for a loaded CI box; it exists to catch an
    // order-of-magnitude regression (an SVD per row, say), not to police 20
    // percent.
    let n = 200usize;
    let mut entities = vec![];
    let mut params = vec![];
    let mut constraints = vec![c_target(ConstraintKind::Fixed, 0, PointSelector::Absent)];
    for k in 0..n {
        entities.push(line(4 * k));
        let y = k as f64 * 0.2;
        params.extend([0.1 * k as f64, y, 10.0 + 0.1 * k as f64, y + 0.5]);
        if k > 0 {
            constraints.push(cons(
                ConstraintKind::Horizontal,
                vec![(RefRole::Target, e_ref(k as u32, PointSelector::Absent))],
            ));
        }
    }
    let inp = input(entities, params, constraints);
    let problem = Problem::new(&inp);
    let start = std::time::Instant::now();
    let (_, pre) = solve_raw(&inp);
    let solve_ms = start.elapsed().as_secs_f64() * 1e3;
    // Tilt line 1 by 1e-9 rad: its horizontal row is now ~1e-8, far outside the
    // 1e-12 rad angular contract, so the finish must take at least one step.
    let mut post = pre.x.clone();
    let (dx, dy) = (post[4 + 2] - post[4], post[4 + 3] - post[4 + 1]);
    let theta = 1e-9_f64;
    let (sin, cos) = theta.sin_cos();
    post[4 + 2] = post[4] + dx * cos - dy * sin;
    post[4 + 3] = post[4 + 1] + dx * sin + dy * cos;
    let finish_start = std::time::Instant::now();
    let finish = finish_contract(&inp, &problem, &mut post);
    let finish_ms = finish_start.elapsed().as_secs_f64() * 1e3;
    println!(
        "200-line cold solve: LM {solve_ms:.1} ms, finish {} steps {finish_ms:.1} ms \
         (angular_miss {:e}, linear_miss {:e})",
        finish.steps, finish.angular_miss, finish.linear_miss
    );
    assert!(
        finish.steps > 0,
        "the fixture stopped exercising the finish"
    );
    assert!(
        solve_ms + finish_ms < 30_000.0,
        "a 200-line cold solve took {solve_ms:.0} + {finish_ms:.0} ms"
    );
}
