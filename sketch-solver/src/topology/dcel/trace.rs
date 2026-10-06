use std::collections::{HashMap, HashSet};

use super::super::curve_split::{bezier_point, ellipse_point_at};
use super::super::profile_loops::{subdivide_loops, BoundaryEdge, EdgeGeom, Vec2};
use super::super::{TOL_FACE_EXISTENCE_MIN_AREA, TOL_TOPOLOGY_MERGE as MERGE, TWO_PI};
use super::build::{bend, depart, HalfEdge};
use super::{dedup, EdgeOut, Split, SurfaceOut, TopoEntity, Verts};
use crate::radians;

pub(super) fn face_area(cycle: &[usize], hes: &[HalfEdge], verts: &Verts) -> f64 {
    let mut pts: Vec<Vec2> = Vec::new();
    for &i in cycle {
        let (vf, _, eg) = &hes[i];
        let Some(p) = verts.get(vf) else {
            return 0.0; // an edge naming an unknown vertex encloses nothing
        };
        pts.push(p);
        match *eg {
            EdgeGeom::Spline { start, c1, c2, end } => {
                for k in 1..8 {
                    pts.push(bezier_point(start, c1, c2, end, k as f64 / 8.0));
                }
            }
            EdgeGeom::Arc {
                center,
                radius,
                angle_start_deg,
                angle_end_deg,
                ccw,
                ..
            } => {
                let mut a0 = radians(angle_start_deg);
                let mut a1 = radians(angle_end_deg);
                if !ccw {
                    std::mem::swap(&mut a0, &mut a1);
                }
                if a1 < a0 {
                    a1 += TWO_PI;
                }
                let am = (a0 + a1) / 2.0;
                pts.push([center[0] + radius * am.cos(), center[1] + radius * am.sin()]);
            }
            EdgeGeom::EllipseArc {
                center,
                a,
                b,
                theta,
                angle_start_deg,
                angle_end_deg,
                ccw,
                ..
            } => {
                let p0 = radians(angle_start_deg);
                let mut p1 = radians(angle_end_deg);
                if ccw {
                    if p1 < p0 {
                        p1 += TWO_PI;
                    }
                } else if p1 > p0 {
                    p1 -= TWO_PI;
                }
                let cr = (theta * std::f64::consts::PI / 180.0).cos();
                let sr = (theta * std::f64::consts::PI / 180.0).sin();
                for k in 1..8 {
                    pts.push(ellipse_point_at(
                        [center[0], center[1]],
                        a,
                        b,
                        cr,
                        sr,
                        p0 + (p1 - p0) * k as f64 / 8.0,
                    ));
                }
            }
            EdgeGeom::Line { .. } | EdgeGeom::Ellipse { .. } => {}
        }
    }
    let n = pts.len();
    let mut sum = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        sum += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    sum / 2.0
}

fn boundary_edge(eg: &EdgeGeom, id: &str, v0: &str, v1: &str) -> BoundaryEdge {
    BoundaryEdge {
        geom: eg.clone(),
        id: Some(id.to_string()),
        start_vertex: Some(v0.to_string()),
        end_vertex: Some(v1.to_string()),
    }
}

/// Drop the degenerate "spikes" a dangling curve leaves in a face cycle.
///
/// A curve whose endpoint sits in the interior of a face (a centre-to-rim line,
/// for example) has a degree-1 terminal vertex. The face tracer reaches it via
/// one half-edge and, with no other departure to choose, returns immediately on
/// the twin, so the cycle carries the pair back to back: a zero-width slit that
/// bounds nothing. OCC cannot build a face from that boundary, and it reads to
/// the user as a "thin plane". Such a slit is a bridge, and a bridge is never
/// part of the real boundary, so collapse each consecutive twin pair (and any
/// pair the wrap-around leaves at the seam) out of the cycle.
fn collapse_spikes(cycle: &[usize]) -> Vec<usize> {
    let mut stack: Vec<usize> = Vec::with_capacity(cycle.len());
    for &i in cycle {
        if stack.last().is_some_and(|&l| l == (i ^ 1)) {
            stack.pop();
        } else {
            stack.push(i);
        }
    }
    // The cycle is cyclic: the first and last edges can be the two halves of one
    // bridge, which the linear pass above cannot see.
    while stack.len() >= 2 && stack[0] == (stack[stack.len() - 1] ^ 1) {
        stack.remove(stack.len() - 1);
        stack.remove(0);
    }
    stack
}

pub(super) fn trace_face_cycles(
    hes: &[HalfEdge],
    he_eid: &[String],
    verts: &Verts,
) -> Vec<SurfaceOut> {
    let mut surfaces: Vec<SurfaceOut> = Vec::new();
    if hes.is_empty() {
        return surfaces;
    }

    let mut out_map: HashMap<String, Vec<(f64, f64, usize)>> = HashMap::new();
    for (i, (vf, _, eg)) in hes.iter().enumerate() {
        let angle = depart(eg);
        out_map
            .entry(vf.clone())
            .or_default()
            .push((angle, bend(eg), i));
    }
    for outs in out_map.values_mut() {
        // Order CCW by departure angle. Two edges that leave along the same tangent
        // (a tangency cusp) have effectively equal angles; the first derivative
        // cannot separate them, so break the tie by signed curvature (the
        // right-bending edge precedes the left-bending one). ANGLE_TIE rounds away
        // the float noise between two analytically-equal tangent directions while
        // staying far below the gap between genuinely distinct crossing edges.
        const ANGLE_TIE: f64 = 1e-7;
        // A NaN angle or curvature (a poisoned param that reached the geometry
        // pass) compares to nothing, so both orderings fall back to Equal the
        // way `dedup` does: an unordered edge is a lost face, an unwrap here is
        // a dead Worker.
        outs.sort_by(|a, b| {
            if (a.0 - b.0).abs() > ANGLE_TIE {
                a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)
            } else if a.1 != b.1 {
                a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                a.2.cmp(&b.2)
            }
        });
    }

    debug_assert!(
        (0..hes.len()).step_by(2).all(|i| {
            let t = i ^ 1;
            hes[i].0 == hes[t].1 && hes[i].1 == hes[t].0
        }),
        "half-edge twin invariant violated"
    );

    let mut next_he: HashMap<usize, usize> = HashMap::new();
    for outs in out_map.values() {
        let k = outs.len();
        if k == 0 {
            continue;
        }
        for pos in 0..k {
            let i = outs[pos].2;
            let ti = i ^ 1;
            let prev = ((pos as i64 - 1).rem_euclid(k as i64)) as usize;
            next_he.insert(ti, outs[prev].2);
        }
    }

    let mut visited: HashSet<usize> = HashSet::new();
    for start in 0..hes.len() {
        if visited.contains(&start) || !next_he.contains_key(&start) {
            continue;
        }
        let mut cycle: Vec<usize> = Vec::new();
        let mut cur = start;
        while !visited.contains(&cur) && next_he.contains_key(&cur) {
            visited.insert(cur);
            cycle.push(cur);
            cur = next_he[&cur];
            if cur == start {
                break;
            }
        }
        if !cycle.is_empty() && cur == start {
            let cycle = collapse_spikes(&cycle);
            if cycle.len() >= 2 && face_area(&cycle, hes, verts) > TOL_FACE_EXISTENCE_MIN_AREA {
                let boundary: Vec<BoundaryEdge> = cycle
                    .iter()
                    .map(|&i| boundary_edge(&hes[i].2, &he_eid[i], &hes[i].0, &hes[i].1))
                    .collect();
                let face_entity_ids: Vec<String> =
                    cycle.iter().map(|&i| he_eid[i].clone()).collect();
                surfaces.push(SurfaceOut {
                    boundary,
                    face_entity_ids,
                    holes: vec![],
                });
            }
        }
    }

    surfaces
}

fn circle_arcs(cx: f64, cy: f64, r: f64, eid: &str) -> Vec<BoundaryEdge> {
    vec![
        BoundaryEdge {
            geom: EdgeGeom::Arc {
                center: [cx, cy],
                radius: r,
                angle_start_deg: 0.0,
                angle_end_deg: 180.0,
                ccw: true,
                start: [cx + r, cy],
                end: [cx - r, cy],
            },
            id: Some(eid.to_string()),
            start_vertex: None,
            end_vertex: None,
        },
        BoundaryEdge {
            geom: EdgeGeom::Arc {
                center: [cx, cy],
                radius: r,
                angle_start_deg: 180.0,
                angle_end_deg: 360.0,
                ccw: true,
                start: [cx - r, cy],
                end: [cx + r, cy],
            },
            id: Some(eid.to_string()),
            start_vertex: None,
            end_vertex: None,
        },
    ]
}

// A whole closed curve becomes its own face only when nothing subdivides it.
// `max_keep` is the largest split count that still counts as "undivided"; each
// entity that passes maps to its boundary loop (or `None` to skip).
fn build_standalone<F>(
    entities: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
    max_keep: usize,
    mut boundary_of: F,
) -> Vec<SurfaceOut>
where
    F: FnMut(&str, &TopoEntity) -> Option<Vec<BoundaryEdge>>,
{
    let empty: Vec<Split> = Vec::new();
    let mut surfaces = Vec::new();
    for (eid, e) in entities {
        if dedup(splits.get(eid).unwrap_or(&empty)).len() > max_keep {
            continue;
        }
        if let Some(boundary) = boundary_of(eid, e) {
            surfaces.push(SurfaceOut {
                boundary,
                face_entity_ids: vec![eid.clone()],
                holes: vec![],
            });
        }
    }
    surfaces
}

pub(super) fn build_standalone_surfaces(
    circles: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> Vec<SurfaceOut> {
    build_standalone(circles, splits, 1, |eid, e| {
        let TopoEntity::Circle { center, radius, .. } = *e else {
            return None;
        };
        Some(circle_arcs(center[0], center[1], radius, eid))
    })
}

pub(super) fn build_standalone_ellipses(
    ellipses: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> Vec<SurfaceOut> {
    let mut seen: Vec<[f64; 5]> = Vec::new();
    build_standalone(ellipses, splits, 1, move |eid, e| {
        let TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } = *e
        else {
            return None;
        };
        // A degenerate ellipse (near-zero semi-axis) bounds no area; never a face.
        if a.abs() < MERGE || b.abs() < MERGE {
            return None;
        }
        let theta = theta.unwrap_or(0.0);
        let key = [center[0], center[1], a, b, theta];
        if seen
            .iter()
            .any(|k| k.iter().zip(key.iter()).all(|(v, w)| (v - w).abs() < MERGE))
        {
            return None;
        }
        seen.push(key);
        Some(vec![BoundaryEdge {
            geom: EdgeGeom::Ellipse {
                center: [center[0], center[1]],
                a,
                b,
                theta,
            },
            id: Some(eid.to_string()),
            start_vertex: None,
            end_vertex: None,
        }])
    })
}

pub(super) fn build_standalone_splines(
    splines: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
    verts: &mut Verts,
) -> Vec<SurfaceOut> {
    build_standalone(splines, splits, 2, |eid, e| {
        let TopoEntity::Spline {
            start, c1, c2, end, ..
        } = *e
        else {
            return None;
        };
        let v0 = verts.vid(start);
        let v1 = verts.vid(end);
        if v0 != v1 {
            return None; // open spline: only closes a loop with other edges
        }
        Some(vec![BoundaryEdge {
            geom: EdgeGeom::Spline { start, end, c1, c2 },
            id: Some(eid.to_string()),
            start_vertex: Some(v0.clone()),
            end_vertex: Some(v1),
        }])
    })
}

/// Fold nested loops into the sketch-area model via `subdivide_loops`: every loop
/// stays its own area, carrying the loops immediately nested inside it as holes.
pub(super) fn nest_surfaces(surfaces: Vec<SurfaceOut>) -> Vec<SurfaceOut> {
    if surfaces.len() < 2 {
        return surfaces;
    }
    let loops: Vec<Vec<BoundaryEdge>> = surfaces.iter().map(|s| s.boundary.clone()).collect();
    let sub = subdivide_loops(&loops);
    let mut out: Vec<SurfaceOut> = Vec::with_capacity(surfaces.len());
    for (oi, hole_idxs) in sub {
        let mut s = surfaces[oi].clone();
        if !hole_idxs.is_empty() {
            s.holes = hole_idxs.into_iter().map(|i| loops[i].clone()).collect();
        }
        out.push(s);
    }
    out
}

pub(super) fn build_edge_queries(hes: &[HalfEdge], he_eid: &[String]) -> Vec<EdgeOut> {
    let mut edges = Vec::new();
    for (edge_idx, i) in (0..hes.len()).step_by(2).enumerate() {
        let (_v0, _v1, eg) = &hes[i];
        let eid = &he_eid[i];
        let edge_type = if matches!(eg, EdgeGeom::Line { .. }) {
            "straightedge"
        } else {
            "edge"
        };
        edges.push(EdgeOut {
            entity_id: eid.clone(),
            edge_index: edge_idx,
            edge_type,
            geom: eg.clone(),
        });
    }
    edges
}
