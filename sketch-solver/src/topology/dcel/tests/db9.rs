use super::helpers::*;
use crate::topology::dcel::{detect_topology, InputEntity, TopologyOut};
use crate::topology::profile_loops::{loop_pts, EdgeGeom};
use crate::topology::TOL_TOPOLOGY_MERGE;

/// The DB9 connector outline from the Panel report: four slanted/straight lines
/// and four r3.4 corner arcs forming one closed D-shaped loop. The corner arcs
/// are authored CCW (a0 < a1) with `a1 = 360` on the bottom-right one, the
/// boundary the report lost.
fn db9(dx: f64, dy: f64) -> Vec<(String, InputEntity)> {
    let p = |x: f64, y: f64| [x + dx, y + dy];
    let arc = |c: [f64; 2], a0: f64, a1: f64| {
        let at = |deg: f64| {
            let a = deg.to_radians();
            [c[0] + 3.4 * a.cos(), c[1] + 3.4 * a.sin()]
        };
        InputEntity {
            center: Some(c),
            radius: Some(3.4),
            start: Some(at(a0)),
            end: Some(at(a1)),
            angle_start: Some(a0),
            angle_end: Some(a1),
            ..Default::default()
        }
    };
    vec![
        ("l1".into(), line(p(-9.438896, -2.3), p(-10.25, 2.3))),
        ("l2".into(), line(p(-6.85, 5.7), p(6.85, 5.7))),
        ("l3".into(), line(p(10.25, 2.3), p(9.438896, -2.3))),
        ("l4".into(), line(p(6.038896, -5.7), p(-6.038896, -5.7))),
        ("a2".into(), arc(p(-6.85, 2.3), 90.0, 180.0)),
        ("a1".into(), arc(p(-6.038896, -2.3), 180.0, 270.0)),
        ("a3".into(), arc(p(6.85, 2.3), 0.0, 90.0)),
        ("a4".into(), arc(p(6.038896, -2.3), 270.0, 360.0)),
    ]
}

fn boundary_area(t: &TopologyOut) -> f64 {
    let pts = loop_pts(&t.surfaces[0].boundary, 64);
    let n = pts.len();
    (0..n)
        .map(|i| {
            let p = pts[i];
            let q = pts[(i + 1) % n];
            p[0] * q[1] - q[0] * p[1]
        })
        .sum::<f64>()
        / 2.0
}

fn arc_spans(t: &TopologyOut) -> Vec<(f64, f64)> {
    t.surfaces[0]
        .boundary
        .iter()
        .filter_map(|e| match e.geom {
            EdgeGeom::Arc {
                angle_start_deg,
                angle_end_deg,
                ..
            } => Some((angle_start_deg, angle_end_deg)),
            _ => None,
        })
        .collect()
}

#[test]
fn the_db9_outline_is_one_face_at_the_origin_and_at_the_report_offset() {
    // The report's loop cut as a full r3.4 disc at (91,225) but as the D shape
    // at the origin. The corner arcs are tangent to the two long lines, so the
    // line/arc intersections sat a hair either side of the tangency once the
    // coordinates were large: two roots, one vertex, and the far root was read
    // back at the other end of the authored sweep (a 270 degree complement that
    // closed the whole circle). One face, the same 8 edges and the same area at
    // both placements is the contract.
    let at_origin = detect_topology(&db9(0.0, 0.0));
    let at_offset = detect_topology(&db9(91.0, 225.0));
    for (name, t) in [("origin", &at_origin), ("offset", &at_offset)] {
        assert_eq!(t.surfaces.len(), 1, "{name}: expected one face");
        assert_eq!(
            t.surfaces[0].boundary.len(),
            8,
            "{name}: the loop must keep all four lines and four arcs"
        );
        assert!(t.surfaces[0].holes.is_empty(), "{name}: no hole expected");
        // The authored sweeps, none stretched to the complement.
        let mut spans = arc_spans(t);
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        assert_eq!(
            spans,
            vec![(0.0, 90.0), (90.0, 180.0), (180.0, 270.0), (270.0, 360.0)],
            "{name}: arc sweeps moved"
        );
    }
    let a0 = boundary_area(&at_origin);
    let a1 = boundary_area(&at_offset);
    // The analytic D area is the chord polygon's shoelace plus four quarter-disc
    // segments, 214.530225475...; the sampled polygon is inscribed, so it reads
    // a few thousandths low (one sagitta per arc). The two placements must
    // agree far tighter than that shared sampling bias.
    assert!((a0 - 214.530225475498).abs() < 1e-2, "origin area {a0}");
    assert!(
        (a1 - a0).abs() <= 1e-9 * a0.abs(),
        "the same loop must have the same area at (91,225): {a0} vs {a1}"
    );
}

#[test]
fn a_line_tangent_to_an_arc_makes_one_contact_even_when_the_coordinates_are_large() {
    // The bisect from the report: at the origin the discriminant of the
    // line/circle quadratic is exactly zero; at an offset of a few hundred the
    // subtraction of the two coordinates leaves it a hair positive, the two
    // roots land ~1e-6 world apart (the square root of the rounding), and the
    // vertex merge fuses them while their split parameters stay distinct. The
    // root a hair below the arc start used to wrap to the far end of the angle
    // window and split the arc into its complement; `within_arc_span` now
    // refuses a split outside the authored sweep, so the arc stays one span.
    let cases: [([f64; 2], f64, f64); 3] = [
        ([6.038896, -2.3], 3.4, 270.0), // origin, the bottom-right corner arc
        ([97.038896, 222.7], 3.4, 270.0), // the report offset's same corner
        ([1506.038896, -802.3], 3.4, 270.0), // a second large placement
    ];
    for (center, radius, at_deg) in cases {
        let a = at_deg.to_radians();
        let p = [center[0] + radius * a.cos(), center[1] + radius * a.sin()];
        // The authored 90 degree corner arc, and the flat side tangent at its
        // start, running along the arc's own tangent direction.
        let tangent = [-a.sin(), a.cos()];
        let far = [p[0] + 20.0 * tangent[0], p[1] + 20.0 * tangent[1]];
        let geom = vec![
            ("line".into(), line(p, far)),
            (
                "arc".into(),
                super_arc(center, radius, at_deg, at_deg + 90.0),
            ),
        ];
        let t = detect_topology(&geom);
        let arc_edges: Vec<_> = t.edges.iter().filter(|e| e.entity_id == "arc").collect();
        assert_eq!(
            arc_edges.len(),
            1,
            "tangent at {center:?} {at_deg}: the arc must stay one span, got {:?}",
            arc_edges.iter().map(|e| &e.geom).collect::<Vec<_>>()
        );
        let span = match arc_edges[0].geom {
            EdgeGeom::Arc {
                angle_start_deg,
                angle_end_deg,
                ..
            } => angle_end_deg - angle_start_deg,
            _ => panic!("not an arc"),
        };
        // A duplicate root that survives as one extra split (same vertex, one
        // MERGE-wide sliver) moves the effective start by at most MERGE/r in
        // radians; that is not the complement, and the vertex itself is one.
        assert!(
            (span - 90.0).abs() < 1e-3,
            "tangent at {center:?}: arc span {span}"
        );
        for (_, v) in &t.intersection_points {
            let miss = (v[0] - p[0]).hypot(v[1] - p[1]);
            assert!(
                miss <= TOL_TOPOLOGY_MERGE,
                "tangent contact left its foot by {miss:e}"
            );
        }
    }
}

fn super_arc(center: [f64; 2], radius: f64, a0: f64, a1: f64) -> InputEntity {
    let at = |deg: f64| {
        let a = deg.to_radians();
        [center[0] + radius * a.cos(), center[1] + radius * a.sin()]
    };
    InputEntity {
        center: Some(center),
        radius: Some(radius),
        start: Some(at(a0)),
        end: Some(at(a1)),
        angle_start: Some(a0),
        angle_end: Some(a1),
        ..Default::default()
    }
}
