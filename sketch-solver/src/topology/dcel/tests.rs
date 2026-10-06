use crate::radians;
use crate::topology::dcel::{
    angle_in_arc, degrees, detect_topology, InputEntity, TopoEntity, TANGENT_GAP_REL,
};
use crate::topology::profile_loops::EdgeGeom;
use crate::topology::TOL_TOPOLOGY_MERGE as MERGE;

use self::helpers::*;

mod construction;
mod helpers;
mod primitives;

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
    // angle_start = 3e38 echoes through normalize_arcs_and_init_splits for
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
    let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
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
    let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
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
    // the venn's own 3 regions. The cliff is `TANGENT_GAP_REL * r` of the
    // SMALLER circle (4e-5 here) since the region needs both contacts; it is
    // pinned from both sides so widening the constant cannot pass unnoticed.
    for gap in [4.1e-5, 1e-3, 1e-2, 0.1] {
        let t = detect_topology(&tangent_pair_offset_by(gap));
        assert_eq!(t.surfaces.len(), 3, "gap {gap:e}: a real miss stays a miss");
    }
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
