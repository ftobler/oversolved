use crate::topology::dcel::{detect_topology, InputEntity};
use crate::topology::profile_loops::Vec2;

use super::helpers::*;

#[test]
fn construction_corner_diagonal_adds_no_crossing() {
    // The frozen-fixture case: a construction diagonal whose endpoints are
    // already real corners contributes nothing, so the golden stays valid.
    let mut geom = square(2.0);
    geom.push(("diag".into(), as_construction(line([0.0, 0.0], [2.0, 2.0]))));
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        1,
        "the construction diagonal does not divide the face"
    );
    assert_eq!(t.intersection_points.len(), 0);
    assert_eq!(t.vertices.len(), 4);
    assert_eq!(t.edges.len(), 4);
}

#[test]
fn construction_crossbar_yields_two_snap_points_and_one_face() {
    // The headline regression: the crossings come back as snap points while
    // the sides they cross stay single edges (the Design-B parity pin).
    let mut geom = square(2.0);
    geom.push(("bar".into(), as_construction(line([-1.0, 1.0], [3.0, 1.0]))));
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        1,
        "a construction line never splits a face"
    );
    assert_eq!(t.intersection_points.len(), 2);
    assert!(has_point(&t.intersection_points, [0.0, 1.0]));
    assert!(has_point(&t.intersection_points, [2.0, 1.0]));
    assert_eq!(t.edges.len(), 4, "the crossed sides are not over-segmented");
    assert_eq!(t.vertices.len(), 6, "four corners plus two crossings");
}

#[test]
fn construction_crossbar_does_not_renumber_real_vertices() {
    // Construction crossings are minted last, so the real corners hold the
    // same `_vN` slots whatever position the construction line takes in the
    // input list. Saved queries against `_v0.._v3` keep resolving.
    // The slot-by-slot mapping `square()`'s endpoint seeding produces, not
    // merely "some corner": a swap of _v0 and _v2 IS the renumbering this
    // test exists to catch.
    let corners: [(&str, Vec2); 4] = [
        ("_v0", [0.0, 0.0]),
        ("_v1", [2.0, 0.0]),
        ("_v2", [2.0, 2.0]),
        ("_v3", [0.0, 2.0]),
    ];
    let bar = (
        "bar".to_string(),
        as_construction(line([-1.0, 1.0], [3.0, 1.0])),
    );

    let mut appended = square(2.0);
    appended.push(bar.clone());
    let mut prepended = vec![bar];
    prepended.extend(square(2.0));

    for geom in [appended, prepended] {
        let vm = vert_map(&detect_topology(&geom));
        assert_eq!(
            vm.len(),
            6,
            "four corners plus the two crossings, nothing else"
        );
        for (id, corner) in corners {
            let v = vm.get(id).unwrap_or_else(|| panic!("{id} missing"));
            assert!(
                (corner[0] - v[0]).abs() < 1e-9 && (corner[1] - v[1]).abs() < 1e-9,
                "{id} moved to {v:?}, expected {corner:?}"
            );
        }
        // The crossings take the slots after the real geometry, in either order.
        let mut minted = [vm["_v4"], vm["_v5"]];
        minted.sort_by(|p, q| p[0].total_cmp(&q[0]));
        assert!(
            (minted[0][0]).abs() < 1e-9 && (minted[0][1] - 1.0).abs() < 1e-9,
            "_v4/_v5 hold (0,1)"
        );
        assert!(
            (minted[1][0] - 2.0).abs() < 1e-9 && (minted[1][1] - 1.0).abs() < 1e-9,
            "_v4/_v5 hold (2,1)"
        );
    }
}

#[test]
fn construction_circle_alone_emits_nothing() {
    let geom = vec![("c0".into(), as_construction(circle([0.0, 0.0], 1.0)))];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 0);
    assert_eq!(t.intersection_points.len(), 0);
    assert_eq!(t.edges.len(), 0);
    assert_eq!(t.vertices.len(), 0);
}

#[test]
fn construction_circle_crossing_line_yields_two_snap_points_no_face() {
    // A pitch or clearance circle: its rim crossings are exactly the points
    // a user aligns to, and the line it crosses stays one edge.
    let geom = vec![
        ("l0".into(), line([-2.0, 0.0], [2.0, 0.0])),
        ("c0".into(), as_construction(circle([0.0, 0.0], 1.0))),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 0);
    assert_eq!(t.intersection_points.len(), 2);
    assert!(has_point(&t.intersection_points, [1.0, 0.0]));
    assert!(has_point(&t.intersection_points, [-1.0, 0.0]));
    assert_eq!(
        t.edges.len(),
        1,
        "the real line is not split by the construction rim"
    );
}

#[test]
fn two_crossing_construction_lines_yield_one_snap_point() {
    // The crossing of two centerlines is a legitimate reference point even
    // though neither line is real geometry.
    let geom = vec![
        ("x".into(), as_construction(line([0.0, 0.0], [2.0, 2.0]))),
        ("y".into(), as_construction(line([0.0, 2.0], [2.0, 0.0]))),
    ];
    let t = detect_topology(&geom);
    assert_eq!(t.surfaces.len(), 0);
    assert_eq!(t.intersection_points.len(), 1);
    assert!(has_point(&t.intersection_points, [1.0, 1.0]));
    assert_eq!(t.edges.len(), 0);
}

#[test]
fn construction_arc_crosses_line_only_inside_its_sweep() {
    // The crossing pass must reuse `angle_in_arc`, so the half of the full
    // circle the arc does not sweep yields nothing. Built inline rather than
    // through the `arc()` helper, which pins `end` at 180 degrees whatever
    // `angle_end` says.
    let quarter = as_construction(InputEntity {
        center: Some([0.0, 0.0]),
        radius: Some(1.0),
        start: Some([1.0, 0.0]),
        end: Some([0.0, 1.0]),
        angle_start: Some(0.0),
        angle_end: Some(90.0),
        ..Default::default()
    });
    let inside = vec![
        ("l0".into(), line([0.5, -2.0], [0.5, 2.0])),
        ("a0".into(), quarter.clone()),
    ];
    let t = detect_topology(&inside);
    assert_eq!(
        t.intersection_points.len(),
        1,
        "only the first-quadrant crossing is on the arc"
    );
    assert!(has_point(&t.intersection_points, [0.5, (0.75f64).sqrt()]));

    let outside = vec![
        ("l0".into(), line([-2.0, -0.5], [2.0, -0.5])),
        ("a0".into(), quarter),
    ];
    assert_eq!(
        detect_topology(&outside).intersection_points.len(),
        0,
        "crossings past the sweep end are not snap points"
    );
}

#[test]
fn construction_ellipse_crossing_is_clipped_to_the_line_segment() {
    // The `intersect_curves` half of the pass, which had no construction
    // coverage at all. The conic meets the line's infinite extension at
    // (4,0) and (-4,0); only (4,0) is on the drawn segment, and a snap point
    // off the end of the line the user drew would be a phantom.
    let geom = vec![
        ("l0".into(), line([2.5, 0.0], [10.0, 0.0])),
        (
            "e0".into(),
            as_construction(ellipse([0.0, 0.0], 4.0, 2.0, 0.0)),
        ),
    ];
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        0,
        "a construction ellipse encloses nothing"
    );
    assert_eq!(t.intersection_points.len(), 1);
    assert!(has_point(&t.intersection_points, [4.0, 0.0]));
    assert_eq!(
        t.edges.len(),
        1,
        "the real line is not split by the construction conic"
    );
}

#[test]
fn construction_arc_crossing_a_real_ellipse_is_clipped_to_its_sweep() {
    // The clip `hit_on_entity` actually performs: a circle of radius 3 meets this
    // ellipse in all four quadrants, and the quarter arc claims only the
    // first. The real ellipse keeps its face and stays one edge.
    let quarter = as_construction(InputEntity {
        center: Some([0.0, 0.0]),
        radius: Some(3.0),
        start: Some([3.0, 0.0]),
        end: Some([0.0, 3.0]),
        angle_start: Some(0.0),
        angle_end: Some(90.0),
        ..Default::default()
    });
    let geom = vec![
        ("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 0.0)),
        ("a0".into(), quarter),
    ];
    let t = detect_topology(&geom);
    assert_eq!(
        t.surfaces.len(),
        1,
        "the real ellipse still encloses its area"
    );
    assert_eq!(
        t.intersection_points.len(),
        1,
        "only the first-quadrant crossing is on the arc"
    );
    let (x, y) = (f64::sqrt(20.0 / 3.0), f64::sqrt(7.0 / 3.0));
    assert!(has_point(&t.intersection_points, [x, y]));
}
