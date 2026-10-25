use crate::radians;
use crate::tolerance::tangent_gap_tol;
use crate::topology::dcel::{angle_in_arc, degrees, detect_topology, InputEntity, TopoEntity};
use crate::topology::profile_loops::EdgeGeom;
use crate::topology::TOL_TOPOLOGY_MERGE as MERGE;

use self::helpers::*;

mod construction;
mod db9;
mod helpers;
mod primitives;
mod tangent_hole;

#[test]
fn a_point_between_two_vertices_merges_into_the_first_registered() {
    // Two vertices 1.5 MERGE apart and a point within MERGE of both. Every
    // pool gets a fresh HashMap seed, so scanning one picked either vertex at
    // random across these runs; the insertion-ordered pool always picks _v0.
    use crate::topology::dcel::Verts;
    for _ in 0..64 {
        let mut verts = Verts::new();
        assert_eq!(verts.vid([0.0, 0.0]), "_v0");
        assert_eq!(verts.vid([1.5 * MERGE, 0.0]), "_v1");
        assert_eq!(verts.vid([0.8 * MERGE, 0.0]), "_v0");
    }
}

#[test]
fn vertex_emission_order_is_the_registration_order_on_every_run() {
    // The backlog item "DCEL vertex emission order is HashMap-random" is
    // stale: the pool is the insertion-ordered `Verts` since 7676df76, and
    // `vertices`/`intersection_points` are drained straight from its Vec, so
    // their order is the registration order on every run. A HashMap-ordered
    // emission would reshuffle under a fresh seed every run.
    let geom = vec![
        ("a".into(), line([0.0, 0.0], [4.0, 0.0])),
        ("b".into(), line([4.0, 0.0], [4.0, 4.0])),
        ("c".into(), line([4.0, 4.0], [0.0, 4.0])),
        ("d".into(), line([0.0, 4.0], [0.0, 0.0])),
        // Crosses the left and right side mid-span; its two hits are minted
        // after the four seeded corners.
        ("cross".into(), line([-1.0, 2.0], [5.0, 2.0])),
    ];
    let first = detect_topology(&geom);
    let vertex_ids = |t: &crate::topology::dcel::TopologyOut| -> Vec<String> {
        t.vertices.iter().map(|(k, _)| k.clone()).collect()
    };
    for _ in 0..64 {
        assert_eq!(vertex_ids(&detect_topology(&geom)), vertex_ids(&first));
    }
    // Registration order, not sorted: the seeded corners own _v0.._v3, the
    // cross line's free endpoints follow, then the two chord hits.
    let ids = vertex_ids(&first);
    assert_eq!(
        ids,
        vec!["_v0", "_v1", "_v2", "_v3", "_v4", "_v5", "_v6", "_v7"]
    );
    assert_eq!(
        first
            .intersection_points
            .iter()
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>(),
        vec!["_v6", "_v7"]
    );
}

#[test]
fn single_square_is_one_surface() {
    let t = detect_topology(&square(2.0));
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.surfaces[0].boundary.len(), 4);
    assert!(t.surfaces[0].holes.is_empty());
    assert_eq!(t.edges.len(), 4);
}

#[test]
fn standalone_circle_is_one_surface_two_arcs() {
    let geom = vec![("c0".into(), circle([0.0, 0.0], 1.0))];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.surfaces[0].boundary.len(), 2);
    assert_eq!(t.surfaces[0].face_entity_ids, vec!["c0".to_string()]);
}

#[test]
fn near_tangent_circles_stay_two_standalone_faces() {
    // Regression for the white-line report: two "tangent" circles the solver
    // left a hair overlapping must NOT be sliced into half-edge arcs. The cc
    // collapse keeps one contact -> one split each -> both standalone, no edges.
    let geom = vec![
        ("cA".into(), circle([0.0, 0.0], 5.0)),
        ("cB".into(), circle([10.0 - 1e-6, 0.0], 5.0)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2);
    assert!(
        t.edges.is_empty(),
        "tangent circles must emit no split edges"
    );
    assert_eq!(t.intersection_points.len(), 1, "one virtual tangent point");
}

#[test]
fn near_tangent_lines_at_the_circle_seam_keep_the_disk_face() {
    // A disk touched by two near-tangent lines whose virtual contacts land a
    // hair either side of the atan2 branch cut at +-pi. The contacts merge
    // into one vertex but their params sit ~2pi apart, so the split list kept
    // both, every segment hit the v0 == v1 skip, and the standalone max_keep
    // guard dropped the face: a clear disk reported no area. Pin the face.
    let r: f64 = 50.0;
    let gap: f64 = 1e-6;
    let delta: f64 = 5e-8;
    let tangent_line = |theta: f64| {
        let n = [theta.cos(), theta.sin()];
        let d = [-theta.sin(), theta.cos()];
        let p = [r * n[0] + gap * n[0], r * n[1] + gap * n[1]];
        line([p[0] - d[0], p[1] - d[1]], [p[0] + d[0], p[1] + d[1]])
    };
    let geom = vec![
        ("c0".into(), circle([0.0, 0.0], r)),
        ("l1".into(), tangent_line(std::f64::consts::PI - delta)),
        ("l2".into(), tangent_line(-std::f64::consts::PI + delta)),
    ];
    let t = detect_topology(&geom);
    assert!(
        t.surfaces
            .iter()
            .any(|s| s.face_entity_ids == vec!["c0".to_string()]),
        "the disk face must survive two near-tangent contacts at the seam"
    );
}

#[test]
fn near_tangent_lines_at_the_ellipse_seam_keep_the_face() {
    // Mirror of the circle seam test for the ellipse: a closed ellipse anchors
    // its params at 0/2pi (the +a major-axis direction), not the circle's
    // atan2 branch cut at +-pi. Two near-tangent lines whose contacts land a
    // hair either side of that seam must collapse to one split and keep the
    // standalone face.
    //
    // The circle test drives its contact through `lc`'s miss-side virtual
    // tangent point; `line_ellipse` now has the same miss-side rule, but this
    // test keeps its lines pushed inward by `g` (the point sits inside the
    // rim, so the discriminant stays positive). Each line genuinely crosses in
    // two roots within MERGE of the foot, which the point de-dup folds to one
    // contact; the two lines' contacts are `2*b*delta` apart and fuse into one
    // vertex.
    let a: f64 = 50.0;
    let b: f64 = 10.0;
    let g: f64 = 2e-14; // inward graze: disc stays robustly positive
    let delta: f64 = 4e-7; // eccentric angle either side of the 0/2pi seam
    let tangent_line = |phi: f64| {
        let p = [(1.0 - g) * a * phi.cos(), (1.0 - g) * b * phi.sin()];
        let d = [-a * phi.sin(), b * phi.cos()];
        line([p[0] - d[0], p[1] - d[1]], [p[0] + d[0], p[1] + d[1]])
    };
    let geom = vec![
        ("e0".into(), ellipse([0.0, 0.0], a, b, 0.0)),
        ("l1".into(), tangent_line(delta)),
        ("l2".into(), tangent_line(-delta)),
    ];
    let t = detect_topology(&geom);
    // The two contacts land a hair either side of the 0/2pi seam and must fuse
    // into one vertex; without the seam collapse that vertex splits the ellipse
    // into two zero-length segments and the standalone face is dropped.
    assert_eq!(
        t.intersection_points.len(),
        1,
        "the two seam contacts must merge into one virtual tangent vertex"
    );
    assert!(
        t.surfaces
            .iter()
            .any(|s| s.face_entity_ids == vec!["e0".to_string()]),
        "the ellipse face must survive two near-tangent contacts at the 0/2pi seam"
    );
}

// One incomplete entity per kind, each missing a field the geometry pass
// unwraps. The Worker is fed by structured-clone postMessage and cannot
// trust its input, so a truncated record must be dropped, not panicked on.
#[test]
fn incomplete_entities_are_dropped_per_kind() {
    let cases: Vec<(&str, InputEntity)> = vec![
        (
            "line without end",
            InputEntity {
                start: Some([0.0, 0.0]),
                ..Default::default()
            },
        ),
        (
            "circle without radius",
            InputEntity {
                center: Some([0.0, 0.0]),
                ..Default::default()
            },
        ),
        (
            "arc without angle_start",
            InputEntity {
                start: Some([1.0, 0.0]),
                end: Some([0.0, 1.0]),
                center: Some([0.0, 0.0]),
                radius: Some(1.0),
                angle_end: Some(90.0),
                ..Default::default()
            },
        ),
        (
            "arc without end",
            InputEntity {
                start: Some([1.0, 0.0]),
                center: Some([0.0, 0.0]),
                radius: Some(1.0),
                angle_start: Some(0.0),
                angle_end: Some(90.0),
                ..Default::default()
            },
        ),
        (
            "spline without c1",
            InputEntity {
                kind: Some("spline".into()),
                start: Some([0.0, 0.0]),
                end: Some([2.0, 0.0]),
                c2: Some([1.5, 1.0]),
                ..Default::default()
            },
        ),
        (
            "ellipse without b",
            InputEntity {
                kind: Some("ellipse".into()),
                center: Some([0.0, 0.0]),
                a: Some(3.0),
                ..Default::default()
            },
        ),
    ];
    for (label, ent) in cases {
        let t = detect_topology(&[("bad".into(), ent)]);
        assert!(t.edges.is_empty(), "{label} must contribute no edges");
        assert!(t.surfaces.is_empty(), "{label} must contribute no surfaces");
    }
}

#[test]
fn try_from_classifies_and_drops_incomplete_records() {
    // The `TryFrom` boundary is the only door into the geometry pass, so it
    // owns both halves of the old `classify` contract: a complete record
    // becomes the variant naming its kind WITH every field carried across,
    // and a truncated record becomes Err (dropped) instead of reaching a
    // builder. Compare whole values rather than `matches!` shape: all four
    // Vec2 positions are interchangeable, so a scramble would still match
    // `Variant { .. }`. The end-to-end drop is asserted by
    // `incomplete_entities_are_dropped_per_kind`.
    assert_eq!(
        TopoEntity::try_from(line([0.0, 0.0], [1.0, 0.0])).unwrap(),
        TopoEntity::Line {
            construction: false,
            start: [0.0, 0.0],
            end: [1.0, 0.0],
        }
    );
    assert_eq!(
        TopoEntity::try_from(circle([1.0, 2.0], 3.0)).unwrap(),
        TopoEntity::Circle {
            construction: false,
            center: [1.0, 2.0],
            radius: 3.0,
        }
    );
    // The `arc` helper pins start/end to the horizontal diameter.
    assert_eq!(
        TopoEntity::try_from(arc([1.0, 2.0], 3.0, 0.0, 90.0)).unwrap(),
        TopoEntity::Arc {
            construction: false,
            center: [1.0, 2.0],
            radius: 3.0,
            angle_start: 0.0,
            angle_end: 90.0,
            start: [4.0, 2.0],
            end: [-2.0, 2.0],
        }
    );
    assert_eq!(
        TopoEntity::try_from(ellipse([1.0, 2.0], 3.0, 1.0, 30.0)).unwrap(),
        TopoEntity::Ellipse {
            construction: false,
            center: [1.0, 2.0],
            a: 3.0,
            b: 1.0,
            theta: Some(30.0),
        }
    );
    assert_eq!(
        TopoEntity::try_from(spline_open([0.0, 0.0], [1.0, 1.0], [2.0, 1.0], [3.0, 0.0],)).unwrap(),
        TopoEntity::Spline {
            construction: false,
            start: [0.0, 0.0],
            c1: [1.0, 1.0],
            c2: [2.0, 1.0],
            end: [3.0, 0.0],
        }
    );

    // A malformed arc is dropped AS an arc, never demoted to a line, and a
    // record with no discriminating field at all is dropped too.
    let malformed_arc = InputEntity {
        start: Some([1.0, 0.0]),
        radius: Some(1.0),
        ..Default::default()
    };
    assert!(TopoEntity::try_from(malformed_arc).is_err());
    assert!(TopoEntity::try_from(InputEntity::default()).is_err());

    // The construction flag rides through the conversion.
    let mut construction_circle = circle([0.0, 0.0], 1.0);
    construction_circle.construction = true;
    assert!(TopoEntity::try_from(construction_circle)
        .unwrap()
        .construction());
}

#[test]
fn line_tangent_exactly_at_arc_endpoint_closes_the_slot() {
    // The exact-endpoint contract (passes today; guards the change): a line
    // tangent at the arc end must close the slot corner as one surface and
    // emit no degenerate sliver arc edge below MERGE/r of angular span.
    let r: f64 = 2.0;
    let t = detect_topology(&slot_corner(r, 90.0));
    assert_eq!(
        t.surfaces.len(),
        1,
        "exact-endpoint tangent closes the slot"
    );
    for e in &t.edges {
        if let EdgeGeom::Arc {
            angle_start_deg,
            angle_end_deg,
            ..
        } = e.geom
        {
            let span = (radians(angle_end_deg - angle_start_deg)).abs();
            assert!(
                span >= MERGE / r,
                "no sliver arc edge below MERGE/r (span {span:e})"
            );
        }
    }
}

#[test]
fn arc_endpoint_tangency_tolerance_is_world_scaled() {
    // The headline: the endpoint slack is the angular width of a MERGE-world
    // chord at this radius (MERGE / r), not a bare 1e-9 radians (which was
    // 1e-9 * r world -- four orders tighter than the vertex merge). A tangent
    // contact within MERGE world of the arc end keeps the slot closed; one a
    // hair further (2 * MERGE) leaves it open, matching the vertex merge.
    let r: f64 = 2.0;
    for delta_world in [MERGE / 2.0, MERGE] {
        let end_deg = degrees(radians(90.0) - delta_world / r);
        assert!(
                angle_in_arc(radians(90.0), r, 0.0, end_deg),
                "delta_world {delta_world:e}: a contact within MERGE of the arc end is inside the sweep"
            );
        let t = detect_topology(&slot_corner(r, end_deg));
        assert_eq!(
            t.surfaces.len(),
            1,
            "delta_world {delta_world:e}: the slot still closes"
        );
    }
    let delta_world = 2.0 * MERGE;
    let end_deg = degrees(radians(90.0) - delta_world / r);
    assert!(
        !angle_in_arc(radians(90.0), r, 0.0, end_deg),
        "a contact 2x MERGE past the arc end is outside the sweep"
    );
    let t = detect_topology(&slot_corner(r, end_deg));
    assert_eq!(
        t.surfaces.len(),
        0,
        "a real miss past MERGE leaves the slot open"
    );
}

#[test]
fn arc_with_huge_decoded_angles_completes_and_keeps_the_square_intact() {
    // angle_start = 3e38 echoes through init_arc_splits for
    // an unconstrained arc whose seed survives LM. Normalization walked one
    // 2*pi step per iteration (~9e35 steps): detect_topology effectively
    // never returned and the Worker wedged. The square alongside must still
    // resolve exactly as without the hostile arc.
    let mut geom = square(2.0);
    geom.push(("bad".into(), arc([50.0, 50.0], 1.0, 3e38, 3e38)));
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.surfaces[0].boundary.len(), 4);
    assert_eq!(t.edges.len(), 4);
}

#[test]
fn incomplete_entity_does_not_take_down_its_neighbours() {
    // A stale record alongside good geometry loses only itself: the square
    // still resolves to its one surface.
    let mut geom = square(2.0);
    geom.push((
        "stale".into(),
        InputEntity {
            center: Some([0.5, 0.5]),
            ..Default::default()
        },
    ));
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.edges.len(), 4);
}

#[test]
fn concentric_circles_make_two_areas_outer_has_hole() {
    // The 4af0712 behavior: hole region becomes its own selectable area.
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 2.0)),
        ("inner".into(), circle([0.0, 0.0], 1.0)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2);
    // The bigger circle carries the smaller as a hole; the smaller is its own area.
    let with_hole = t.surfaces.iter().filter(|s| !s.holes.is_empty()).count();
    assert_eq!(with_hole, 1);
}

#[test]
fn two_crossing_lines_enclose_nothing() {
    let geom = vec![
        ("h".into(), line([-1.0, 0.0], [1.0, 0.0])),
        ("v".into(), line([0.0, -1.0], [0.0, 1.0])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 0);
    // One intersection vertex at the origin.
    assert_eq!(t.intersection_points.len(), 1);
}

#[test]
fn three_mutually_tangent_circles_make_four_areas() {
    // Bug report tangential_sketch_area_building: three equal circles, each
    // pair externally tangent, must yield 4 areas (3 disks + 1 central
    // curvilinear triangle). The tangent vertices are cusps where two arcs
    // share a departure direction, so the face tracer must break the angular
    // tie by curvature or it merges/loses faces.
    let r = 2.61391544342041;
    let geom = vec![
        ("A".into(), circle([0.0, 0.0], r)),
        (
            "B".into(),
            circle([-5.223526954650879, -0.21208451688289642], r),
        ),
        (
            "C".into(),
            circle([-2.4280929565429688, -4.629749298095703], r),
        ),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 4, "expected 3 disks + 1 central triangle");
}

#[test]
fn near_tangent_circle_pair_miss_side_stays_two_standalone_faces() {
    // The miss-side mirror of near_tangent_circles_stay_two_standalone_faces
    // and the direct end-to-end regression for finding 1: two tangent circles
    // the solver left a hair APART must still close as two standalone disks
    // with one virtual tangent point, not zero contact.
    let r: f64 = 5.0;
    let tol = tangent_gap_tol(r, MERGE);
    for gap in [1e-9, 1e-7, 0.5 * tol] {
        let t = detect_topology(&circle_pair_offset_by(r, gap));
        assert_eq!(t.surfaces.len(), 2, "gap {gap:e}: two standalone disks");
        assert!(
            t.edges.is_empty(),
            "gap {gap:e}: no split edges at a tangency"
        );
        assert_eq!(
            t.intersection_points.len(),
            1,
            "gap {gap:e}: one virtual tangent point"
        );
    }
}

#[test]
fn three_circles_a_hair_apart_still_make_four_areas() {
    // The three_mutually_tangent_circles geometry pushed a hair apart: the
    // reported "4 -> 3 surfaces" cliff was the collapse never firing on the
    // miss side. An equilateral centre spacing of 2r + gap keeps every pair
    // a miss within tolerance, so the central triangle must still build.
    let r: f64 = 2.61391544342041;
    let tol = tangent_gap_tol(r, MERGE);
    for gap in [1e-7, 0.5 * tol] {
        let s = 2.0 * r + gap;
        let geom = vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("B".into(), circle([s, 0.0], r)),
            ("C".into(), circle([s / 2.0, 3.0f64.sqrt() * s / 2.0], r)),
        ];
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            4,
            "gap {gap:e}: 3 disks + 1 central triangle"
        );
    }
}

#[test]
fn tangent_line_between_two_circles_closes_its_own_area() {
    // Bug report bug-report-1788207174415: a venn of two circles plus an
    // external tangent line spanning them bounds a fifth region (line + the
    // two arcs it touches). A converged tangent constraint leaves the
    // line/circle discriminant a hair NEGATIVE (here -7.6e-4 and -8.8e-5,
    // i.e. the line misses each rim by ~1e-7), so the old `disc < 0` bail
    // split neither circle at its tangent point and that region never closed.
    let geom = vec![
        ("A".into(), circle([0.0, 0.0], 9.5)),
        ("B".into(), circle([0.0, 10.0], 4.0)),
        (
            "L".into(),
            line([3.340658664703369, 12.2], [7.9340643882751465, 5.225]),
        ),
    ];
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        4,
        "2 crescents + lens + the tangent region"
    );

    // The vertical line from B's centre down through A's centre cuts the lens
    // in two; both of its ends are free, so neither crescent is divided.
    let mut with_chord = geom.clone();
    with_chord.push(("V".into(), line([0.0, 10.0], [0.0, 0.0])));
    let t2 = detect_topology(&with_chord);
    assert_eq!(t2.surfaces.len(), 5, "the chord splits only the lens");
}

#[test]
fn tangent_collapse_holds_across_the_solver_residual_band() {
    // Exact tangency, and a miss an order of magnitude past anything a
    // converged solve leaves (the report's own solve sits at gap 9e-8): the
    // collapse must carry all of them, or the tangent region stops building
    // as soon as a drag loosens the solve. This is the side that needs the
    // rule -- only a near-MISS has no roots to work from.
    for gap in [0.0, 1e-9, 9e-8, 1e-6, 1e-5, 4e-5] {
        let t = detect_topology(&tangent_pair_offset_by(gap));
        assert_eq!(
            t.surfaces.len(),
            4,
            "gap {gap:e}: tangent region must build"
        );
    }
    // The near-GRAZE side needs no tolerance to close the region -- the two
    // roots are real -- but taking both would slice each rim into a phantom
    // sliver arc. Inside tolerance the collapse asserts the single foot, and
    // past it the chords are honest geometry: 4 either way, never a
    // degenerate extra face.
    for gap in [-1e-5, -1e-4, -1e-2] {
        let t = detect_topology(&tangent_pair_offset_by(gap));
        assert_eq!(t.surfaces.len(), 4, "gap {gap:e}: no sliver face");
    }
    // Past tolerance on the miss side the line touches nothing, leaving just
    // the venn's own 3 regions. The cliff is the pair's gap budget of the
    // SMALLER circle (4e-5 here) since the region needs both contacts; it is
    // pinned from both sides so widening the constant cannot pass unnoticed.
    for gap in [4.1e-5, 1e-3, 1e-2, 0.1] {
        let t = detect_topology(&tangent_pair_offset_by(gap));
        assert_eq!(t.surfaces.len(), 3, "gap {gap:e}: a real miss stays a miss");
    }
}

#[test]
fn near_tangent_lines_to_an_ellipse_close_the_side_regions() {
    // Bug class A: a line tangent to an ellipse reported no contact, so the
    // region the line closes never built. The stadium's top and bottom sides
    // sit a hair off tangency to the ellipse inside it; within the gap budget
    // each side's virtual contact splits the ellipse and the stadium into the
    // pinned left and right side regions plus the disk. On a real miss the
    // ellipse stays whole and the stadium is its one and only region.
    let (a, b, half_width): (f64, f64, f64) = (5.0, 2.0, 6.0);
    let stadium = |gap: f64| {
        vec![
            ("e0".into(), ellipse([0.0, 0.0], a, b, 0.0)),
            (
                "top".into(),
                line([-half_width, b + gap], [half_width, b + gap]),
            ),
            (
                "bottom".into(),
                line([half_width, -b - gap], [-half_width, -b - gap]),
            ),
            (
                "right".into(),
                line([half_width, b + gap], [half_width, -b - gap]),
            ),
            (
                "left".into(),
                line([-half_width, -b - gap], [-half_width, b + gap]),
            ),
        ]
    };
    for gap in [1e-7, 5e-6] {
        let t = detect_topology(&stadium(gap));
        assert_eq!(
            t.surfaces.len(),
            3,
            "gap {gap:e}: disk + left and right side regions"
        );
    }
    let t = detect_topology(&stadium(1e-2));
    assert_eq!(t.surfaces.len(), 2, "a real miss leaves the stadium whole");
}

#[test]
fn a_concave_container_keeps_a_nested_face_as_its_hole() {
    // The nesting fix end to end: a small C-shaped traced face inside a big
    // one, plus a circle in the notch. The small C's centroid sits in its own
    // mouth, which the big C's mouth also covers, so the centroid-only test
    // dropped the hole; the circle is genuinely outside both and stays its own
    // face. The two C outlines share no edge and no vertex, so the DCEL sees
    // three clean loops.
    let outline = |pts: &[[f64; 2]], prefix: &str| {
        (0..pts.len())
            .map(|i| {
                (
                    format!("{prefix}{i}"),
                    line(pts[i], pts[(i + 1) % pts.len()]),
                )
            })
            .collect::<Vec<_>>()
    };
    let big = outline(
        &[
            [0.0, 0.0],
            [0.0, 12.0],
            [12.0, 12.0],
            [12.0, 8.0],
            [4.0, 8.0],
            [4.0, 4.0],
            [12.0, 4.0],
            [12.0, 0.0],
        ],
        "big",
    );
    let small = outline(
        &[
            [1.5, 1.0],
            [1.5, 11.0],
            [10.5, 11.0],
            [10.5, 9.0],
            [3.5, 9.0],
            [3.5, 3.0],
            [10.5, 3.0],
            [10.5, 1.0],
        ],
        "small",
    );
    let mut geom = big;
    geom.extend(small);
    geom.push(("disc".into(), circle([8.0, 6.0], 1.0)));

    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 3, "big C, small C and the disc");
    let with_hole: Vec<_> = t.surfaces.iter().filter(|s| !s.holes.is_empty()).collect();
    assert_eq!(with_hole.len(), 1, "only the big C carries a hole");
    assert!(
        with_hole[0]
            .face_entity_ids
            .iter()
            .all(|id| id.starts_with("big")),
        "the hole belongs to the big C's face"
    );
    assert!(
        with_hole[0].holes[0]
            .iter()
            .all(|e| e.id.as_deref().is_some_and(|id| id.starts_with("small"))),
        "the hole is the small C's loop"
    );
}

#[test]
fn a_crossing_survives_a_foot_that_lies_off_the_segment() {
    // The collapse must never cost a real root. A line running from just past
    // the foot of its own perpendicular to beyond the rim crosses the circle
    // for real, but its foot sits off the segment -- when the collapse also
    // ran on the graze side, that combination short-circuited and the whole
    // crossing was dropped, which is worse than never having collapsed at all.
    let r: f64 = 100.0;
    for gap in [9e-4, 1e-3] {
        let y = r - gap; // chord `gap` inside the rim
        let half = (r * r - y * y).sqrt();
        let g = vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("H".into(), line([0.1, y], [half + 0.5, y])), // foot at x=0, off-segment
        ];
        let t = detect_topology(&g);
        assert_eq!(
            t.intersection_points.len(),
            1,
            "gap {gap:e}: the crossing is real"
        );
    }
}

#[test]
fn a_near_miss_whose_foot_is_off_the_segment_stays_a_miss() {
    // The other side of the same branch: the line misses the rim by less than
    // tolerance, but its tangency would fall beyond the segment's end, so
    // there is nothing to contact.
    let r: f64 = 100.0;
    let y = r + 1e-4; // inside the 1e-3 budget for r=100
    let g = vec![
        ("A".into(), circle([0.0, 0.0], r)),
        ("H".into(), line([5.0, y], [40.0, y])), // foot at x=0, well off the segment
    ];
    let t = detect_topology(&g);
    assert!(t.intersection_points.is_empty());
}

#[test]
fn venn_chord_splits_lens_into_four_areas() {
    // Bug report sketch_area_building: two overlapping circles (a venn diagram)
    // with a line connecting their two intersection points must yield 4 areas
    // (the 2 outer crescents + the lens split in two by the chord). The solver
    // leaves each circle/circle intersection ~1e-6 from the coincident line
    // endpoint, so the vertex merge must be looser than that residual or the
    // chord's corner vertices fail to fuse, the planar graph tears, and the
    // tracer collapses to a single face. Geometry is the report's solved values.
    let geom = vec![
        (
            "A".into(),
            circle(
                [-49.890132904052734, -0.0206315740942955],
                23.889873504638672,
            ),
        ),
        (
            "B".into(),
            circle(
                [-28.857667922973633, 3.3534867763519287],
                23.889873504638672,
            ),
        ),
        (
            "L".into(),
            line(
                [-42.76115417480469, 22.780765533447266],
                [-35.98664855957031, -19.44791030883789],
            ),
        ),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 4, "2 crescents + 2 lens halves");
}

#[test]
fn line_slashes_circle_into_two_areas() {
    let geom = vec![
        ("c0".into(), circle([0.0, 0.0], 1.0)),
        ("l0".into(), line([-2.0, 0.0], [2.0, 0.0])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2);
}

#[test]
fn center_to_center_line_bounds_no_spike() {
    // Bug report bug-report-1788364894806: two overlapping circles plus a
    // line joining their two centres. Each circle centre is an interior point,
    // so the line dangles into both crescents and the face tracer used to
    // carry the dangling segment back and forth as a zero-width slit. OCC
    // cannot build a face from that boundary, so the picked "big circle minus
    // the venn" area extruded as a thin plane instead of the crescent. The
    // crescents must be clean 3-edge loops (the chord still splits the lens
    // in two, so 4 areas total).
    let geom = vec![
        ("A".into(), circle([0.0, 0.0], 9.5)),
        ("B".into(), circle([0.0, 10.0], 4.0)),
        ("V".into(), line([0.0, 10.0], [0.0, 0.0])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 4, "2 crescents + 2 lens halves");
    // The line only divides the lens, so it must appear in exactly the two
    // lens-half faces, never in a crescent it merely dangled into.
    let with_line = t
        .surfaces
        .iter()
        .filter(|s| s.face_entity_ids.contains(&"V".to_string()))
        .count();
    assert_eq!(with_line, 2, "the chord bounds only the lens halves");
    for s in &t.surfaces {
        assert_eq!(s.boundary.len(), 3, "no dangling slit in any boundary");
    }
}

#[test]
fn full_open_spline_half_edge_preserves_its_control_points() {
    // A spline subdivides only when a crossing splits it; otherwise the
    // whole curve goes through `spline_eg`. All four of its arguments are
    // `Vec2`, so a positional scramble at the call site would silently emit
    // a different curve while still producing a `Spline` variant. Pin every
    // control point, not just the variant.
    let start = [0.0, 0.0];
    let c1 = [0.5, 2.0];
    let c2 = [1.5, 2.0];
    let end = [2.0, 0.0];
    // An open spline plus the chord joining its endpoints closes one loop
    // with no crossing, so the spline stays a single full half-edge.
    let geom = vec![
        ("s0".into(), spline_open(start, c1, c2, end)),
        ("l0".into(), line(end, start)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1, "spline plus chord close one loop");
    let spline = t
        .edges
        .iter()
        .find_map(|e| match e.geom {
            EdgeGeom::Spline { start, c1, c2, end } => Some((start, c1, c2, end)),
            _ => None,
        })
        .expect("the spline must contribute a half-edge");
    assert_eq!(spline, (start, c1, c2, end));
}

#[test]
fn standalone_ellipse_is_one_surface() {
    let geom = vec![("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 30.0))];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.surfaces[0].boundary.len(), 1);
    assert!(matches!(
        t.surfaces[0].boundary[0].geom,
        EdgeGeom::Ellipse { .. }
    ));
}

#[test]
fn closed_spline_is_one_surface() {
    // A cubic Bezier starting and ending at the same point.
    let geom = vec![(
        "s0".into(),
        spline_closed([0.0, 0.0], [1.0, 2.0], [-1.0, 2.0]),
    )];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1);
    assert_eq!(t.surfaces[0].boundary.len(), 1);
    assert!(matches!(
        t.surfaces[0].boundary[0].geom,
        EdgeGeom::Spline { .. }
    ));
}

#[test]
fn ellipse_split_by_a_center_line_makes_two_faces() {
    // The conic half of the split pipeline: a line through the ellipse
    // centre crosses it at the two ends of the minor axis and cuts the
    // boundary into two elliptical arcs meeting one chord.
    let geom = vec![
        ("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 0.0)),
        ("l0".into(), line([0.0, -3.0], [0.0, 3.0])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2, "the chord splits the ellipse in two");
    let arcs = t
        .edges
        .iter()
        .filter(|e| matches!(e.geom, EdgeGeom::EllipseArc { .. }))
        .count();
    assert_eq!(arcs, 2, "the ellipse is cut into two sub-arcs");
}

#[test]
fn closed_spline_split_by_a_line_makes_two_faces() {
    // The spline half: a chord across the teardrop loop cuts the single
    // closed spline into sub-edges and closes two faces on the chord.
    let geom = vec![
        (
            "s0".into(),
            spline_closed([0.0, 0.0], [1.0, 2.0], [-1.0, 2.0]),
        ),
        ("l0".into(), line([-2.0, 1.0], [2.0, 1.0])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2, "the chord splits the spline loop");
    let spline_edges = t
        .edges
        .iter()
        .filter(|e| matches!(e.geom, EdgeGeom::Spline { .. }))
        .count();
    assert!(
        spline_edges >= 2,
        "the spline must be cut into sub-edges, got {spline_edges}"
    );
}

#[test]
fn a_self_crossing_spline_closes_its_lobe() {
    // A cubic whose branches meet again near (0.44, 0.36): the crossing must
    // become a vertex, the piece between the two parameters a self-loop
    // half-edge, and the lobe it bounds the one face. Before the self-crossing
    // pass the curve had no vertex but its ends, every span of it was a running
    // piece between them, and the lobe was invisible.
    let geom = vec![(
        "s0".into(),
        spline_open([0.0, 0.0], [4.0, 3.0], [-4.0, 3.0], [1.0, 0.0]),
    )];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1, "the lobe is the one face");
    let boundary = &t.surfaces[0].boundary;
    assert_eq!(boundary.len(), 1, "the lobe is the self-loop piece alone");
    assert!(matches!(boundary[0].geom, EdgeGeom::Spline { .. }));
    assert_eq!(
        boundary[0].start_vertex, boundary[0].end_vertex,
        "the lobe starts and ends on the crossing vertex"
    );
    // The crossing vertex is one of the two minted ones, and the lobe's area
    // is the region between the two parameters: positive, smaller than the
    // curve's own bounding box, and stable to the vertex merge.
    let cross = &t
        .intersection_points
        .iter()
        .find(|(_, p)| (p[0] - 0.44).abs() < 1e-4 && (p[1] - 0.36).abs() < 1e-4)
        .expect("the crossing is an intersection point");
    assert_eq!(&boundary[0].start_vertex, &Some(cross.0.clone()));
    let area = t
        .surfaces
        .iter()
        .map(|s| crate::topology::profile_loops::loop_signed_area(&s.boundary))
        .sum::<f64>();
    // Rough magnitude check: the lobe spans about 1.1 by 1.9 world units.
    assert!(
        (0.5..4.0).contains(&area),
        "lobe area {area} outside the plausible band"
    );
}

#[test]
fn a_node_at_the_start_still_slices_its_lobe() {
    // B(0) = B(0.5) = (0, 0): the node sits on ONE end (the start), so it is
    // not the closure and the lobe between the parameters is a face. The
    // crossing's vertex is the start's own, so the lobe piece is a self-loop.
    let geom = vec![(
        "s0".into(),
        spline_open([0.0, 0.0], [1.0, 1.0], [0.0, 2.0], [-3.0, -9.0]),
    )];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 1, "the lobe is the one face");
    let boundary = &t.surfaces[0].boundary;
    assert_eq!(boundary.len(), 1, "the lobe is the self-loop piece alone");
    assert_eq!(
        boundary[0].start_vertex, boundary[0].end_vertex,
        "the lobe starts and ends on the node, which is the start vertex"
    );
    assert!(
        crate::topology::profile_loops::loop_signed_area(boundary) > 0.0,
        "the lobe bounds a positive area"
    );
}

#[test]
fn a_sliced_washer_keeps_the_c_shapes_and_drops_the_bore_halves() {
    // The even/odd rule end to end: a washer sliced across by a line used to
    // emit four bounded regions (two ring halves and two bore halves), because
    // each face's own loop is contained in no other loop. The rule is stated
    // on the closed carriers, so the outer and inner circles are still two
    // shells whatever the line did to their loops: the ring halves are the
    // fillable areas and the bore halves are holes.
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 2.0)),
        ("inner".into(), circle([0.0, 0.0], 1.0)),
        ("slice".into(), line([-3.0, 0.0], [3.0, 0.0])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2, "the two ring halves are the areas");
    assert_eq!(t.hole_regions.len(), 2, "the bore halves are holes");
    for s in &t.surfaces {
        assert!(s.holes.is_empty(), "the ring halves carry no holes");
    }
    // The two C-shapes together are the annulus: pi * (4 - 1). Exact Green's
    // quadrature, not the coarse polygon area: a half-annulus sampled at one
    // interior point per arc under-reports by a third.
    let area: f64 = t
        .surfaces
        .iter()
        .map(|s| crate::topology::oracle::loop_area_centroid(&s.boundary).0)
        .sum();
    let annulus = std::f64::consts::PI * 3.0;
    assert!(
        (area - annulus).abs() < 1e-3,
        "the C-shapes' area {area} is not the annulus {annulus}"
    );
    // Both C-shapes carry a slice line side and an arc of each circle.
    for s in &t.surfaces {
        let ids = &s.face_entity_ids;
        for want in ["outer", "inner", "slice"] {
            assert!(
                ids.iter().any(|id| id == want),
                "a C-shape is bounded by {want}: {ids:?}"
            );
        }
    }
}

#[test]
fn an_unsliced_washer_keeps_its_island() {
    // The rule's exemption: a shell the arrangement never cut keeps the sketch
    // model's standalone loop, so an unsliced washer is still two areas (the
    // ring with the bore as its hole, plus the bore as its own island).
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 2.0)),
        ("inner".into(), circle([0.0, 0.0], 1.0)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2);
    assert_eq!(t.hole_regions.len(), 0, "nothing is cut, nothing is a hole");
}

#[test]
fn a_nearly_closed_spline_is_a_shell_like_a_closed_one() {
    // A teardrop whose ends sit a gap under MERGE apart is one closed curve to
    // the vertex merge, so it is a shell like the exactly closed teardrop. The
    // cubic's only double point is its own near-closure; reporting it split the
    // curve at a phantom lobe and left the shell out of the hole rule, which
    // the oracle (which reads the ends as merged) then disagreed with.
    for gap in [0.0, 0.5 * MERGE] {
        let geom = vec![
            (
                "s0".into(),
                spline_open([0.0, 0.0], [1.0, 2.0], [-1.0, 2.0], [gap, 0.0]),
            ),
            ("l0".into(), line([-3.0, 0.0], [3.0, 0.0])),
        ];
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            1,
            "gap {gap:e}: the teardrop is one standalone area"
        );
        assert!(
            t.surfaces[0].holes.is_empty() && t.hole_regions.is_empty(),
            "gap {gap:e}: nothing nests in a lone teardrop"
        );
        assert!(
            t.edges.iter().all(|e| e.entity_id == "l0"),
            "gap {gap:e}: the spline must not be split anywhere"
        );
        let violations = crate::topology::oracle::check_input(&geom)
            .iter()
            .map(|v| v.render())
            .collect::<Vec<_>>();
        assert!(violations.is_empty(), "gap {gap:e}: {violations:?}");
    }
}

#[test]
fn a_lone_island_still_subtracts_the_bore_it_covers() {
    // The island's hole subtraction must run when it is the only surface left:
    // an uncut outer circle carrying a slit inner circle keeps the whole disk
    // as one standalone face, and the bore pieces the slit traced are holes
    // the disk must subtract (the early return used to skip exactly this).
    let geom = vec![
        ("outer".into(), circle([5.0, 3.0], 6.5)),
        ("inner".into(), circle([5.0, 3.0], 5.0)),
        ("slit_a".into(), line([3.0, 4.5], [-1.0, 4.5])),
        ("slit_b".into(), line([-1.0, -1.5], [3.0, -1.5])),
    ];
    let t = detect_topology(&geom);
    assert!(
        t.surfaces.iter().any(|s| !s.holes.is_empty()),
        "the covering face subtracts the bore: {} surfaces, {} hole regions",
        t.surfaces.len(),
        t.hole_regions.len()
    );
    let violations = crate::topology::oracle::check_input(&geom)
        .iter()
        .map(|v| v.render())
        .collect::<Vec<_>>();
    assert!(violations.is_empty(), "{violations:?}");
}

#[test]
fn a_traced_face_subtracts_the_bore_it_owns() {
    // An outer circle cut only in its ring and an inner circle cut only in its
    // bore. The ring face is not a standalone island, but its boundary encloses
    // the bore: the bore halves are its inner boundary, so they must be
    // subtracted. The island-only rule skipped them and the oracle read the
    // bore's cells as filled.
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 2.0)),
        ("inner".into(), circle([0.0, 0.0], 1.0)),
        ("ring_cut".into(), line([-3.0, 1.8], [3.0, 1.8])),
        ("bore_cut".into(), line([-1.5, 0.5], [1.5, 0.5])),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2, "the cap and the lower ring");
    assert_eq!(t.hole_regions.len(), 2, "the two bore halves are holes");
    let ring = t
        .surfaces
        .iter()
        .find(|s| !s.holes.is_empty())
        .expect("the ring face subtracts the two bore halves");
    assert_eq!(ring.holes.len(), 2, "both bore halves");
    let violations = crate::topology::oracle::check_input(&geom)
        .iter()
        .map(|v| v.render())
        .collect::<Vec<_>>();
    assert!(violations.is_empty(), "{violations:?}");
}

#[test]
fn a_hole_circle_crossed_by_a_shell_keeps_its_pieces_as_material() {
    // The frontend's peanut-with-hole sketch: two crossing circles, their chord
    // line and a hole circle centred on one lobe, cut in two by the other
    // circle. The hole is not a clean bore: the right circle splits it into
    // pieces that belong to different faces, so it takes no nesting level. The
    // peanut's four faces plus the hole's two pieces are the areas; the pieces
    // used to be hole regions (the old rule dropped them and the extrude's
    // add-fuse had to avoid wiring them into the crescent).
    let geom = vec![
        ("cL".into(), circle([-6.614378452301025, 7.5], 10.0)),
        ("cR".into(), circle([6.614378452301025, 7.5], 10.0)),
        ("ln".into(), line([0.0, 0.0], [0.0, 15.0])),
        (
            "cHole".into(),
            circle([-6.614378452301025, 7.5], 5.703681945800781),
        ),
    ];
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        6,
        "the four peanut faces plus the hole's two pieces"
    );
    assert_eq!(t.hole_regions.len(), 0, "the crossed hole takes no level");
    for s in &t.surfaces {
        assert!(
            s.holes.is_empty(),
            "nothing is a hole here: {:?} carries {}",
            s.face_entity_ids,
            s.holes.len()
        );
    }
    let violations = crate::topology::oracle::check_input(&geom)
        .iter()
        .map(|v| v.render())
        .collect::<Vec<_>>();
    assert!(violations.is_empty(), "{violations:?}");
}

#[test]
fn a_washer_sliced_by_a_diameter_line_keeps_its_two_rings() {
    // Two concentric circles cut by a diameter line: the ring halves are the
    // areas and the bore halves the holes. The bore halves' boundary points are
    // REBUILT (an arc endpoint from its angle, a crossing from the line/circle
    // solve), so they land a few ulp of the largest coordinate off the inner
    // carrier; an allowance derived from the carrier's radius alone was too
    // tight for the crossing's magnitude and read every face as material.
    let geom = vec![
        ("line".into(), line([-0.105, 0.01], [0.105, 0.01])),
        ("outer".into(), circle([-0.005, 0.01], 0.025)),
        ("inner".into(), circle([-0.005, 0.01], 0.01)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 2, "the two ring halves are the areas");
    assert_eq!(t.hole_regions.len(), 2, "the bore halves are holes");
    let violations = crate::topology::oracle::check_input(&geom)
        .iter()
        .map(|v| v.render())
        .collect::<Vec<_>>();
    assert!(violations.is_empty(), "{violations:?}");
}

#[test]
fn quarter_arc_split_by_a_bezier_makes_two_faces() {
    // The arc half: a quarter disk (arc plus its two radii) cleaved by a
    // straight cubic that enters on one radius and leaves through the arc,
    // so the arc reaches the half-edge builder as two sub-arcs.
    let quarter = InputEntity {
        kind: Some("arc".into()),
        center: Some([0.0, 0.0]),
        radius: Some(1.0),
        start: Some([1.0, 0.0]),
        end: Some([0.0, 1.0]),
        angle_start: Some(0.0),
        angle_end: Some(90.0),
        ..Default::default()
    };
    let bezier = InputEntity {
        kind: Some("spline".into()),
        start: Some([-1.0, 0.8]),
        end: Some([1.0, 0.8]),
        c1: Some([-0.3, 0.8]),
        c2: Some([0.3, 0.8]),
        ..Default::default()
    };
    let geom = vec![
        ("a0".into(), quarter),
        ("l0".into(), line([1.0, 0.0], [0.0, 0.0])),
        ("l1".into(), line([0.0, 0.0], [0.0, 1.0])),
        ("s0".into(), bezier),
    ];
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        2,
        "the bezier chord splits the quarter disk"
    );
    let arcs = t
        .edges
        .iter()
        .filter(|e| matches!(e.geom, EdgeGeom::Arc { .. }))
        .count();
    assert_eq!(arcs, 2, "the arc is cut at the bezier crossing");
}

#[test]
fn a_hole_circle_crossed_by_another_circle_keeps_its_pieces_as_areas() {
    // Bug report 20261020_0019_sketch_area: a r=15 hole circle concentric with
    // the r=25 outer circle, and a second r=25 circle 30 away that crosses both.
    // The hole is not a clean bore: the offset circle splits it in two, and
    // each piece is its own bounded region. The even/odd rule used to read the
    // pieces as an even-level hole and drop them, leaving only the three faces
    // outside the r=15 disk.
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 25.0)),
        ("hole".into(), circle([0.0, 0.0], 15.0)),
        ("offset".into(), circle([30.0, 0.0], 25.0)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 5, "all five bounded regions are areas");
    assert_eq!(t.hole_regions.len(), 0, "nothing is a clean bore here");
    let hole_pieces = t
        .surfaces
        .iter()
        .filter(|s| {
            let mut ids = s.face_entity_ids.clone();
            ids.sort();
            ids == vec!["hole".to_string(), "offset".to_string()]
        })
        .count();
    assert_eq!(hole_pieces, 2, "the two pieces of the hole disk");
    // The areas partition the union of the outer and offset disks: the hole
    // disk adds nothing (it lies inside the outer one).
    let area: f64 = t
        .surfaces
        .iter()
        .map(|s| crate::topology::oracle::loop_area_centroid(&s.boundary).0)
        .sum();
    let lens = 2.0 * 25.0f64.powi(2) * (30.0f64 / 50.0).acos() - 15.0 * (2500.0f64 - 900.0).sqrt();
    let union = 2.0 * std::f64::consts::PI * 25.0f64.powi(2) - lens;
    assert!(
        (area - union).abs() < 1e-3,
        "the five areas cover the disk union: {area} vs {union}"
    );
    let violations = crate::topology::oracle::check_input(&geom)
        .iter()
        .map(|v| v.render())
        .collect::<Vec<_>>();
    assert!(violations.is_empty(), "{violations:?}");
}

/// Closed rectangle as four line entities, the way the area builder sees a
/// drawn rect: the corners are shared by consecutive edges.
fn rect_lines(prefix: &str, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<(String, InputEntity)> {
    let p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    (0..4)
        .map(|i| (format!("{prefix}{i}"), line(p[i], p[(i + 1) % 4])))
        .collect()
}

#[test]
fn two_overlapping_circles_partition_their_union() {
    // The cast-bearing report's envelope: r10 circles 8 apart. The area model
    // must expose the two crescents and the lens as three independent areas;
    // their union is the extrudable region. A classifier that nests either
    // crescent in the lens builds the intersection, not the union (the
    // frontend regression pinned in profileLoops.test.ts).
    let geom = vec![
        ("A".into(), circle([0.0, 0.0], 10.0)),
        ("B".into(), circle([8.0, 0.0], 10.0)),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 3, "two crescents plus the lens");
    assert_eq!(t.hole_regions.len(), 0, "nothing is a bore here");
    for s in &t.surfaces {
        assert!(
            s.holes.is_empty(),
            "the areas are independent, not nested: {:?}",
            s.face_entity_ids
        );
        assert_eq!(s.boundary.len(), 2, "each area is an arc pair");
    }
    let area: f64 = t
        .surfaces
        .iter()
        .map(|s| crate::topology::oracle::loop_area_centroid(&s.boundary).0)
        .sum();
    let lens = 2.0 * 100.0 * (0.4f64).acos() - 4.0 * (400.0f64 - 64.0).sqrt();
    let union = 2.0 * std::f64::consts::PI * 100.0 - lens;
    assert!(
        (area - union).abs() < 1e-6,
        "the three areas cover the union: {area} vs {union}"
    );
}

#[test]
fn two_crossing_rectangles_partition_the_plus() {
    // The key-cap report's crossing rectangles: the arrangement must expose the
    // five rectangles (four arms plus the centre) as separate areas, none
    // nested, so a whole-sketch extrude can union them into the plus.
    let mut geom = rect_lines("h", -2.05, -0.585, 2.05, 0.585);
    geom.extend(rect_lines("v", -0.585, -2.05, 0.585, 2.05));
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 5, "four arms plus the centre");
    assert_eq!(t.hole_regions.len(), 0);
    for s in &t.surfaces {
        assert!(s.holes.is_empty(), "nothing nests: {:?}", s.face_entity_ids);
        assert_eq!(s.boundary.len(), 4, "every region is a quad");
    }
    let area: f64 = t
        .surfaces
        .iter()
        .map(|s| crate::topology::oracle::loop_area_centroid(&s.boundary).0)
        .sum();
    // 2 * (4.1 * 1.17) - 1.17 * 1.17
    let union = 2.0 * 4.1 * 1.17 - 1.17 * 1.17;
    assert!(
        (area - union).abs() < 1e-9,
        "the five areas cover the plus: {area} vs {union}"
    );
}

#[test]
fn a_circle_with_crossing_rects_keeps_the_five_touching_holes() {
    // The key-cap cut's tool: a r4 circle with a plus of two crossing rects
    // inside it. The sketch-area model publishes the four corner regions as
    // the circle's area and the five plus regions as its HOLES; the holes share
    // edges (each arm borders the centre). A prism built from five touching
    // hole wires is not a sound solid (the cut failed BRepCheck_Analyzer), so
    // classifyLoops dissolves them into one plus-shaped wire. This pins the
    // input that dissolve consumes.
    let mut geom = vec![("circ".into(), circle([0.0, 0.0], 4.0))];
    geom.extend(rect_lines("h", -3.0, -1.0, 3.0, 1.0));
    geom.extend(rect_lines("v", -1.0, -3.0, 1.0, 3.0));
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        6,
        "the circle area plus the five plus regions"
    );
    assert_eq!(
        t.hole_regions.len(),
        0,
        "the plus regions are material areas"
    );
    let circle = t
        .surfaces
        .iter()
        .find(|s| s.face_entity_ids == vec!["circ".to_string()])
        .expect("the enclosing area");
    assert_eq!(circle.holes.len(), 5, "one hole per plus region");
    let hole_area: f64 = circle
        .holes
        .iter()
        .map(|h| crate::topology::oracle::loop_area_centroid(h).0.abs())
        .sum();
    let plus = 2.0 * 6.0 * 2.0 - 2.0 * 2.0;
    assert!(
        (hole_area - plus).abs() < 1e-9,
        "the five holes tile the plus: {hole_area} vs {plus}"
    );
}
