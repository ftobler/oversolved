//! A line tangent to a spline (cubic Bezier or fit spline). The endpoint case
//! reads the spline's end tangent; the interior case needs a coincident that
//! pins a line endpoint onto the spline locus, and the row is the line
//! direction against the spline tangent at that pinned point's projection.
//! Before the projection the interior row read the Bezier at t = 0.5 and the
//! fit spline at the point closest to the line START, wherever the contact was.
use super::super::geom::{bezier_closest_t, bezier_deriv, bezier_eval};
use super::*;
use crate::fit_spline::FitSpline;

fn abs() -> PointSelector {
    PointSelector::Absent
}

fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn unit(v: [f64; 2]) -> [f64; 2] {
    let n = v[0].hypot(v[1]).max(1e-12);
    [v[0] / n, v[1] / n]
}

/// An arch whose tangent turns from up-right to down-right, so the interior
/// tangent at t = 0.25 is far from the t = 0.5 one (horizontal).
const ARCH: [f64; 8] = [0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 4.0, 0.0];

/// A three-point fit spline over the same arch, without handles.
const FIT_ARCH: [[f64; 2]; 3] = [[0.0, 0.0], [2.0, 2.0], [4.0, 0.0]];

fn fit_entity(off: usize, points: usize) -> Entity {
    Entity {
        kind: Kind::FitSpline,
        param_offset: off,
        param_count: 2 * points,
        flags: 0,
    }
}

fn fit_arch() -> FitSpline {
    FitSpline::new(&FIT_ARCH, None, None).unwrap()
}

/// The fit spline's parameter a quarter of the way along its knot range.
fn fit_quarter_u(fit: &FitSpline) -> f64 {
    let knots = fit.knots();
    knots[0] + 0.25 * (knots[knots.len() - 1] - knots[0])
}

fn fit_params() -> Vec<f64> {
    FIT_ARCH.iter().flatten().copied().collect()
}

fn pin(inp: &mut Input, params: impl IntoIterator<Item = usize>) {
    let mut mask = vec![0u8; inp.params_initial.len().div_ceil(8)];
    for i in params {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
}

/// Spline (0..8) and a line (8..12) from `start` to `end`, with a coincident
/// pinning the line's `contact` end onto the spline locus and the tangent.
fn bezier_interior(start: [f64; 2], end: [f64; 2], contact: PointSelector) -> Input {
    let mut params = ARCH.to_vec();
    params.extend_from_slice(&[start[0], start[1], end[0], end[1]]);
    input(
        vec![spline(0), ent(Kind::Line, 8)],
        params,
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, contact), e_ref(0, abs())),
            ),
            // Written spline-first: the operand pairing orders the line first.
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(0, abs()), e_ref(1, abs())),
            ),
        ],
    )
}

fn fit_interior(start: [f64; 2], end: [f64; 2]) -> Input {
    let mut params = fit_params();
    params.extend_from_slice(&[start[0], start[1], end[0], end[1]]);
    input(
        vec![fit_entity(0, 3), ent(Kind::Line, 6)],
        params,
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, PointSelector::Start), e_ref(0, abs())),
            ),
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(1, abs()), e_ref(0, abs())),
            ),
        ],
    )
}

#[test]
fn a_line_tangent_at_an_interior_bezier_point_reads_zero() {
    // The line already touches the arch at t = 0.25 along the tangent there.
    // The old row compared it with B'(0.5) (horizontal) and read about -0.85.
    let p0 = bezier_eval(&ARCH, 0.25);
    let d = unit(bezier_deriv(&ARCH, 0.25));
    let end = [p0[0] + 3.0 * d[0], p0[1] + 3.0 * d[1]];
    let inp = bezier_interior(p0, end, PointSelector::Start);
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 2, "the interior tangent survives");
    let r = p.residuals(&p.x0);
    assert_eq!(r.len(), 2, "locus coincident 1 row, tangent 1");
    assert!(r[0].abs() < 1e-9, "seed contact is off the curve: {}", r[0]);
    assert!(r[1].abs() < 1e-9, "a tangent seed read {}", r[1]);
}

#[test]
fn a_line_tangent_at_an_interior_bezier_point_solves_parallel_there() {
    // The spline and the contact end are pinned; the free end must swing the
    // line onto the spline tangent at the contact, not the midpoint tangent.
    for contact in [PointSelector::Start, PointSelector::End] {
        let p0 = bezier_eval(&ARCH, 0.25);
        let free = [p0[0] + 3.0, p0[1] - 0.5];
        let (start, end, pinned) = if contact == PointSelector::Start {
            (p0, free, 0..10)
        } else {
            (free, p0, 0..8)
        };
        let mut inp = bezier_interior(start, end, contact);
        let pins: Vec<usize> = if contact == PointSelector::Start {
            pinned.collect()
        } else {
            pinned.chain(10..12).collect()
        };
        pin(&mut inp, pins);
        let out = solve_sketch(&inp);
        assert!(
            out.diagnostics.residual_norm < 1e-8,
            "{contact:?}: tangent not satisfied: {}",
            out.diagnostics.residual_norm
        );
        let s = &out.params_solved;
        let dir = unit([s[10] - s[8], s[11] - s[9]]);
        let touch = if contact == PointSelector::Start {
            [s[8], s[9]]
        } else {
            [s[10], s[11]]
        };
        let t = bezier_closest_t(&ARCH, touch);
        assert!(
            (t - 0.25).abs() < 1e-6,
            "{contact:?}: contact moved to t={t}"
        );
        let tan = unit(bezier_deriv(&ARCH, t));
        assert!(
            cross(dir, tan).abs() < 1e-6,
            "{contact:?}: line {dir:?} is not parallel to the tangent {tan:?}"
        );
        assert!(
            dir[1].abs() > 0.3,
            "{contact:?}: the line settled on the midpoint tangent {dir:?}"
        );
    }
}

#[test]
fn a_line_meeting_a_bezier_end_reads_the_end_tangent_from_the_contact() {
    // Line end on the spline START, tangent picked on the two entities (no
    // selector on the tangent itself). The contact names the spline end, so
    // the row is the start tangent, (1,2), not the midpoint tangent.
    let mut params = ARCH.to_vec();
    params.extend_from_slice(&[-1.0, -2.0, 0.0, 0.0]);
    for (line_sel, spline_sel) in [
        (PointSelector::End, PointSelector::Start),
        // A spline end on the line body is the same endpoint joint.
        (abs(), PointSelector::Start),
    ] {
        let inp = input(
            vec![spline(0), ent(Kind::Line, 8)],
            params.clone(),
            vec![
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(1, line_sel), e_ref(0, spline_sel)),
                ),
                cons(
                    ConstraintKind::Tangent,
                    ab(e_ref(1, abs()), e_ref(0, abs())),
                ),
            ],
        );
        let p = Problem::new(&inp);
        assert_eq!(p.constraints().len(), 2, "{line_sel:?}: tangent dropped");
        let r = p.residuals(&p.x0);
        let row = *r.last().unwrap();
        assert!(
            row.abs() < 1e-9,
            "{line_sel:?}: end-tangent seed read {row}"
        );
    }
}

#[test]
fn a_line_tangent_at_an_interior_fit_spline_point_reads_zero_and_solves() {
    let fit = fit_arch();
    let u = fit_quarter_u(&fit);
    let p0 = fit.eval(u);
    let d = unit(fit.deriv(u));
    // The contact is the line start here; the next test moves it to the end,
    // where the old start projection measured the wrong point.
    let inp = fit_interior(p0, [p0[0] + 3.0 * d[0], p0[1] + 3.0 * d[1]]);
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 2, "the interior tangent survives");
    let r = p.residuals(&p.x0);
    assert!(r[1].abs() < 1e-9, "a tangent seed read {}", r[1]);

    let mut inp = fit_interior(p0, [p0[0] + 3.0, p0[1] - 0.5]);
    pin(&mut inp, 0..8);
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "tangent not satisfied: {}",
        out.diagnostics.residual_norm
    );
    let s = &out.params_solved;
    let dir = unit([s[8] - s[6], s[9] - s[7]]);
    let tan = unit(fit.deriv(fit.closest([s[6], s[7]]).u));
    assert!(
        cross(dir, tan).abs() < 1e-6,
        "line {dir:?} is not parallel to the tangent {tan:?}"
    );
}

#[test]
fn a_fit_spline_contact_at_the_line_end_projects_the_end_not_the_start() {
    // The contact is the line's END; its start sits far off near the spline's
    // far side. The old row projected the start and measured the wrong point.
    let fit = fit_arch();
    let u = fit_quarter_u(&fit);
    let p0 = fit.eval(u);
    let d = unit(fit.deriv(u));
    let start = [p0[0] - 2.0 * d[0], p0[1] - 2.0 * d[1]];
    let mut params = fit_params();
    params.extend_from_slice(&[start[0], start[1], p0[0], p0[1]]);
    let inp = input(
        vec![fit_entity(0, 3), ent(Kind::Line, 6)],
        params,
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, PointSelector::End), e_ref(0, abs())),
            ),
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(1, abs()), e_ref(0, abs())),
            ),
        ],
    );
    let p = Problem::new(&inp);
    let r = p.residuals(&p.x0);
    assert!(r[1].abs() < 1e-9, "a tangent seed read {}", r[1]);
    // Sanity: the start projects somewhere else, with a different tangent.
    let at_start = unit(fit.deriv(fit.closest(start).u));
    assert!(
        cross(d, at_start).abs() > 1e-2,
        "the fixture does not discriminate"
    );
}

#[test]
fn a_line_spline_tangent_with_no_contact_and_no_end_is_dropped() {
    // Nothing says where the line meets the spline: there is no free
    // line-to-spline form, so the row is dropped rather than read at a guess.
    let mut bezier = ARCH.to_vec();
    bezier.extend_from_slice(&[0.0, 3.0, 4.0, 3.0]);
    let mut fit = fit_params();
    fit.extend_from_slice(&[0.0, 3.0, 4.0, 3.0]);
    for (entities, params) in [
        (vec![spline(0), ent(Kind::Line, 8)], bezier.clone()),
        (vec![fit_entity(0, 3), ent(Kind::Line, 6)], fit.clone()),
    ] {
        let tangent =
            |sel: PointSelector| cons(ConstraintKind::Tangent, ab(e_ref(1, abs()), e_ref(0, sel)));
        let dropped = input(entities.clone(), params.clone(), vec![tangent(abs())]);
        let p = Problem::new(&dropped);
        assert_eq!(
            p.constraints().len(),
            0,
            "a free line/spline tangent has a row"
        );
        let out = solve_sketch(&dropped);
        assert_ne!(
            out.constraint_flags[0] & crate::CONSTRAINT_FLAG_DROPPED,
            0,
            "the drop must be reported"
        );
        // An explicit spline end on the tangent itself is the endpoint form.
        let at_end = input(entities, params, vec![tangent(PointSelector::End)]);
        assert_eq!(Problem::new(&at_end).constraints().len(), 1);
    }
}

#[test]
fn an_arc_end_on_a_spline_locus_is_still_not_a_tangent_contact() {
    // The interior relaxation is for a line only: a curve partner reads the
    // spline's END tangent, so a locus spline side would measure the wrong
    // point and stays dropped.
    let mut params = ARCH.to_vec();
    params.extend_from_slice(&[0.0, -5.0, 5.0, 90.0, 120.0]);
    let inp = input(
        vec![spline(0), ent(Kind::Arc, 8)],
        params,
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, PointSelector::Start), e_ref(0, abs())),
            ),
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(1, abs()), e_ref(0, abs())),
            ),
        ],
    );
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 1, "only the coincident survives");
}

#[test]
fn line_spline_interior_tangent_jacobian_matches_finite_difference() {
    // The tangent row goes through the finite-difference fallback; this checks
    // that the projected contact keeps it smooth around a perturbed iterate.
    let fit = fit_arch();
    let u = fit_quarter_u(&fit);
    let fp = fit.eval(u);
    let bp = bezier_eval(&ARCH, 0.3);
    let mut params = ARCH.to_vec();
    params.extend_from_slice(&[bp[0], bp[1], bp[0] + 2.0, bp[1] + 1.0]);
    params.extend(fit_params());
    params.extend_from_slice(&[fp[0] + 2.0, fp[1] + 1.0, fp[0], fp[1]]);
    let entities = vec![
        spline(0),
        ent(Kind::Line, 8),
        fit_entity(12, 3),
        ent(Kind::Line, 18),
    ];
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(1, PointSelector::Start), e_ref(0, abs())),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(1, abs()), e_ref(0, abs())),
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(3, PointSelector::End), e_ref(2, abs())),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(2, abs()), e_ref(3, abs())),
        ),
    ];
    let inp = input(entities, params, constraints);
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 4);
    let x: Vec<f64> = inp
        .params_initial
        .iter()
        .enumerate()
        .map(|(i, &v)| v + 0.05 * ((i as f64) * 1.3).sin())
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
    // The finite differences above compare the row with itself; the value is
    // checked independently at the same perturbed iterate: the line direction
    // against the spline tangent at the projection of the pinned endpoint.
    let r = p.residuals(&x);
    let sp = &x[0..8];
    let dir = unit([x[10] - x[8], x[11] - x[9]]);
    let tan = unit(bezier_deriv(sp, bezier_closest_t(sp, [x[8], x[9]])));
    let want = p.line_len0(1) * cross(dir, tan);
    assert!((r[1] - want).abs() < 1e-12, "Bezier row {} != {want}", r[1]);
    let pts: Vec<[f64; 2]> = x[12..18].chunks(2).map(|c| [c[0], c[1]]).collect();
    let fit = FitSpline::new(&pts, None, None).unwrap();
    let dir = unit([x[20] - x[18], x[21] - x[19]]);
    let tan = unit(fit.deriv(fit.closest([x[20], x[21]]).u));
    let want = p.fit_len0(2) * cross(dir, tan);
    assert!((r[3] - want).abs() < 1e-12, "fit row {} != {want}", r[3]);
}

#[test]
fn an_end_named_on_the_tangent_wins_over_the_contact() {
    // A line closing the arch: one coincident at each spline end, the tangent
    // naming the spline END. The contact map keeps only the first coincident,
    // so with the START join listed first the row read the start tangent and
    // the outcome hung on constraint order.
    let end_tan = unit(bezier_deriv(&ARCH, 1.0));
    // The line runs from the spline end back along the end tangent; its far
    // end is coincident with the spline start only by constraint, not seed.
    let mut params = ARCH.to_vec();
    params.extend_from_slice(&[4.0, 0.0, 4.0 - 3.0 * end_tan[0], -3.0 * end_tan[1]]);
    let join_start = cons(
        ConstraintKind::Coincident,
        ab(e_ref(1, PointSelector::End), e_ref(0, PointSelector::Start)),
    );
    let join_end = cons(
        ConstraintKind::Coincident,
        ab(e_ref(1, PointSelector::Start), e_ref(0, PointSelector::End)),
    );
    let tangent = cons(
        ConstraintKind::Tangent,
        ab(e_ref(1, abs()), e_ref(0, PointSelector::End)),
    );
    for joins in [
        vec![join_start.clone(), join_end.clone()],
        vec![join_end, join_start],
    ] {
        let mut constraints = joins;
        constraints.push(tangent.clone());
        let inp = input(
            vec![spline(0), ent(Kind::Line, 8)],
            params.clone(),
            constraints,
        );
        let p = Problem::new(&inp);
        assert_eq!(p.constraints().len(), 3);
        let r = p.residuals(&p.x0);
        let row = *r.last().unwrap();
        assert!(row.abs() < 1e-9, "the end tangent seed read {row}");
    }
}

#[test]
fn a_line_meeting_a_fit_spline_end_reads_the_end_tangent_from_the_contact() {
    // The fit-spline twin of the Bezier end joint: the line ends on the
    // spline START along its start derivative, the tangent names no end.
    let fit = fit_arch();
    let d = unit(fit.derivative(0));
    let mut params = fit_params();
    params.extend_from_slice(&[-2.0 * d[0], -2.0 * d[1], 0.0, 0.0]);
    let inp = input(
        vec![fit_entity(0, 3), ent(Kind::Line, 6)],
        params,
        vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, PointSelector::End), e_ref(0, PointSelector::Start)),
            ),
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(1, abs()), e_ref(0, abs())),
            ),
        ],
    );
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 2);
    let r = p.residuals(&p.x0);
    assert!(r[2].abs() < 1e-9, "the start tangent seed read {}", r[2]);
}
