//! Profile-loop helpers: the topology slice of the loop machinery that also
//! lives (for SVG/3D consumers) in `frontend/src/kernel/profileLoops.ts`:
//! arc/spline/ellipse sampling, the
//! polygon point list, containment nesting, signed area and area-weighted
//! centroid. Only what the slice topology needs is ported.
//!
//! `EdgeGeom`/`BoundaryEdge` are the loop-edge vocabulary the whole pipeline
//! shares: `dcel` builds them, this module samples them.

use super::curve_split::bezier_point;
use super::TOL_NEAR_ZERO_AREA;
use crate::radians;

pub type Vec2 = [f64; 2];

const CENTROID_ARC_SAMPLES: usize = 64;

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
        match *self {
            EdgeGeom::Line { start, .. }
            | EdgeGeom::Arc { start, .. }
            | EdgeGeom::EllipseArc { start, .. }
            | EdgeGeom::Spline { start, .. } => Some(start),
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

/// n interior points spread along an arc edge (n>=1); empty if not an arc.
fn arc_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
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
        let mut a0 = radians(angle_start_deg);
        let mut a1 = radians(angle_end_deg);
        if !ccw {
            std::mem::swap(&mut a0, &mut a1);
        }
        if a1 < a0 {
            a1 += 2.0 * std::f64::consts::PI;
        }
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            let a = a0 + (a1 - a0) * (k as f64 + 1.0) / (n as f64 + 1.0);
            out.push([cx + radius * a.cos(), cy + radius * a.sin()]);
        }
        out
    } else {
        vec![]
    }
}

/// n interior points along a cubic-Bezier spline edge; empty if not one.
fn spline_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
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

/// n interior points along an elliptical-arc edge; empty if not one.
fn ellipse_arc_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
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
fn ellipse_sample_points(e: &EdgeGeom, n: usize) -> Vec<Vec2> {
    if let EdgeGeom::Ellipse { center, a, b, theta } = *e {
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
pub fn loop_pts(loop_edges: &[BoundaryEdge], arc_samples: usize) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    for be in loop_edges {
        let e = &be.geom;
        if let Some(s) = e.start() {
            pts.push(s);
        }
        pts.extend(arc_sample_points(e, arc_samples));
        pts.extend(ellipse_arc_sample_points(e, arc_samples.max(4)));
        // A self-closing spline (start == end) is a standalone closed loop, so it
        // needs enough points to read as a polygon on its own, like a full ellipse.
        let spline_n = if spline_is_closed(e) {
            (arc_samples * 4).max(16)
        } else {
            arc_samples
        };
        pts.extend(spline_sample_points(e, spline_n));
        // A full ellipse is a standalone closed loop: enough points to read as a
        // polygon on its own, independent of the coarse arc sample count.
        pts.extend(ellipse_sample_points(e, (arc_samples * 4).max(16)));
    }
    pts
}

/// Signed 2D area via the shoelace formula. Positive = CCW.
pub fn loop_signed_area(loop_edges: &[BoundaryEdge]) -> f64 {
    let pts = loop_pts(loop_edges, 1);
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

/// Ray-casting point-in-polygon test against a 2D loop.
pub fn point_in_loop(pt: Vec2, loop_edges: &[BoundaryEdge]) -> bool {
    let x = pt[0];
    let y = pt[1];
    let pts = loop_pts(loop_edges, 1);
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

/// Area-weighted centroid of a 2D loop polygon.
pub fn loop_centroid(loop_edges: &[BoundaryEdge]) -> Vec2 {
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

/// For each loop: its immediate `container` (the smallest strictly larger loop
/// that encloses it, or `None`). The `depth` count is also returned for the
/// even/odd `classify_loops` model.
fn loop_containment(loops: &[Vec<BoundaryEdge>]) -> (Vec<usize>, Vec<Option<usize>>) {
    let n = loops.len();
    let areas: Vec<f64> = loops.iter().map(|l| loop_signed_area(l).abs()).collect();
    let cents: Vec<Vec2> = loops.iter().map(|l| loop_centroid(l)).collect();

    let mut depth = vec![0usize; n];
    let mut container: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        let mut best_area = f64::INFINITY;
        for j in 0..n {
            if i == j {
                continue;
            }
            if areas[j] > areas[i] && point_in_loop(cents[i], &loops[j]) {
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

/// Planar subdivision: every loop bounds its own face whose holes are the loops
/// immediately nested inside it. Returns, per loop index `oi`, the indices of the
/// loops whose immediate container is `oi`. The sketch-area model: every visible
/// region is selectable (unlike the even/odd donut `classify_loops`).
pub fn subdivide_loops(loops: &[Vec<BoundaryEdge>]) -> Vec<(usize, Vec<usize>)> {
    if loops.is_empty() {
        return vec![];
    }
    if loops.len() == 1 {
        return vec![(0, vec![])];
    }
    let n = loops.len();
    let (_depth, container) = loop_containment(loops);
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
    fn signed_area_ccw_positive() {
        assert!((loop_signed_area(&rect(0.0, 0.0, 2.0, 3.0)) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn centroid_of_rect() {
        let c = loop_centroid(&rect(0.0, 0.0, 2.0, 2.0));
        assert!((c[0] - 1.0).abs() < 1e-9 && (c[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn point_in_loop_inside_and_outside() {
        let r = rect(0.0, 0.0, 2.0, 2.0);
        assert!(point_in_loop([1.0, 1.0], &r));
        assert!(!point_in_loop([3.0, 1.0], &r));
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
}
