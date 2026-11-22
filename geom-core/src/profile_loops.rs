//! Profile-loop helpers: arc/spline/ellipse sampling, the polygon point list,
//! containment nesting, signed area and area-weighted centroid.
//!
//! `EdgeGeom`/`BoundaryEdge` are the loop-edge vocabulary the whole pipeline
//! shares: the solver's `dcel` builds them, this module samples them, and the
//! TypeScript kernel reaches them through the `profile_loops_bytes` codec.
//!
//! Float parity is load-bearing: vertex order, the sample counts and the
//! containment tie-breaks feed strings the TS decorator builds, and the
//! `geom-core` golden fixture (generated from the TS implementation) pins the
//! two sides together. The polygonising sample count is therefore an argument,
//! not a constant: the coarse 1 is the area builder's historical pass, the
//! fine 64 is what the profile dump and the even/odd classifier measure.

use crate::curve_split::bezier_point;
use crate::{radians, TOL_NEAR_ZERO_AREA};

pub use crate::Vec2;

/// Sample count that makes a curved loop read as its true shape rather than as
/// its chord polygon: the centroid uses it, the viewport tessellates boundaries
/// at the same 64, and the profile dump re-runs containment at it to measure
/// how far the coarse 1-sample polygon has drifted from what the user sees.
pub const CENTROID_ARC_SAMPLES: usize = 64;

/// Geometry of one boundary/half-edge. Mirrors the stringly-typed geom dicts
/// the original `topology.ts` built (`lineEg`/`arcEg`/`ellipseArcEg`/`splineEg`,
/// plus the standalone
/// full-`Ellipse` boundary edge which carries no start/end).
#[derive(Clone, Debug, PartialEq)]
pub enum EdgeGeom {
    Line {
        start: Vec2,
        end: Vec2,
    },
    Arc {
        center: Vec2,
        radius: f64,
        angle_start_deg: f64,
        angle_end_deg: f64,
        ccw: bool,
        start: Vec2,
        end: Vec2,
    },
    EllipseArc {
        center: Vec2,
        a: f64,
        b: f64,
        theta: f64,
        angle_start_deg: f64,
        angle_end_deg: f64,
        ccw: bool,
        start: Vec2,
        end: Vec2,
    },
    Spline {
        start: Vec2,
        c1: Vec2,
        c2: Vec2,
        end: Vec2,
    },
    /// One run of an interpolating fit spline: the C0 cubic Bezier chain poles
    /// (`3 M + 1` of them, sharing each joint) and the `M + 1` chord knots. A
    /// run cut by an intersection carries the de Casteljau-split end pieces and
    /// their interpolated end knots, so the same variant covers a whole entity
    /// and any sub-edge of it.
    FitSpline {
        poles: Vec<Vec2>,
        knots: Vec<f64>,
    },
    /// A full closed ellipse standalone boundary edge: carries NO start/end (so
    /// `loop_pts` samples it via `ellipse_sample_points`, like the TS dict that
    /// lacks the `start` key).
    Ellipse {
        center: Vec2,
        a: f64,
        b: f64,
        theta: f64,
    },
}

impl EdgeGeom {
    /// The edge's start point, when it has one (everything but a full ellipse).
    pub fn start(&self) -> Option<Vec2> {
        match self {
            EdgeGeom::Line { start, .. }
            | EdgeGeom::Arc { start, .. }
            | EdgeGeom::EllipseArc { start, .. }
            | EdgeGeom::Spline { start, .. } => Some(*start),
            EdgeGeom::FitSpline { poles, .. } => poles.first().copied(),
            EdgeGeom::Ellipse { .. } => None,
        }
    }
}

/// A boundary edge: geometry plus the ancestry metadata the output carries.
#[derive(Clone, Debug)]
pub struct BoundaryEdge {
    pub geom: EdgeGeom,
    pub id: Option<String>,
    pub start_vertex: Option<String>,
    pub end_vertex: Option<String>,
}

/// One loop edge as the wire holds it: the geometry plus the start point the
/// caller's dict carried.
///
/// The explicit start matters for a fit spline whose joint was snapped onto a
/// shared vertex: the dict's `start` can sit up to the merge tolerance off the
/// first pole, and the TS sampler pushed the dict's start. `None` means "use the
/// geometry's own start", which is what the area builder's edges always do.
#[derive(Clone, Debug)]
pub struct LoopEdge {
    pub geom: EdgeGeom,
    pub start: Option<Vec2>,
}

/// What the loop samplers need from an edge. Implemented by the area builder's
/// `BoundaryEdge` and by the wire `LoopEdge`; they differ in where the start
/// point comes from: the area builder derives it from the geometry, the wire
/// edge carries the dict's own `start` (which a snapped fit-spline joint can
/// move off its first pole, and which a dict can lack entirely).
pub trait ProfiledEdge {
    fn geom(&self) -> &EdgeGeom;
    /// The point the polygon reader pushes before this edge's interior samples.
    fn start_point(&self) -> Option<Vec2>;
}

impl ProfiledEdge for BoundaryEdge {
    fn geom(&self) -> &EdgeGeom {
        &self.geom
    }

    fn start_point(&self) -> Option<Vec2> {
        self.geom.start()
    }
}

impl ProfiledEdge for LoopEdge {
    fn geom(&self) -> &EdgeGeom {
        &self.geom
    }

    fn start_point(&self) -> Option<Vec2> {
        self.start
    }
}

/// n interior points spread along an arc edge (n>=1); empty if not an arc.
pub(crate) fn arc_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
    if let EdgeGeom::Arc {
        center,
        radius,
        angle_start_deg,
        angle_end_deg,
        ccw,
        ..
    } = *e
    {
        let cx = center[0];
        let cy = center[1];
        let a0 = radians(angle_start_deg);
        let a1 = radians(angle_end_deg);
        // Samples follow the stored traversal direction: a CW side sweeps
        // towards its end angle (the sign of the sweep keeps the turn), so the
        // point sequence stays on the edge's own arc. Swapping the angles
        // instead, as this once did, sampled the complementary arc in reverse
        // order and the loop polygon grew a chord across it.
        let two_pi = 2.0 * std::f64::consts::PI;
        // A stored 360-degree arc is a full turn, not a zero one: rem_euclid
        // would collapse 2*pi to 0 and sample every point at the start.
        let full_turn = (a1 - a0).abs() >= two_pi - 1e-9;
        let sweep = if full_turn {
            if ccw {
                two_pi
            } else {
                -two_pi
            }
        } else if ccw {
            (a1 - a0).rem_euclid(two_pi)
        } else {
            -(a0 - a1).rem_euclid(two_pi)
        };
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            let a = a0 + sweep * (k as f64 + 1.0) / (n as f64 + 1.0);
            out.push([cx + radius * a.cos(), cy + radius * a.sin()]);
        }
        out
    } else {
        vec![]
    }
}

/// n interior points along a cubic-Bezier spline edge; empty if not one.
pub(crate) fn spline_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
    if let EdgeGeom::Spline { start, c1, c2, end } = *e {
        (0..n)
            .map(|k| {
                let t = (k as f64 + 1.0) / (n as f64 + 1.0);
                bezier_point(start, c1, c2, end, t)
            })
            .collect()
    } else {
        vec![]
    }
}

/// True for a spline edge whose start and end coincide (a closed self-loop).
fn spline_is_closed(e: &EdgeGeom) -> bool {
    if let EdgeGeom::Spline { start, end, .. } = *e {
        (start[0] - end[0]).hypot(start[1] - end[1]) < 1e-6
    } else {
        false
    }
}

/// The piece index containing `u`, clamped into the chain's domain.
pub fn fit_chain_piece(knots: &[f64], u: f64) -> usize {
    let last = knots.len().saturating_sub(2);
    if u <= knots[0] {
        return 0;
    }
    if u >= knots[knots.len() - 1] {
        return last;
    }
    let mut lo = 0;
    let mut hi = knots.len() - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if knots[mid] <= u {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo.min(last)
}

/// Evaluate a C0 cubic Bezier chain at chord parameter `u`.
pub fn fit_chain_point(poles: &[Vec2], knots: &[f64], u: f64) -> Vec2 {
    let i = fit_chain_piece(knots, u);
    let h = knots[i + 1] - knots[i];
    let t = if h > 0.0 {
        ((u - knots[i]) / h).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let ctrl = [
        poles[3 * i],
        poles[3 * i + 1],
        poles[3 * i + 2],
        poles[3 * i + 3],
    ];
    bezier_point(ctrl[0], ctrl[1], ctrl[2], ctrl[3], t)
}

/// n interior points along a fit-spline chain edge; empty if not one.
pub(crate) fn fit_spline_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
    if let EdgeGeom::FitSpline { poles, knots } = e {
        let (u0, u1) = (knots[0], knots[knots.len() - 1]);
        (0..n)
            .map(|k| {
                let u = u0 + (u1 - u0) * (k as f64 + 1.0) / (n as f64 + 1.0);
                fit_chain_point(poles, knots, u)
            })
            .collect()
    } else {
        vec![]
    }
}

/// True for a fit-spline edge whose start and end coincide (a closed loop).
fn fit_spline_is_closed(e: &EdgeGeom) -> bool {
    if let EdgeGeom::FitSpline { poles, .. } = e {
        let start = poles[0];
        let end = poles[poles.len() - 1];
        (start[0] - end[0]).hypot(start[1] - end[1]) < 1e-6
    } else {
        false
    }
}

/// n interior points along an elliptical-arc edge; empty if not one.
pub(crate) fn ellipse_arc_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
    if let EdgeGeom::EllipseArc {
        center,
        a,
        b,
        theta,
        angle_start_deg,
        angle_end_deg,
        ccw,
        ..
    } = *e
    {
        let rot = radians(theta);
        let cr = rot.cos();
        let sr = rot.sin();
        let p0 = radians(angle_start_deg);
        let mut p1 = radians(angle_end_deg);
        if ccw {
            if p1 < p0 {
                p1 += 2.0 * std::f64::consts::PI;
            }
        } else if p1 > p0 {
            p1 -= 2.0 * std::f64::consts::PI;
        }
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            let phi = p0 + (p1 - p0) * (k as f64 + 1.0) / (n as f64 + 1.0);
            let ax = a * phi.cos();
            let ay = b * phi.sin();
            out.push([center[0] + ax * cr - ay * sr, center[1] + ax * sr + ay * cr]);
        }
        out
    } else {
        vec![]
    }
}

/// n points spread around a full closed ellipse edge; empty if not one.
pub(crate) fn ellipse_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
    if let EdgeGeom::Ellipse {
        center,
        a,
        b,
        theta,
    } = *e
    {
        let cx = center[0];
        let cy = center[1];
        let rot = radians(theta);
        let cr = rot.cos();
        let sr = rot.sin();
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            let t = 2.0 * std::f64::consts::PI * k as f64 / n as f64;
            let ax = a * t.cos();
            let ay = b * t.sin();
            out.push([cx + ax * cr - ay * sr, cy + ax * sr + ay * cr]);
        }
        out
    } else {
        vec![]
    }
}

/// Polygon point list from a loop, inserting arc/spline/ellipse sample points.
pub fn loop_pts<E: ProfiledEdge>(loop_edges: &[E], arc_samples: usize) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    for be in loop_edges {
        let e = be.geom();
        if let Some(s) = be.start_point() {
            pts.push(s);
        }
        pts.extend(arc_sample_points(e, arc_samples));
        pts.extend(ellipse_arc_sample_points(e, arc_samples.max(4)));
        // A self-closing spline (start == end) is a standalone closed loop, so it
        // needs enough points to read as a polygon on its own, like a full ellipse.
        pts.extend(spline_sample_points(
            e,
            if spline_is_closed(e) {
                (arc_samples * 4).max(16)
            } else {
                arc_samples
            },
        ));
        // A fit-spline chain needs the same treatment: a closed one is a
        // standalone polygon, and a long chain deserves more than the coarse
        // arc count so its lobes read correctly.
        pts.extend(fit_spline_sample_points(
            e,
            if fit_spline_is_closed(e) {
                (arc_samples * 4).max(16)
            } else {
                arc_samples.max(8)
            },
        ));
        // A full ellipse is a standalone closed loop: enough points to read as a
        // polygon on its own, independent of the coarse arc sample count.
        pts.extend(ellipse_sample_points(e, (arc_samples * 4).max(16)));
    }
    pts
}

/// Signed 2D area via the shoelace formula. Positive = CCW.
pub fn loop_signed_area<E: ProfiledEdge>(loop_edges: &[E], arc_samples: usize) -> f64 {
    let pts = loop_pts(loop_edges, arc_samples);
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut acc = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    acc / 2.0
}

/// Ray-casting point-in-polygon test against explicit polygon points.
/// `point_in_loop` samples its edges at one point each, which is too coarse
/// for a containment question between curves that nearly touch; callers that
/// need resolution sample first and reach this directly.
pub fn point_in_polygon(pt: Vec2, pts: &[Vec2]) -> bool {
    let x = pt[0];
    let y = pt[1];
    let n = pts.len();
    if n == 0 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let xi = pts[i][0];
        let yi = pts[i][1];
        let xj = pts[j][0];
        let yj = pts[j][1];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Ray-casting point-in-polygon test against a 2D loop.
pub fn point_in_loop<E: ProfiledEdge>(pt: Vec2, loop_edges: &[E], arc_samples: usize) -> bool {
    point_in_polygon(pt, &loop_pts(loop_edges, arc_samples))
}

/// Distance from `pt` to a polygon's boundary.
pub fn point_polygon_dist(pt: Vec2, pts: &[Vec2]) -> f64 {
    let n = pts.len();
    if n == 0 {
        return f64::INFINITY;
    }
    let mut best = f64::INFINITY;
    for i in 0..n {
        best = best.min(point_segment_dist(pt, pts[i], pts[(i + 1) % n]));
    }
    best
}

/// How far a uniform n-gon on a curve of radius `r` falls inside it: the
/// sagitta `r * (2*pi/n)^2 / 8`, with the polygon's half-diagonal standing in
/// for `r`. The sampling error of a polygon read against a curve, in one place.
pub fn polygon_sagitta(pts: &[Vec2], samples: usize) -> f64 {
    if pts.is_empty() || samples == 0 {
        return 0.0;
    }
    let (mut mnx, mut mny, mut mxx, mut mxy) = (pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
    for p in pts {
        mnx = mnx.min(p[0]);
        mny = mny.min(p[1]);
        mxx = mxx.max(p[0]);
        mxy = mxy.max(p[1]);
    }
    let r = 0.5 * (mxx - mnx).hypot(mxy - mny);
    let theta = 2.0 * std::f64::consts::PI / samples as f64;
    r * theta * theta / 8.0
}

/// Distance from `pt` to the closed segment `a..b`.
pub fn point_segment_dist(pt: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (pt[0] - a[0]).hypot(pt[1] - a[1]);
    }
    let t = (((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    let q = [a[0] + t * dx, a[1] + t * dy];
    (pt[0] - q[0]).hypot(pt[1] - q[1])
}

/// Area-weighted centroid of a 2D loop polygon.
pub fn loop_centroid<E: ProfiledEdge>(loop_edges: &[E]) -> Vec2 {
    let pts = loop_pts(loop_edges, CENTROID_ARC_SAMPLES);
    let n = pts.len();
    if n < 3 {
        return [0.0, 0.0];
    }
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
    if area.abs() < TOL_NEAR_ZERO_AREA {
        return [pts[0][0], pts[0][1]];
    }
    cx /= 6.0 * area;
    cy /= 6.0 * area;
    [cx, cy]
}

/// A point `point_in_loop` reads as genuinely inside the loop, for the
/// containment questions `loop_centroid` cannot answer: a concave loop (a C or
/// a U) can have its area centroid in its own notch, outside the loop, and
/// every containment question asked of that point is then answered wrong.
/// Returns the centroid when it verifies as interior; otherwise nudges a
/// boundary edge's midpoint to either side, shrinking the step until one side
/// verifies (a step past the opposite boundary of a thin loop lands outside and
/// is rejected). `None` when nothing verifies, so the caller can keep its
/// centroid-only behaviour.
///
/// The polygon is sampled at the caller's `arc_samples`: the profile dump's
/// fine pass verifies the probe on the same polygon it tests containment with,
/// and the area builder passes the coarse 1.
fn interior_probe<E: ProfiledEdge>(loop_edges: &[E], arc_samples: usize) -> Option<Vec2> {
    let pts = loop_pts(loop_edges, arc_samples);
    let n = pts.len();
    if n < 3 {
        return None;
    }
    let centroid = loop_centroid(loop_edges);
    if point_in_loop(centroid, loop_edges, arc_samples) {
        return Some(centroid);
    }
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let len = dx.hypot(dy);
        // A zero-length edge has no normal, and a NaN len (a poisoned param
        // that the TS mirror's `!(len > 0)` guard also skips) must not seed the
        // step.
        if len.is_nan() || len <= 0.0 {
            continue;
        }
        let m = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
        let (nx, ny) = (-dy / len, dx / len);
        for scale in [0.25, 0.1, 0.02, 0.005, 0.001, 0.0002] {
            let step = len * scale;
            for side in [1.0, -1.0] {
                let candidate = [m[0] + side * step * nx, m[1] + side * step * ny];
                if point_in_loop(candidate, loop_edges, arc_samples) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// For each loop: its immediate `container` (the smallest strictly larger loop
/// that encloses it, or `None`). The `depth` count is also returned for the
/// even/odd `classify_loops` model.
fn loop_containment<E: ProfiledEdge>(
    loops: &[Vec<E>],
    arc_samples: usize,
) -> (Vec<usize>, Vec<Option<usize>>) {
    let n = loops.len();
    let areas: Vec<f64> = loops
        .iter()
        .map(|l| loop_signed_area(l, arc_samples).abs())
        .collect();
    let cents: Vec<Vec2> = loops.iter().map(|l| loop_centroid(l)).collect();
    // The centroid is the historical probe and stays the primary one; a
    // concave loop whose centroid sits outside it is backed by a probe that is
    // verified interior, or a hole inside it would be dropped.
    let probes: Vec<Option<Vec2>> = loops
        .iter()
        .map(|l| interior_probe(l, arc_samples))
        .collect();

    let mut depth = vec![0usize; n];
    let mut container: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        let mut best_area = f64::INFINITY;
        for j in 0..n {
            if i == j {
                continue;
            }
            let held = point_in_loop(cents[i], &loops[j], arc_samples)
                || probes[i].is_some_and(|p| point_in_loop(p, &loops[j], arc_samples));
            if areas[j] > areas[i] && held {
                depth[i] += 1;
                if areas[j] < best_area {
                    best_area = areas[j];
                    container[i] = Some(j);
                }
            }
        }
    }
    (depth, container)
}

/// The containment analysis the TS classifier reads: per loop, its nesting
/// depth and its immediate container (`None` for an outer loop).
///
/// `arc_samples` is the polygon count the areas and point tests are measured
/// on. The area builder's own `subdivide_loops` uses the coarse 1; the TS
/// even/odd classifier passes `CENTROID_ARC_SAMPLES`, because a 1-sample chord
/// polygon is a shape neither the user nor `loop_centroid` sees.
pub fn profile_loop_containment<E: ProfiledEdge>(
    loops: &[Vec<E>],
    arc_samples: usize,
) -> (Vec<usize>, Vec<Option<usize>>) {
    loop_containment(loops, arc_samples)
}

/// Planar subdivision: every loop bounds its own face whose holes are the loops
/// immediately nested inside it. Returns, per loop index `oi`, the indices of the
/// loops whose immediate container is `oi`. The sketch-area model: every visible
/// region is selectable (unlike the even/odd donut `classify_loops`).
pub fn subdivide_loops<E: ProfiledEdge>(loops: &[Vec<E>]) -> Vec<(usize, Vec<usize>)> {
    if loops.is_empty() {
        return vec![];
    }
    if loops.len() == 1 {
        return vec![(0, vec![])];
    }
    let n = loops.len();
    let (_depth, container) = loop_containment(loops, 1);
    let mut result = Vec::with_capacity(n);
    for oi in 0..n {
        let holes: Vec<usize> = (0..n).filter(|&i| container[i] == Some(oi)).collect();
        result.push((oi, holes));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<BoundaryEdge> {
        let p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        let mut out = Vec::new();
        for i in 0..4 {
            out.push(BoundaryEdge {
                geom: EdgeGeom::Line {
                    start: p[i],
                    end: p[(i + 1) % 4],
                },
                id: None,
                start_vertex: None,
                end_vertex: None,
            });
        }
        out
    }

    #[test]
    fn the_centroid_sample_count_is_the_ts_mirror_value() {
        // `kernel/profileLoops.ts` carries the same 64 for the classifier and
        // the profile dump; both sides pin it so a one-sided change fails.
        assert_eq!(CENTROID_ARC_SAMPLES, 64);
    }

    #[test]
    fn signed_area_ccw_positive() {
        assert!((loop_signed_area(&rect(0.0, 0.0, 2.0, 3.0), 1) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn centroid_of_rect() {
        let c = loop_centroid(&rect(0.0, 0.0, 2.0, 2.0));
        assert!((c[0] - 1.0).abs() < 1e-9 && (c[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn point_in_loop_inside_and_outside() {
        let r = rect(0.0, 0.0, 2.0, 2.0);
        assert!(point_in_loop([1.0, 1.0], &r, 1));
        assert!(!point_in_loop([3.0, 1.0], &r, 1));
    }

    #[test]
    fn subdivide_nested_rects_outer_carries_inner_as_hole() {
        let loops = vec![rect(0.0, 0.0, 10.0, 10.0), rect(3.0, 3.0, 6.0, 6.0)];
        let sub = subdivide_loops(&loops);
        assert_eq!(sub.len(), 2);
        // loop 0 (big) contains loop 1; loop 1 contains nothing.
        assert_eq!(sub[0], (0, vec![1]));
        assert_eq!(sub[1], (1, vec![]));
    }

    #[test]
    fn subdivide_tracks_container_depth_through_three_nested_levels() {
        // The two-loop test only reaches depth one. A third level pins that
        // containment walks past the immediate parent and that each loop's hole
        // is its IMMEDIATE child, not every loop it encloses.
        let loops = vec![
            rect(0.0, 0.0, 30.0, 30.0),
            rect(5.0, 5.0, 25.0, 25.0),
            rect(10.0, 10.0, 20.0, 20.0),
        ];
        let (depth, container) = loop_containment(&loops, 1);
        assert_eq!(depth, vec![0, 1, 2]);
        assert_eq!(container, vec![None, Some(0), Some(1)]);

        let sub = subdivide_loops(&loops);
        assert_eq!(sub, vec![(0, vec![1]), (1, vec![2]), (2, vec![])]);
    }

    /// Closed line loop over the given vertices.
    fn poly(pts: &[Vec2]) -> Vec<BoundaryEdge> {
        let n = pts.len();
        (0..n)
            .map(|i| BoundaryEdge {
                geom: EdgeGeom::Line {
                    start: pts[i],
                    end: pts[(i + 1) % n],
                },
                id: None,
                start_vertex: None,
                end_vertex: None,
            })
            .collect()
    }

    /// A C (the shape of "⊂"): back bar `x in [0, back]`, arms reaching to
    /// `x = w`, arm thickness `t`. The mouth is the region between the arms.
    fn c_shape(w: f64, h: f64, t: f64, back: f64) -> Vec<BoundaryEdge> {
        poly(&[
            [0.0, 0.0],
            [0.0, h],
            [w, h],
            [w, h - t],
            [back, h - t],
            [back, t],
            [w, t],
            [w, 0.0],
        ])
    }

    /// A circle the way the area builder emits one: two 180 degree arcs.
    fn circle_loop(cx: f64, cy: f64, r: f64) -> Vec<BoundaryEdge> {
        vec![
            arc_edge([cx, cy], r, 0.0, 180.0, true),
            arc_edge([cx, cy], r, 180.0, 360.0, true),
        ]
    }

    #[test]
    fn interior_probe_of_a_concave_loop_lands_inside_it() {
        // The C's centroid sits in its own mouth, outside the loop; the probe
        // must land somewhere the ray cast accepts as interior.
        let c = c_shape(10.0, 10.0, 2.0, 2.0);
        let centroid = loop_centroid(&c);
        assert!(
            !point_in_loop(centroid, &c, 1),
            "the centroid is in the mouth"
        );
        let probe = interior_probe(&c, 1).expect("a concave loop has an interior probe");
        assert!(
            point_in_loop(probe, &c, 1),
            "the probe verifies as interior"
        );
    }

    #[test]
    fn interior_probe_declines_degenerate_loops() {
        // Under 3 polygon points there is no interior to probe at all; a
        // zero-area collinear polygon has 3 points but no candidate the ray
        // cast accepts, so both fall back to the caller's centroid-only path.
        let single = poly(&[[0.0, 0.0]]);
        assert!(interior_probe(&single, 1).is_none());
        let collinear = poly(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]);
        assert_eq!(loop_signed_area(&collinear, 1), 0.0);
        assert!(interior_probe(&collinear, 1).is_none());
        // A poisoned coordinate must not seed a step either: the NaN-length
        // edge is skipped and no neighbour candidate verifies.
        let poisoned = poly(&[[0.0, 0.0], [1.0, 0.0], [1.0, f64::NAN]]);
        assert!(interior_probe(&poisoned, 1).is_none());
    }

    #[test]
    fn subdivide_keeps_a_nested_loop_whose_centroid_sits_in_its_own_notch() {
        // Nested C shapes: the small C's material is inside the big C, but its
        // centroid falls in the small C's own mouth, which is also inside the
        // big C's mouth, so the old centroid-only test dropped the hole.
        let big = c_shape(10.0, 11.0, 4.0, 2.0);
        let small = c_shape(10.0, 10.0, 2.0, 2.0);
        let sub = subdivide_loops(&[big, small]);
        assert_eq!(sub, vec![(0, vec![1]), (1, vec![])]);

        // The nested U pair is the same failure with a U instead of a C.
        let outer_u = poly(&[
            [0.0, 0.0],
            [0.0, 12.0],
            [10.0, 12.0],
            [10.0, 0.0],
            [8.0, 0.0],
            [8.0, 10.0],
            [2.0, 10.0],
            [2.0, 0.0],
        ]);
        let inner_u = poly(&[
            [1.0, 1.0],
            [1.0, 11.0],
            [9.0, 11.0],
            [9.0, 1.0],
            [8.5, 1.0],
            [8.5, 10.5],
            [1.5, 10.5],
            [1.5, 1.0],
        ]);
        let sub = subdivide_loops(&[outer_u, inner_u]);
        assert_eq!(sub, vec![(0, vec![1]), (1, vec![])]);
    }

    #[test]
    fn a_circle_in_the_notch_of_a_c_is_not_a_hole_of_it() {
        // The C's centroid is in its mouth, where the circle sits; the circle
        // is genuinely outside the C, so no containment may be invented for
        // it. Nested C's still nest, the circle stays its own face.
        let big = c_shape(10.0, 11.0, 4.0, 2.0);
        let small = c_shape(10.0, 10.0, 2.0, 2.0);
        let circle = circle_loop(6.0, 5.0, 1.0);
        let sub = subdivide_loops(&[big, small, circle]);
        assert_eq!(sub, vec![(0, vec![1]), (1, vec![]), (2, vec![])]);
    }

    #[test]
    fn subdivide_concentric_loops_nest_by_area() {
        // Equal centroids cannot be told apart by a point test, so the strict
        // area comparison is what decides: the larger holds the smaller, and
        // two identical loops are two independent faces.
        let outer = rect(0.0, 0.0, 10.0, 10.0);
        let inner = rect(3.0, 3.0, 7.0, 7.0);
        let sub = subdivide_loops(&[outer.clone(), inner]);
        assert_eq!(sub, vec![(0, vec![1]), (1, vec![])]);
        let twin = rect(0.0, 0.0, 10.0, 10.0);
        let sub = subdivide_loops(&[outer, twin]);
        assert_eq!(sub, vec![(0, vec![]), (1, vec![])]);
    }

    fn arc_edge(center: Vec2, radius: f64, a0: f64, a1: f64, ccw: bool) -> BoundaryEdge {
        let at = |deg: f64| {
            let a = radians(deg);
            [center[0] + radius * a.cos(), center[1] + radius * a.sin()]
        };
        BoundaryEdge {
            geom: EdgeGeom::Arc {
                center,
                radius,
                angle_start_deg: a0,
                angle_end_deg: a1,
                ccw,
                start: at(a0),
                end: at(a1),
            },
            id: None,
            start_vertex: None,
            end_vertex: None,
        }
    }

    #[test]
    fn loop_pts_samples_an_arc_from_its_start_between_the_endpoints() {
        // The edge's own start point is emitted first, then `arc_samples`
        // interior points strictly inside the sweep; the end point is left for
        // the next edge, so it is not among them.
        let pts = loop_pts(&[arc_edge([0.0, 0.0], 2.0, 0.0, 90.0, true)], 4);
        assert_eq!(pts.len(), 5);
        assert!(
            (pts[0][0] - 2.0).abs() < 1e-12 && pts[0][1].abs() < 1e-12,
            "first point should be the arc start: {:?}",
            pts[0]
        );

        let last = *pts.last().unwrap();
        let want = [
            2.0 * (72.0_f64.to_radians()).cos(),
            2.0 * (72.0_f64.to_radians()).sin(),
        ];
        assert!(
            (last[0] - want[0]).abs() < 1e-12 && (last[1] - want[1]).abs() < 1e-12,
            "last interior sample should sit at 4/5 of the sweep: {last:?}"
        );
        for p in &pts[1..] {
            assert!(
                p[0] > 0.0 && p[1] > 0.0,
                "sample off the first quadrant: {p:?}"
            );
        }
    }

    #[test]
    fn loop_pts_samples_a_cw_arc_towards_its_end_angle() {
        // A CW side sweeps towards its end angle (here 0 -> 90 is the long way
        // round, 270 degrees), so the interior samples follow the traversal:
        // 54, 108, 162 and 216 degrees below the start. Swapping the angles
        // instead sampled the same arc in reverse and the loop polygon grew a
        // chord across it, which read a hole region inside a face that only
        // touches it.
        let pts = loop_pts(&[arc_edge([0.0, 0.0], 1.0, 0.0, 90.0, false)], 4);
        assert_eq!(pts.len(), 5);
        let want = |deg: f64| [deg.to_radians().cos(), deg.to_radians().sin()];
        for (k, deg) in [-54.0, -108.0, -162.0, -216.0].iter().enumerate() {
            let w = want(*deg);
            assert!(
                (pts[k + 1][0] - w[0]).abs() < 1e-12 && (pts[k + 1][1] - w[1]).abs() < 1e-12,
                "sample {k} should sit at {deg} degrees: {:?}",
                pts[k + 1]
            );
        }
    }

    #[test]
    fn loop_pts_keeps_a_stored_360_degree_arc_as_a_full_turn() {
        // The modulo sweep would read 2*pi as 0 and collapse every sample onto
        // the start; a full turn must still sample around the circle.
        let pts = loop_pts(&[arc_edge([0.0, 0.0], 1.0, 0.0, 360.0, true)], 3);
        assert_eq!(pts.len(), 4);
        let quadrants = [90.0_f64, 180.0, 270.0];
        for (k, deg) in quadrants.iter().enumerate() {
            let w = [deg.to_radians().cos(), deg.to_radians().sin()];
            assert!(
                (pts[k + 1][0] - w[0]).abs() < 1e-12 && (pts[k + 1][1] - w[1]).abs() < 1e-12,
                "sample {k} should sit at {deg} degrees: {:?}",
                pts[k + 1]
            );
        }
    }

    #[test]
    fn loop_pts_samples_a_full_ellipse_on_the_curve() {
        // A standalone full ellipse carries no start point and ignores the
        // coarse arc count: it uses at least 16 samples so it reads as a
        // polygon on its own.
        let e = BoundaryEdge {
            geom: EdgeGeom::Ellipse {
                center: [1.0, 2.0],
                a: 4.0,
                b: 2.0,
                theta: 0.0,
            },
            id: None,
            start_vertex: None,
            end_vertex: None,
        };
        let pts = loop_pts(&[e], 2);
        assert!(
            pts.len() >= 16,
            "a full ellipse needs a readable sample count"
        );
        for p in &pts {
            let u = p[0] - 1.0;
            let v = p[1] - 2.0;
            let on_curve = u * u / 16.0 + v * v / 4.0;
            assert!(
                (on_curve - 1.0).abs() < 1e-12,
                "point off the ellipse: {p:?}"
            );
        }
    }

    #[test]
    fn the_arc_sample_count_reaches_area_and_containment() {
        // A 2-sample chord polygon of a circle reads much smaller than the
        // circle; the fine count is what the TS classifier measures with, so the
        // argument has to reach the area and the point test, not just loop_pts.
        let circle = circle_loop(0.0, 0.0, 10.0);
        let coarse = loop_signed_area(&circle, 1).abs();
        let fine = loop_signed_area(&circle, CENTROID_ARC_SAMPLES).abs();
        assert!(fine > coarse, "coarse {coarse}, fine {fine}");
        assert!((fine - std::f64::consts::PI * 100.0).abs() < 2.0);
        // A point just inside the true rim on a diagonal is outside the coarse
        // axis-aligned diamond the 1-sample polygon builds.
        let rim = [7.0, 7.0];
        assert!(!point_in_loop(rim, &circle, 1));
        assert!(point_in_loop(rim, &circle, CENTROID_ARC_SAMPLES));
    }

    #[test]
    fn the_explicit_start_of_a_wire_edge_wins_over_its_first_pole() {
        // A fit spline whose joint was snapped carries a dict start off its
        // first pole; the polygon reader pushed the dict start, and the wire
        // edge has to reproduce that or a snapped joint moves the polygon. A
        // wire edge with no start pushes nothing at all (the TS dict lacked the
        // key), even though the geometry's first pole exists.
        let geom = EdgeGeom::FitSpline {
            poles: vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]],
            knots: vec![0.0, 3.0],
        };
        let hinted = LoopEdge {
            geom: geom.clone(),
            start: Some([0.000004, 0.0]),
        };
        let plain = LoopEdge { geom, start: None };
        assert_eq!(loop_pts(&[hinted], 1)[0], [0.000004, 0.0]);
        let plain_pts = loop_pts(&[plain], 1);
        assert_eq!(plain_pts.len(), 8, "no start push: only the 8 fit samples");
        assert!((plain_pts[0][0] - 1.0 / 3.0).abs() < 1e-12);
    }
}
