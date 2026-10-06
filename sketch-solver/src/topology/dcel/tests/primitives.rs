use crate::radians;
use crate::topology::dcel::build::{push_half_edge_pair, HalfEdge};
use crate::topology::dcel::intersect::{cc, collinear_overlap};
use crate::topology::dcel::trace::{face_area, trace_face_cycles};
use crate::topology::dcel::{norm_arc_param, Verts, TANGENT_GAP_REL};
use crate::topology::profile_loops::EdgeGeom;
use crate::topology::{TOL_TOPOLOGY_MERGE as MERGE, TOL_TOPOLOGY_SPLIT as SPLIT_EPS, TWO_PI};

use super::helpers::*;

#[test]
fn cc_exact_external_tangency_is_one_point() {
    let pts = cc(0.0, 0.0, 5.0, 10.0, 0.0, 5.0);
    assert_eq!(pts.len(), 1);
    assert!((pts[0].2[0] - 5.0).abs() < 1e-9 && pts[0].2[1].abs() < 1e-9);
}

#[test]
fn cc_near_tangent_overlap_collapses_to_one_point() {
    // The solver leaves a hair of overlap at a tangency; the two analytic
    // roots are ~2.2e-3 apart and must collapse to the single foot at (5,0).
    let pts = cc(0.0, 0.0, 5.0, 10.0 - 1e-6, 0.0, 5.0);
    assert_eq!(pts.len(), 1);
    assert!((pts[0].2[0] - 5.0).abs() < 1e-3 && pts[0].2[1].abs() < 1e-3);
}

#[test]
fn cc_internal_tangency_is_one_point() {
    let pts = cc(0.0, 0.0, 5.0, 3.0, 0.0, 2.0); // d == r1 - r2
    assert_eq!(pts.len(), 1);
    assert!((pts[0].2[0] - 5.0).abs() < 1e-9 && pts[0].2[1].abs() < 1e-9);
}

#[test]
fn cc_clear_crossing_keeps_two_points() {
    let pts = cc(0.0, 0.0, 5.0, 8.0, 0.0, 5.0); // roots 6 apart, not tangent
    assert_eq!(pts.len(), 2);
}

#[test]
fn cc_disjoint_circles_have_no_points() {
    assert!(cc(0.0, 0.0, 5.0, 20.0, 0.0, 5.0).is_empty());
}

#[test]
fn cc_external_miss_within_tolerance_is_one_point() {
    // A converged tangency that landed a hair apart has no analytic roots, so
    // the contact the area builder closes on is lost. The miss gap IS the
    // r_tangent residual, so a miss within the tolerance must assert the foot.
    let r: f64 = 5.0;
    let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
    for gap in [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 0.5 * tol] {
        let pts = cc(0.0, 0.0, r, 2.0 * r + gap, 0.0, r);
        assert_eq!(
            pts.len(),
            1,
            "gap {gap:e}: a miss within tolerance is one point"
        );
        // The foot is the midpoint of closest approach, gap/2 past the ideal
        // touch point, so the horizontal budget must scale with the gap.
        assert!(
            (pts[0].2[0] - r).abs() < 1e-6 + gap && pts[0].2[1].abs() < 1e-9,
            "gap {gap:e}: foot at the tangent point"
        );
    }
}

#[test]
fn cc_external_miss_past_tolerance_stays_empty() {
    // The cliff pinned from the far side so a widened constant cannot pass
    // unnoticed: a genuine separation keeps zero contact.
    let r: f64 = 5.0;
    let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
    for gap in [2.0 * tol, 1e-3, 1e-2] {
        assert!(
            cc(0.0, 0.0, r, 2.0 * r + gap, 0.0, r).is_empty(),
            "gap {gap:e}: a real miss stays a miss"
        );
    }
}

#[test]
fn cc_internal_miss_within_tolerance_is_one_point() {
    // Internal mirror: B nested a hair short of touching A from inside.
    let (r1, r2): (f64, f64) = (5.0, 2.0);
    let tol = MERGE.max(TANGENT_GAP_REL * r1.min(r2));
    for gap in [1e-9, 1e-7, 0.5 * tol] {
        let pts = cc(0.0, 0.0, r1, r1 - r2 - gap, 0.0, r2);
        assert_eq!(
            pts.len(),
            1,
            "gap {gap:e}: an internal miss within tolerance is one point"
        );
        // The internal foot sits at the radical-axis a, which grows a hair
        // past r1 as the miss deepens, so the budget scales with the gap.
        assert!(
            (pts[0].2[0] - r1).abs() < 1e-6 + gap && pts[0].2[1].abs() < 1e-9,
            "gap {gap:e}: foot at the tangent point"
        );
    }
}

#[test]
fn cc_internal_miss_past_tolerance_stays_empty() {
    let (r1, r2): (f64, f64) = (5.0, 2.0);
    let tol = MERGE.max(TANGENT_GAP_REL * r1.min(r2));
    let gap = 2.0 * tol;
    assert!(cc(0.0, 0.0, r1, r1 - r2 - gap, 0.0, r2).is_empty());
}

#[test]
fn face_area_drops_a_cycle_naming_an_unknown_vertex() {
    // `Verts::get` used to panic on a missing id; an unknown vertex must
    // bound no area instead, so the cycle is dropped.
    let verts = Verts::new();
    let hes: Vec<HalfEdge> = vec![(
        "_v0".to_string(),
        "_v1".to_string(),
        EdgeGeom::Line {
            start: [0.0, 0.0],
            end: [1.0, 0.0],
        },
    )];
    assert_eq!(face_area(&[0], &hes, &verts), 0.0);
}

#[test]
fn nan_departure_angle_does_not_panic_the_cycle_tracer() {
    // A NaN param (from a poisoned solve) reaching the half-edge graph gives
    // an edge a NaN departure angle AND a NaN curvature. Ordering the edges
    // leaving that vertex must degrade to "equal", not unwrap a None.
    let mut verts = Verts::new();
    let v0 = verts.vid([0.0, 0.0]);
    let v1 = verts.vid([1.0, 0.0]);
    let v2 = verts.vid([0.0, 1.0]);
    let straight = EdgeGeom::Line {
        start: [0.0, 0.0],
        end: [1.0, 0.0],
    };
    let poisoned = EdgeGeom::Arc {
        center: [0.0, 0.0],
        radius: f64::NAN,
        angle_start_deg: f64::NAN,
        angle_end_deg: f64::NAN,
        ccw: true,
        start: [0.0, 0.0],
        end: [0.0, 1.0],
    };
    let mut hes: Vec<HalfEdge> = Vec::new();
    let mut he_eid: Vec<String> = Vec::new();
    push_half_edge_pair(&mut hes, &mut he_eid, "good", &v0, &v1, straight);
    push_half_edge_pair(&mut hes, &mut he_eid, "bad", &v0, &v2, poisoned);
    // The result is meaningless geometry; the point is that it returns.
    let _ = trace_face_cycles(&hes, &he_eid, &verts);
}

#[test]
fn norm_arc_param_matches_the_reference_walk_for_sane_inputs() {
    // Frozen golden payloads depend on the original +-2*pi step arithmetic,
    // so the walk must stay the exact code path for every input it can
    // finish in bounded time. Only magnitudes it could never walk may take
    // a shortcut.
    fn walk(mut p: f64, a0: f64) -> f64 {
        while p < a0 - SPLIT_EPS {
            p += TWO_PI;
        }
        while p >= a0 + TWO_PI - SPLIT_EPS {
            p -= TWO_PI;
        }
        p
    }
    let cases = [
        (-1.0, 0.0),
        (0.0, 0.0),
        (5.0, -1.0),
        (-1.0, 1.0),
        (TWO_PI, 0.0),
        (0.0, TWO_PI),
        (3.5, -2.5),
    ];
    for (p, a0) in cases {
        assert_eq!(norm_arc_param(p, a0), walk(p, a0));
    }
}

#[test]
fn norm_arc_param_lands_in_the_walk_window_for_huge_inputs() {
    // Decoded arc angles are untrusted magnitude: 3e38 degrees is finite,
    // passes every solver gate, and used to mean ~9e35 single-step loop
    // iterations here (or an absorbed-step spin at equal angles: the walk's
    // own threshold collapses onto p once a turn is below one ulp). At
    // 3e38 the landing interval itself is degenerate below ulp(a0), so
    // there only finiteness can be asserted; at 1e15 degrees the interval
    // is representable and must hold exactly.
    let a0 = radians(3e38);
    for deg in [-3e38, -1e300, -1e15, 1e15, 1e150, 3e38] {
        let p = norm_arc_param(radians(deg), a0);
        assert!(p.is_finite(), "radians({deg}) must normalize finite");
    }
    let a0 = radians(1e15);
    for deg in [-1e300, -720.0, 0.0, 720.0, 1e15, 1e150] {
        let p = norm_arc_param(radians(deg), a0);
        assert!(p.is_finite(), "radians({deg}) must normalize finite");
        assert!(
            p >= a0 - SPLIT_EPS && p < a0 + TWO_PI - SPLIT_EPS,
            "radians({deg}) landed outside the split window"
        );
    }
}

#[test]
fn collinear_overlap_degenerate_and_normal() {
    // Ported from the deleted TS topology.test.ts collinearOverlap block.
    // Zero-length segment A -> no overlap.
    assert!(collinear_overlap(
        &topo(line([1.0, 0.0], [1.0, 0.0])),
        &topo(line([0.0, 0.0], [2.0, 0.0]))
    )
    .is_empty());
    // Zero-length segment B -> no overlap.
    assert!(collinear_overlap(
        &topo(line([0.0, 0.0], [2.0, 0.0])),
        &topo(line([1.0, 0.0], [1.0, 0.0]))
    )
    .is_empty());
    // Genuinely overlapping collinear segments -> overlap points.
    assert!(!collinear_overlap(
        &topo(line([0.0, 0.0], [2.0, 0.0])),
        &topo(line([1.0, 0.0], [3.0, 0.0]))
    )
    .is_empty());
}
