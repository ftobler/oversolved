use super::*;

fn line(p0: Vec2, p1: Vec2) -> Curve {
    Curve::Line { p0, p1 }
}

#[test]
fn line_through_ellipse_center() {
    let e = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 1.0,
        theta: 0.0,
    };
    let h = intersect_curves(&line([-4.0, 0.0], [4.0, 0.0]), &e);
    assert_eq!(h.len(), 2);
    let mut xs: Vec<f64> = h.iter().map(|x| x.point[0]).collect();
    xs.sort_by(|p, q| p.total_cmp(q));
    assert!((xs[0] + 3.0).abs() < 1e-9 && (xs[1] - 3.0).abs() < 1e-9);
}

#[test]
fn circle_circle_two_points() {
    let a = Curve::Circle {
        c: [0.0, 0.0],
        r: 1.0,
    };
    let b = Curve::Circle {
        c: [1.0, 0.0],
        r: 1.0,
    };
    let h = intersect_curves(&a, &b);
    assert_eq!(h.len(), 2);
    for hit in &h {
        assert!((hit.point[0] - 0.5).abs() < 1e-9);
    }
}

#[test]
fn circle_circle_tangent_reports_one_point() {
    // A coincident double root is a real contact for the closed-form arms,
    // unlike the sign-change scan's no-tangency rule. The two rims touch at
    // exactly (1,0).
    let a = Curve::Circle {
        c: [0.0, 0.0],
        r: 1.0,
    };
    let b = Curve::Circle {
        c: [2.0, 0.0],
        r: 1.0,
    };
    let h = intersect_curves(&a, &b);
    assert_eq!(h.len(), 1);
    assert!((h[0].point[0] - 1.0).abs() < 1e-9 && (h[0].point[1]).abs() < 1e-9);
}

#[test]
fn line_tangent_to_ellipse_reports_one_point() {
    // Zero discriminant in the closed-form line/ellipse arm: y = 1 touches
    // the ellipse a=2, b=1 at (0,1) and must report the double root once.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 2.0,
        b: 1.0,
        theta: 0.0,
    };
    let h = intersect_curves(&line([-3.0, 1.0], [3.0, 1.0]), &ell);
    assert_eq!(h.len(), 1);
    assert!((h[0].point[0]).abs() < 1e-9 && (h[0].point[1] - 1.0).abs() < 1e-9);
}

#[test]
fn line_near_tangent_to_ellipse_reports_the_foot() {
    // The solver leaves a converged line/ellipse tangency a hair short of
    // the rim; the miss-side collapse must report that foot, or the region
    // the line closes never builds. lc's rule in the ellipse's terms.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 2.0,
        b: 1.0,
        theta: 0.0,
    };
    for gap in [1e-9, 1e-7, 5e-6, 9e-6] {
        let h = intersect_curves(&line([-3.0, 1.0 + gap], [3.0, 1.0 + gap]), &ell);
        assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
        assert!(
            h[0].point[0].abs() < 1e-6 && (h[0].point[1] - 1.0).abs() < 1e-4,
            "gap {gap:e}: the foot of the closest approach: {:?}",
            h[0].point
        );
    }
}

#[test]
fn line_clear_of_an_ellipse_stays_a_miss() {
    // Ten times the budget: no sign change and no collapse, so a genuine
    // miss still reports nothing and cannot split either curve.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 2.0,
        b: 1.0,
        theta: 0.0,
    };
    for gap in [1.1e-5, 1e-4, 1e-3, 1e-1] {
        let h = intersect_curves(&line([-3.0, 1.0 + gap], [3.0, 1.0 + gap]), &ell);
        assert!(h.is_empty(), "gap {gap:e} stays a miss");
    }
}

#[test]
fn line_near_tangent_off_its_segment_switches_at_the_merge_overhang() {
    // The foot of the closest approach falls before the segment's start by
    // `overhang` world units. Within MERGE the foot is clamped to the end
    // vertex and still contacts; past MERGE there is nothing to clamp to
    // and the pair stays a miss, even though the end vertex itself sits
    // well inside the gap budget. The existing off-segment test pins the
    // far 1.0 overhang; these pin the switch just around MERGE.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 2.0,
        b: 1.0,
        theta: 0.0,
    };
    let gap = 1e-6;
    let just_inside = intersect_curves(&line([5e-6, 1.0 + gap], [2.0, 1.0 + gap]), &ell);
    assert_eq!(just_inside.len(), 1, "half-MERGE overhang still contacts");
    assert!(
        (just_inside[0].point[0] - 5e-6).abs() < 1e-9,
        "the clamped end vertex, not the true foot: {:?}",
        just_inside[0].point
    );
    let just_outside = intersect_curves(&line([2e-5, 1.0 + gap], [2.0, 1.0 + gap]), &ell);
    assert!(
        just_outside.is_empty(),
        "twice-MERGE overhang has no contact to make"
    );
}

#[test]
fn line_near_tangent_off_its_segment_stays_a_miss() {
    // The foot falls beyond the segment end by well over MERGE, so there
    // is nothing to contact: the collapse must not extend the segment.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 2.0,
        b: 1.0,
        theta: 0.0,
    };
    let h = intersect_curves(&line([1.0, 1.0000001], [3.0, 1.0000001]), &ell);
    assert!(h.is_empty());
}

#[test]
fn spline_near_tangent_to_ellipse_reports_the_foot() {
    // The sampled-root half of the same bug: a spline approaching the
    // ellipse's top vertex tangentially with no sign change used to report
    // nothing. The sampled valley must collapse to its foot.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 2.0,
        theta: 0.0,
    };
    // Symmetric cubic whose horizontal tangent at t = 1/2 dips to y = g.
    let spline = |g: f64| Curve::Bezier {
        p0: [-2.0, 4.0 + g],
        c1: [-1.0, 4.0 / 3.0 + g],
        c2: [1.0, 4.0 / 3.0 + g],
        p3: [2.0, 4.0 + g],
    };
    for gap in [0.0, 1e-7] {
        let h = intersect_curves(&spline(gap), &ell);
        assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
        assert!(
            h[0].point[0].abs() < 1e-6 && (h[0].point[1] - 2.0).abs() < 1e-5,
            "gap {gap:e}: the foot at the ellipse apex: {:?}",
            h[0].point
        );
    }
}

#[test]
fn spline_clear_of_an_ellipse_stays_a_miss() {
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 2.0,
        theta: 0.0,
    };
    let spline = Curve::Bezier {
        p0: [-2.0, 4.01],
        c1: [-1.0, 4.0 / 3.0 + 0.01],
        c2: [1.0, 4.0 / 3.0 + 0.01],
        p3: [2.0, 4.01],
    };
    assert!(intersect_curves(&spline, &ell).is_empty());
}

#[test]
fn circle_near_tangent_to_ellipse_reports_the_foot() {
    // Conic-conic through the same sampled scan: the circle's bottom rim
    // stops `gap` short of the ellipse apex.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 2.0,
        theta: 0.0,
    };
    for gap in [1e-7, 5e-6] {
        let circ = Curve::Circle {
            c: [0.0, 3.0 + gap],
            r: 1.0,
        };
        let h = intersect_curves(&circ, &ell);
        assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
        assert!(
            h[0].point[0].abs() < 1e-6 && (h[0].point[1] - 2.0).abs() < 1e-4,
            "gap {gap:e}: the foot at the rim: {:?}",
            h[0].point
        );
    }
    let circ = Curve::Circle {
        c: [0.0, 3.0 + 1e-2],
        r: 1.0,
    };
    assert!(intersect_curves(&circ, &ell).is_empty(), "a real miss");
}

#[test]
fn bezier_bezier_near_touch_reports_the_foot() {
    // Two splines that never cross but come within the budget: the AABB
    // search prunes them (only a tangency leaves this picture), so the
    // near-touch fallback must produce the foot.
    let a = Curve::Bezier {
        p0: [-1.0, 0.0],
        c1: [0.0, 0.0],
        c2: [1.0, 0.0],
        p3: [2.0, 0.0],
    };
    let b = |g: f64| Curve::Bezier {
        p0: [0.0, 1.0 + g],
        c1: [1.0 / 3.0, -1.0 / 3.0 + g],
        c2: [2.0 / 3.0, -1.0 / 3.0 + g],
        p3: [1.0, 1.0 + g],
    };
    for gap in [0.0, 1e-7, 1e-6] {
        let h = intersect_curves(&a, &b(gap));
        assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
        assert!(
            (h[0].point[0] - 0.5).abs() < 1e-3 && h[0].point[1].abs() < 1e-4,
            "gap {gap:e}: the foot at (0.5, 0): {:?}",
            h[0].point
        );
    }
    assert!(
        intersect_curves(&a, &b(1e-2)).is_empty(),
        "a real miss stays a miss"
    );
}

#[test]
fn bezier_bezier_gap_just_inside_and_outside_the_budget_splits_cleanly() {
    // A genuine spline pair (control points far apart, so the coincident
    // short-circuit cannot answer) whose minimum distance to the straight
    // carrier is 8e-6 or 2e-5 against a 1.5e-5 budget: the inside case must
    // report its foot, the outside case must stay a miss.
    let a = Curve::Bezier {
        p0: [-1.0, 0.0],
        c1: [0.0, 0.0],
        c2: [1.0, 0.0],
        p3: [2.0, 0.0],
    };
    // Symmetric cubic whose midpoint dips to y = g.
    let b = |g: f64| Curve::Bezier {
        p0: [0.0, 4.0 + g],
        c1: [1.0 / 3.0, -4.0 / 3.0 + g],
        c2: [2.0 / 3.0, -4.0 / 3.0 + g],
        p3: [1.0, 4.0 + g],
    };
    let inside = intersect_curves(&a, &b(8e-6));
    assert_eq!(inside.len(), 1, "8e-6 is inside the budget: {inside:?}");
    assert!(
        (inside[0].point[0] - 0.5).abs() < 1e-3 && inside[0].point[1].abs() < 1e-5,
        "the foot at (0.5, 0): {:?}",
        inside[0].point
    );
    assert!(
        intersect_curves(&a, &b(2e-5)).is_empty(),
        "2e-5 is outside the budget and stays a miss"
    );
}

#[test]
fn bezier_near_touch_rejects_a_run_together_beyond_the_coincident_shortcut() {
    // Two long offset copies: their control points sit 5e-4 apart, forty
    // times POINT_MERGE, so `ctrl_polygons_coincident` cannot answer and
    // the fallback runs. Every coarse sample of one sits within the 1e-3
    // budget of the other, so the run heuristic must read the pair as two
    // curves running together and report no contact.
    let a: BzCtrl = [[-100.0, 0.0], [-50.0, 20.0], [50.0, -20.0], [100.0, 0.0]];
    let b: BzCtrl = [
        [-100.0, 5e-4],
        [-50.0, 20.0 + 5e-4],
        [50.0, -20.0 + 5e-4],
        [100.0, 5e-4],
    ];
    assert!(!ctrl_polygons_coincident(&a, &b));
    let tol = tangent_gap_tol(bezier_scale(&a).min(bezier_scale(&b)), TOL_TOPOLOGY_MERGE);
    assert!(tol > 5e-4, "the offset must sit inside the budget: {tol:e}");
    assert!(
        bezier_near_touch(&a, &b, tol).is_none(),
        "a run together is not a graze"
    );
}

#[test]
fn a_shallow_lens_never_reports_a_third_contact() {
    // A pair that really crosses in a shallow lens reports its crossings,
    // not a phantom graze in the middle of the lens: a third point between
    // the two crossings would slice a sliver out of both curves.
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 2.0,
        theta: 0.0,
    };
    for r in [1.0, 1.0003] {
        for depth in [1e-2, 1e-3, 1e-4] {
            let circ = Curve::Circle {
                c: [0.0, r + 2.0 - depth],
                r,
            };
            let h = intersect_curves(&circ, &ell);
            assert!(
                h.len() <= 2,
                "r {r} depth {depth:e}: no third point, got {h:?}"
            );
            for hit in &h {
                assert!(
                    (hit.point[1] - 1.9998).abs() < 2e-3,
                    "r {r} depth {depth:e}: contact near the apex, got {:?}",
                    hit.point
                );
            }
        }
    }
}

#[test]
fn nearly_parallel_beziers_stay_no_contact() {
    // Two long near-parallel splines within the budget along a stretch are
    // a degenerate overlap, not a graze: the fallback must not invent a
    // contact point for them.
    let a = Curve::Bezier {
        p0: [0.0, 0.0],
        c1: [1.0, 2.0],
        c2: [2.0, -2.0],
        p3: [3.0, 0.0],
    };
    let b = Curve::Bezier {
        p0: [0.0, 1e-6],
        c1: [1.0, 2.0 + 1e-6],
        c2: [2.0, -2.0 + 1e-6],
        p3: [3.0, 1e-6],
    };
    let h = intersect_curves(&a, &b);
    assert!(h.is_empty(), "a run together is not a graze: {h:?}");
}

#[test]
fn a_near_tangency_at_the_scanned_ellipses_seam_reports_the_foot() {
    // The periodic scan's seam window wraps ts[0] between its neighbours, so
    // a foot sitting exactly on the 0/2pi seam is found by that window
    // alone. A circle whose rim stops 5e-6 short of the ellipse's +a apex:
    // no crossing anywhere, minimum gap on the seam.
    let gap = 5e-6;
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 2.0,
        b: 1.0,
        theta: 0.0,
    };
    let circ = Curve::Circle {
        c: [3.0 + gap, 0.0],
        r: 1.0,
    };
    let h = intersect_curves(&ell, &circ);
    assert_eq!(h.len(), 1, "one virtual tangent point on the seam: {h:?}");
    assert!(
        (h[0].point[0] - 2.0).abs() < 1e-6 && h[0].point[1].abs() < 1e-6,
        "the foot at the ellipse apex: {:?}",
        h[0].point
    );
}

/// The review family of sub-sample lenses: an `a x b` ellipse at the origin
/// and a circle of radius `r` whose rim dips `depth` inside the ellipse's +a
/// apex, slid `y0` along the tangent. Returns the pair and the eccentric-angle
/// crossings dense sampling (4e4 samples, ~14 across the lens) sees, each
/// bisected onto the crossing so the widths quoted in the tests are exact.
fn lens_fixture(a: f64, b: f64, r: f64, depth: f64, y0: f64) -> (Curve, Curve, Vec<f64>) {
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a,
        b,
        theta: 0.0,
    };
    let circ = Curve::Circle {
        c: [a + r - depth, y0],
        r,
    };
    let n = 40_000usize;
    let cc = [a + r - depth, y0];
    let gap = |phi: f64| {
        let p = [a * phi.cos(), b * phi.sin()];
        (p[0] - cc[0]).hypot(p[1] - cc[1]) - r
    };
    let mut roots: Vec<f64> = Vec::new();
    let mut prev_phi = 0.0;
    let mut prev = gap(0.0);
    for i in 1..=n {
        let phi = TWO_PI * i as f64 / n as f64;
        let cur = gap(phi);
        if (prev > 0.0) != (cur > 0.0) {
            roots.push(bisect(&gap, prev_phi, phi));
        }
        prev_phi = phi;
        prev = cur;
    }
    (ell, circ, roots)
}

/// The eccentric-angle parameter of a hit on the fixture's ellipse.
fn lens_param(hit: &Hit, a: f64, b: f64) -> f64 {
    pymod((hit.point[1] / b).atan2(hit.point[0] / a), TWO_PI)
}

/// Angular distance between a hit's parameter and the nearest dense crossing.
fn nearest_lens_crossing(hit: &Hit, a: f64, b: f64, dense: &[f64]) -> f64 {
    let t = lens_param(hit, a, b);
    dense
        .iter()
        .map(|&d| {
            let off = pymod(t - d, TWO_PI);
            off.min(TWO_PI - off)
        })
        .fold(f64::INFINITY, f64::min)
}

/// World separation of the two dense crossings of a lens fixture.
fn lens_separation(a: f64, b: f64, dense: &[f64]) -> f64 {
    let at = |phi: f64| [a * phi.cos(), b * phi.sin()];
    let (p, q) = (at(dense[0]), at(dense[1]));
    (p[0] - q[0]).hypot(p[1] - q[1])
}

#[test]
fn sub_sample_crossing_lens_beyond_the_collapse_band_reports_both_roots() {
    // A real two-crossing lens whose whole crossing pair falls between two
    // scan samples: the sign-change scan alone never sees it (the samples
    // bracket the lens with one sign), and the sampled valley used to be read
    // through the hidden-crossing guard, where the last ternary step's side of
    // zero decided between 0 contacts (the pair rejected) and 1 (a foot in the
    // middle of a real lens). The valley refinement now minimises the SIGNED
    // residual, so a minimum past zero is a crossing pair, and both flanks are
    // bisected to their exact roots.
    //
    // This is the class the fix exists for: a lens wider than the collapse
    // band (2 * TANGENT_COLLAPSE_RESOLUTIONS * resolution(r_min), here 2 *
    // 1e-3 * 2000 = 4.0 world, the closed-form `cc` graze rule) is geometry,
    // not a converged tangency. Measured on the review fixture family with
    // dense sampling seeing two crossings at every one of them (the helper
    // bisects each crossing, so these are the exact separations): at depth
    // 0.01 and y0 = 8.95 the pair sits 4.464 world apart and the old scan
    // reported 0 crossings; at depth 0.03 and y0 = -16.9 (5.079 apart) and
    // depth 0.05 and y0 = -20 (10.0 apart) it reported the single foot the
    // ternary landed on instead of the pair. The scan now reports both roots,
    // each on its dense twin.
    for (a, b, r, depth, y0) in [
        (3000.0, 2000.0, 4000.0, 0.01, 8.95),
        (3000.0, 2000.0, 4000.0, 0.03, -16.9),
        (3000.0, 2000.0, 4000.0, 0.05, -20.0),
    ] {
        let (ell, circ, dense) = lens_fixture(a, b, r, depth, y0);
        assert_eq!(
            dense.len(),
            2,
            "depth {depth} y0 {y0}: the lens is real, got {dense:?}"
        );
        let sep = lens_separation(a, b, &dense);
        let band = 2.0 * tangent_collapse_tol(b.min(r));
        assert!(
            sep > band,
            "depth {depth} y0 {y0}: the fixture must sit outside the collapse band, sep {sep:e} vs {band:e}"
        );
        let h = intersect_curves(&ell, &circ);
        assert_eq!(
            h.len(),
            2,
            "depth {depth} y0 {y0}: both crossings of a real lens must be reported, got {h:?}"
        );
        // Each reported hit sits on its dense-sampling twin; the two roots are
        // exact bisections, so one scan step is a generous match window.
        for hit in &h {
            let nearest = nearest_lens_crossing(hit, a, b, &dense);
            assert!(
                nearest < 1e-3,
                "depth {depth} y0 {y0}: hit {hit:?} is {nearest:e} from the nearest dense crossing"
            );
        }
    }
}

#[test]
fn sub_sample_crossing_lens_inside_the_collapse_band_is_one_virtual_tangent_point() {
    // The pinned repro's own lens: the same family at depth 0.01, slid over
    // y0 = 9.5..10.0. Both tangency budgets put it INSIDE the near-tangency
    // band, so the model's answer is the single virtual tangent point, not two
    // crossings: the rim gap 0.01 is inside the gap budget (1e-5 * 2000 =
    // 0.02), and the crossings sit 2.236 to 3.509 world apart (exact, via the
    // same bisection) against a 4.0 world collapse band. What the fix changed
    // is who decides: the old scan reported 0 hits at y0 = 9.5 and 1 at
    // y0 = 10 depending on which side of zero the last ternary step landed on,
    // so the sampling phase, not the model, decided whether the tangency
    // survived (0 lost the contact the region closes on). The sampled valley
    // now refines the signed residual and reports exactly the model's one
    // contact, deterministically, at every slid position.
    let (a, b, r) = (3000.0, 2000.0, 4000.0);
    for y0 in [9.5, 9.75, 10.0] {
        let (ell, circ, dense) = lens_fixture(a, b, r, 0.01, y0);
        assert_eq!(dense.len(), 2, "y0 {y0}: the lens is real");
        let sep = lens_separation(a, b, &dense);
        assert!(
            sep <= 2.0 * tangent_collapse_tol(b.min(r)),
            "y0 {y0}: the fixture must sit inside the collapse band, sep {sep:e}"
        );
        let h = intersect_curves(&ell, &circ);
        assert_eq!(h.len(), 1, "y0 {y0}: one virtual tangent point, got {h:?}");
        // The contact is the foot BETWEEN the two crossings, not one of them:
        // its parameter sits inside the pair's span and one scan step from it.
        let (first, second) = (dense[0], dense[1]);
        let t = lens_param(&h[0], a, b);
        assert!(
            (first.min(second)..=first.max(second)).contains(&t),
            "y0 {y0}: the foot {t:e} must lie between the crossings {first:e}..{second:e}"
        );
        assert!(
            nearest_lens_crossing(&h[0], a, b, &dense) < 0.05,
            "y0 {y0}: the foot must sit at the closest approach, got {h:?}"
        );
    }
}

#[test]
fn circle_ellipse_four_points() {
    let circ = Curve::Circle {
        c: [0.0, 0.0],
        r: 2.0,
    };
    let ell = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 1.0,
        theta: 0.0,
    };
    let h = intersect_curves(&circ, &ell);
    assert_eq!(h.len(), 4);
}

#[test]
fn collapsed_ellipse_conic_produces_no_nan_hits() {
    // b == 0 makes the conic residual divide by zero; the resulting NaN is
    // never a sign change, so the scan must simply report nothing (or a
    // finite point), never a NaN coordinate feeding the vertex merge.
    let flat = Curve::Ellipse {
        c: [0.0, 0.0],
        a: 3.0,
        b: 0.0,
        theta: 0.0,
    };
    let circ = Curve::Circle {
        c: [0.0, 0.0],
        r: 2.0,
    };
    let g = conic_residual(&flat).expect("a flat ellipse is still a conic");
    assert!(
        g([1.0, 0.5]).is_finite(),
        "conic residual off the flat axis"
    );
    assert!(g([1.0, 0.0]).is_finite(), "conic residual on the flat axis");
    for hit in intersect_curves(&circ, &flat) {
        assert!(
            hit.point[0].is_finite() && hit.point[1].is_finite() && hit.t_a.is_finite(),
            "degenerate ellipse produced {hit:?}"
        );
    }
}

#[test]
fn conic_residual_returns_none_for_non_conics() {
    // A line or bezier has no implicit conic form. Returning None lets the
    // scan dispatch skip it instead of aborting the worker.
    assert!(conic_residual(&line([0.0, 0.0], [1.0, 0.0])).is_none());
    let bz = Curve::Bezier {
        p0: [0.0, 0.0],
        c1: [1.0, 0.0],
        c2: [0.0, 1.0],
        p3: [1.0, 1.0],
    };
    assert!(conic_residual(&bz).is_none());
}

#[test]
fn bezier_line_one_crossing() {
    let bz = Curve::Bezier {
        p0: [0.0, 0.0],
        c1: [1.0, 2.0],
        c2: [2.0, -2.0],
        p3: [3.0, 0.0],
    };
    let h = intersect_curves(&bz, &line([-1.0, 0.0], [4.0, 0.0]));
    // y=0 line crosses the symmetric S-curve at the two ends and the middle.
    assert!(!h.is_empty());
    for hit in &h {
        assert!(hit.point[1].abs() < 1e-6);
    }
}

#[test]
fn bezier_bezier_cross() {
    let a = Curve::Bezier {
        p0: [-2.0, 0.0],
        c1: [-1.0, 0.0],
        c2: [1.0, 0.0],
        p3: [2.0, 0.0],
    };
    let b = Curve::Bezier {
        p0: [0.0, -2.0],
        c1: [0.0, -1.0],
        c2: [0.0, 1.0],
        p3: [0.0, 2.0],
    };
    let h = intersect_curves(&a, &b);
    assert_eq!(h.len(), 1);
    assert!(h[0].point[0].abs() < 1e-5 && h[0].point[1].abs() < 1e-5);
}

#[test]
fn bezier_bezier_three_crossings() {
    // A wiggling spline through a straight-as-bezier segment crosses three
    // times; none of those transversal hits may be lost to the recursion
    // budget or its degenerate-overlap policy.
    let a = Curve::Bezier {
        p0: [-3.0, 0.0],
        c1: [-1.0, 0.0],
        c2: [1.0, 0.0],
        p3: [3.0, 0.0],
    };
    let b = Curve::Bezier {
        p0: [0.0, -2.0],
        c1: [4.0, 6.0],
        c2: [-4.0, -6.0],
        p3: [0.0, 2.0],
    };
    let h = intersect_curves(&a, &b);
    assert_eq!(h.len(), 3);
    for hit in &h {
        assert!(hit.point[1].abs() < 1e-6);
        assert!((-3.0..=3.0).contains(&hit.point[0]));
    }
}

#[test]
fn identical_beziers_terminate_and_report_nothing() {
    // Pasting a spline onto itself used to explode the AABB subdivision:
    // every split pair's boxes keep touching until the FLAT cutoff,
    // pushing ~10^8 phantom leaves into an unbounded Vec on the wasm
    // heap. It must now return promptly under the degenerate-overlap
    // policy (no points), not hang or abort.
    let bz = Curve::Bezier {
        p0: [0.0, 0.0],
        c1: [1.0, 2.0],
        c2: [2.0, -2.0],
        p3: [3.0, 0.0],
    };
    let h = intersect_curves(&bz, &bz);
    assert!(h.is_empty());
}

#[test]
fn heavily_overlapping_beziers_stay_bounded() {
    // The same shape nudged past the control-polygon short-circuit: the
    // search must stay inside its budget and its output inside the >10
    // discard bound, whatever the exact crossing count turns out to be.
    let a = Curve::Bezier {
        p0: [0.0, 0.0],
        c1: [1.0, 2.0],
        c2: [2.0, -2.0],
        p3: [3.0, 0.0],
    };
    let b = Curve::Bezier {
        p0: [0.005, 0.0],
        c1: [1.005, 2.0],
        c2: [2.005, -2.0],
        p3: [3.005, 0.0],
    };
    let h = intersect_curves(&a, &b);
    assert!(h.len() <= 10);
}

#[test]
fn a_self_crossing_spline_reports_one_crossing() {
    // The oracle's long-standing self-crossing fixture: an open cubic whose
    // branches leave the start, loop over the top and meet again on the way
    // to the end.
    let c: BzCtrl = [[0.0, 0.0], [4.0, 3.0], [-4.0, 3.0], [1.0, 0.0]];
    let cross = bezier_self_crossing(&c).expect("the fixture crosses itself");
    assert!(0.0 < cross.t_lo && cross.t_lo < cross.t_hi && cross.t_hi < 1.0);

    // Both branches pass through the reported point: B(t_lo) and B(t_hi)
    // agree far inside the vertex merge.
    let pa = bezier_point(c[0], c[1], c[2], c[3], cross.t_lo);
    let pb = bezier_point(c[0], c[1], c[2], c[3], cross.t_hi);
    let apart = (pa[0] - pb[0]).hypot(pa[1] - pb[1]);
    assert!(
        apart < 1e-9,
        "the two branches are {apart:e} apart: {pa:?} {pb:?}"
    );
    for p in [pa, pb] {
        let d = (p[0] - cross.point[0]).hypot(p[1] - cross.point[1]);
        assert!(d < 1e-9, "{:?} sits {d:e} off the crossing", cross.point);
    }
    // The fixture's crossing is the shallow X near (0.44, 0.36): pin where it
    // lands, not just that something was found.
    assert!(
        (cross.point[0] - 0.44).abs() < 1e-6 && (cross.point[1] - 0.36).abs() < 1e-6,
        "{:?}",
        cross.point
    );
}

#[test]
fn a_teardrop_and_an_s_curve_report_no_self_crossing() {
    // The shapes the builder must not split: a closed teardrop whose ends
    // merge at one point, a smooth S, and a straight segment.
    let teardrop: BzCtrl = [[0.0, 0.0], [1.0, 2.0], [-1.0, 2.0], [0.0, 0.0]];
    let s_curve: BzCtrl = [[0.0, 0.0], [1.0, 2.0], [2.0, -2.0], [3.0, 0.0]];
    let straight: BzCtrl = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]];
    for (label, c) in [
        ("teardrop", teardrop),
        ("s curve", s_curve),
        ("straight", straight),
    ] {
        assert!(
            bezier_self_crossing(&c).is_none(),
            "{label} reported a self-crossing"
        );
    }
}

#[test]
fn a_retracing_spline_reports_nothing_instead_of_a_partial_ring() {
    // The cubic runs out along x and comes straight back through the same
    // points: every branch pair coincides, so there is no isolated double
    // point. The degenerate-overlap policy reports nothing, like the pairwise
    // identical-carrier shortcut: a partial ring of phantom split points would
    // slice the curve into nonsense.
    let c: BzCtrl = [[0.0, 0.0], [1.0, 0.0], [-1.0, 0.0], [0.0, 0.0]];
    assert!(bezier_self_crossing(&c).is_none());
}

#[test]
fn a_self_crossing_is_found_at_every_curve_scale() {
    // The closed form reads control-point differences only, so it must not
    // depend on the curve's size: the same shape at a thousandth and a
    // thousand times the size reports its one crossing.
    let base: BzCtrl = [[0.0, 0.0], [4.0, 3.0], [-4.0, 3.0], [1.0, 0.0]];
    for scale in [1e-3, 1.0, 1e3] {
        let c: BzCtrl = base.map(|p| [p[0] * scale, p[1] * scale]);
        let cross = bezier_self_crossing(&c).expect("scaled fixture crosses");
        let pa = bezier_point(c[0], c[1], c[2], c[3], cross.t_lo);
        let pb = bezier_point(c[0], c[1], c[2], c[3], cross.t_hi);
        let apart = (pa[0] - pb[0]).hypot(pa[1] - pb[1]);
        assert!(
            apart <= 1e-12 * scale,
            "scale {scale:e}: branches {apart:e} apart"
        );
    }
}
