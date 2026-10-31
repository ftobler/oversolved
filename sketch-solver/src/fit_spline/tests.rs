//! Golden parity and edge cases for the interpolating spline.
//!
//! The fixture is `golden.json`, generated from OCP's `GeomAPI_Interpolate` by
//! `tests/fit_spline_golden.py`. It is the single oracle shared with the
//! TypeScript mirror, so a drift in either implementation fails here or there
//! instead of in a kernel test.

use super::*;

const GOLDEN: &str = include_str!("golden.json");

fn golden() -> serde_json::Value {
    serde_json::from_str(GOLDEN).expect("golden.json parses")
}

fn as_point(v: &serde_json::Value) -> [f64; 2] {
    [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]
}

fn point_list(v: &serde_json::Value) -> Vec<[f64; 2]> {
    v.as_array().unwrap().iter().map(as_point).collect()
}

fn assert_close(actual: f64, expected: f64, what: &str) {
    let scale = actual.abs().max(expected.abs()).max(1.0);
    assert!(
        (actual - expected).abs() <= 1e-12 * scale,
        "{what}: {actual} != {expected} (delta {})",
        (actual - expected).abs()
    );
}

fn assert_points_close(actual: &[[f64; 2]], expected: &[[f64; 2]], what: &str) {
    assert_eq!(actual.len(), expected.len(), "{what}: length");
    for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_close(a[0], e[0], &format!("{what}[{i}].x"));
        assert_close(a[1], e[1], &format!("{what}[{i}].y"));
    }
}

fn chord_params(points: &[[f64; 2]]) -> Vec<f64> {
    let mut us = vec![0.0];
    for i in 1..points.len() {
        let h = (points[i][0] - points[i - 1][0]).hypot(points[i][1] - points[i - 1][1]);
        us.push(us[i - 1] + h);
    }
    us
}

#[test]
fn every_golden_case_matches_ocp() {
    let fixture = golden();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 28, "the fixture lost cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let points = point_list(&case["points"]);
        let handle_start = case["handle_start"]
            .as_array()
            .map(|v| [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]);
        let handle_end = case["handle_end"]
            .as_array()
            .map(|v| [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]);
        let curve = FitSpline::new(&points, handle_start, handle_end)
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));

        assert_points_close(&curve.poles(), &point_list(&case["chain"]), name);

        let us = chord_params(&points);
        assert_points_close(
            &curve.knots().iter().map(|&u| [u, 0.0]).collect::<Vec<_>>(),
            &us.iter().map(|&u| [u, 0.0]).collect::<Vec<_>>(),
            &format!("{name} chord params"),
        );

        // The end derivatives are the strongest check on the handle and
        // Lagrange rules: OCP's `tangent_start`/`tangent_end` are the exact
        // vectors it used, scaled or not.
        let tangent_start = as_point(&case["tangent_start"]);
        let tangent_end = as_point(&case["tangent_end"]);
        assert_points_close(
            &[curve.derivative(0)],
            &[tangent_start],
            &format!("{name} start derivative"),
        );
        assert_points_close(
            &[curve.derivative(curve.point_count() - 1)],
            &[tangent_end],
            &format!("{name} end derivative"),
        );

        // 9 interior samples per span, at the chord parameter fractions.
        let spans = case["samples"].as_array().unwrap();
        assert_eq!(spans.len(), points.len() - 1, "{name}: span count");
        for (i, span) in spans.iter().enumerate() {
            for (k, expected) in span.as_array().unwrap().iter().enumerate() {
                let fraction = (k + 1) as f64 / 10.0;
                let u = us[i] + (us[i + 1] - us[i]) * fraction;
                let actual = curve.eval(u);
                let expected = as_point(expected);
                assert_close(
                    actual[0],
                    expected[0],
                    &format!("{name} span {i} sample {k}.x"),
                );
                assert_close(
                    actual[1],
                    expected[1],
                    &format!("{name} span {i} sample {k}.y"),
                );
            }
        }

        // The C2 representation is only cubic for N >= 4; the smaller cases are
        // a line and a quadratic, so their OCP knot lists are shorter by design.
        if case["degree"].as_u64() == Some(3) {
            let knots: Vec<f64> = case["knots"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            assert_eq!(curve.knots().len(), knots.len(), "{name}: knot count");
            for (a, e) in curve.knots().iter().zip(&knots) {
                assert_close(*a, *e, &format!("{name} knot"));
            }
            let mults: Vec<u64> = case["mults"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap())
                .collect();
            assert_eq!(mults.len(), knots.len());
            assert_eq!(mults.first(), Some(&4));
            assert_eq!(mults.last(), Some(&4));
        }
    }
}

#[test]
fn every_golden_split_matches_ocp() {
    // `Geom_BezierCurve.Segment` is the oracle: the same fixture pins the Rust
    // and the TypeScript split against OCP instead of against each other.
    let fixture = golden();
    let splits = fixture["splits"].as_array().unwrap();
    assert!(splits.len() >= 4, "the fixture lost its split cases");
    for case in splits {
        let name = case["name"].as_str().unwrap();
        let control: [[f64; 2]; 4] = point_list(&case["control"]).try_into().unwrap();
        let t0 = case["t0"].as_f64().unwrap();
        let t1 = case["t1"].as_f64().unwrap();
        let actual = split_bezier(&control, t0, t1);
        assert_points_close(&actual, &point_list(&case["poles"]), name);
    }
}

#[test]
fn a_split_at_the_far_joint_stays_finite() {
    // The old head-first rescale divided by `1 - t0`; at t0 == 1.0 that is 0/0
    // and every pole came back NaN. A cut one ulp below a piece joint is the
    // case that produces it (see `a_cut_one_ulp_below_a_joint_...`).
    let control = [[0.0, 0.0], [1.0, 2.0], [2.0, -1.0], [3.0, 1.0]];
    let out = split_bezier(&control, 1.0, 1.0);
    assert!(out.iter().flatten().all(|v| v.is_finite()), "{out:?}");
    assert_points_close(&out, &[control[3]; 4], "split at the joint");
}

#[test]
fn a_cut_one_ulp_below_a_joint_keeps_the_sub_chain_finite() {
    // Chosen so the head fraction `(u0 - a) / (b - a)` rounds up to exactly
    // 1.0: the joint itself. `sub_chain` still keeps the piece because `b` is
    // strictly above `u0`, so the split goes through `split_bezier(1.0, 1.0)`.
    let points = [
        [0.0, 0.0],
        [1.6733906860886536, 1.6094009701277372],
        [3.161360788020988, -2.829537828938908],
        [5.598324259115278, -2.6156588303029107],
    ];
    let curve = FitSpline::new(&points, None, None).unwrap();
    let (a, b) = (curve.knots()[1], curve.knots()[2]);
    let u0 = f64::from_bits(b.to_bits() - 1);
    assert_eq!(
        ((u0 - a) / (b - a)).clamp(0.0, 1.0),
        1.0,
        "the fixture no longer rounds the head fraction onto the joint"
    );
    let (poles, knots) = curve.sub_chain(u0, b);
    assert_eq!(poles.len(), 3 * (knots.len() - 1) + 1);
    assert!(poles.iter().flatten().all(|v| v.is_finite()), "{poles:?}");
    // And the sub-chain still ends on the joint it was cut at.
    assert_points_close(&[poles[poles.len() - 1]], &[curve.eval(b)], "end");
}

#[test]
fn the_one_sided_scaled_cases_are_in_the_fixture() {
    // The generic loop above reads these like any other case; this pins that
    // the fixture still carries the one-sided ScaleTangents cases, whose
    // end-only window is an extrapolation by OCCT's own rule.
    let fixture = golden();
    let names: Vec<String> = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect();
    for n in 3..=5 {
        for side in ["start", "end"] {
            let name = format!("n{n}_{side}_scale");
            assert!(names.contains(&name), "missing {name}");
        }
    }
}

#[test]
fn two_points_with_one_handle_use_the_chord_at_the_free_end() {
    // OCP leaves the free end derivative at ZERO for this one case (its
    // `PerformNonPeriodic` never calls `BuildTangents` below three points).
    // That is a degenerate curve no user wants, so D4 uses the chord rule; the
    // expected piece is computed by hand here to pin the deviation.
    let points = [[0.0, 0.0], [2.0, 0.0]];
    let curve = FitSpline::new(&points, Some([1.0, 1.0]), None).unwrap();
    // D0 = 3 (c1 - P0) / h0 = 3 (1, 1) / 2 = (1.5, 1.5).
    assert_points_close(&[curve.derivative(0)], &[[1.5, 1.5]], "start derivative");
    // The free end is the chord: (2, 0) - (0, 0) over h = 2, i.e. (1, 0).
    assert_points_close(&[curve.derivative(1)], &[[1.0, 0.0]], "free end derivative");
    assert_points_close(
        &curve.poles(),
        &[[0.0, 0.0], [1.0, 1.0], [4.0 / 3.0, 0.0], [2.0, 0.0]],
        "poles",
    );
}

#[test]
fn a_closed_point_list_is_finite_and_closes() {
    // A closed fit spline is C0 at the seam, like CadQuery's default; the test
    // is that the chain exists and lands back on the first point.
    let points = [[0.0, 0.0], [1.0, 1.0], [2.0, 0.0], [1.0, -1.0], [0.0, 0.0]];
    let curve = FitSpline::new(&points, None, None).unwrap();
    let start = curve.eval(curve.knots()[0]);
    let end = curve.eval(*curve.knots().last().unwrap());
    assert_points_close(&[start, end], &[[0.0, 0.0], [0.0, 0.0]], "seam");
    assert!(curve.poles().iter().flatten().all(|v| v.is_finite()));
}

#[test]
fn collinear_points_produce_a_straight_chain() {
    let points = [[0.0, 0.0], [1.0, 2.0], [2.0, 4.0], [3.0, 6.0]];
    let curve = FitSpline::new(&points, None, None).unwrap();
    for pole in curve.poles() {
        // Cross product with the line direction (1, 2) is zero on the line.
        let cross = (pole[0] - points[0][0]) * 2.0 - (pole[1] - points[0][1]);
        assert!(cross.abs() < 1e-12, "pole {pole:?} left the line");
    }
}

#[test]
fn a_large_coordinate_offset_keeps_relative_precision() {
    // The solver works in absolute sketch coordinates, so a shape placed at
    // 1e4 must interpolate the same way; only the representation noise grows.
    let fixture = golden();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ex010")
        .unwrap();
    let base = point_list(&case["points"]);
    let offset = 1e4;
    let shifted: Vec<[f64; 2]> = base
        .iter()
        .map(|p| [p[0] + offset, p[1] + offset])
        .collect();
    let curve = FitSpline::new(&shifted, None, None).unwrap();
    let expected: Vec<[f64; 2]> = point_list(&case["chain"])
        .iter()
        .map(|p| [p[0] + offset, p[1] + offset])
        .collect();
    assert_eq!(curve.poles().len(), expected.len());
    for (actual, expected) in curve.poles().iter().zip(&expected) {
        assert!(
            (actual[0] - expected[0]).abs() < 1e-8 && (actual[1] - expected[1]).abs() < 1e-8,
            "offset pole {actual:?} != {expected:?}"
        );
    }
}

#[test]
fn a_zero_span_is_a_clean_error_not_a_nan() {
    let points = [[0.0, 0.0], [0.0, 0.0], [1.0, 1.0]];
    assert_eq!(
        FitSpline::new(&points, None, None),
        Err(FitSplineError::CoincidentPoints(0, 1))
    );
    // The solver's floored variant stays finite so a constrained coincidence
    // can be solved back out of the degeneracy.
    let curve = FitSpline::with_min_span(&points, None, None, 1e-9).unwrap();
    assert!(curve.poles().iter().flatten().all(|v| v.is_finite()));
}

#[test]
fn closest_point_picks_the_right_piece_and_signs_by_the_tangent() {
    // A curve running left to right: a point above reads positive, below
    // negative, matching `spline_point_residual`.
    let points = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]];
    let curve = FitSpline::new(&points, None, None).unwrap();
    let above = curve.closest([1.0, 1.0]);
    let below = curve.closest([1.0, -1.0]);
    assert_close(above.distance, 1.0, "above distance");
    assert_close(below.distance, 1.0, "below distance");
    assert!(above.signed > 0.0 && below.signed < 0.0);

    // A point at the joint is closest to the joint itself, which belongs to
    // both adjacent pieces; the reported parameter is the knot.
    let bent = FitSpline::new(&[[0.0, 0.0], [1.0, 2.0], [3.0, 1.0]], None, None).unwrap();
    let at_joint = bent.closest([1.0, 2.0]);
    assert_close(at_joint.distance, 0.0, "joint distance");
    assert_close(at_joint.u, bent.knots()[1], "joint parameter");
    let on_second = bent.closest([2.5, 1.8]);
    assert!(on_second.u > bent.knots()[1], "closest point is on piece 1");
}

#[test]
fn a_sub_chain_reproduces_the_curve() {
    let points = [[0.0, 0.0], [1.0, 2.0], [3.0, 1.0], [4.0, 3.0]];
    let curve = FitSpline::new(&points, None, None).unwrap();
    let (poles, knots) = curve.sub_chain(0.3, 2.6);
    assert_eq!(poles.len(), 3 * (knots.len() - 1) + 1);
    // Evaluate the sub-chain as a chain of cubic Beziers at a few points and
    // compare against the parent curve at the same chord parameter.
    for k in 0..=8 {
        let u = 0.3 + (2.6 - 0.3) * k as f64 / 8.0;
        let piece = knots
            .windows(2)
            .position(|w| u >= w[0] && u <= w[1])
            .unwrap();
        let h = knots[piece + 1] - knots[piece];
        let t = ((u - knots[piece]) / h).clamp(0.0, 1.0);
        let ctrl = [
            poles[3 * piece],
            poles[3 * piece + 1],
            poles[3 * piece + 2],
            poles[3 * piece + 3],
        ];
        let actual = bezier_eval(&ctrl, t);
        let expected = curve.eval(u);
        assert_close(actual[0], expected[0], "sub-chain x");
        assert_close(actual[1], expected[1], "sub-chain y");
    }
}

#[test]
fn the_param_layout_refuses_every_malformed_wire_shape() {
    assert_eq!(
        ParamLayout::from_wire(6, 0),
        Ok(ParamLayout {
            points: 3,
            handle_start: false,
            handle_end: false
        })
    );
    assert_eq!(
        ParamLayout::from_wire(8, HANDLE_FLAGS),
        Ok(ParamLayout {
            points: 2,
            handle_start: true,
            handle_end: true
        })
    );
    // A line's count, an odd count, one point and one too many.
    assert!(ParamLayout::from_wire(5, 0).is_err());
    assert!(ParamLayout::from_wire(7, 0).is_err());
    assert!(ParamLayout::from_wire(2, 0).is_err());
    assert!(ParamLayout::from_wire(2 * 65, 0).is_err());
    // An unknown flag bit is its own error, not a geometry complaint.
    assert_eq!(
        ParamLayout::from_wire(6, 0b100),
        Err(FitSplineError::BadFlags(0b100))
    );
    assert_eq!(ParamLayout::from_wire(4, 0).unwrap().points, 2);
}

#[test]
fn split_params_reads_points_then_handles() {
    let layout = ParamLayout {
        points: 2,
        handle_start: true,
        handle_end: true,
    };
    let params = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0];
    let (points, start, end) = split_params(&params, layout);
    assert_eq!(points, vec![[0.0, 1.0], [2.0, 3.0]]);
    assert_eq!(start, Some([4.0, 5.0]));
    assert_eq!(end, Some([6.0, 7.0]));
}
