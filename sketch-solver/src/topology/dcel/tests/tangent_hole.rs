//! A circle inside the 20 x 20 square touching it from inside at a tangent
//! point (bug-arc-profile D1, the enclosure lip). The profile the user drew is
//! the square minus the full disc, 400 - 4*pi. These pin what the area builder
//! hands the profile composition for it: a touch is a contact, not a crossing,
//! so the disc is never merged into the square or dropped, and the areas around
//! it already leave it out. Which of the published areas a whole-sketch
//! profile fills is `classifyLoops`'s even/odd question on the TS side.

use super::helpers::*;
use crate::topology::dcel::{detect_topology, InputEntity, SurfaceOut};
use crate::topology::profile_loops::{loop_pts, BoundaryEdge};

const SQUARE_MINUS_DISC: f64 = 400.0 - 4.0 * std::f64::consts::PI;

fn loop_area(edges: &[BoundaryEdge]) -> f64 {
    let pts = loop_pts(edges, 512);
    let n = pts.len();
    let sum: f64 = (0..n)
        .map(|i| {
            let p = pts[i];
            let q = pts[(i + 1) % n];
            p[0] * q[1] - q[0] * p[1]
        })
        .sum();
    (sum / 2.0).abs()
}

/// A surface's filled area: its boundary minus its holes.
fn net_area(s: &SurfaceOut) -> f64 {
    loop_area(&s.boundary) - s.holes.iter().map(|h| loop_area(h)).sum::<f64>()
}

fn is_disc(s: &SurfaceOut) -> bool {
    s.face_entity_ids.iter().all(|id| id == "hole")
}

/// The 20 x 20 square with an r2 circle at `c`.
fn square_with_circle(c: [f64; 2]) -> Vec<(String, InputEntity)> {
    let mut g = square(20.0);
    g.push(("hole".into(), circle(c, 2.0)));
    g
}

#[test]
fn a_circle_touching_one_side_is_the_square_hole() {
    // One tangent point leaves the circle a standalone loop: the square's
    // area carries it as a hole and the disc stays its own area.
    let t = detect_topology(&square_with_circle([2.0, 10.0]));
    assert_eq!(t.surfaces.len(), 2);
    let sq = t.surfaces.iter().find(|s| !is_disc(s)).expect("the square");
    assert_eq!(
        sq.holes.len(),
        1,
        "the touching circle is the square's hole"
    );
    assert!((net_area(sq) - SQUARE_MINUS_DISC).abs() < 1e-3);
    assert!(t.surfaces.iter().any(is_disc), "the disc is its own area");
    assert_eq!(
        t.intersection_points,
        vec![("_v4".to_string(), [0.0, 10.0])]
    );
}

#[test]
fn a_circle_touching_two_sides_leaves_the_disc_out_of_its_neighbours() {
    // Two tangent points split square and circle into the corner pocket, the
    // rest of the square, and the disc. The disc is the circle's whole
    // interior, and the two areas around it sum to the square minus the disc,
    // so a profile that fills the neighbours and not the disc is the drawing.
    let t = detect_topology(&square_with_circle([2.0, 2.0]));
    assert_eq!(t.surfaces.len(), 3);
    assert!(t.hole_regions.is_empty());
    let discs: Vec<&SurfaceOut> = t.surfaces.iter().filter(|s| is_disc(s)).collect();
    assert_eq!(discs.len(), 1, "one area bounded by the circle alone");
    assert!((loop_area(&discs[0].boundary) - 4.0 * std::f64::consts::PI).abs() < 1e-3);
    let around: f64 = t
        .surfaces
        .iter()
        .filter(|s| !is_disc(s))
        .map(net_area)
        .sum();
    assert!(
        (around - SQUARE_MINUS_DISC).abs() < 1e-3,
        "pocket + rest = {around}"
    );
}
