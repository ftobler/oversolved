use std::collections::HashMap;

use crate::radians;
use crate::topology::dcel::{InputEntity, TopoEntity, TopologyOut};
use crate::topology::profile_loops::Vec2;

pub(super) fn line(start: Vec2, end: Vec2) -> InputEntity {
    InputEntity {
        start: Some(start),
        end: Some(end),
        ..Default::default()
    }
}

pub(super) fn circle(c: Vec2, r: f64) -> InputEntity {
    InputEntity {
        center: Some(c),
        radius: Some(r),
        ..Default::default()
    }
}

pub(super) fn square(side: f64) -> Vec<(String, InputEntity)> {
    vec![
        ("a".into(), line([0.0, 0.0], [side, 0.0])),
        ("b".into(), line([side, 0.0], [side, side])),
        ("c".into(), line([side, side], [0.0, side])),
        ("d".into(), line([0.0, side], [0.0, 0.0])),
    ]
}

/// Lift a known-complete record through the same boundary the passes use,
/// for the tests that drive an internal helper directly.
pub(super) fn topo(e: InputEntity) -> TopoEntity {
    TopoEntity::try_from(e).expect("complete entity")
}

pub(super) fn arc(center: Vec2, r: f64, a0: f64, a1: f64) -> InputEntity {
    InputEntity {
        center: Some(center),
        radius: Some(r),
        start: Some([center[0] + r, center[1]]),
        end: Some([center[0] - r, center[1]]),
        angle_start: Some(a0),
        angle_end: Some(a1),
        ..Default::default()
    }
}

// Tangent line at angle 90 deg of the circle (horizontal y = r), the arc
// ending at `end_deg`. The arc's `end` field sits at its angle_end position
// (not the helper default) so the seeded arc-end vertex fuses with the
// tangent contact instead of dangling at (center - r, center). Returns
// (arc, tangent_line, closing_line).
pub(super) fn slot_corner(r: f64, end_deg: f64) -> Vec<(String, InputEntity)> {
    let end_rad = radians(end_deg);
    vec![
        (
            "arc".into(),
            InputEntity {
                center: Some([0.0, 0.0]),
                radius: Some(r),
                start: Some([r, 0.0]),
                end: Some([r * end_rad.cos(), r * end_rad.sin()]),
                angle_start: Some(0.0),
                angle_end: Some(end_deg),
                ..Default::default()
            },
        ),
        ("tangent".into(), line([-3.0, r], [3.0, r])),
        ("close".into(), line([r, 0.0], [r, r])),
    ]
}

// Two equal circles tangent externally, centre distance 2r + gap: gap > 0 is
// a miss (apart), gap < 0 is a graze (overlap). gap is the external residual
// the solver drives, so walking it walks the collapse rule the way a sketch
// degrades as the solve loosens.
pub(super) fn circle_pair_offset_by(r: f64, gap: f64) -> Vec<(String, InputEntity)> {
    vec![
        ("A".into(), circle([0.0, 0.0], r)),
        ("B".into(), circle([2.0 * r + gap, 0.0], r)),
    ]
}

/// The report's two circles plus their external tangent line, with the line
/// displaced `gap` along its own normal: `gap > 0` pulls it clear of both
/// rims, `gap < 0` pushes it in to cut two real chords. `gap` IS the quantity
/// the solver's tangent residual drives, so this walks the collapse rule
/// across its tolerance the way the sketch degrades as a solve gets looser.
pub(super) fn tangent_pair_offset_by(gap: f64) -> Vec<(String, InputEntity)> {
    let (ra, rb, d): (f64, f64, f64) = (9.5, 4.0, 10.0);
    // Unit normal of the common external tangent, pointing at both centres.
    let ny = (rb - ra) / d;
    let nx = -(1.0 - ny * ny).sqrt();
    // Feet on each rim, then slid along -n so the line sits `gap` further out.
    let foot = |cy: f64, r: f64| [-r * nx - gap * nx, cy - r * ny - gap * ny];
    vec![
        ("A".into(), circle([0.0, 0.0], ra)),
        ("B".into(), circle([0.0, d], rb)),
        ("L".into(), line(foot(d, rb), foot(0.0, ra))),
    ]
}

pub(super) fn ellipse(center: Vec2, a: f64, b: f64, theta: f64) -> InputEntity {
    InputEntity {
        kind: Some("ellipse".into()),
        center: Some(center),
        a: Some(a),
        b: Some(b),
        theta: Some(theta),
        ..Default::default()
    }
}

pub(super) fn spline_closed(start_end: Vec2, c1: Vec2, c2: Vec2) -> InputEntity {
    InputEntity {
        kind: Some("spline".into()),
        start: Some(start_end),
        end: Some(start_end),
        c1: Some(c1),
        c2: Some(c2),
        ..Default::default()
    }
}

pub(super) fn spline_open(start: Vec2, c1: Vec2, c2: Vec2, end: Vec2) -> InputEntity {
    InputEntity {
        kind: Some("spline".into()),
        start: Some(start),
        end: Some(end),
        c1: Some(c1),
        c2: Some(c2),
        ..Default::default()
    }
}

pub(super) fn as_construction(mut e: InputEntity) -> InputEntity {
    e.construction = true;
    e
}

/// Coordinates of every emitted vertex, keyed by id, for the construction
/// tests that pin which `_vN` slots the real geometry keeps.
pub(super) fn vert_map(t: &TopologyOut) -> HashMap<String, Vec2> {
    t.vertices.iter().map(|(k, v)| (k.clone(), *v)).collect()
}

pub(super) fn has_point(pts: &[(String, Vec2)], p: Vec2) -> bool {
    pts.iter()
        .any(|(_, v)| (v[0] - p[0]).abs() < 1e-6 && (v[1] - p[1]).abs() < 1e-6)
}
