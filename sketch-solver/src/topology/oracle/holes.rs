//! The oracle's own even/odd hole derivation: the fill rule the builder
//! applies to its traced faces, re-derived from the raw input curves alone.
//!
//! A closed carrier (a circle, a full ellipse, a spline whose ends coincide
//! within the merge) is a shell; a shell strictly inside another alternates
//! the fill of its interior (outer shell's interior material, a nested
//! shell's interior a hole, material again inside that). Two shells that meet
//! are fused and never nest, and a shell another shell crosses takes no
//! nesting level at all (its pieces are separate regions, not one bore). The
//! coverage check reads `region_level` per grid cell to decide whether the
//! cell is expected to sit in a face.
//!
//! Containment is decided on the shells' own sample points against a strict
//! region test, so a shell that crosses or merely touches another is never
//! contained in it and the two never nest. The level reads a cell through the
//! same two-part rule the builder reads a face through: strictly inside a
//! shell, or within `tolerance::on_carrier_tol` of it (the builder's face side
//! is a RECOMPUTED point, so its closure question carries that allowance and a
//! cell-level rule without it would disagree by construction).
//!
//! Two limits of this derivation are deliberate and stated rather than hidden:
//!   - `subdivided` is read from the builder's own output (`out.edges`): the
//!     derivation judges the fill RULE, not whether the builder found every
//!     cut, so that axis of agreement is not independent.
//!   - the derivation is a sampling of the same rule, not a second
//!     implementation of the arrangement: on inputs whose traced faces are
//!     degenerate (a face loop that crosses itself) the two can read a cell
//!     differently, and those inputs are the catalogued failures, not this
//!     check's to excuse.

use super::geometry::{point_in_polygon, sample_curve};
use super::Curve;
use crate::radians;
use crate::tolerance::on_carrier_tol;
use crate::topology::profile_loops::{point_polygon_dist, Vec2};
use crate::topology::TOL_FACE_EXISTENCE_MIN_AREA;
use crate::topology::TOL_TOPOLOGY_MERGE as MERGE;
use crate::MIN_SEMI_AXIS_SQ;

/// Uniform samples per turn for a shell's polygon. The containment question
/// is whole-region (a shell is inside another or not), so this only has to be
/// fine enough that a nested shell's samples land on the right side; the
/// exact circle and ellipse tests carry the points themselves.
const SHELL_SAMPLES: usize = 256;

/// One shell's region test.
enum Carrier {
    Circle {
        c: Vec2,
        r: f64,
    },
    Ellipse {
        c: Vec2,
        a: f64,
        b: f64,
        theta: f64,
    },
    /// A closed spline, sampled to the coverage chord tolerance.
    Polygon(Vec<Vec2>),
}

impl Carrier {
    /// Strictly inside, no margin: at the boundary the shells meet, and a
    /// fused pair never nests (see `chain_inside`).
    fn holds(&self, p: Vec2) -> bool {
        match *self {
            Carrier::Circle { c, r } => (p[0] - c[0]).hypot(p[1] - c[1]) < r,
            Carrier::Ellipse { c, a, b, theta } => conic_residual(c, a, b, theta, p) < 0.0,
            Carrier::Polygon(ref pts) => point_in_polygon(p, pts),
        }
    }

    /// Inside or on, the allowance included: the level rule the builder's
    /// `holds_or_on` states for a face, read for a point. A cell centre is
    /// never ON a shell, but a face side the builder rebuilt from a split
    /// parameter can sit within the allowance of one, and the two rules must
    /// agree on the region that face covers.
    fn holds_or_on(&self, p: Vec2) -> bool {
        match *self {
            Carrier::Circle { c, r } => {
                let magnitude = p[0]
                    .abs()
                    .max(p[1].abs())
                    .max(c[0].abs())
                    .max(c[1].abs())
                    .max(r);
                (p[0] - c[0]).hypot(p[1] - c[1]) <= r + on_carrier_tol(magnitude)
            }
            Carrier::Ellipse { c, a, b, theta } => {
                let magnitude = p[0]
                    .abs()
                    .max(p[1].abs())
                    .max(c[0].abs())
                    .max(c[1].abs())
                    .max(a.abs())
                    .max(b.abs());
                conic_gap(c, a, b, theta, p) <= on_carrier_tol(magnitude)
            }
            Carrier::Polygon(ref pts) => point_in_polygon(p, pts),
        }
    }

    /// World distance from `p` to the carrier's boundary. Zero on the curve,
    /// used to read a sample near the boundary as a fused contact rather than
    /// as a crossing side.
    fn boundary_gap(&self, p: Vec2) -> f64 {
        match *self {
            Carrier::Circle { c, r } => ((p[0] - c[0]).hypot(p[1] - c[1]) - r).abs(),
            Carrier::Ellipse { c, a, b, theta } => conic_gap(c, a, b, theta, p).abs(),
            Carrier::Polygon(ref pts) => point_polygon_dist(p, pts),
        }
    }
}

/// The conic residual `F(p)` of an ellipse: negative inside, zero on it.
fn conic_residual(c: Vec2, a: f64, b: f64, theta: f64, p: Vec2) -> f64 {
    let cr = radians(theta).cos();
    let sr = radians(theta).sin();
    let dx = p[0] - c[0];
    let dy = p[1] - c[1];
    let xl = dx * cr + dy * sr;
    let yl = -dx * sr + dy * cr;
    xl * xl / (a * a).max(MIN_SEMI_AXIS_SQ) + yl * yl / (b * b).max(MIN_SEMI_AXIS_SQ) - 1.0
}

/// First-order (world) signed gap of a point from an ellipse: negative inside,
/// positive outside, in the residual-over-gradient form the builder uses.
fn conic_gap(c: Vec2, a: f64, b: f64, theta: f64, p: Vec2) -> f64 {
    let f = conic_residual(c, a, b, theta, p);
    let cr = radians(theta).cos();
    let sr = radians(theta).sin();
    let dx = p[0] - c[0];
    let dy = p[1] - c[1];
    let xl = dx * cr + dy * sr;
    let yl = -dx * sr + dy * cr;
    let gx = 2.0 * xl / (a * a).max(MIN_SEMI_AXIS_SQ);
    let gy = 2.0 * yl / (b * b).max(MIN_SEMI_AXIS_SQ);
    let m = gx.hypot(gy);
    if m > 0.0 {
        f / m
    } else {
        f
    }
}

/// One shell: its region test, its polygon (for the fused test and for its
/// own sample points), its bbox, its nesting depth, and whether the
/// arrangement actually subdivided it.
pub(crate) struct Chain {
    carrier: Carrier,
    poly: Vec<Vec2>,
    bbox: [f64; 4],
    depth: usize,
    /// True when some edge of the builder's split graph walks this shell: the
    /// shell was cut by other geometry, so its interior is a traced face and
    /// the even/odd alternation decides it. An UNcut shell keeps the sketch
    /// model's standalone loop: its interior is its own face (the unsliced
    /// washer's bore is still an area).
    subdivided: bool,
    /// True when another closed carrier crosses this shell. Such a shell has
    /// no single interior to alternate: the crossing splits it into pieces,
    /// so it takes no nesting level and its pieces stay material.
    crossed: bool,
}

fn closed_carrier(c: &Curve, chord_tol: f64) -> Option<Carrier> {
    match *c {
        Curve::Circle { c, r } if r > MERGE => Some(Carrier::Circle { c, r }),
        Curve::Ellipse { c, a, b, theta } if a.abs() >= MERGE && b.abs() >= MERGE => {
            Some(Carrier::Ellipse { c, a, b, theta })
        }
        Curve::Spline { p0, p3, .. } if (p0[0] - p3[0]).hypot(p0[1] - p3[1]) <= MERGE => {
            // The curvature rule closes the spline wherever the builder's
            // vertex merge does: a gap within MERGE is one point to the
            // pipeline, so the curve is a shell like the exactly closed
            // teardrop (a closed cubic cannot cross itself, and the
            // near-closure is not a crossing to the builder either).
            let s = sample_curve(c, chord_tol);
            let poly = s.pts;
            if poly.len() < 3 {
                return None;
            }
            Some(Carrier::Polygon(poly))
        }
        _ => None,
    }
}

fn shell_polygon(carrier: &Carrier) -> Vec<Vec2> {
    match *carrier {
        Carrier::Circle { c, r } => (0..SHELL_SAMPLES)
            .map(|k| {
                let t = 2.0 * std::f64::consts::PI * k as f64 / SHELL_SAMPLES as f64;
                [c[0] + r * t.cos(), c[1] + r * t.sin()]
            })
            .collect(),
        Carrier::Ellipse { c, a, b, theta } => {
            let cr = radians(theta).cos();
            let sr = radians(theta).sin();
            (0..SHELL_SAMPLES)
                .map(|k| {
                    let t = 2.0 * std::f64::consts::PI * k as f64 / SHELL_SAMPLES as f64;
                    let ax = a * t.cos();
                    let ay = b * t.sin();
                    [c[0] + ax * cr - ay * sr, c[1] + ax * sr + ay * cr]
                })
                .collect()
        }
        Carrier::Polygon(ref pts) => pts.clone(),
    }
}

fn bbox_of_poly(poly: &[Vec2]) -> [f64; 4] {
    let mut b = [poly[0][0], poly[0][1], poly[0][0], poly[0][1]];
    for p in poly {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b
}

/// The shells of one input, with their nesting depths. `subdivided` marks the
/// shells some edge of the built graph walks.
pub(crate) fn chains_of(
    curves: &[(String, Curve)],
    chord_tol: f64,
    edges: &[crate::topology::dcel::EdgeOut],
) -> Vec<Chain> {
    let mut chains: Vec<Chain> = Vec::new();
    for (id, c) in curves {
        let Some(carrier) = closed_carrier(c, chord_tol) else {
            continue;
        };
        let poly = shell_polygon(&carrier);
        let bbox = bbox_of_poly(&poly);
        let subdivided = edges.iter().any(|e| &e.entity_id == id);
        chains.push(Chain {
            carrier,
            poly,
            bbox,
            depth: 0,
            subdivided,
            crossed: false,
        });
    }
    // A shell another closed carrier crosses has no single interior to
    // alternate, so it takes no nesting level (the builder marks the same
    // shell on its own carriers).
    let crossed: Vec<bool> = (0..chains.len())
        .map(|i| (0..chains.len()).any(|j| i != j && chains_cross(&chains[i], &chains[j])))
        .collect();
    for (c, crossed) in chains.iter_mut().zip(crossed) {
        c.crossed = crossed;
    }
    for _ in 0..chains.len() {
        let mut changed = false;
        for i in 0..chains.len() {
            let mut deepest = 0;
            for j in 0..chains.len() {
                if i != j && !chains[i].crossed && chain_inside(&chains[i], &chains[j]) {
                    deepest = deepest.max(chains[j].depth + 1);
                }
            }
            if deepest > chains[i].depth {
                chains[i].depth = deepest;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    chains
}

/// True when two shells cross: samples of one fall strictly inside the other
/// and samples fall strictly outside it. A sample within MERGE of the other's
/// boundary is a fused contact, not a crossing side (the same identity rule
/// the builder's vertex merge applies), so a contained, disjoint, tangent or
/// duplicated pair does not read as crossed.
fn chains_cross(a: &Chain, b: &Chain) -> bool {
    fn straddles(samples: &[Vec2], other: &Carrier) -> bool {
        let mut inside = false;
        let mut outside = false;
        for &p in samples {
            if other.boundary_gap(p) <= MERGE {
                continue;
            }
            if other.holds(p) {
                inside = true;
            } else {
                outside = true;
            }
            if inside && outside {
                return true;
            }
        }
        false
    }
    straddles(&a.poly, &b.carrier) || straddles(&b.poly, &a.carrier)
}

/// True when shell `inner` lies strictly inside shell `outer`: every sample
/// point of the inner shell held by the outer one. `holds` is strict, so a
/// shell that touches its container (an internal tangency) or crosses it keeps
/// some point unheld and never nests: only whole-region enclosure alternates
/// the fill.
fn chain_inside(inner: &Chain, outer: &Chain) -> bool {
    if inner.bbox[0] > outer.bbox[2]
        || inner.bbox[2] < outer.bbox[0]
        || inner.bbox[1] > outer.bbox[3]
        || inner.bbox[3] < outer.bbox[1]
    {
        return false;
    }
    inner.poly.iter().all(|&p| outer.carrier.holds(p))
}

/// The fill level of the region around `p`: one plus the depth of the deepest
/// shell containing the point, or zero when no shell contains it.
pub(crate) fn region_level(p: Vec2, chains: &[Chain]) -> usize {
    let mut level = 0;
    for c in chains {
        if c.depth < level {
            continue;
        }
        if p[0] < c.bbox[0] || p[0] > c.bbox[2] || p[1] < c.bbox[1] || p[1] > c.bbox[3] {
            continue;
        }
        if c.carrier.holds(p) {
            level = c.depth + 1;
        }
    }
    level
}

/// Whether the cell at `p` must stay out of every face. True when the deepest
/// shell containing the point is an even level at or above two AND that shell
/// was subdivided by the arrangement: an uncut shell keeps the sketch model's
/// standalone loop, where its interior is its own selectable area.
pub(crate) fn hole_expected(p: Vec2, chains: &[Chain]) -> bool {
    let holds = |c: &Chain| {
        p[0] >= c.bbox[0]
            && p[0] <= c.bbox[2]
            && p[1] >= c.bbox[1]
            && p[1] <= c.bbox[3]
            && c.carrier.holds_or_on(p)
    };
    let mut level = 0;
    for c in chains {
        if c.depth + 1 > level && holds(c) {
            level = c.depth + 1;
        }
    }
    if !is_hole_level(level) {
        return false;
    }
    // ORed over the shells at the region's own level, exactly as the builder's
    // `face_state` decides it: overlapping shells are equally innermost.
    chains
        .iter()
        .any(|c| c.depth + 1 == level && c.subdivided && holds(c))
}

/// True when an even level means a non-fillable hole.
pub(crate) fn is_hole_level(level: usize) -> bool {
    level >= 2 && level % 2 == 0
}

/// One drawn line/arc loop, sampled as a polygon: the material rule's second
/// list. Built from the raw curves, independent of the builder's split graph.
pub(crate) struct ClosedChain {
    poly: Vec<Vec2>,
    bbox: [f64; 4],
}

impl ClosedChain {
    fn holds(&self, p: Vec2) -> bool {
        p[0] >= self.bbox[0]
            && p[0] <= self.bbox[2]
            && p[1] >= self.bbox[1]
            && p[1] <= self.bbox[3]
            && point_in_polygon(p, &self.poly)
    }
}

/// The same material question the builder asks, read for a cell: is the point
/// inside any closed carrier or any drawn line/arc loop? A cell in none of
/// them is expected to be void, so a missing face there is not a lost area.
pub(crate) fn holds_any(p: Vec2, chains: &[Chain], closed: &[ClosedChain]) -> bool {
    chains.iter().any(|c| c.carrier.holds(p)) || holds_closed(p, closed)
}

pub(crate) fn holds_closed(p: Vec2, closed: &[ClosedChain]) -> bool {
    closed.iter().any(|c| c.holds(p))
}

/// The split halves of the builder's graph, read back from `out.edges`: a loop
/// closed at a mid-entity contact (a T junction, a slot corner) is a drawn loop
/// too, and the authored graph cannot see it. This mirrors the builder's
/// `split_chains`, so a lost area behind such a loop still reports.
pub(crate) fn split_chains(
    edges: &[crate::topology::dcel::EdgeOut],
    chord_tol: f64,
) -> Vec<ClosedChain> {
    struct Edge {
        u: usize,
        v: usize,
        geom: crate::topology::profile_loops::EdgeGeom,
    }
    let mut pts: Vec<Vec2> = Vec::new();
    let node = |p: Vec2, pts: &mut Vec<Vec2>| -> usize {
        for (i, q) in pts.iter().enumerate() {
            if (p[0] - q[0]).hypot(p[1] - q[1]) <= MERGE {
                return i;
            }
        }
        pts.push(p);
        pts.len() - 1
    };
    let mut pieces: Vec<Edge> = Vec::new();
    for e in edges {
        let (Some(s), Some(t)) = (e.geom.start(), super::structure::edge_end(&e.geom)) else {
            continue;
        };
        if !matches!(
            e.geom,
            crate::topology::profile_loops::EdgeGeom::Line { .. }
                | crate::topology::profile_loops::EdgeGeom::Arc { .. }
        ) {
            continue;
        }
        let u = node(s, &mut pts);
        let v = node(t, &mut pts);
        if u != v {
            pieces.push(Edge {
                u,
                v,
                geom: e.geom.clone(),
            });
        }
    }

    let mut adj: Vec<Vec<(usize, usize, bool)>> = vec![Vec::new(); pts.len()];
    for (i, e) in pieces.iter().enumerate() {
        adj[e.u].push((i, e.v, true));
        adj[e.v].push((i, e.u, false));
    }
    let mut chains: Vec<ClosedChain> = Vec::new();
    let mut seen: std::collections::HashSet<Vec<usize>> = std::collections::HashSet::new();
    for i in 0..pieces.len() {
        let Some(path) = undirected_path(&adj, pieces[i].u, pieces[i].v, i) else {
            continue;
        };
        let mut key: Vec<usize> = path.iter().map(|&(e, _)| e).collect();
        key.push(i);
        key.sort_unstable();
        key.dedup();
        if key.len() < 2 || !seen.insert(key) {
            continue;
        }
        let mut poly: Vec<Vec2> = Vec::new();
        let mut walk: Vec<(usize, bool)> = path;
        walk.push((i, false));
        for (e, forward) in walk {
            let sampled = super::geometry::edge_polyline(&pieces[e].geom, chord_tol);
            let mut piece = sampled.pts;
            if !forward {
                piece.reverse();
            }
            if let (Some(last), Some(first)) = (poly.last(), piece.first()) {
                if (last[0] - first[0]).hypot(last[1] - first[1]) <= MERGE {
                    piece.remove(0);
                }
            }
            poly.extend(piece);
        }
        if poly.len() < 3 || signed_area(&poly).abs() < TOL_FACE_EXISTENCE_MIN_AREA {
            continue;
        }
        let mut bbox = [poly[0][0], poly[0][1], poly[0][0], poly[0][1]];
        for p in &poly {
            bbox[0] = bbox[0].min(p[0]);
            bbox[1] = bbox[1].min(p[1]);
            bbox[2] = bbox[2].max(p[0]);
            bbox[3] = bbox[3].max(p[1]);
        }
        chains.push(ClosedChain { poly, bbox });
    }
    chains
}

fn undirected_path(
    adj: &[Vec<(usize, usize, bool)>],
    u: usize,
    v: usize,
    skip: usize,
) -> Option<Vec<(usize, bool)>> {
    if u == v {
        return None;
    }
    let mut parent: Vec<Option<(usize, usize, bool)>> = vec![None; adj.len()];
    let mut seen = vec![false; adj.len()];
    let mut queue = std::collections::VecDeque::new();
    seen[u] = true;
    queue.push_back(u);
    let mut found = false;
    while let Some(cur) = queue.pop_front() {
        if cur == v {
            found = true;
            break;
        }
        for &(edge, next, forward) in &adj[cur] {
            if edge == skip || seen[next] {
                continue;
            }
            seen[next] = true;
            parent[next] = Some((cur, edge, forward));
            queue.push_back(next);
        }
    }
    if !found {
        return None;
    }
    let mut path = Vec::new();
    let mut cur = v;
    while cur != u {
        let (prev, edge, forward) = parent[cur]?;
        path.push((edge, forward));
        cur = prev;
    }
    path.reverse();
    Some(path)
}

/// The closed line/arc loops of the raw curves. Whole entities are joined at
/// their authored endpoints and a loop is a consistently directed cycle, the
/// same rule the builder's authored chains use: a loop the user drew is walked
/// one way around, while the outer silhouette of touching loops mixes edge
/// directions at the shared corners. Both directions are searched so a
/// consistently clockwise loop is found too.
pub(crate) fn authored_chains(curves: &[(String, Curve)], chord_tol: f64) -> Vec<ClosedChain> {
    struct Edge {
        u: usize,
        v: usize,
        curve: usize,
    }
    let mut pts: Vec<Vec2> = Vec::new();
    let node = |p: Vec2, pts: &mut Vec<Vec2>| -> usize {
        for (i, q) in pts.iter().enumerate() {
            if (p[0] - q[0]).hypot(p[1] - q[1]) <= MERGE {
                return i;
            }
        }
        pts.push(p);
        pts.len() - 1
    };
    let endpoints = |c: &Curve| -> Option<(Vec2, Vec2)> {
        match *c {
            Curve::Line { p0, p1 } => Some((p0, p1)),
            Curve::Arc { c, r, a0, a1 } => {
                let start = radians(a0);
                let sweep =
                    crate::topology::dcel::pymod(radians(a1) - start, std::f64::consts::TAU);
                if !(crate::topology::TOL_TOPOLOGY_EPS
                    ..=std::f64::consts::TAU - crate::topology::TOL_TOPOLOGY_EPS)
                    .contains(&sweep)
                {
                    return None; // a full-turn arc is a closed carrier in its own right
                }
                let end = start + sweep;
                Some((
                    [c[0] + r * start.cos(), c[1] + r * start.sin()],
                    [c[0] + r * end.cos(), c[1] + r * end.sin()],
                ))
            }
            Curve::Circle { .. } | Curve::Ellipse { .. } | Curve::Spline { .. } => None,
        }
    };
    let mut edges: Vec<Edge> = Vec::new();
    for (i, (_, c)) in curves.iter().enumerate() {
        if let Some((u, v)) = endpoints(c) {
            let u = node(u, &mut pts);
            let v = node(v, &mut pts);
            if u != v {
                edges.push(Edge { u, v, curve: i });
            }
        }
    }

    let mut chains: Vec<ClosedChain> = Vec::new();
    let mut seen: std::collections::HashSet<Vec<usize>> = std::collections::HashSet::new();
    for reversed in [false, true] {
        let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); pts.len()];
        for (i, e) in edges.iter().enumerate() {
            if reversed {
                adj[e.v].push((i, e.u));
            } else {
                adj[e.u].push((i, e.v));
            }
        }
        for (i, e) in edges.iter().enumerate() {
            let (from, to) = if reversed { (e.v, e.u) } else { (e.u, e.v) };
            let Some(path) = directed_path(&adj, to, from, i) else {
                continue;
            };
            let mut key: Vec<usize> = path.clone();
            key.push(i);
            key.sort_unstable();
            key.dedup();
            if key.len() < 2 || !seen.insert(key) {
                continue;
            }
            let mut poly: Vec<Vec2> = Vec::new();
            for &ei in std::iter::once(&i).chain(path.iter()) {
                let sampled = sample_curve(&curves[edges[ei].curve].1, chord_tol);
                let mut piece = sampled.pts;
                if reversed {
                    piece.reverse();
                }
                if let (Some(last), Some(first)) = (poly.last(), piece.first()) {
                    if (last[0] - first[0]).hypot(last[1] - first[1]) <= MERGE {
                        piece.remove(0);
                    }
                }
                poly.extend(piece);
            }
            if poly.len() < 3 || signed_area(&poly).abs() < TOL_FACE_EXISTENCE_MIN_AREA {
                continue;
            }
            let mut bbox = [poly[0][0], poly[0][1], poly[0][0], poly[0][1]];
            for p in &poly {
                bbox[0] = bbox[0].min(p[0]);
                bbox[1] = bbox[1].min(p[1]);
                bbox[2] = bbox[2].max(p[0]);
                bbox[3] = bbox[3].max(p[1]);
            }
            chains.push(ClosedChain { poly, bbox });
        }
    }
    chains
}

fn directed_path(
    adj: &[Vec<(usize, usize)>],
    u: usize,
    v: usize,
    skip: usize,
) -> Option<Vec<usize>> {
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; adj.len()];
    let mut seen = vec![false; adj.len()];
    let mut queue = std::collections::VecDeque::new();
    seen[u] = true;
    queue.push_back(u);
    while let Some(cur) = queue.pop_front() {
        if cur == v {
            let mut path = Vec::new();
            let mut cur = v;
            while cur != u {
                let (prev, edge) = parent[cur]?;
                path.push(edge);
                cur = prev;
            }
            path.reverse();
            return Some(path);
        }
        for &(edge, next) in &adj[cur] {
            if edge == skip || seen[next] {
                continue;
            }
            seen[next] = true;
            parent[next] = Some((cur, edge));
            queue.push_back(next);
        }
    }
    None
}

fn signed_area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    let mut acc = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    acc / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::topology::profile_loops::EdgeGeom;

    fn circ(c: Vec2, r: f64) -> Curve {
        Curve::Circle { c, r }
    }

    fn chains(curves: &[Curve]) -> Vec<Chain> {
        let list: Vec<(String, Curve)> = curves
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("e{i}"), c.clone()))
            .collect();
        // Every shell counts as subdivided here: the level rule is what these
        // tests pin, and the unsliced exemption is exercised end to end.
        let edges: Vec<crate::topology::dcel::EdgeOut> = list
            .iter()
            .enumerate()
            .map(|(i, (id, _))| crate::topology::dcel::EdgeOut {
                entity_id: id.clone(),
                edge_index: i,
                edge_type: "edge",
                geom: EdgeGeom::Line {
                    start: [0.0, 0.0],
                    end: [1.0, 0.0],
                },
            })
            .collect();
        chains_of(&list, 1e-6, &edges)
    }

    #[test]
    fn a_square_line_loop_is_a_closed_chain() {
        let curves: Vec<(String, Curve)> = vec![
            (
                "a".into(),
                Curve::Line {
                    p0: [0.0, 0.0],
                    p1: [2.0, 0.0],
                },
            ),
            (
                "b".into(),
                Curve::Line {
                    p0: [2.0, 0.0],
                    p1: [2.0, 2.0],
                },
            ),
            (
                "c".into(),
                Curve::Line {
                    p0: [2.0, 2.0],
                    p1: [0.0, 2.0],
                },
            ),
            (
                "d".into(),
                Curve::Line {
                    p0: [0.0, 2.0],
                    p1: [0.0, 0.0],
                },
            ),
        ];
        let closed = authored_chains(&curves, 1e-6);
        assert!(!closed.is_empty(), "the square is a drawn loop");
        assert!(closed.iter().any(|c| c.holds([1.0, 1.0])));
        assert!(closed.iter().all(|c| !c.holds([3.0, 3.0])));
    }

    #[test]
    fn nested_circles_alternate_the_fill_level() {
        let cs = chains(&[
            circ([0.0, 0.0], 3.0),
            circ([0.0, 0.0], 2.0),
            circ([0.0, 0.0], 1.0),
        ]);
        assert_eq!(region_level([5.0, 0.0], &cs), 0);
        assert_eq!(region_level([2.5, 0.0], &cs), 1);
        assert!(is_hole_level(region_level([1.5, 0.0], &cs)));
        assert_eq!(region_level([0.5, 0.0], &cs), 3);
    }

    #[test]
    fn a_crossed_nested_shell_takes_no_fill_level() {
        // B is concentric with A; C crosses B. B has no single interior to
        // alternate, so the region inside it stays at the first (material)
        // level instead of becoming a hole. Without C it is a hole.
        let clean = chains(&[circ([0.0, 0.0], 3.0), circ([0.0, 0.0], 1.0)]);
        assert!(
            is_hole_level(region_level([0.0, 0.0], &clean)),
            "the uncrossed bore is a hole"
        );
        let crossed = chains(&[
            circ([0.0, 0.0], 3.0),
            circ([0.0, 0.0], 1.0),
            circ([1.5, 0.0], 1.0),
        ]);
        assert_eq!(region_level([0.0, 0.0], &crossed), 1);
        assert!(!hole_expected([0.0, 0.0], &crossed));
        // Two carriers within MERGE are one fused curve, not a crossing.
        let fused = chains(&[circ([0.0, 0.0], 3.0), circ([MERGE / 2.0, 0.0], 3.0)]);
        assert!(!fused[0].crossed && !fused[1].crossed);
    }

    #[test]
    fn crossing_circles_do_not_nest() {
        let cs = chains(&[circ([0.0, 0.0], 2.0), circ([1.0, 0.0], 2.0)]);
        assert_eq!(
            region_level([0.5, 0.0], &cs),
            1,
            "a point in both crossing shells stays at the first level"
        );
    }

    #[test]
    fn an_open_spline_is_not_a_shell() {
        // Only a spline whose ends coincide bounds a region on its own.
        let open = Curve::Spline {
            p0: [0.0, 0.0],
            c1: [4.0, 0.0],
            c2: [4.0, 4.0],
            p3: [1.0, 0.0],
        };
        assert!(chains(&[open]).is_empty());
    }

    #[test]
    fn a_closed_spline_inside_another_is_a_hole_boundary() {
        // The polygon path of the derivation: a small teardrop inside a big
        // one is at level two, and a point between them at level one.
        let big = Curve::Spline {
            p0: [0.0, 0.0],
            c1: [4.0, 0.0],
            c2: [4.0, 4.0],
            p3: [0.0, 0.0],
        };
        let small = Curve::Spline {
            p0: [1.5, 0.6],
            c1: [2.0, 0.6],
            c2: [2.0, 0.9],
            p3: [1.5, 0.6],
        };
        let cs = chains(&[big, small]);
        assert_eq!(cs.len(), 2, "both closed splines are shells");
        assert_eq!(region_level([1.0, 0.3], &cs), 1, "inside the big loop only");
        assert!(
            is_hole_level(region_level([1.75, 0.65], &cs)),
            "inside the small loop, which is inside the big one"
        );
    }
}
