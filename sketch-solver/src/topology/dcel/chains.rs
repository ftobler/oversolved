//! Closed line/arc loops and the interior probe the material rule reads.
//!
//! The hole rule in `holes` reasons about CLOSED CARRIERS, which are circles,
//! full ellipses and closed splines. A loop drawn out of lines and arcs is not
//! a carrier there: its interior is a traced face, and no single carrier can
//! say whether a region enclosed by pieces of several input loops is material
//! or a void. This module builds the second list the material test needs: the
//! closed loops those lines and arcs actually draw, each sampled as a polygon.
//!
//! A drawn loop is read two ways: as a cycle of whole entities joined at their
//! authored endpoints (a crossing does not cut an entity), and as a cycle of
//! split pieces (two lines that meet at a contact in the middle of one of them
//! still close their loop). The cycle chosen through each edge is the SHORTEST
//! by curve length: a loop the user drew is the shortest way around the pieces
//! it owns, while the outer silhouette of a set of touching loops is a longer
//! cycle that reuses pieces already owned by the shorter loops (the
//! four-rectangle frame). That keeps the silhouette out of the list without
//! special-casing entity counts or geometry.
//!
//! The probe is deliberately an interior point, not a boundary sample: the
//! frame's void boundary lies on the four rectangles, and an L-shaped pair of
//! touching rectangles (which must stay material) has every boundary point on
//! some loop too. Only a point strictly inside the face can tell them apart.

use std::collections::{HashMap, HashSet};

use super::super::profile_loops::{loop_pts, point_in_polygon, BoundaryEdge, EdgeGeom, Vec2};
use super::super::TOL_FACE_EXISTENCE_MIN_AREA;
use super::build::{rev, HalfEdge};
use super::TopoEntity;
use super::Verts;

/// Polygon resolution for a chain, matching the spline carrier's.
const CHAIN_SAMPLES: usize = 256;

/// Boundary resolution for the probe's own face polygon.
const FACE_CHAIN_SAMPLES: usize = 64;

/// One closed line/arc loop: its sampled polygon, its bbox and the graph
/// pieces it walks (so the face it bounds can skip it as its own boundary).
pub(super) struct ClosedChain {
    poly: Vec<Vec2>,
    bbox: [f64; 4],
    pieces: Vec<usize>,
}

impl ClosedChain {
    /// Strictly inside the polygon. The probe is a face interior point, so a
    /// boundary reading never decides; a bbox pre-check keeps the grid cheap.
    pub(super) fn holds(&self, p: Vec2) -> bool {
        if p[0] < self.bbox[0] || p[0] > self.bbox[2] || p[1] < self.bbox[1] || p[1] > self.bbox[3]
        {
            return false;
        }
        point_in_polygon(p, &self.poly)
    }

    pub(super) fn pieces(&self) -> &[usize] {
        &self.pieces
    }

    /// True when the whole chain lies inside `face`: then it is a nested loop
    /// (a hole or an island inside the face), not a loop the face belongs to.
    /// The gap around a clear circle drawn in the tangent-circle triangle is
    /// exactly this: its centroid falls in the nested circle, so treating that
    /// circle as the enclosing chain would fill the gap again.
    pub(super) fn nested_in(&self, face: &[Vec2]) -> bool {
        if face.is_empty() {
            return false;
        }
        let b = bbox_of(face);
        self.bbox[0] >= b[0]
            && self.bbox[1] >= b[1]
            && self.bbox[2] <= b[2]
            && self.bbox[3] <= b[3]
            && self.poly.iter().all(|&p| point_in_polygon(p, face))
    }
}

/// What the material rule needs to know about one traced face.
#[derive(Clone, Default)]
pub(super) struct FaceMeta {
    /// Even half-edge indices around the face, sorted. Empty for a standalone
    /// loop (which is always material) and for a synthetic face in a test.
    pub(super) pieces: Vec<usize>,
    /// True when one of the face's twins belongs to an exterior (negative
    /// area) cycle: the face borders the open plane, so it is part of the
    /// drawing's silhouette and never a void.
    pub(super) exterior: bool,
    /// False only for a standalone closed carrier, whose own shell already
    /// decides its fill.
    pub(super) traced: bool,
}

/// Build the closed line/arc loops of one split graph. A piece whose both
/// endpoints are the same vertex (a spline lobe) is skipped: it is not a loop
/// of input geometry. A two-piece duplicate pair has zero area and is skipped
/// by the same floor the tracer uses.
pub(super) fn split_chains(
    hes: &[HalfEdge],
    he_eid: &[String],
    line_arc_ids: &HashSet<&str>,
) -> Vec<ClosedChain> {
    let mut node_of: HashMap<&str, usize> = HashMap::new();
    let mut adj: Vec<Vec<(usize, usize, usize)>> = Vec::new();
    for i in (0..hes.len()).step_by(2) {
        if !line_arc_ids.contains(he_eid[i].as_str()) {
            continue;
        }
        let (v0, v1, _) = &hes[i];
        if v0 == v1 {
            continue;
        }
        let u = *node_of.entry(v0.as_str()).or_insert_with(|| {
            adj.push(Vec::new());
            adj.len() - 1
        });
        let v = *node_of.entry(v1.as_str()).or_insert_with(|| {
            adj.push(Vec::new());
            adj.len() - 1
        });
        adj[u].push((i, v, i));
        adj[v].push((i, u, i ^ 1));
    }

    let mut piece_len: Vec<f64> = vec![0.0; hes.len()];
    for i in (0..hes.len()).step_by(2) {
        piece_len[i] = geom_len(&hes[i].2);
    }
    let mut chains: Vec<ClosedChain> = Vec::new();
    let mut seen_cycles: HashSet<Vec<usize>> = HashSet::new();
    for i in (0..hes.len()).step_by(2) {
        if !line_arc_ids.contains(he_eid[i].as_str()) {
            continue;
        }
        let (v0, v1, _) = &hes[i];
        if v0 == v1 {
            continue;
        }
        let (Some(&u), Some(&v)) = (node_of.get(v0.as_str()), node_of.get(v1.as_str())) else {
            continue;
        };
        let Some(path) = shortest_path(&adj, &piece_len, u, v, i) else {
            continue;
        };
        let mut cycle: Vec<usize> = path;
        // Return along the piece's twin, which already walks v -> u.
        cycle.push(i ^ 1);
        let mut key: Vec<usize> = cycle.iter().map(|&h| h & !1).collect();
        key.sort_unstable();
        key.dedup();
        if key.len() < 2 || !seen_cycles.insert(key.clone()) {
            continue;
        }
        let edges: Vec<BoundaryEdge> = cycle
            .iter()
            .map(|&h| BoundaryEdge {
                geom: hes[h].2.clone(),
                id: Some(he_eid[h].clone()),
                start_vertex: Some(hes[h].0.clone()),
                end_vertex: Some(hes[h].1.clone()),
            })
            .collect();
        let poly = loop_pts(&edges, CHAIN_SAMPLES);
        if poly.len() < 3 || polygon_area(&poly).abs() < TOL_FACE_EXISTENCE_MIN_AREA {
            continue;
        }
        chains.push(ClosedChain {
            bbox: bbox_of(&poly),
            poly,
            pieces: key,
        });
    }
    chains
}

struct AuthoredEdge {
    u: String,
    v: String,
    geom: EdgeGeom,
    /// Curve length, the tie-break between equal-hop cycles. The outer
    /// silhouette of touching loops is the same hop count as a real loop but
    /// longer, and length picks the loop the user actually drew.
    len: f64,
}

fn geom_len(geom: &EdgeGeom) -> f64 {
    match *geom {
        EdgeGeom::Line { start, end } => (end[0] - start[0]).hypot(end[1] - start[1]),
        EdgeGeom::Arc {
            radius,
            angle_start_deg,
            angle_end_deg,
            ..
        } => {
            let a0 = crate::radians(angle_start_deg);
            let a1 = crate::radians(angle_end_deg);
            let sweep = if (a1 - a0).abs() >= std::f64::consts::TAU - 1e-9 {
                std::f64::consts::TAU
            } else {
                (a1 - a0).rem_euclid(std::f64::consts::TAU)
            };
            // The length of a curve is a magnitude. A solved arc can reach the
            // topology with a negative radius (the degenerate collapse the
            // stale-length bug produced), and a negative edge weight makes the
            // shortest-path walk below non-terminating: its parent chain can
            // cycle and the worker never returns. `abs` keeps the weight a
            // length; a non-finite radius or angle contributes no length at all.
            let len = radius.abs() * sweep;
            if len.is_finite() {
                len
            } else {
                0.0
            }
        }
        // Only lines and arcs reach here.
        _ => 0.0,
    }
}

/// The loops the sketcher drew: cycles of whole input entities joined at their
/// authored endpoints. A crossing subdivides such a loop in the arrangement but
/// does not cut the entity, so this graph still closes the rectangle the user
/// drew and a face inside it (the centre of a plus of two crossing rectangles)
/// reads as material rather than as a void between arrangement pieces.
pub(super) fn authored_chains(
    lines: &[(String, TopoEntity)],
    arcs: &[(String, TopoEntity)],
    verts: &Verts,
) -> Vec<ClosedChain> {
    let mut edges: Vec<AuthoredEdge> = Vec::new();
    let mut push = |start: Vec2, end: Vec2, geom: EdgeGeom| {
        let (Some(u), Some(v)) = (verts.find(start), verts.find(end)) else {
            return;
        };
        edges.push(AuthoredEdge {
            u: u.to_string(),
            v: v.to_string(),
            len: geom_len(&geom),
            geom,
        });
    };
    for (_, e) in lines {
        if let TopoEntity::Line { start, end, .. } = *e {
            push(start, end, EdgeGeom::Line { start, end });
        }
    }
    for (_, e) in arcs {
        if let TopoEntity::Arc {
            center,
            radius,
            angle_start,
            angle_end,
            start,
            end,
            ..
        } = *e
        {
            push(
                start,
                end,
                EdgeGeom::Arc {
                    center: [center[0], center[1]],
                    radius,
                    angle_start_deg: angle_start,
                    angle_end_deg: angle_end,
                    ccw: true,
                    start,
                    end,
                },
            );
        }
    }

    let mut node_of: HashMap<&str, usize> = HashMap::new();
    for edge in &edges {
        for node in [&edge.u, &edge.v] {
            let next = node_of.len();
            node_of.entry(node.as_str()).or_insert(next);
        }
    }

    let mut chains: Vec<ClosedChain> = Vec::new();
    let mut seen_cycles: HashSet<Vec<usize>> = HashSet::new();
    // A drawn loop walked in its authored direction is a directed cycle. The
    // outer silhouette of a set of touching loops can be a cycle of the
    // undirected graph, but it mixes edge directions at the shared corners and
    // is not one. Search both directions so a consistently CW loop is found
    // too.
    for reversed in [false, true] {
        directed_chains(&edges, &node_of, reversed, &mut chains, &mut seen_cycles);
    }
    chains
}

fn directed_chains(
    edges: &[AuthoredEdge],
    node_of: &HashMap<&str, usize>,
    reversed: bool,
    chains: &mut Vec<ClosedChain>,
    seen_cycles: &mut HashSet<Vec<usize>>,
) {
    let n = node_of.values().copied().max().map_or(0, |m| m + 1);
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n];
    for (i, edge) in edges.iter().enumerate() {
        if edge.u == edge.v {
            continue;
        }
        let (Some(&u), Some(&v)) = (node_of.get(edge.u.as_str()), node_of.get(edge.v.as_str()))
        else {
            continue;
        };
        if reversed {
            adj[v].push((i, u));
        } else {
            adj[u].push((i, v));
        }
    }
    for u in 0..edges.len() {
        let edge = &edges[u];
        if edge.u == edge.v {
            continue;
        }
        // In the chosen orientation the edge leaves `from` and enters `to`;
        // the closing path must bring `to` back to `from`.
        let (Some(&from), Some(&to)) = (
            node_of.get(if reversed {
                edge.v.as_str()
            } else {
                edge.u.as_str()
            }),
            node_of.get(if reversed {
                edge.u.as_str()
            } else {
                edge.v.as_str()
            }),
        ) else {
            continue;
        };
        let Some(path) = shortest_directed_path(&adj, edges, to, from, u) else {
            continue;
        };
        let mut key: Vec<usize> = path.clone();
        key.push(u);
        key.sort_unstable();
        key.dedup();
        if key.len() < 2 || !seen_cycles.insert(key.clone()) {
            continue;
        }
        let mut boundary: Vec<BoundaryEdge> = Vec::with_capacity(path.len() + 1);
        for &e in std::iter::once(&u).chain(path.iter()) {
            let geom = if reversed {
                rev(&edges[e].geom)
            } else {
                edges[e].geom.clone()
            };
            boundary.push(BoundaryEdge {
                geom,
                id: None,
                start_vertex: None,
                end_vertex: None,
            });
        }
        let poly = loop_pts(&boundary, CHAIN_SAMPLES);
        if poly.len() < 3 || polygon_area(&poly).abs() < TOL_FACE_EXISTENCE_MIN_AREA {
            continue;
        }
        chains.push(ClosedChain {
            bbox: bbox_of(&poly),
            poly,
            pieces: Vec::new(),
        });
    }
}

/// Shortest (by curve length) directed path from `u` to `v` avoiding edge
/// `skip`. Length, not hop count, is what separates a drawn loop from the
/// same-hop silhouette around a set of touching loops.
fn shortest_directed_path(
    adj: &[Vec<(usize, usize)>],
    edges: &[AuthoredEdge],
    u: usize,
    v: usize,
    skip: usize,
) -> Option<Vec<usize>> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let mut dist = vec![f64::INFINITY; adj.len()];
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; adj.len()];
    let mut settled = vec![false; adj.len()];
    let mut queue: BinaryHeap<Reverse<(u64, usize)>> = BinaryHeap::new();
    dist[u] = 0.0;
    queue.push(Reverse((0u64, u)));
    while let Some(Reverse((d_bits, cur))) = queue.pop() {
        let d = f64::from_bits(d_bits);
        // Settle each node once. A malformed vertex (a negative arc length used
        // to reach here) makes the weighting non-metric, and re-relaxing a
        // settled node can hand it a parent that leads back into itself: the
        // parent walk then never reaches `u`. Settling also keeps a valid graph
        // exact, because every weight is a length.
        if settled[cur] || d > dist[cur] {
            continue;
        }
        settled[cur] = true;
        if cur == v {
            let mut path: Vec<usize> = Vec::new();
            let mut cur = v;
            while cur != u {
                // Defence in depth: the settle rule is the fix, this bound keeps
                // any future weighting bug from wedging the worker.
                if path.len() > adj.len() {
                    return None;
                }
                let (prev, edge) = parent[cur]?;
                path.push(edge);
                cur = prev;
            }
            path.reverse();
            return Some(path);
        }
        for &(edge, next) in &adj[cur] {
            if edge == skip || settled[next] {
                continue;
            }
            let nd = d + edges[edge].len;
            if nd < dist[next] {
                dist[next] = nd;
                parent[next] = Some((cur, edge));
                queue.push(Reverse((nd.to_bits(), next)));
            }
        }
    }
    None
}

/// The shortest (by curve length) path from `u` to `v` that does not use piece
/// `skip`, as the oriented half-edge indices it walks. `None` when no other
/// route exists, so the piece is a bridge and bounds no separate loop. Length,
/// not hop count, keeps the smallest face around a piece rather than the
/// silhouette of a set of touching loops, and removes ties that would depend
/// on entity order.
fn shortest_path(
    adj: &[Vec<(usize, usize, usize)>],
    weights: &[f64],
    u: usize,
    v: usize,
    skip: usize,
) -> Option<Vec<usize>> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    if u == v {
        return None;
    }
    let mut dist = vec![f64::INFINITY; adj.len()];
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; adj.len()];
    let mut settled = vec![false; adj.len()];
    let mut queue: BinaryHeap<Reverse<(u64, usize)>> = BinaryHeap::new();
    dist[u] = 0.0;
    queue.push(Reverse((0u64, u)));
    while let Some(Reverse((d_bits, cur))) = queue.pop() {
        let d = f64::from_bits(d_bits);
        // Same settle rule as `shortest_path`: a re-relaxed node's parent chain
        // can cycle when the weighting is not a metric, and the walk below has
        // no other termination proof.
        if settled[cur] || d > dist[cur] {
            continue;
        }
        settled[cur] = true;
        if cur == v {
            let mut path: Vec<usize> = Vec::new();
            let mut cur = v;
            while cur != u {
                if path.len() > adj.len() {
                    return None;
                }
                let (prev, he) = parent[cur]?;
                path.push(he);
                cur = prev;
            }
            path.reverse();
            return Some(path);
        }
        for &(piece, next, he) in &adj[cur] {
            if piece == skip || settled[next] {
                continue;
            }
            let nd = d + weights[piece];
            if nd < dist[next] {
                dist[next] = nd;
                parent[next] = Some((cur, he));
                queue.push(Reverse((nd.to_bits(), next)));
            }
        }
    }
    None
}

/// A point strictly inside the traced face: the centroid when it verifies,
/// otherwise a boundary midpoint nudged to either side by shrinking steps. A
/// centroid alone is not safe for a concave face (its notch is outside it).
/// `None` when nothing verifies, and the caller then keeps the face rather
/// than guessing it is a void.
pub(super) fn face_interior_probe(boundary: &[BoundaryEdge]) -> Option<Vec2> {
    let pts = loop_pts(boundary, FACE_CHAIN_SAMPLES);
    let n = pts.len();
    if n < 3 {
        return None;
    }
    let centroid = polygon_centroid(&pts);
    if point_in_polygon(centroid, &pts) {
        return Some(centroid);
    }
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let len = dx.hypot(dy);
        if len.is_nan() || len <= 0.0 {
            continue;
        }
        let m = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
        let (nx, ny) = (-dy / len, dx / len);
        for scale in [0.25, 0.1, 0.02, 0.005, 0.001, 0.0002] {
            let step = len * scale;
            for side in [1.0, -1.0] {
                let candidate = [m[0] + side * step * nx, m[1] + side * step * ny];
                if point_in_polygon(candidate, &pts) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn bbox_of(poly: &[Vec2]) -> [f64; 4] {
    let mut b = [poly[0][0], poly[0][1], poly[0][0], poly[0][1]];
    for p in poly {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b
}

fn polygon_area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    let mut acc = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    acc / 2.0
}

fn polygon_centroid(pts: &[Vec2]) -> Vec2 {
    let n = pts.len();
    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        let cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
        area += cross;
        cx += (pts[i][0] + pts[j][0]) * cross;
        cy += (pts[i][1] + pts[j][1]) * cross;
    }
    area /= 2.0;
    if area.abs() < TOL_FACE_EXISTENCE_MIN_AREA {
        return pts[0];
    }
    cx /= 6.0 * area;
    cy /= 6.0 * area;
    [cx, cy]
}
