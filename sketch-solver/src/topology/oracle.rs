//! Invariant oracle for the sketch area builder: an independent judge of
//! `detect_topology`'s OUTPUT that trusts neither the DCEL pass, nor the trace
//! order, nor the hole nesting. It re-derives the ground truth from the raw
//! input geometry alone (its own curve classification, its own sampling, its
//! own grid) and then asks whether the builder's faces are exactly the regions
//! those curves bound.
//!
//! Four checks:
//!
//! 1. Coverage (the strong one). Polygonize every real input curve at a chord
//!    tolerance tied to the grid, lay a grid over the bbox (a cell is
//!    `scale/200`), mark a cell "on curve" when its rectangle comes within
//!    `3 * TOL_TOPOLOGY_MERGE` of a curve, and flood fill the rest from the
//!    border. A cell the fill does not reach must lie inside exactly one built
//!    face (outer loop minus holes); a reached cell must lie inside none. This
//!    judges the result without trusting the builder at all.
//! 2. Structure: every loop closes and is non-self-intersecting, every face
//!    side lands on a registered vertex of its own geometry, every face side
//!    names a real non-construction input entity, every hole loop is the
//!    boundary of exactly one other face, each boundary side (half-edge)
//!    appears in exactly one cycle, each split edge piece is used by at most
//!    two sides.
//! 3. Euler: V - E + F = 1 + C over the split graph, the outer face counted in
//!    F, standalone loops counted as their own component.
//! 4. Determinism, entity-order independence and vertex jitter stability, as
//!    separate entry points the fuzz drives with its own seed.
//!
//! Near-merge gaps are a resolution limit of any grid: a gap narrower than a
//! cell cannot be resolved by the flood fill. The oracle therefore runs two
//! fills: a pessimistic one whose barrier is dilated by a cell (so it cannot
//! slip through a diagonal), and an optimistic one with a corridor punched
//! through every endpoint pair closer than `GAP_BRIDGE` (8 merge tolerances,
//! well above the 0.5x and 2x merge gaps the generator injects). Any cell
//! whose reachability differs between the two is undecidable and skipped.
//! Without that pass, a 2x merge gap (which the builder correctly leaves open)
//! would read as a lost area.
//!
//! Known-limitation tags: a violation on an input containing a
//! self-intersecting spline or a line crossing both rings of concentric
//! circles carries `known:<backlog-slug>` and does not count as a failure. The
//! two held-out limitations are accepted behaviour, not bugs to report; the
//! classes they can plausibly corrupt are the geometry-consistency ones
//! (coverage, structure, euler, half-edge), while the pipeline-level checks
//! (determinism, order, stability) stay untagged because the held-out
//! limitations do not excuse those.
//!
//! Only the JSON entry the `fuzz` build exposes is reachable without
//! `cfg(test)`; the generator-facing helpers below are dead in that build.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};

use super::dcel::{detect_topology, InputEntity, TopologyOut};
use super::profile_loops::{BoundaryEdge, EdgeGeom, Vec2};
use super::{
    TOL_FACE_EXISTENCE_MIN_AREA, TOL_NEAR_ZERO_AREA, TOL_TOPOLOGY_EPS as EPS,
    TOL_TOPOLOGY_MERGE as MERGE, TWO_PI,
};
use crate::radians;

// ─── Violations and known-limitation slugs ───

/// Backlog slugs of the two held-out limitations (see feature/backlog.md).
pub(crate) const KNOWN_SELF_INTERSECTING_SPLINE: &str = "slice-spline-self-intersect";
pub(crate) const KNOWN_DONUT_SLICED_ACROSS_RINGS: &str = "donut-sliced-across-rings";

/// One invariant violation. `known` is the backlog slug of a held-out
/// limitation the input exhibits, and a tagged violation is not a failure.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Violation {
    pub(crate) class: &'static str,
    pub(crate) reason: String,
    pub(crate) known: Option<&'static str>,
}

impl Violation {
    pub(crate) fn new(class: &'static str, reason: String) -> Self {
        Violation {
            class,
            reason,
            known: None,
        }
    }

    pub(crate) fn is_pending(&self) -> bool {
        self.known.is_none()
    }

    /// The text the fuzz minimiser and the checked-in cases carry.
    pub(crate) fn render(&self) -> String {
        match self.known {
            Some(slug) => format!("{}: {} [known:{}]", self.class, self.reason, slug),
            None => format!("{}: {}", self.class, self.reason),
        }
    }
}

// ─── Ground-truth curve set ───

/// A real (non-construction) input curve, re-derived from the raw record by
/// the documented discriminating fields. Deliberately independent of the
/// builder's own `TryFrom` classification: a curve the oracle reads here and
/// the builder does not (or vice versa) is exactly the kind of divergence the
/// coverage check exists to catch.
#[derive(Clone, Debug, PartialEq)]
enum Curve {
    Line {
        p0: Vec2,
        p1: Vec2,
    },
    Circle {
        c: Vec2,
        r: f64,
    },
    Arc {
        c: Vec2,
        r: f64,
        a0: f64,
        a1: f64,
    },
    Ellipse {
        c: Vec2,
        a: f64,
        b: f64,
        theta: f64,
    },
    Spline {
        p0: Vec2,
        c1: Vec2,
        c2: Vec2,
        p3: Vec2,
    },
}

/// Classify one raw record, mirroring the input contract's discriminating
/// order (`spline`, `ellipse`, arc by start+radius, line by start, circle by
/// center). `None` for a record missing a field its kind needs: the builder
/// drops those, so they bound no area and the oracle must not expect any.
fn curve_of(e: &InputEntity) -> Option<Curve> {
    if e.kind.as_deref() == Some("spline") {
        let (Some(p0), Some(c1), Some(c2), Some(p3)) = (e.start, e.c1, e.c2, e.end) else {
            return None;
        };
        return Some(Curve::Spline { p0, c1, c2, p3 });
    }
    if e.kind.as_deref() == Some("ellipse") {
        let (Some(c), Some(a), Some(b)) = (e.center, e.a, e.b) else {
            return None;
        };
        return Some(Curve::Ellipse {
            c,
            a,
            b,
            theta: e.theta.unwrap_or(0.0),
        });
    }
    if e.start.is_some() && e.radius.is_some() {
        let (Some(c), Some(r), Some(a0), Some(a1)) =
            (e.center, e.radius, e.angle_start, e.angle_end)
        else {
            return None;
        };
        return Some(Curve::Arc { c, r, a0, a1 });
    }
    if e.start.is_some() {
        let (Some(p0), Some(p1)) = (e.start, e.end) else {
            return None;
        };
        return Some(Curve::Line { p0, p1 });
    }
    if e.center.is_some() {
        let (Some(c), Some(r)) = (e.center, e.radius) else {
            return None;
        };
        return Some(Curve::Circle { c, r });
    }
    None
}

/// The real curves of one input, in input order, with their entity ids.
fn real_curves(input: &[(String, InputEntity)]) -> Vec<(String, Curve)> {
    let mut out = Vec::new();
    for (eid, e) in input {
        if e.construction {
            continue;
        }
        if let Some(c) = curve_of(e) {
            out.push((eid.clone(), c));
        }
    }
    out
}

// ─── Sampling ───

/// A sampled curve: points plus whether the first and last points join (a
/// closed ring has no repeated first point).
struct Sampled {
    pts: Vec<Vec2>,
    closed: bool,
}

/// Angular step whose chord sagitta is at most `tol`.
fn arc_step(r: f64, tol: f64) -> f64 {
    if r <= tol {
        return std::f64::consts::FRAC_PI_2;
    }
    (2.0 * (2.0 * tol / r).sqrt()).clamp(1e-4, std::f64::consts::FRAC_PI_2)
}

fn sample_arc(c: Vec2, r: f64, a0: f64, a1: f64, tol: f64) -> Sampled {
    let sweep = a1 - a0;
    let n = ((sweep.abs() / arc_step(r, tol)).ceil() as usize).max(1);
    let pts = (0..=n)
        .map(|k| {
            let a = a0 + sweep * k as f64 / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect();
    Sampled { pts, closed: false }
}

fn sample_ellipse(
    c: Vec2,
    a: f64,
    b: f64,
    theta_deg: f64,
    phi0: f64,
    phi1: f64,
    tol: f64,
) -> Sampled {
    let th = radians(theta_deg);
    let (cr, sr) = (th.cos(), th.sin());
    let r_max = a.abs().max(b.abs());
    let n = (((phi1 - phi0).abs() / arc_step(r_max, tol)).ceil() as usize).max(1);
    let pts = (0..=n)
        .map(|k| {
            let phi = phi0 + (phi1 - phi0) * k as f64 / n as f64;
            let ax = a * phi.cos();
            let ay = b * phi.sin();
            [c[0] + ax * cr - ay * sr, c[1] + ax * sr + ay * cr]
        })
        .collect();
    Sampled { pts, closed: false }
}

/// Flatten a cubic Bezier by recursive subdivision until its control net is
/// flat to `tol` (or the depth cap trips, which only happens for a pathological
/// control net; the cap keeps the oracle from stalling on hostile input).
fn sample_spline(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, tol: f64) -> Sampled {
    let mut pts = vec![p0];
    flatten_bezier(p0, c1, c2, p3, tol, 0, &mut pts);
    Sampled {
        pts,
        closed: (p0[0] - p3[0]).abs() < EPS && (p0[1] - p3[1]).abs() < EPS,
    }
}

fn flatten_bezier(
    p0: Vec2,
    c1: Vec2,
    c2: Vec2,
    p3: Vec2,
    tol: f64,
    depth: u32,
    out: &mut Vec<Vec2>,
) {
    // Distance of the off-curve handles from the chord; zero chord length (a
    // closed spline) falls back to the distance from the start point, so the
    // recursion still terminates on a small control net.
    let chord = (p3[0] - p0[0]).hypot(p3[1] - p0[1]);
    let flat = if chord > tol {
        let d1 = point_line_dist(c1, p0, p3);
        let d2 = point_line_dist(c2, p0, p3);
        d1.max(d2)
    } else {
        (c1[0] - p0[0])
            .hypot(c1[1] - p0[1])
            .max((c2[0] - p0[0]).hypot(c2[1] - p0[1]))
    };
    if flat <= tol || depth >= 18 {
        out.push(p3);
        return;
    }
    let mid = |a: Vec2, b: Vec2| [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
    let l1 = mid(p0, c1);
    let m = mid(c1, c2);
    let r2 = mid(c2, p3);
    let l2 = mid(l1, m);
    let r1 = mid(m, r2);
    let mid_all = mid(l2, r1);
    flatten_bezier(p0, l1, l2, mid_all, tol, depth + 1, out);
    flatten_bezier(mid_all, r1, r2, p3, tol, depth + 1, out);
}

fn sample_curve(c: &Curve, tol: f64) -> Sampled {
    match *c {
        Curve::Line { p0, p1 } => Sampled {
            pts: vec![p0, p1],
            closed: false,
        },
        Curve::Circle { c, r } => sample_arc(c, r, 0.0, TWO_PI, tol),
        Curve::Arc { c, r, a0, a1 } => {
            // Input arc angles are degrees (the document convention); the
            // sampler works in radians.
            let start = radians(a0);
            let sweep = super::dcel::pymod(radians(a1) - start, TWO_PI);
            sample_arc(c, r, start, start + sweep, tol)
        }
        Curve::Ellipse { c, a, b, theta } => sample_ellipse(c, a, b, theta, 0.0, TWO_PI, tol),
        Curve::Spline { p0, c1, c2, p3 } => sample_spline(p0, c1, c2, p3, tol),
    }
}

/// Sampled points of one boundary edge, in traversal order. A full ellipse is
/// a ring with no explicit repeat of the first point.
fn edge_polyline(eg: &EdgeGeom, tol: f64) -> Sampled {
    match *eg {
        EdgeGeom::Line { start, end } => Sampled {
            pts: vec![start, end],
            closed: false,
        },
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            ccw,
            start,
            end,
        } => {
            let a0 = radians(angle_start_deg);
            let a1 = radians(angle_end_deg);
            // The traversal is CCW or CW by the stored flag; the sweep keeps
            // that sign, so a reversed (CW) side samples towards the end
            // angle, not away from it.
            let sweep = if ccw {
                super::dcel::pymod(a1 - a0, TWO_PI)
            } else {
                -super::dcel::pymod(a0 - a1, TWO_PI)
            };
            let mut s = sample_arc(center, radius, a0, a0 + sweep, tol);
            // The stored endpoints are the builder's own values; anchoring the
            // sampled chain on them keeps the closure check meaningful even
            // when the angles and the endpoints disagree by rounding.
            if let Some(first) = s.pts.first_mut() {
                *first = start;
            }
            if let Some(last) = s.pts.last_mut() {
                *last = end;
            }
            s
        }
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
        } => {
            let p0 = radians(angle_start_deg);
            let p1 = radians(angle_end_deg);
            let sweep = if ccw {
                super::dcel::pymod(p1 - p0, TWO_PI)
            } else {
                -super::dcel::pymod(p0 - p1, TWO_PI)
            };
            let mut s = sample_ellipse(center, a, b, theta, p0, p0 + sweep, tol);
            if let Some(first) = s.pts.first_mut() {
                *first = start;
            }
            if let Some(last) = s.pts.last_mut() {
                *last = end;
            }
            s
        }
        EdgeGeom::Spline { start, c1, c2, end } => sample_spline(start, c1, c2, end, tol),
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta,
        } => {
            let mut s = sample_ellipse(center, a, b, theta, 0.0, TWO_PI, tol);
            s.closed = true;
            s
        }
    }
}

/// One loop's polygon: the edges' points chained, consecutive duplicates (the
/// shared junction of two edges) and the wrap-around duplicate dropped.
pub(crate) fn loop_polygon(loop_edges: &[BoundaryEdge], tol: f64, max_pts: usize) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    for be in loop_edges {
        let s = edge_polyline(&be.geom, tol);
        for p in s.pts {
            // MERGE, not EPS: two sides of one loop meet at a vertex that each
            // computed from its own curve, so their coordinates can differ by
            // the solve's own noise. MERGE is the tolerance the whole pipeline
            // already treats as "the same point".
            if pts
                .last()
                .is_none_or(|q: &Vec2| (q[0] - p[0]).hypot(q[1] - p[1]) > MERGE)
            {
                pts.push(p);
            }
        }
    }
    if pts.len() > max_pts {
        // Decimate rather than truncate: a truncated polygon would have a
        // wrong area and a wrong self-intersection story.
        let step = pts.len().div_ceil(max_pts);
        pts = pts
            .iter()
            .enumerate()
            .filter(|(i, _)| i % step == 0)
            .map(|(_, p)| *p)
            .collect();
    }
    if pts.len() > 1 {
        let first = pts[0];
        if (pts[pts.len() - 1][0] - first[0]).hypot(pts[pts.len() - 1][1] - first[1]) <= MERGE {
            pts.pop();
        }
    }
    pts
}

// ─── Small geometry ───

fn point_line_dist(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len2.sqrt()
}

fn point_seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    let q = [a[0] + t * dx, a[1] + t * dy];
    (p[0] - q[0]).hypot(p[1] - q[1])
}

/// The segment's distance to an axis-aligned box, zero when it enters the box.
fn seg_rect_dist(a: Vec2, b: Vec2, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for i in 0..4 {
        if seg_seg_intersect(a, b, corners[i], corners[(i + 1) % 4]) {
            return 0.0;
        }
    }
    let point_rect = |p: Vec2| {
        let dx = (x0 - p[0]).max(p[0] - x1).max(0.0);
        let dy = (y0 - p[1]).max(p[1] - y1).max(0.0);
        dx.hypot(dy)
    };
    let mut best = point_rect(a).min(point_rect(b));
    for corner in corners {
        best = best.min(point_seg_dist(corner, a, b));
    }
    best
}

fn orient(a: Vec2, b: Vec2, c: Vec2) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Proper or touching intersection of two closed segments, shared endpoints
/// included (callers that must allow a shared vertex filter it out first).
fn seg_seg_intersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    if ((o1 > 0.0) != (o2 > 0.0)) && ((o3 > 0.0) != (o4 > 0.0)) {
        return true;
    }
    let on_seg = |p: Vec2, q: Vec2, r: Vec2| {
        r[0] >= p[0].min(q[0])
            && r[0] <= p[0].max(q[0])
            && r[1] >= p[1].min(q[1])
            && r[1] <= p[1].max(q[1])
    };
    (o1.abs() <= EPS && on_seg(a, b, c))
        || (o2.abs() <= EPS && on_seg(a, b, d))
        || (o3.abs() <= EPS && on_seg(c, d, a))
        || (o4.abs() <= EPS && on_seg(c, d, b))
}

fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

// ─── Grid and coverage ───

/// Cells along the bbox diagonal: the plan's `scale/200`.
const CELLS_PER_DIAGONAL: f64 = 200.0;
/// A cell is "on curve" when its rectangle comes within this many merge
/// tolerances of a curve; the plan's 3.
const BAND_MERGE: f64 = 3.0;
/// Endpoint pairs closer than this are a near-merge gap the grid cannot
/// resolve: the flood fill gets a bridged pass through their cell so the
/// region behind the gap lands in the skip set instead of reading as a lost
/// area. Chosen well above the generator's 2x merge gap and far below any gap
/// the builder itself would honour.
const GAP_BRIDGE_MERGE: f64 = 8.0;
/// Cap on the sampled points of one loop for the self-intersection test.
const SELF_INTERSECT_MAX_PTS: usize = 512;
/// Cap on the points of one face polygon for cell containment. The cap is a
/// backstop against a pathological loop, not a sampling choice: a decimated
/// polygon can cut across a band between two nearby curves (the crescent of
/// two near-tangent circles is 0.03 wide), which would push cells inside a
/// face out of it. The chord-tolerance sampling already bounds a real face at
/// a few hundred points, so the cap sits far above that.
const FACE_POLY_MAX_PTS: usize = 1024;

struct Grid {
    nx: usize,
    ny: usize,
    x0: f64,
    y0: f64,
    cell: f64,
}

impl Grid {
    fn center(&self, i: usize, j: usize) -> Vec2 {
        [
            self.x0 + (i as f64 + 0.5) * self.cell,
            self.y0 + (j as f64 + 0.5) * self.cell,
        ]
    }
}

/// Flood-fill state over one grid: `blocked` cells stop the fill, everything
/// else is reached from the border outward (4-connectivity).
fn flood_reach(grid: &Grid, blocked: &[bool]) -> Vec<bool> {
    let mut reached = vec![false; grid.nx * grid.ny];
    let mut stack: Vec<usize> = Vec::new();
    let idx = |i: usize, j: usize| j * grid.nx + i;
    for i in 0..grid.nx {
        for j in [0, grid.ny - 1] {
            let k = idx(i, j);
            if !blocked[k] && !reached[k] {
                reached[k] = true;
                stack.push(k);
            }
        }
    }
    for j in 0..grid.ny {
        for i in [0, grid.nx - 1] {
            let k = idx(i, j);
            if !blocked[k] && !reached[k] {
                reached[k] = true;
                stack.push(k);
            }
        }
    }
    while let Some(k) = stack.pop() {
        let i = k % grid.nx;
        let j = k / grid.nx;
        let visit = |ni: usize, nj: usize, reached: &mut Vec<bool>, stack: &mut Vec<usize>| {
            let nk = nj * grid.nx + ni;
            if !blocked[nk] && !reached[nk] {
                reached[nk] = true;
                stack.push(nk);
            }
        };
        if i > 0 {
            visit(i - 1, j, &mut reached, &mut stack);
        }
        if i + 1 < grid.nx {
            visit(i + 1, j, &mut reached, &mut stack);
        }
        if j > 0 {
            visit(i, j - 1, &mut reached, &mut stack);
        }
        if j + 1 < grid.ny {
            visit(i, j + 1, &mut reached, &mut stack);
        }
    }
    reached
}

/// One built face as the coverage check judges it: the boundary loop with its
/// holes subtracted, plus a bbox for the cheap reject.
struct FacePoly {
    outer: Vec<Vec2>,
    holes: Vec<Vec<Vec2>>,
    bbox: [f64; 4],
}

impl FacePoly {
    fn contains(&self, p: Vec2) -> bool {
        if p[0] < self.bbox[0] || p[0] > self.bbox[2] || p[1] < self.bbox[1] || p[1] > self.bbox[3]
        {
            return false;
        }
        if !point_in_polygon(p, &self.outer) {
            return false;
        }
        !self.holes.iter().any(|h| point_in_polygon(p, h))
    }
}

fn bbox_of(pts: &[Vec2]) -> Option<[f64; 4]> {
    let mut it = pts.iter();
    let first = it.next()?;
    let mut b = [first[0], first[1], first[0], first[1]];
    for p in it {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    Some(b)
}

/// The coverage oracle. Judges cells far enough from every curve to be
/// decidable, against the faces the builder returned.
fn coverage_violations(
    curves: &[(String, Curve)],
    faces: &[FacePoly],
    chord_tol: f64,
) -> Vec<Violation> {
    let mut all: Vec<Vec2> = Vec::new();
    let sampled: Vec<Sampled> = curves
        .iter()
        .map(|(_, c)| sample_curve(c, chord_tol))
        .collect();
    for s in &sampled {
        all.extend_from_slice(&s.pts);
    }
    let Some(bbox) = bbox_of(&all) else {
        return vec![];
    };
    let (w, h) = (bbox[2] - bbox[0], bbox[3] - bbox[1]);
    let diag = w.hypot(h);
    if diag <= 0.0 {
        return vec![];
    }
    let cell = diag / CELLS_PER_DIAGONAL;
    // One cell of padding on each side so a shape that fills its own bbox still
    // has a border to flood from.
    let grid = Grid {
        nx: ((w / cell).ceil() as usize + 3).max(4),
        ny: ((h / cell).ceil() as usize + 3).max(4),
        x0: bbox[0] - cell,
        y0: bbox[1] - cell,
        cell,
    };

    // Barrier: a cell whose rectangle comes within the band of any curve.
    let band = BAND_MERGE * MERGE + chord_tol;
    let mut blocked = vec![false; grid.nx * grid.ny];
    for s in &sampled {
        let n = s.pts.len();
        if n < 2 {
            continue;
        }
        let last = if s.closed { n } else { n - 1 };
        let half_cell_diag = cell * std::f64::consts::SQRT_2 * 0.5;
        for k in 0..last {
            let a = s.pts[k];
            let b = s.pts[(k + 1) % n];
            // Cheap reject: a cell whose centre is farther from the segment's
            // midpoint than half the segment plus the band plus the cell's
            // half diagonal cannot come within the band.
            let mid = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
            let reach = 0.5 * (a[0] - b[0]).hypot(a[1] - b[1]) + band + half_cell_diag;
            let (mnx, mny, mxx, mxy) = (
                a[0].min(b[0]) - band,
                a[1].min(b[1]) - band,
                a[0].max(b[0]) + band,
                a[1].max(b[1]) + band,
            );
            let (i0, i1) = cell_range(mnx, mxx, &grid, 0);
            let (j0, j1) = cell_range(mny, mxy, &grid, 1);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    if blocked[j * grid.nx + i] {
                        continue;
                    }
                    let (x0, y0) = (grid.x0 + i as f64 * cell, grid.y0 + j as f64 * cell);
                    let c = [x0 + 0.5 * cell, y0 + 0.5 * cell];
                    if (c[0] - mid[0]).hypot(c[1] - mid[1]) > reach {
                        continue;
                    }
                    if seg_rect_dist(a, b, x0, y0, x0 + cell, y0 + cell) <= band {
                        blocked[j * grid.nx + i] = true;
                    }
                }
            }
        }
    }

    // A one-cell-wide digital curve does not stop a 4-connected fill: the
    // curve can step diagonally from one marked cell into another, leaving a
    // free pixel pair the fill slips through. So the pessimistic barrier is
    // the marked set DILATED by one cell, which blocks the fill; and the
    // optimistic barrier is the plain marked set with a corridor punched
    // through every near-merge gap, which lets the fill pass through gaps too
    // small for the grid. A cell whose reachability differs between the two
    // fills sits somewhere the grid cannot decide (behind such a gap, or in a
    // passage only as wide as a cell) and is skipped rather than judged.
    let gap_cells = near_gap_cells(&sampled, &grid, chord_tol);
    let mut optimistic_blocked = blocked.clone();
    for &(i, j) in &gap_cells {
        optimistic_blocked[j * grid.nx + i] = false;
    }
    let pessimistic_blocked = dilate(&blocked, &grid);

    let reached = flood_reach(&grid, &pessimistic_blocked);
    let reached_opt = flood_reach(&grid, &optimistic_blocked);

    let mut face_union: Option<[f64; 4]> = None;
    for f in faces {
        face_union = Some(match face_union {
            None => f.bbox,
            Some(mut u) => {
                u[0] = u[0].min(f.bbox[0]);
                u[1] = u[1].min(f.bbox[1]);
                u[2] = u[2].max(f.bbox[2]);
                u[3] = u[3].max(f.bbox[3]);
                u
            }
        });
    }

    let mut unreached_missing = 0usize;
    let mut unreached_multi = 0usize;
    let mut unreached_example: Option<(Vec2, usize)> = None;
    let mut reached_inside = 0usize;
    let mut reached_example: Option<Vec2> = None;
    for j in 0..grid.ny {
        for i in 0..grid.nx {
            let k = j * grid.nx + i;
            if blocked[k] || reached[k] != reached_opt[k] {
                continue;
            }
            let p = grid.center(i, j);
            // Outside the union of every face bbox the count is trivially
            // zero, which is the common case over a padded grid.
            let inside = match face_union {
                Some(u) if p[0] >= u[0] && p[0] <= u[2] && p[1] >= u[1] && p[1] <= u[3] => {
                    faces.iter().filter(|f| f.contains(p)).count()
                }
                _ => 0,
            };
            if reached[k] {
                if inside > 0 {
                    reached_inside += 1;
                    reached_example.get_or_insert(p);
                }
            } else if inside == 0 {
                unreached_missing += 1;
                unreached_example.get_or_insert((p, inside));
            } else if inside > 1 {
                unreached_multi += 1;
                unreached_example.get_or_insert((p, inside));
            }
        }
    }

    let mut out = Vec::new();
    if let Some((p, n)) = unreached_example {
        let class = if n == 0 {
            "coverage (lost area)"
        } else {
            "coverage (overlap)"
        };
        out.push(Violation::new(
            "coverage",
            format!(
                "{class}: {unreached_missing} cells read as bounded but sit in no face and \
                 {unreached_multi} sit in more than one, first at ({:.6}, {:.6}) with {n}",
                p[0], p[1]
            ),
        ));
    } else if unreached_missing > 0 || unreached_multi > 0 {
        unreachable!("counts only accumulate with an example");
    }
    if let Some(p) = reached_example {
        out.push(Violation::new(
            "coverage",
            format!(
                "coverage (phantom area): {reached_inside} cells reachable from the border sit \
                 inside a face, first at ({:.6}, {:.6})",
                p[0], p[1]
            ),
        ));
    }
    out
}

fn cell_range(lo: f64, hi: f64, grid: &Grid, axis: usize) -> (usize, usize) {
    let (origin, n) = if axis == 0 {
        (grid.x0, grid.nx)
    } else {
        (grid.y0, grid.ny)
    };
    let i0 = (((lo - origin) / grid.cell).floor().max(0.0) as usize).min(n - 1);
    let i1 = (((hi - origin) / grid.cell).ceil().max(0.0) as usize).min(n - 1);
    (i0, i1.max(i0))
}

/// One-cell 4-neighbour dilation: the pessimistic barrier.
fn dilate(blocked: &[bool], grid: &Grid) -> Vec<bool> {
    let mut out = blocked.to_vec();
    for j in 0..grid.ny {
        for i in 0..grid.nx {
            if !blocked[j * grid.nx + i] {
                continue;
            }
            if i > 0 {
                out[j * grid.nx + i - 1] = true;
            }
            if i + 1 < grid.nx {
                out[j * grid.nx + i + 1] = true;
            }
            if j > 0 {
                out[(j - 1) * grid.nx + i] = true;
            }
            if j + 1 < grid.ny {
                out[(j + 1) * grid.nx + i] = true;
            }
        }
    }
    out
}

/// Grid cells the bridged fill may pass through: every pair of curve ends
/// closer than `GAP_BRIDGE_MERGE * MERGE` (and not coincident), plus every
/// curve end that sits that close to another curve's interior. The corridor is
/// cleared on the optimistic barrier only.
fn near_gap_cells(sampled: &[Sampled], grid: &Grid, chord_tol: f64) -> Vec<(usize, usize)> {
    let mut ends: Vec<Vec2> = Vec::new();
    for s in sampled {
        if s.pts.len() < 2 {
            continue;
        }
        ends.push(s.pts[0]);
        ends.push(s.pts[s.pts.len() - 1]);
    }
    let near_threshold = GAP_BRIDGE_MERGE * MERGE;
    let mut cells: BTreeSet<(usize, usize)> = BTreeSet::new();
    let mark_between = |a: Vec2, b: Vec2, cells: &mut BTreeSet<(usize, usize)>| {
        let (mnx, mxx) = (a[0].min(b[0]), a[0].max(b[0]));
        let (mny, mxy) = (a[1].min(b[1]), a[1].max(b[1]));
        let (i0, i1) = cell_range(mnx, mxx, grid, 0);
        let (j0, j1) = cell_range(mny, mxy, grid, 1);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let (x0, y0) = (
                    grid.x0 + i as f64 * grid.cell,
                    grid.y0 + j as f64 * grid.cell,
                );
                if seg_rect_dist(a, b, x0, y0, x0 + grid.cell, y0 + grid.cell) <= near_threshold {
                    cells.insert((i, j));
                }
            }
        }
    };
    for i in 0..ends.len() {
        for j in (i + 1)..ends.len() {
            if i / 2 == j / 2 && i % 2 != j % 2 {
                continue; // the two ends of one open curve are not a gap
            }
            let d = (ends[i][0] - ends[j][0]).hypot(ends[i][1] - ends[j][1]);
            if d > EPS && d <= near_threshold {
                mark_between(ends[i], ends[j], &mut cells);
            }
        }
        // An end almost touching another curve's interior is the same class:
        // a gap the grid cannot resolve.
        for s in sampled {
            let n = s.pts.len();
            if n < 2 {
                continue;
            }
            if s.closed {
                continue;
            }
            for k in 0..(n - 1) {
                let (a, b) = (s.pts[k], s.pts[k + 1]);
                if (a[0] - ends[i][0]).hypot(a[1] - ends[i][1]) <= EPS
                    || (b[0] - ends[i][0]).hypot(b[1] - ends[i][1]) <= EPS
                {
                    continue;
                }
                let d = point_seg_dist(ends[i], a, b);
                if d > chord_tol + EPS && d <= near_threshold + chord_tol {
                    mark_between(ends[i], [ends[i][0], ends[i][1]], &mut cells);
                    break;
                }
            }
        }
    }
    cells.into_iter().collect()
}

// ─── Structure ───

/// Loop sides as the structural checks consume them: vertex ids when present,
/// the geometry endpoints, and the source entity id.
struct Side<'a> {
    be: &'a BoundaryEdge,
}

fn side_ends(s: &Side<'_>) -> Option<(Vec2, Vec2)> {
    match s.be.geom {
        EdgeGeom::Line { start, end }
        | EdgeGeom::Arc { start, end, .. }
        | EdgeGeom::EllipseArc { start, end, .. }
        | EdgeGeom::Spline { start, end, .. } => Some((start, end)),
        EdgeGeom::Ellipse { .. } => None,
    }
}

fn check_loop(
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
fn first_self_crossing(poly: &[Vec2]) -> Option<(usize, usize)> {
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
fn reversed(eg: &EdgeGeom) -> EdgeGeom {
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
fn piece_of(out: &TopologyOut, id: &str, eg: &EdgeGeom) -> Option<usize> {
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

fn edge_end(eg: &EdgeGeom) -> Option<Vec2> {
    match *eg {
        EdgeGeom::Line { end, .. }
        | EdgeGeom::Arc { end, .. }
        | EdgeGeom::EllipseArc { end, .. }
        | EdgeGeom::Spline { end, .. } => Some(end),
        EdgeGeom::Ellipse { .. } => None,
    }
}

fn half_edge_usage_violations(out: &TopologyOut) -> Vec<Violation> {
    // Each traced face side must be one half-edge of a split edge piece, each
    // piece is used by at most two sides, and no oriented side twice.
    let mut uses: BTreeMap<usize, Vec<(String, String)>> = BTreeMap::new();
    let mut violations = Vec::new();
    for (si, s) in out.surfaces.iter().enumerate() {
        for be in &s.boundary {
            let (Some(v0), Some(v1), Some(id)) = (&be.start_vertex, &be.end_vertex, &be.id) else {
                continue; // a standalone loop's sides are not split pieces
            };
            match piece_of(out, id, &be.geom) {
                Some(piece) => uses
                    .entry(piece)
                    .or_default()
                    .push((v0.clone(), v1.clone())),
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
        // Two uses must be the two orientations.
        if used.len() == 2 && used[0] == used[1] {
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
    violations
}

fn hole_wiring_violations(out: &TopologyOut) -> Vec<Violation> {
    // Every hole loop is another face's boundary (every visible region is its
    // own selectable area, so a hole is never a private subdivision).
    type SideKey = (Option<String>, Option<String>, Option<String>);
    let boundary_keys: Vec<Vec<SideKey>> = out
        .surfaces
        .iter()
        .map(|s| {
            s.boundary
                .iter()
                .map(|be| {
                    (
                        be.id.clone(),
                        be.start_vertex.clone(),
                        be.end_vertex.clone(),
                    )
                })
                .collect()
        })
        .collect();
    let mut violations = Vec::new();
    for (si, s) in out.surfaces.iter().enumerate() {
        for (hi, hole) in s.holes.iter().enumerate() {
            let key: Vec<SideKey> = hole
                .iter()
                .map(|be| {
                    (
                        be.id.clone(),
                        be.start_vertex.clone(),
                        be.end_vertex.clone(),
                    )
                })
                .collect();
            if !boundary_keys.contains(&key) {
                violations.push(Violation::new(
                    "structure",
                    format!("surface {si} hole {hi} is not any face's boundary loop"),
                ));
            }
        }
    }
    violations
}

fn euler_violations(out: &TopologyOut) -> Vec<Violation> {
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
    for s in &out.surfaces {
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
    // the half-edge graph never emits (the standalone pass owns it).
    let self_loops = out
        .surfaces
        .iter()
        .filter(|s| {
            s.boundary.len() == 1
                && matches!(s.boundary[0].geom, EdgeGeom::Spline { .. })
                && s.boundary[0].start_vertex.is_some()
                && s.boundary[0].start_vertex == s.boundary[0].end_vertex
        })
        .count();

    let vertex_count = used.len();
    let edge_count = edges.len() + self_loops;
    let face_count = out.surfaces.len() + 1; // the outer face

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
        .filter(|s| {
            s.boundary
                .iter()
                .all(|be| be.start_vertex.is_none() && be.end_vertex.is_none())
        })
        .count();
    let component_count = roots.len() + vertex_free_faces;

    let lhs = vertex_count as i64 - edge_count as i64 + face_count as i64;
    let rhs = 1 + component_count as i64;
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

// ─── Face summaries: order independence and stability ───

/// What two runs of the builder must agree on: one entry per face, by area
/// (boundary loop), the sorted hole areas and the boundary centroid.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FaceSummary {
    pub(crate) area: f64,
    pub(crate) holes: Vec<f64>,
    pub(crate) centroid: Vec2,
    /// `2 * area / perimeter`: how thick the face is on average. A face whose
    /// thickness is comparable to a perturbation cannot be a stability
    /// invariant (its area is a difference of nearly equal terms), so the
    /// comparisons below exempt it instead of reporting noise.
    pub(crate) thickness: f64,
}

pub(crate) fn face_summaries(out: &TopologyOut) -> Vec<FaceSummary> {
    // Exact area and centroid per loop (Green's theorem quadrature): the
    // comparisons below are 1e-9 relative, and a sampled polygon's area is
    // not continuous in the geometry at that scale.
    out.surfaces
        .iter()
        .map(|s| {
            let (area, centroid) = loop_area_centroid(&s.boundary);
            let mut holes: Vec<f64> = s
                .holes
                .iter()
                .map(|h| loop_area_centroid(h).0.abs())
                .collect();
            holes.sort_by(|a, b| a.total_cmp(b));
            // A coarse sampling for the perimeter: a face's thickness needs a
            // couple of percent, not merge-tight geometry, and a merge-tight
            // sampling of a large circle is tens of thousands of points.
            let coarse = (area.abs().sqrt() / 50.0).max(MERGE);
            let poly = loop_polygon(&s.boundary, coarse, 128);
            let mut perimeter = 0.0;
            for k in 0..poly.len() {
                let p = poly[k];
                let q = poly[(k + 1) % poly.len()];
                perimeter += (p[0] - q[0]).hypot(p[1] - q[1]);
            }
            let thickness = if perimeter > 0.0 {
                2.0 * area.abs() / perimeter
            } else {
                0.0
            };
            FaceSummary {
                area,
                holes,
                centroid,
                thickness,
            }
        })
        .collect()
}

/// Greedy multiset match between two runs, with a relative tolerance. Ids may
/// differ; only the geometry has to agree.
///
/// `area_perturbation` is the largest boundary motion the two runs may have
/// introduced (a sub-merge amount for a reordering, the jitter magnitude for
/// the stability check) and `centroid_perturbation` the largest distance a
/// face may have moved in response. A face thinner than
/// `10 * area_perturbation` is exempt: its area is a difference of nearly
/// equal terms, so that motion explains any change it shows. The tolerance on
/// a compared face widens by `4 * perturbation / thickness`, which is what
/// the same boundary motion can explain.
#[allow(clippy::too_many_arguments)]
pub(crate) fn compare_face_multisets(
    class: &'static str,
    label: &str,
    a: &[FaceSummary],
    b: &[FaceSummary],
    area_tol: f64,
    centroid_tol: f64,
    area_perturbation: f64,
    centroid_perturbation: f64,
) -> Vec<Violation> {
    let perturbation = area_perturbation;
    let min_thickness = 10.0 * perturbation;
    let a_kept: Vec<&FaceSummary> = a.iter().filter(|f| f.thickness >= min_thickness).collect();
    let b_kept: Vec<&FaceSummary> = b.iter().filter(|f| f.thickness >= min_thickness).collect();
    if a_kept.len() != b_kept.len() {
        return vec![Violation::new(
            class,
            format!(
                "{label}: face count {} != {} (faces at least {min_thickness:e} thick)",
                a_kept.len(),
                b_kept.len()
            ),
        )];
    }
    let mut taken = vec![false; b_kept.len()];
    let mut out = Vec::new();
    for fa in &a_kept {
        let mut best: Option<(usize, f64)> = None;
        for (i, fb) in b_kept.iter().enumerate() {
            if taken[i] {
                continue;
            }
            let tol = area_tol.max(4.0 * perturbation / fa.thickness.max(f64::MIN_POSITIVE));
            let area_ok = (fa.area - fb.area).abs()
                <= tol
                    * fa.area
                        .abs()
                        .max(fb.area.abs())
                        .max(TOL_FACE_EXISTENCE_MIN_AREA);
            let holes_ok = fa.holes.len() == fb.holes.len()
                && fa.holes.iter().zip(fb.holes.iter()).all(|(x, y)| {
                    (x - y).abs() <= tol * x.abs().max(y.abs()).max(TOL_FACE_EXISTENCE_MIN_AREA)
                });
            let d = (fa.centroid[0] - fb.centroid[0]).hypot(fa.centroid[1] - fb.centroid[1]);
            let centroid_ok = d <= centroid_tol * scale_of(a) + centroid_perturbation;
            if area_ok && holes_ok && centroid_ok {
                best = Some((i, d));
                break;
            }
        }
        match best {
            Some((i, _)) => taken[i] = true,
            None => out.push(Violation::new(
                class,
                format!(
                    "{label}: face with area {:.9} and centroid ({:.6}, {:.6}) has no match",
                    fa.area, fa.centroid[0], fa.centroid[1]
                ),
            )),
        }
    }
    out
}

fn scale_of(faces: &[FaceSummary]) -> f64 {
    let mut scale: f64 = 0.0;
    for f in faces {
        scale = scale
            .max(f.centroid[0].abs())
            .max(f.centroid[1].abs())
            .max(f.area.abs().sqrt());
    }
    scale.max(MERGE)
}

// ─── Known-limitation detection ───

/// The held-out limitation slugs the input exhibits. Self-intersecting spline
/// first (its geometry poisons more checks), then the line across a washer.
pub(crate) fn known_slugs(input: &[(String, InputEntity)]) -> Vec<&'static str> {
    let curves = real_curves(input);
    let mut slugs = Vec::new();
    if curves.iter().any(|(_, c)| match c {
        Curve::Spline { p0, c1, c2, p3 } => {
            // Coarse sampling on purpose: a self-crossing is a feature-scale
            // event, and a merge-tight flattening of a large spline is tens of
            // thousands of points whose O(n^2) scan dominated the whole check.
            let span = bbox_of(&[*p0, *c1, *c2, *p3])
                .map(|b| (b[2] - b[0]).hypot(b[3] - b[1]))
                .unwrap_or(0.0);
            let s = sample_spline(*p0, *c1, *c2, *p3, chord_tol_for(span));
            let mut pts = s.pts;
            if pts.len() > 256 {
                let step = pts.len().div_ceil(256);
                pts = pts
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| i % step == 0)
                    .map(|(_, p)| *p)
                    .collect();
            }
            let n = pts.len();
            let segs = if s.closed { n } else { n - 1 };
            let mut crosses = false;
            'outer: for i in 0..segs {
                let a = pts[i];
                let b = pts[(i + 1) % n];
                for j in (i + 1)..segs {
                    if (i + 1) % n == j || (j + 1) % n == i {
                        continue;
                    }
                    let c = pts[j];
                    let d = pts[(j + 1) % n];
                    if seg_seg_intersect(a, b, c, d) {
                        let shared = [a, b].iter().any(|p| {
                            [c, d]
                                .iter()
                                .any(|q| (p[0] - q[0]).hypot(p[1] - q[1]) <= MERGE)
                        });
                        if !shared {
                            crosses = true;
                            break 'outer;
                        }
                    }
                }
            }
            crosses
        }
        _ => false,
    }) {
        slugs.push(KNOWN_SELF_INTERSECTING_SPLINE);
    }
    if line_crosses_both_rings_of_a_washer(&curves) {
        slugs.push(KNOWN_DONUT_SLICED_ACROSS_RINGS);
    }
    slugs
}

/// True when some line pierces both circles of a concentric pair (two proper
/// crossings each): the "line across a washer" case.
fn line_crosses_both_rings_of_a_washer(curves: &[(String, Curve)]) -> bool {
    let circles: Vec<(Vec2, f64)> = curves
        .iter()
        .filter_map(|(_, c)| match *c {
            Curve::Circle { c, r } if r > MERGE => Some((c, r)),
            _ => None,
        })
        .collect();
    let lines: Vec<(Vec2, Vec2)> = curves
        .iter()
        .filter_map(|(_, c)| match *c {
            Curve::Line { p0, p1 } => Some((p0, p1)),
            _ => None,
        })
        .collect();
    for i in 0..circles.len() {
        for j in (i + 1)..circles.len() {
            let ((c1, r1), (c2, r2)) = (circles[i], circles[j]);
            if (c1[0] - c2[0]).hypot(c1[1] - c2[1]) > MERGE || (r1 - r2).abs() <= MERGE {
                continue;
            }
            for (p0, p1) in &lines {
                if chord_count(*p0, *p1, c1, r1) == 2 && chord_count(*p0, *p1, c2, r2) == 2 {
                    return true;
                }
            }
        }
    }
    false
}

/// Number of proper crossings of the segment `p0..p1` with the circle.
fn chord_count(p0: Vec2, p1: Vec2, c: Vec2, r: f64) -> usize {
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    let fx = p0[0] - c[0];
    let fy = p0[1] - c[1];
    let a = dx * dx + dy * dy;
    if a <= 0.0 {
        return 0;
    }
    let b = 2.0 * (fx * dx + fy * dy);
    let cc = fx * fx + fy * fy - r * r;
    let disc = b * b - 4.0 * a * cc;
    if disc <= 0.0 {
        return 0;
    }
    let sq = disc.sqrt();
    let mut count = 0;
    for t in [(-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)] {
        if t > EPS && t < 1.0 - EPS {
            count += 1;
        }
    }
    count
}

// ─── Entry points ───

/// A few points that bound a curve, for span measurements: the control points
/// for a spline, the centre/radius box for a circle or arc, a conservative box
/// for an ellipse, the endpoints for a line.
fn hull_points(c: &Curve) -> Vec<Vec2> {
    match *c {
        Curve::Line { p0, p1 } => vec![p0, p1],
        Curve::Circle { c, r } => vec![[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]],
        Curve::Arc { c, r, a0, a1 } => vec![
            [c[0] - r, c[1] - r],
            [c[0] + r, c[1] + r],
            [c[0] + r * radians(a0).cos(), c[1] + r * radians(a0).sin()],
            [c[0] + r * radians(a1).cos(), c[1] + r * radians(a1).sin()],
        ],
        Curve::Ellipse { c, a, b, theta: _ } => {
            let r = a.abs().max(b.abs());
            vec![[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]]
        }
        Curve::Spline { p0, c1, c2, p3 } => vec![p0, c1, c2, p3],
    }
}

// ─── Exact loop area and centroid ───

/// 16-point Gauss-Legendre nodes and weights on [-1, 1]. The loop integrals
/// below are trigonometric or polynomial and smooth, so fixed-order quadrature
/// is essentially exact AND continuous in the geometry: a sampled polygon's
/// area jumps whenever its point count crosses a threshold, which is exactly
/// what a 1e-9 relative comparison cannot tolerate.
const GL_NODES: [f64; 8] = [
    0.09501250983763744,
    0.2816035507792589,
    0.45801677765722737,
    0.6178762444026438,
    0.755404408355003,
    0.8656312023878318,
    0.9445750230732326,
    0.9894009349916499,
];
const GL_WEIGHTS: [f64; 8] = [
    0.1894506104550685,
    0.18260341504492358,
    0.16915651939500254,
    0.14959598881657674,
    0.12462897125553388,
    0.09515851168249279,
    0.062253523938647894,
    0.027152459411754096,
];

/// Integrate three integrands at once over `t in [0, 1]` with the 16-point
/// rule: the Green's theorem integrands of one edge, evaluated in one pass.
fn gl01_3(mut f: impl FnMut(f64) -> (f64, f64, f64)) -> (f64, f64, f64) {
    let mut sum = (0.0, 0.0, 0.0);
    for (node, weight) in GL_NODES.iter().zip(GL_WEIGHTS.iter()) {
        for t in [0.5 - 0.5 * node, 0.5 + 0.5 * node] {
            let v = f(t);
            sum = (
                sum.0 + weight * v.0,
                sum.1 + weight * v.1,
                sum.2 + weight * v.2,
            );
        }
    }
    (0.5 * sum.0, 0.5 * sum.1, 0.5 * sum.2)
}

/// The three Green's-theorem integrals of one boundary edge in its traversal
/// direction: `(integral x dy, integral x^2 dy, integral y^2 dx)`.
fn edge_integrals(eg: &EdgeGeom) -> (f64, f64, f64) {
    // `dp` is the derivative with respect to the unit parameter `t`.
    let integrand = |p: Vec2, dp: Vec2| (p[0] * dp[1], p[0] * p[0] * dp[1], p[1] * p[1] * dp[0]);
    match *eg {
        EdgeGeom::Line { start, end } => {
            let dp = [end[0] - start[0], end[1] - start[1]];
            gl01_3(|t| {
                let p = [start[0] + t * dp[0], start[1] + t * dp[1]];
                integrand(p, dp)
            })
        }
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            ccw,
            ..
        } => {
            let a0 = radians(angle_start_deg);
            let a1 = radians(angle_end_deg);
            let sweep = if ccw {
                super::dcel::pymod(a1 - a0, TWO_PI)
            } else {
                -super::dcel::pymod(a0 - a1, TWO_PI)
            };
            gl01_3(|t| {
                let theta = a0 + t * sweep;
                let p = [
                    center[0] + radius * theta.cos(),
                    center[1] + radius * theta.sin(),
                ];
                let dp = [-radius * theta.sin() * sweep, radius * theta.cos() * sweep];
                integrand(p, dp)
            })
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
            let th = radians(theta);
            let (cr, sr) = (th.cos(), th.sin());
            let p0 = radians(angle_start_deg);
            let p1 = radians(angle_end_deg);
            let sweep = if ccw {
                super::dcel::pymod(p1 - p0, TWO_PI)
            } else {
                -super::dcel::pymod(p0 - p1, TWO_PI)
            };
            gl01_3(|t| {
                let phi = p0 + t * sweep;
                let (c, s) = (phi.cos(), phi.sin());
                let p = [
                    center[0] + a * c * cr - b * s * sr,
                    center[1] + a * c * sr + b * s * cr,
                ];
                let dp = [
                    (-a * s * cr - b * c * sr) * sweep,
                    (-a * s * sr + b * c * cr) * sweep,
                ];
                integrand(p, dp)
            })
        }
        EdgeGeom::Spline { start, c1, c2, end } => {
            // A cubic's derivative is quadratic, so the integrands are degree
            // five polynomials and the 16-point rule is exact, not approximate.
            gl01_3(|t| {
                let p = super::curve_split::bezier_point(start, c1, c2, end, t);
                let d0 = [3.0 * (c1[0] - start[0]), 3.0 * (c1[1] - start[1])];
                let d1 = [
                    6.0 * (start[0] - 2.0 * c1[0] + c2[0]),
                    6.0 * (start[1] - 2.0 * c1[1] + c2[1]),
                ];
                let d2 = [
                    3.0 * (end[0] - 3.0 * c2[0] + 3.0 * c1[0] - start[0]),
                    3.0 * (end[1] - 3.0 * c2[1] + 3.0 * c1[1] - start[1]),
                ];
                let dp = [
                    d0[0] + d1[0] * t + d2[0] * t * t,
                    d0[1] + d1[1] * t + d2[1] * t * t,
                ];
                integrand(p, dp)
            })
        }
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta: _,
        } => {
            // A full ellipse is closed; rotation does not change its area and
            // its centroid is the centre, so the closed forms are exact.
            let area = std::f64::consts::PI * a * b;
            (area, 2.0 * center[0] * area, -2.0 * center[1] * area)
        }
    }
}

/// Exact signed area and area-weighted centroid of one loop, in the loop's
/// stored traversal direction (CCW faces are positive).
pub(crate) fn loop_area_centroid(loop_edges: &[BoundaryEdge]) -> (f64, Vec2) {
    let mut integrals = (0.0, 0.0, 0.0);
    for be in loop_edges {
        let (a, b, c) = edge_integrals(&be.geom);
        integrals.0 += a;
        integrals.1 += b;
        integrals.2 += c;
    }
    let area = integrals.0;
    if area.abs() < TOL_NEAR_ZERO_AREA {
        let first = loop_edges.first().and_then(|be| be.geom.start());
        return (area, first.unwrap_or([0.0, 0.0]));
    }
    (
        area,
        [integrals.1 / (2.0 * area), -integrals.2 / (2.0 * area)],
    )
}

/// Chord tolerance for the ground-truth sampling: the plan's "well below the
/// merge tolerance" made scale-adaptive. A fixed 1e-7 would emit hundreds of
/// thousands of segments for the r ~ 1000 motifs the generator reaches; tying
/// the tolerance to a hundredth of a cell keeps the segment counts in the
/// hundreds while staying far below a cell, which is all the grid checks need.
fn chord_tol_for(span: f64) -> f64 {
    (MERGE / 2.0).max(span / CELLS_PER_DIAGONAL / 100.0)
}

/// Judge one builder run against its input. `out` must be the output of
/// `detect_topology(input)`.
pub(crate) fn check_topology(input: &[(String, InputEntity)], out: &TopologyOut) -> Vec<Violation> {
    if input.is_empty() {
        return vec![];
    }
    let curves = real_curves(input);
    let input_ids: BTreeSet<String> = input.iter().map(|(id, _)| id.clone()).collect();
    let construction_ids: BTreeSet<String> = input
        .iter()
        .filter(|(_, e)| e.construction)
        .map(|(id, _)| id.clone())
        .collect();

    // One span for the whole run: the bbox diagonal of the real curves, so the
    // grid and every sampling tolerance agree. Bounding points only: sampling
    // every curve at a fine tolerance just to measure the span is the one
    // quadratic cost the oracle would otherwise pay per check.
    let mut pts: Vec<Vec2> = Vec::new();
    for (_, c) in &curves {
        pts.extend_from_slice(&hull_points(c));
    }
    let span = bbox_of(&pts)
        .map(|b| (b[2] - b[0]).hypot(b[3] - b[1]))
        .unwrap_or(0.0);
    let chord_tol = chord_tol_for(span);

    let mut violations = Vec::new();

    let faces: Vec<FacePoly> = out
        .surfaces
        .iter()
        .map(|s| {
            let outer = loop_polygon(&s.boundary, chord_tol, FACE_POLY_MAX_PTS);
            let holes = s
                .holes
                .iter()
                .map(|h| loop_polygon(h, chord_tol, FACE_POLY_MAX_PTS))
                .collect();
            let bbox = bbox_of(&outer).unwrap_or([0.0, 0.0, 0.0, 0.0]);
            FacePoly { outer, holes, bbox }
        })
        .collect();

    if !curves.is_empty() {
        violations.extend(coverage_violations(&curves, &faces, chord_tol));
    }

    let verts: BTreeMap<String, Vec2> = out.vertices.iter().map(|(k, v)| (k.clone(), *v)).collect();
    for (si, s) in out.surfaces.iter().enumerate() {
        for (hi, hole) in s.holes.iter().enumerate() {
            check_loop(
                &format!("surface {si} hole {hi}"),
                hole,
                &verts,
                &input_ids,
                &construction_ids,
                chord_tol,
                &mut violations,
            );
        }
        check_loop(
            &format!("surface {si}"),
            &s.boundary,
            &verts,
            &input_ids,
            &construction_ids,
            chord_tol,
            &mut violations,
        );
    }
    violations.extend(hole_wiring_violations(out));
    violations.extend(half_edge_usage_violations(out));
    violations.extend(euler_violations(out));

    // Tag the geometry-consistency classes when the input exhibits a held-out
    // limitation; the pipeline-level classes never get tagged (see the module
    // comment).
    let slugs = known_slugs(input);
    if !slugs.is_empty() {
        for v in &mut violations {
            if matches!(v.class, "coverage" | "structure" | "euler" | "half-edge") {
                v.known = Some(slugs[0]);
            }
        }
    }
    violations
}

/// Convenience: run the builder and judge the result.
pub(crate) fn check_input(input: &[(String, InputEntity)]) -> Vec<Violation> {
    let out = detect_topology(input);
    check_topology(input, &out)
}

/// Determinism against an already-computed run: the vertex id sequence, the
/// edge identity sequence and every face's exact area, holes and centroid must
/// repeat bit-for-bit. Comparing those beats formatting the whole output (a
/// large sketch's debug string is tens of megabytes) and covers the same
/// classes: a randomized vertex pool or edge order changes the ids/indices,
/// a randomized merge changes the areas.
pub(crate) fn check_determinism_against(
    input: &[(String, InputEntity)],
    out: &TopologyOut,
) -> Vec<Violation> {
    let other = detect_topology(input);
    let ids_a: Vec<&String> = out.vertices.iter().map(|(k, _)| k).collect();
    let ids_b: Vec<&String> = other.vertices.iter().map(|(k, _)| k).collect();
    let edges_a: Vec<(&String, usize)> = out
        .edges
        .iter()
        .map(|e| (&e.entity_id, e.edge_index))
        .collect();
    let edges_b: Vec<(&String, usize)> = other
        .edges
        .iter()
        .map(|e| (&e.entity_id, e.edge_index))
        .collect();
    if ids_a == ids_b && edges_a == edges_b && face_summaries(out) == face_summaries(&other) {
        vec![]
    } else {
        vec![Violation::new(
            "determinism",
            "two runs of the same input differ".to_string(),
        )]
    }
}

/// Determinism: the same input twice, from scratch.
pub(crate) fn check_determinism(input: &[(String, InputEntity)]) -> Vec<Violation> {
    let out = detect_topology(input);
    check_determinism_against(input, &out)
}

/// Entity-order independence: the permuted input (out[i] = input[perm[i]]) must
/// produce the same face multiset within `1e-9` relative (ids may differ).
pub(crate) fn check_order_independence(
    input: &[(String, InputEntity)],
    perm: &[usize],
) -> Vec<Violation> {
    if perm.len() != input.len() {
        return vec![Violation::new(
            "order",
            "permutation length mismatch".into(),
        )];
    }
    let permuted: Vec<(String, InputEntity)> = perm.iter().map(|&i| input[i].clone()).collect();
    let base = face_summaries(&detect_topology(input));
    let other = face_summaries(&detect_topology(&permuted));
    // A reordering moves nothing; the only noise it can introduce is a merge
    // decision at sub-merge distances, so that is the perturbation the
    // comparison is allowed to explain.
    compare_face_multisets(
        "order",
        "entity permutation",
        &base,
        &other,
        1e-9,
        1e-9,
        MERGE / 100.0,
        MERGE,
    )
}

/// Jitter stability: `jittered` is the same input moved by at most
/// `MERGE / 10` per vertex. Face count and areas must hold within `1e-6`
/// relative.
pub(crate) fn check_stability(
    input: &[(String, InputEntity)],
    jittered: &[(String, InputEntity)],
) -> Vec<Violation> {
    let base = face_summaries(&detect_topology(input));
    let moved = face_summaries(&detect_topology(jittered));
    // Two endpoints can move towards each other by 2 * MERGE / 10; that is the
    // largest boundary motion the comparison must be able to explain.
    compare_face_multisets(
        "stability",
        "vertex jitter",
        &base,
        &moved,
        1e-6,
        1e-6,
        2.0 * MERGE / 10.0,
        4.0 * MERGE / 10.0,
    )
}

/// Move every defining point of every entity by the same per-entity delta, so a
/// jittered curve stays internally consistent (an arc's centre and endpoints
/// move together).
pub(crate) fn jitter_input(
    input: &[(String, InputEntity)],
    deltas: &[Vec2],
) -> Vec<(String, InputEntity)> {
    let shift = |p: &mut Option<Vec2>, d: Vec2| {
        if let Some(p) = p {
            p[0] += d[0];
            p[1] += d[1];
        }
    };
    input
        .iter()
        .zip(deltas.iter().cycle())
        .map(|((id, e), d)| {
            let mut j = e.clone();
            shift(&mut j.start, *d);
            shift(&mut j.end, *d);
            shift(&mut j.center, *d);
            shift(&mut j.c1, *d);
            shift(&mut j.c2, *d);
            (id.clone(), j)
        })
        .collect()
}

/// JSON of the violations for the node boundary: `[{class, reason, known}]`.
#[cfg(feature = "fuzz")]
pub(crate) fn violations_json(input: &[u8]) -> Result<Vec<u8>, String> {
    let geometry = super::codec::decode_input(input).map_err(|e| format!("{e:?}"))?;
    let violations = check_input(&geometry);
    let values: Vec<serde_json::Value> = violations
        .iter()
        .map(|v| {
            serde_json::json!({
                "class": v.class,
                "reason": v.reason,
                "known": v.known,
                "text": v.render(),
            })
        })
        .collect();
    serde_json::to_vec(&values).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
