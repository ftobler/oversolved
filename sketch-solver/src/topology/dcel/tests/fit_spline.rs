//! Area-builder coverage for the interpolating fit spline.
//!
//! The chain is one entity, so a run between two real contacts is one edge and
//! the piece joints are never vertices. These tests pin that output contract,
//! the sub-chain reproduction after a cut, the figure-eight slicing and the
//! oracle agreement.

use super::*;
use crate::fit_spline::FitSpline;
use crate::topology::dcel::TopologyOut;
use crate::topology::oracle::{check_topology, loop_area_centroid};

/// Ex010's eight points with `includeCurrent=True`, the fixture every kernel
/// test shares.
const EX010: [[f64; 2]; 8] = [
    [3.0, 1.0],
    [2.75, 1.5],
    [2.5, 1.75],
    [2.0, 1.5],
    [1.5, 1.0],
    [1.0, 1.25],
    [0.5, 1.0],
    [0.0, 1.0],
];

fn fit_edges(t: &TopologyOut) -> Vec<&EdgeGeom> {
    t.edges
        .iter()
        .filter(|e| matches!(e.geom, EdgeGeom::FitSpline { .. }))
        .map(|e| &e.geom)
        .collect()
}

fn profile() -> Vec<(String, InputEntity)> {
    vec![
        ("l1".into(), line([0.0, 0.0], [3.0, 0.0])),
        ("l2".into(), line([3.0, 0.0], [3.0, 1.0])),
        ("sp".into(), fit_spline(&EX010, None, None)),
        ("l3".into(), line([0.0, 1.0], [0.0, 0.0])),
    ]
}

#[test]
fn the_ex010_profile_has_one_fit_spline_edge_with_the_whole_chain() {
    let geom = profile();
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1, "one bounded profile");
    let surface = &t.surfaces[0];
    assert_eq!(surface.boundary.len(), 4, "3 lines + the fit spline");
    let fit: Vec<_> = surface
        .boundary
        .iter()
        .filter(|be| matches!(be.geom, EdgeGeom::FitSpline { .. }))
        .collect();
    assert_eq!(fit.len(), 1, "the whole run is one edge");
    if let EdgeGeom::FitSpline { poles, knots } = &fit[0].geom {
        assert_eq!(poles.len(), 3 * 7 + 1, "22 chain poles");
        assert_eq!(knots.len(), 8, "8 chord knots");
    }
    // The four corners, and no interior piece joint published as a vertex.
    assert_eq!(t.vertices.len(), 4);
    let (area, _) = loop_area_centroid(&surface.boundary);
    // CadQuery 2.8.0 measured this profile at 3.785059288898271.
    assert!(
        (area.abs() - 3.785059288898271).abs() < 1e-9,
        "area {}",
        area.abs()
    );
    assert!(
        check_topology(&geom, &t).is_empty(),
        "{:?}",
        check_topology(&geom, &t)
    );
}

#[test]
fn a_cut_fit_spline_yields_three_sub_chains_that_reproduce_the_curve() {
    // The line crosses the Ex010 curve twice: on the way up to the first hump
    // and on the way back down, so it slices the profile into two faces.
    let mut geom = profile();
    geom.push(("cut".into(), line([0.0, 1.6], [3.0, 1.6])));
    let t = detect_topology(&geom);
    assert_eq!(fit_edges(&t).len(), 3, "three sub-chains");
    assert_eq!(t.surfaces.len(), 2, "the line splits the profile in two");

    let parent = FitSpline::new(&EX010, None, None).unwrap();
    for eg in fit_edges(&t) {
        if let EdgeGeom::FitSpline { poles, knots } = eg {
            // Sample the sub-chain and check each point against the parent;
            // control points are not on the curve, on-curve joints are.
            let (u0, u1) = (knots[0], knots[knots.len() - 1]);
            for k in 0..=20 {
                let u = u0 + (u1 - u0) * k as f64 / 20.0;
                let p = crate::topology::profile_loops::fit_chain_point(poles, knots, u);
                assert!(
                    parent.closest(p).distance < 1e-9,
                    "sub-chain point {p:?} left the parent curve"
                );
            }
        }
    }
    let total: f64 = t
        .surfaces
        .iter()
        .map(|s| loop_area_centroid(&s.boundary).0.abs())
        .sum();
    assert!(
        (total - 3.785059288898271).abs() < 1e-9,
        "cut areas sum to {total}"
    );
}

#[test]
fn a_figure_eight_through_points_slices_into_two_lobes() {
    // A closed curve whose pieces cross in the middle. The crossing is a real
    // split, so the two lobes are separate faces.
    let points = [[0.0, 0.0], [2.0, 2.0], [2.0, 0.0], [0.0, 2.0], [0.0, 0.0]];
    let t = detect_topology(&[("sp".into(), fit_spline(&points, None, None))]);
    assert_eq!(t.surfaces.len(), 2, "two lobes");
    for surface in &t.surfaces {
        assert!(
            loop_area_centroid(&surface.boundary).0.abs() > 0.1,
            "a lobe is not a sliver"
        );
    }
}

#[test]
fn a_closed_fit_spline_is_a_standalone_area() {
    let points = [[0.0, 0.0], [1.0, 1.0], [2.0, 0.0], [1.0, -1.0], [0.0, 0.0]];
    let geom = vec![("sp".into(), fit_spline(&points, None, None))];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.surfaces[0].boundary.len(), 1, "one closed chain edge");
    let (area, _) = loop_area_centroid(&t.surfaces[0].boundary);

    // A dense shoelace of the same curve, independent of the Green's-theorem
    // integral the topology uses.
    let curve = FitSpline::new(&points, None, None).unwrap();
    let n = 200000;
    let (u0, u1) = (curve.knots()[0], curve.knots()[curve.point_count() - 1]);
    let mut sum = 0.0;
    for k in 0..n {
        let a = curve.eval(u0 + (u1 - u0) * k as f64 / n as f64);
        let b = curve.eval(u0 + (u1 - u0) * (k + 1) as f64 / n as f64);
        sum += a[0] * b[1] - b[0] * a[1];
    }
    let shoelace = sum / 2.0;
    assert!(
        (area.abs() - shoelace.abs()).abs() < 1e-7 * shoelace.abs().max(1.0),
        "area {} vs shoelace {shoelace}",
        area.abs()
    );
    assert!(
        check_topology(&geom, &t).is_empty(),
        "{:?}",
        check_topology(&geom, &t)
    );
}

#[test]
fn a_smooth_joint_never_produces_a_split_near_itself() {
    // Every piece joint of a C2 fit spline is tangent, so the graze rule must
    // not invent a contact there: an uncut fit spline has exactly its two end
    // vertices and one edge.
    let t = detect_topology(&[("sp".into(), fit_spline(&EX010, None, None))]);
    assert_eq!(t.vertices.len(), 2, "only the endpoints");
    assert_eq!(t.edges.len(), 1, "one uncut chain edge");
    assert!(t.surfaces.is_empty());
}

#[test]
fn a_degenerate_fit_spline_is_refused_by_the_codec() {
    use crate::topology::codec::{decode_input, TopologyCodecError};
    let payload = serde_json::json!([
        ["bad", {"kind": "fit_spline", "points": [[0.0, 0.0], [0.0, 0.0], [1.0, 1.0]]}]
    ]);
    let bytes = serde_json::to_vec(&payload).unwrap();
    match decode_input(&bytes) {
        Err(TopologyCodecError::DegenerateFitSpline(message)) => {
            assert!(
                message.contains("coincident consecutive fit points 0,1"),
                "{message}"
            );
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}
