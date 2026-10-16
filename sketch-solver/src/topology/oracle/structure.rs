//! The structural oracle: loop closure and self-intersection, half-edge
//! accounting, hole wiring and the Euler characteristic over the split graph.

use std::collections::{BTreeMap, BTreeSet};

/// Cap on the sampled points of one loop for the self-intersection test.
const SELF_INTERSECT_MAX_PTS: usize = 512;

use super::geometry::{
    edge_polyline, loop_area_centroid, loop_polygon, point_line_dist, seg_seg_intersect,
};
use super::Violation;
use crate::topology::dcel::TopologyOut;
use crate::topology::profile_loops::{BoundaryEdge, EdgeGeom, Vec2};
use crate::topology::{TOL_FACE_EXISTENCE_MIN_AREA, TOL_TOPOLOGY_MERGE as MERGE};

/// Loop sides as the structural checks consume them: vertex ids when present,
/// the geometry endpoints, and the source entity id.
pub(crate) struct Side<'a> {
    be: &'a BoundaryEdge,
}

pub(crate) fn side_ends(s: &Side<'_>) -> Option<(Vec2, Vec2)> {
    match s.be.geom {
        EdgeGeom::Line { start, end }
        | EdgeGeom::Arc { start, end, .. }
        | EdgeGeom::EllipseArc { start, end, .. }
        | EdgeGeom::Spline { start, end, .. } => Some((start, end)),
        EdgeGeom::Ellipse { .. } => None,
    }
}

pub(crate) fn check_loop(
    label: &str,
    loop_edges: &[BoundaryEdge],
    verts: &BTreeMap<String, Vec2>,
    input_ids: &BTreeSet<String>,
    construction_ids: &BTreeSet<String>,
    chord_tol: f64,
    out: &mut Vec<Violation>,
) {
    if loop_edges.is_empty() {
        out.push(Violation::new(
            "structure",
            format!("{label} has an empty loop"),
        ));
        return;
    }
    for (k, be) in loop_edges.iter().enumerate() {
        let side = Side { be };
        match &be.id {
            None => out.push(Violation::new(
                "structure",
                format!("{label} side {k} carries no source entity id"),
            )),
            Some(id) if !input_ids.contains(id) => out.push(Violation::new(
                "structure",
                format!("{label} side {k} names unknown entity {id}"),
            )),
            Some(id) if construction_ids.contains(id) => out.push(Violation::new(
                "structure",
                format!("{label} side {k} is the construction entity {id}"),
            )),
            Some(_) => {}
        }
        let (vs, ve) = (&be.start_vertex, &be.end_vertex);
        match (vs, ve) {
            (Some(v0), Some(v1)) => {
                for v in [v0, v1] {
                    if !verts.contains_key(v) {
                        out.push(Violation::new(
                            "structure",
                            format!("{label} side {k} references unregistered vertex {v}"),
                        ));
                    }
                }
                if let (Some(p0), Some(p1), Some(s), Some(e)) = (
                    verts.get(v0),
                    verts.get(v1),
                    side_ends(&side).map(|p| p.0),
                    side_ends(&side).map(|p| p.1),
                ) {
                    let d0 = (p0[0] - s[0]).hypot(p0[1] - s[1]);
                    let d1 = (p1[0] - e[0]).hypot(p1[1] - e[1]);
                    if d0 > MERGE || d1 > MERGE {
                        out.push(Violation::new(
                            "structure",
                            format!(
                                "{label} side {k} geometry does not meet its vertices \
                                 (start off by {d0:e}, end off by {d1:e})"
                            ),
                        ));
                    }
                }
            }
            (None, None) => {}
            _ => out.push(Violation::new(
                "structure",
                format!("{label} side {k} has only one of start/end vertex"),
            )),
        }
    }

    // Closure: each side's end meets the next side's start, by vertex identity
    // when both carry one and by geometry otherwise (a standalone loop has no
    // vertices at all).
    for k in 0..loop_edges.len() {
        let a = &loop_edges[k];
        let b = &loop_edges[(k + 1) % loop_edges.len()];
        let closed = match (&a.end_vertex, &b.start_vertex) {
            (Some(v0), Some(v1)) => v0 == v1,
            _ => match (side_ends(&Side { be: a }), side_ends(&Side { be: b })) {
                (Some((_, e)), Some((s, _))) => (e[0] - s[0]).hypot(e[1] - s[1]) <= MERGE,
                // A full ellipse carries no endpoints: it is closed by itself.
                _ => {
                    matches!(a.geom, EdgeGeom::Ellipse { .. })
                        && matches!(b.geom, EdgeGeom::Ellipse { .. })
                }
            },
        };
        if !closed {
            out.push(Violation::new(
                "structure",
                format!(
                    "{label} is not closed between side {k} and side {}",
                    (k + 1) % loop_edges.len()
                ),
            ));
            break;
        }
    }

    let (area, _) = loop_area_centroid(loop_edges);
    if area <= TOL_FACE_EXISTENCE_MIN_AREA {
        out.push(Violation::new(
            "structure",
            format!("{label} area {area:e} is at or below the face-existence floor"),
        ));
    }
    let poly = loop_polygon(loop_edges, chord_tol, SELF_INTERSECT_MAX_PTS);
    if poly.len() < 3 {
        out.push(Violation::new(
            "structure",
            format!("{label} samples to fewer than 3 points"),
        ));
        return;
    }
    if let Some((i, j)) = first_self_crossing(&poly) {
        out.push(Violation::new(
            "structure",
            format!(
                "{label} self-intersects between segments {i} and {j} near ({:.6}, {:.6})",
                poly[i][0], poly[i][1]
            ),
        ));
    }
}

/// First pair of non-adjacent polygon segments that properly cross (shared
/// endpoints and collinear continuation allowed). O(n^2): the loops are capped
/// at `SELF_INTERSECT_MAX_PTS`.
pub(crate) fn first_self_crossing(poly: &[Vec2]) -> Option<(usize, usize)> {
    let n = poly.len();
    if n < 4 {
        return None;
    }
    // A bbox per segment turns the O(n^2) scan into a near-linear one on the
    // long curved loops: only overlapping boxes reach the orientation tests.
    let boxes: Vec<[f64; 4]> = (0..n)
        .map(|i| {
            let a = poly[i];
            let b = poly[(i + 1) % n];
            [
                a[0].min(b[0]),
                a[1].min(b[1]),
                a[0].max(b[0]),
                a[1].max(b[1]),
            ]
        })
        .collect();
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        for j in (i + 1)..n {
            if (i + 1) % n == j || (j + 1) % n == i {
                continue; // adjacent sides share a vertex by construction
            }
            let (bi, bj) = (boxes[i], boxes[j]);
            if bi[2] < bj[0] || bj[2] < bi[0] || bi[3] < bj[1] || bj[3] < bi[1] {
                continue;
            }
            let c = poly[j];
            let d = poly[(j + 1) % n];
            if !seg_seg_intersect(a, b, c, d) {
                continue;
            }
            // A touch at a shared vertex is a legitimately pinched loop (a
            // cusp where two curves meet); a proper crossing or a collinear
            // overlap is a self-intersection.
            let shares_vertex = [a, b].iter().any(|p| {
                [c, d]
                    .iter()
                    .any(|q| (p[0] - q[0]).hypot(p[1] - q[1]) <= MERGE)
            });
            let collinear = point_line_dist(c, a, b) <= MERGE && point_line_dist(d, a, b) <= MERGE;
            if !shares_vertex || collinear {
                return Some((i, j));
            }
        }
    }
    None
}

/// The same geometry with its direction reversed, mirroring `build::rev`. The
/// oracle needs it to recognise a face side that walks a split edge backwards.
pub(crate) fn reversed(eg: &EdgeGeom) -> EdgeGeom {
    match eg.clone() {
        EdgeGeom::Line { start, end } => EdgeGeom::Line {
            start: end,
            end: start,
        },
        EdgeGeom::Spline { start, c1, c2, end } => EdgeGeom::Spline {
            start: end,
            end: start,
            c1: c2,
            c2: c1,
        },
        EdgeGeom::EllipseArc {
            center,
            a,
            b,
            theta,
            angle_start_deg,
            angle_end_deg,
            ccw,
            start,
            end,
        } => EdgeGeom::EllipseArc {
            center,
            a,
            b,
            theta,
            angle_start_deg: angle_end_deg,
            angle_end_deg: angle_start_deg,
            ccw: !ccw,
            start: end,
            end: start,
        },
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            ccw,
            start,
            end,
        } => EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg: angle_end_deg,
            angle_end_deg: angle_start_deg,
            ccw: !ccw,
            start: end,
            end: start,
        },
        eg @ EdgeGeom::Ellipse { .. } => eg,
    }
}

/// Piece identity for the half-edge counting: the index of the split edge
/// whose geometry equals this side's (either orientation), or a match by
/// endpoints and mid-curve sample within `MERGE` when the exact values differ.
/// Vertex pairs alone cannot identify a piece: a circle split at two points
/// has two pieces between the same pair, one walking each way around.
pub(crate) fn piece_of(out: &TopologyOut, id: &str, eg: &EdgeGeom) -> Option<usize> {
    let exact = |a: &EdgeGeom, b: &EdgeGeom| a == b;
    if let Some(i) = out
        .edges
        .iter()
        .position(|e| e.entity_id == id && (exact(&e.geom, eg) || exact(&e.geom, &reversed(eg))))
    {
        return Some(i);
    }
    let (Some(s), Some(t)) = (eg.start(), edge_end(eg)) else {
        return None;
    };
    let mid = edge_polyline(eg, MERGE);
    let mid = mid.pts.get(mid.pts.len() / 2).copied().unwrap_or(s);
    out.edges.iter().position(|e| {
        if e.entity_id != id {
            return false;
        }
        let (Some(es), Some(et)) = (e.geom.start(), edge_end(&e.geom)) else {
            return false;
        };
        let same = |p: Vec2, q: Vec2| (p[0] - q[0]).hypot(p[1] - q[1]) <= MERGE;
        let emid = edge_polyline(&e.geom, MERGE);
        let emid = emid.pts.get(emid.pts.len() / 2).copied().unwrap_or(es);
        (same(s, es) && same(t, et) && same(mid, emid))
            || (same(s, et) && same(t, es) && same(mid, emid))
    })
}

pub(crate) fn edge_end(eg: &EdgeGeom) -> Option<Vec2> {
    match *eg {
        EdgeGeom::Line { end, .. }
        | EdgeGeom::Arc { end, .. }
        | EdgeGeom::EllipseArc { end, .. }
        | EdgeGeom::Spline { end, .. } => Some(end),
        EdgeGeom::Ellipse { .. } => None,
    }
}

pub(crate) fn half_edge_usage_violations(out: &TopologyOut) -> Vec<Violation> {
    // Each traced face side must be one half-edge of a split edge piece, each
    // piece is used by at most two sides, and no oriented side twice. Hole
    // regions are traced faces too, so their sides count like a surface's.
    let mut uses: BTreeMap<usize, Vec<(String, String, EdgeGeom)>> = BTreeMap::new();
    let mut violations = Vec::new();
    for (si, s) in out
        .surfaces
        .iter()
        .chain(out.hole_regions.iter())
        .enumerate()
    {
        for be in &s.boundary {
            let (Some(v0), Some(v1), Some(id)) = (&be.start_vertex, &be.end_vertex, &be.id) else {
                continue; // a standalone loop's sides are not split pieces
            };
            // An entity the split graph never emitted a piece of bounds its
            // face as a STANDALONE loop (an uncut closed curve): its side
            // legitimately has no piece. A side whose entity does have pieces
            // must match one, or the face is not a traced cycle.
            if !out.edges.iter().any(|e| &e.entity_id == id) {
                continue;
            }
            match piece_of(out, id, &be.geom) {
                Some(piece) => {
                    uses.entry(piece)
                        .or_default()
                        .push((v0.clone(), v1.clone(), be.geom.clone()))
                }
                None => violations.push(Violation::new(
                    "half-edge",
                    format!(
                        "surface {si} side with entity {id} between {v0} and {v1} matches no \
                         split edge piece"
                    ),
                )),
            }
        }
    }
    for (piece, used) in &uses {
        if used.len() > 2 {
            violations.push(Violation::new(
                "half-edge",
                format!(
                    "split edge piece {piece} is used by {} face sides",
                    used.len()
                ),
            ));
            continue;
        }
        if used.len() == 2 {
            // Two uses must be the two orientations. A self-loop piece carries
            // the same vertex pair on both sides (a spline lobe from a
            // self-crossing), so there only the geometry can tell the
            // orientations apart.
            let same_orientation = if used[0].0 == used[0].1 {
                used[0].2 == used[1].2
            } else {
                used[0].0 == used[1].0 && used[0].1 == used[1].1
            };
            if same_orientation {
                violations.push(Violation::new(
                    "half-edge",
                    format!(
                        "split edge piece {piece} sits twice in the same orientation \
                         ({} -> {})",
                        used[0].0, used[0].1
                    ),
                ));
            }
        }
    }
    violations
}

pub(crate) fn hole_wiring_violations(out: &TopologyOut) -> Vec<Violation> {
    // Every hole loop is another face's boundary. A face here is either a
    // surface or a hole region: the even/odd rule's dropped faces still own
    // their loops, and a material face that covers a hole region subtracts it.
    type SideKey = (Option<String>, Option<String>, Option<String>);
    let key_of = |loop_edges: &[BoundaryEdge]| -> Vec<SideKey> {
        loop_edges
            .iter()
            .map(|be| {
                (
                    be.id.clone(),
                    be.start_vertex.clone(),
                    be.end_vertex.clone(),
                )
            })
            .collect()
    };
    let boundary_keys: Vec<Vec<SideKey>> = out
        .surfaces
        .iter()
        .chain(out.hole_regions.iter())
        .map(|s| key_of(&s.boundary))
        .collect();
    let mut violations = Vec::new();
    for (si, s) in out.surfaces.iter().enumerate() {
        for (hi, hole) in s.holes.iter().enumerate() {
            if !boundary_keys.contains(&key_of(hole)) {
                violations.push(Violation::new(
                    "structure",
                    format!("surface {si} hole {hi} is not any face's boundary loop"),
                ));
            }
        }
    }
    violations
}

pub(crate) fn euler_violations(out: &TopologyOut) -> Vec<Violation> {
    let verts: BTreeMap<String, Vec2> = out.vertices.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let nearest = |p: Vec2| -> Option<String> {
        verts
            .iter()
            .filter(|(_, v)| (v[0] - p[0]).hypot(v[1] - p[1]) <= MERGE)
            .map(|(k, v)| (k.clone(), (v[0] - p[0]).hypot(v[1] - p[1])))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(k, _)| k)
    };

    let mut used: BTreeSet<String> = BTreeSet::new();
    for s in out.surfaces.iter().chain(out.hole_regions.iter()) {
        for be in &s.boundary {
            if let Some(v) = &be.start_vertex {
                used.insert(v.clone());
            }
            if let Some(v) = &be.end_vertex {
                used.insert(v.clone());
            }
        }
    }
    let mut violations = Vec::new();
    let mut edges: Vec<(String, String)> = Vec::new();
    for (idx, e) in out.edges.iter().enumerate() {
        let ends = match e.geom {
            EdgeGeom::Line { start, end }
            | EdgeGeom::Arc { start, end, .. }
            | EdgeGeom::EllipseArc { start, end, .. }
            | EdgeGeom::Spline { start, end, .. } => Some((start, end)),
            EdgeGeom::Ellipse { .. } => None,
        };
        let Some((s, t)) = ends else {
            continue;
        };
        match (nearest(s), nearest(t)) {
            (Some(a), Some(b)) => {
                used.insert(a.clone());
                used.insert(b.clone());
                edges.push((a, b));
            }
            _ => violations.push(Violation::new(
                "euler",
                format!(
                    "split edge piece {idx} (entity {}) has an endpoint with no vertex",
                    e.entity_id
                ),
            )),
        }
    }

    // A standalone closed spline is its own component with a self-loop piece
    // the half-edge graph never emits (the standalone pass owns it); a
    // self-loop piece from a self-crossing IS emitted and already sits in
    // `edges`, so only a boundary with no matching piece adds one here.
    let self_loops = out
        .surfaces
        .iter()
        .filter(|s| {
            s.boundary.len() == 1
                && matches!(s.boundary[0].geom, EdgeGeom::Spline { .. })
                && s.boundary[0].start_vertex.is_some()
                && s.boundary[0].start_vertex == s.boundary[0].end_vertex
                && s.boundary[0]
                    .id
                    .as_deref()
                    .is_none_or(|id| piece_of(out, id, &s.boundary[0].geom).is_none())
        })
        .count();

    let vertex_count = used.len();
    let edge_count = edges.len() + self_loops;
    // Every traced face, hole regions included, plus the outer face: the
    // Euler identity is over the planar subdivision, not over the fillable
    // subset.
    let face_count = out.surfaces.len() + out.hole_regions.len() + 1;

    // Connected components over the used vertices plus one for every
    // vertex-free standalone loop (a circle or full ellipse: it bounds area
    // without ever minting a vertex).
    let mut parent: BTreeMap<String, String> =
        used.iter().map(|v| (v.clone(), v.clone())).collect();
    fn find(parent: &mut BTreeMap<String, String>, v: &str) -> String {
        let mut root = v.to_string();
        while parent[&root] != root {
            root = parent[&root].clone();
        }
        let mut cur = v.to_string();
        while parent[&cur] != root {
            let next = parent[&cur].clone();
            parent.insert(cur, root.clone());
            cur = next;
        }
        root
    }
    for (a, b) in &edges {
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra != rb {
            parent.insert(ra, rb);
        }
    }
    let mut roots: BTreeSet<String> = BTreeSet::new();
    for v in &used {
        roots.insert(find(&mut parent, v));
    }
    let vertex_free_faces = out
        .surfaces
        .iter()
        .chain(out.hole_regions.iter())
        .filter(|s| {
            s.boundary
                .iter()
                .all(|be| be.start_vertex.is_none() && be.end_vertex.is_none())
        })
        .count();
    let component_count = roots.len() + vertex_free_faces;

    let lhs = vertex_count as i64 - edge_count as i64 + face_count as i64;
    let rhs = 1 + component_count as i64;
    let mut violations = Vec::new();
    if lhs != rhs {
        violations.push(Violation::new(
            "euler",
            format!(
                "V - E + F = {vertex_count} - {edge_count} + {face_count} = {lhs}, \
                 expected 1 + {component_count} = {rhs}"
            ),
        ));
    }
    violations
}
