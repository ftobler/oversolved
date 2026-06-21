//! Post-solve surface detection — Rust port of the geometry pipeline in
//! `frontend/src/kernel/topology.ts` (`detectTopology`). Pairwise intersections
//! -> entity splitting -> planar half-edge DCEL -> face-cycle traversal -> CCW
//! bounded surfaces, plus standalone closed loops and hole nesting.
//!
//! This port stops at GEOMETRY. It emits a structural `TopologyOut` tagging each
//! edge/surface with its source entity id(s) and a deterministic index; it does
//! NOT build ancestry query strings or line-division classifiers. Those stay in
//! TypeScript (`query.ts`, `attachLineDivisionClassifiers`), driven by this output.
//!
//! Float-parity notes carried from the TS source: Python/JS float modulo takes
//! the sign of the divisor (`pymod`); angle wrapping and sort tie-breaks must
//! match exactly because vertex-merge order and surface/edge indices feed the
//! strings the TS decorator builds.

use std::collections::{HashMap, HashSet};

use super::curve_intersect::{intersect_curves, Curve};
use super::curve_split::{ellipse_point_at, subdivide_bezier, BezierCtrl};
use super::profile_loops::{subdivide_loops, BoundaryEdge, EdgeGeom, Vec2};
use super::{TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE, TOL_TOPOLOGY_SPLIT as SPLIT_EPS};

const TWO_PI: f64 = 2.0 * std::f64::consts::PI;

// Near-tangency collapse: two curves that the solver tried to make tangent leave
// a contact whose two analytic intersection points sit `2h` apart and tend to a
// single point as `h -> 0`. Exact tangency (`h == 0`) never survives floating
// point, so we DEFINE the contact at the foot point whenever the two roots are
// within `TANGENT_COLLAPSE_REL * r_min` of coinciding. The real picture is
// 0-or-2 intersections; asserting the one foot is the "virtual tangent point"
// that collapses the numerical ambiguity into a singular truth the area builder
// can lean on -- a tangent pair then stays two clean standalone faces instead of
// being sliced by a phantom sliver arc. The threshold is on the point separation
// (not the centre-distance gap, which the sqrt amplifies) and relative to the
// smaller radius so it tracks model scale and clears the solver's converged
// tangent residual by orders of magnitude while never merging a real crossing.
const TANGENT_COLLAPSE_REL: f64 = 1e-3;

// ─── Input geometry (the enriched richGeom dict, classified like classifyEntities) ───

/// One sketch entity's solved+enriched geometry, mirroring the stringly-typed
/// `richGeom` dict `enrichSketchEntity` produces. Optional fields match exactly
/// which keys each kind carries, so `classify` reproduces `classifyEntities`.
#[derive(Clone, Debug, Default)]
pub struct InputEntity {
    pub kind: Option<String>,
    pub construction: bool,
    pub start: Option<Vec2>,
    pub end: Option<Vec2>,
    pub center: Option<Vec2>,
    pub radius: Option<f64>,
    pub angle_start: Option<f64>,
    pub angle_end: Option<f64>,
    pub a: Option<f64>,
    pub b: Option<f64>,
    pub theta: Option<f64>,
    pub c1: Option<Vec2>,
    pub c2: Option<Vec2>,
}

// ─── Output (structural; no query strings) ───

#[derive(Clone, Debug)]
pub struct EdgeOut {
    pub entity_id: String,
    pub edge_index: usize,
    pub edge_type: &'static str, // "straightedge" | "edge"
    pub geom: EdgeGeom,
}

#[derive(Clone, Debug)]
pub struct SurfaceOut {
    pub boundary: Vec<BoundaryEdge>,
    /// Source entity ids feeding this surface's ancestry query, in the
    /// pre-`emitWire`/pre-sort multiplicity the TS path uses (cycle order for a
    /// DCEL face; a single id for a standalone loop).
    pub face_entity_ids: Vec<String>,
    pub holes: Vec<Vec<BoundaryEdge>>,
}

#[derive(Clone, Debug)]
pub struct TopologyOut {
    pub intersection_points: Vec<(String, Vec2)>,
    pub vertices: Vec<(String, Vec2)>,
    pub edges: Vec<EdgeOut>,
    pub surfaces: Vec<SurfaceOut>,
}

// ─── small helpers ───

fn radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}
fn degrees(rad: f64) -> f64 {
    rad * 180.0 / std::f64::consts::PI
}
/// Python float modulo (result takes the sign of the divisor).
fn pymod(a: f64, b: f64) -> f64 {
    ((a % b) + b) % b
}

fn angle_in_arc(a_rad: f64, start_deg: f64, end_deg: f64) -> bool {
    let s = pymod(radians(start_deg), TWO_PI);
    let e = pymod(radians(end_deg), TWO_PI);
    let a = pymod(a_rad, TWO_PI);
    if (s - e).abs() < EPS || (s - e).abs() > TWO_PI - EPS {
        return true;
    }
    if s < e {
        s - EPS <= a && a <= e + EPS
    } else {
        a >= s - EPS || a <= e + EPS
    }
}

fn arc_tangent(a_rad: f64, ccw: bool) -> Vec2 {
    let s = if ccw { 1.0 } else { -1.0 };
    [-s * a_rad.sin(), s * a_rad.cos()]
}

// ─── Vertex registry ───

struct Verts {
    map: HashMap<String, Vec2>,
}
impl Verts {
    fn new() -> Self {
        Verts { map: HashMap::new() }
    }
    fn clone_verts(&self) -> Verts {
        Verts {
            map: self.map.clone(),
        }
    }
    /// Merge a point into the pool, returning its `_vN` id (mirrors `vid`).
    fn vid(&mut self, pt: Vec2) -> String {
        for (k, v) in &self.map {
            if (v[0] - pt[0]).powi(2) + (v[1] - pt[1]).powi(2) < MERGE * MERGE {
                return k.clone();
            }
        }
        let k = format!("_v{}", self.map.len());
        self.map.insert(k.clone(), [pt[0], pt[1]]);
        k
    }
    fn get(&self, k: &str) -> Vec2 {
        self.map.get(k).copied().unwrap_or_else(|| panic!("vertex {k} not found"))
    }
    fn keys(&self) -> HashSet<String> {
        self.map.keys().cloned().collect()
    }
}

type Split = (f64, String);

fn has_param(spl: &[Split], p: f64) -> bool {
    spl.iter().any(|(s, _)| (s - p).abs() < SPLIT_EPS)
}

fn norm_arc_param(mut p: f64, a0: f64) -> f64 {
    while p < a0 - SPLIT_EPS {
        p += TWO_PI;
    }
    while p >= a0 + TWO_PI - SPLIT_EPS {
        p -= TWO_PI;
    }
    p
}

/// Sort splits by (param, vid), drop consecutive near-equal params.
fn dedup(spl: &[Split]) -> Vec<Split> {
    if spl.is_empty() {
        return vec![];
    }
    let mut sorted: Vec<Split> = spl.to_vec();
    sorted.sort_by(|x, y| {
        if x.0 != y.0 {
            x.0.partial_cmp(&y.0).unwrap()
        } else {
            x.1.cmp(&y.1)
        }
    });
    let mut out: Vec<Split> = vec![sorted[0].clone()];
    for s in &sorted[1..] {
        if (s.0 - out.last().unwrap().0).abs() > SPLIT_EPS {
            out.push(s.clone());
        }
    }
    out
}

// ─── Intersection primitives ───

fn ll(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2) -> Option<(f64, f64, Vec2)> {
    let dx1 = p2[0] - p1[0];
    let dy1 = p2[1] - p1[1];
    let dx2 = p4[0] - p3[0];
    let dy2 = p4[1] - p3[1];
    let det = dx1 * dy2 - dy1 * dx2;
    if det.abs() < EPS {
        return None;
    }
    let dx3 = p3[0] - p1[0];
    let dy3 = p3[1] - p1[1];
    let mut t = (dx3 * dy2 - dy3 * dx2) / det;
    let mut u = (dx3 * dy1 - dy3 * dx1) / det;
    if !(-EPS..=1.0 + EPS).contains(&t) || !(-EPS..=1.0 + EPS).contains(&u) {
        return None;
    }
    t = t.clamp(0.0, 1.0);
    u = u.clamp(0.0, 1.0);
    Some((t, u, [p1[0] + t * dx1, p1[1] + t * dy1]))
}

fn lc(p1: Vec2, p2: Vec2, cx: f64, cy: f64, r: f64) -> Vec<(f64, f64, Vec2)> {
    let dx = p2[0] - p1[0];
    let dy = p2[1] - p1[1];
    let fx = p1[0] - cx;
    let fy = p1[1] - cy;
    let a = dx * dx + dy * dy;
    if a < EPS {
        return vec![];
    }
    let b = 2.0 * (fx * dx + fy * dy);
    let c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return vec![];
    }
    let sd = disc.max(0.0).sqrt();
    let mut out = Vec::new();
    let mut seen: Vec<f64> = Vec::new();
    for sign in [-1.0, 1.0] {
        let raw = (-b + sign * sd) / (2.0 * a);
        if !(-EPS..=1.0 + EPS).contains(&raw) {
            continue;
        }
        let t = raw.clamp(0.0, 1.0);
        let key = (t * 1e7).round() / 1e7;
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let ix = p1[0] + t * dx;
        let iy = p1[1] + t * dy;
        out.push((t, (iy - cy).atan2(ix - cx), [ix, iy]));
    }
    out
}

fn cc(cx1: f64, cy1: f64, r1: f64, cx2: f64, cy2: f64, r2: f64) -> Vec<(f64, f64, Vec2)> {
    let d = (cx2 - cx1).hypot(cy2 - cy1);
    if d < EPS || d > r1 + r2 + EPS || d < (r1 - r2).abs() - EPS {
        return vec![];
    }
    let a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    let h2 = r1 * r1 - a * a;
    if h2 < 0.0 {
        return vec![];
    }
    let h = h2.max(0.0).sqrt();
    let mx = cx1 + (a * (cx2 - cx1)) / d;
    let my = cy1 + (a * (cy2 - cy1)) / d;
    // Virtual tangent point: when the two roots are within tolerance of
    // coinciding, define the single contact at the foot [mx, my] (the exact
    // tangent point in the h == 0 limit) instead of emitting two near-duplicate
    // intersections that would slice both curves at a phantom sliver.
    if h <= TANGENT_COLLAPSE_REL * r1.min(r2).max(EPS) {
        return vec![(
            (my - cy1).atan2(mx - cx1),
            (my - cy2).atan2(mx - cx2),
            [mx, my],
        )];
    }
    let ox = (h * (cy2 - cy1)) / d;
    let oy = (h * (cx2 - cx1)) / d;
    let pts: Vec<Vec2> = vec![[mx + ox, my - oy], [mx - ox, my + oy]];
    pts.into_iter()
        .map(|[sx, sy]| {
            (
                (sy - cy1).atan2(sx - cx1),
                (sy - cy2).atan2(sx - cx2),
                [sx, sy],
            )
        })
        .collect()
}

fn collinear_overlap(ea: &InputEntity, eb: &InputEntity) -> Vec<(f64, f64, Vec2)> {
    let p1 = ea.start.unwrap();
    let p2 = ea.end.unwrap();
    let q1 = eb.start.unwrap();
    let q2 = eb.end.unwrap();

    let dx1 = p2[0] - p1[0];
    let dy1 = p2[1] - p1[1];
    let dx2 = q2[0] - q1[0];
    let dy2 = q2[1] - q1[1];

    if (dx1 * dy2 - dy1 * dx2).abs() > EPS {
        return vec![];
    }
    let pos_cross = dx1 * (q1[1] - p1[1]) - dy1 * (q1[0] - p1[0]);
    if pos_cross.abs() > EPS {
        return vec![];
    }
    let len1sq = dx1 * dx1 + dy1 * dy1;
    if len1sq < EPS {
        return vec![];
    }
    let proj_a = |pt: Vec2| ((pt[0] - p1[0]) * dx1 + (pt[1] - p1[1]) * dy1) / len1sq;
    let len2sq = dx2 * dx2 + dy2 * dy2;
    if len2sq < EPS {
        return vec![];
    }
    let proj_b = |pt: Vec2| ((pt[0] - q1[0]) * dx2 + (pt[1] - q1[1]) * dy2) / len2sq;

    let mut tb0 = proj_a(q1);
    let mut tb1 = proj_a(q2);
    if tb0 > tb1 {
        std::mem::swap(&mut tb0, &mut tb1);
    }
    let lo = tb0.max(0.0);
    let hi = tb1.min(1.0);
    if hi - lo < SPLIT_EPS {
        return vec![];
    }

    let mut result = Vec::new();
    for pt in [q1, q2] {
        let t_a = proj_a(pt);
        if t_a > SPLIT_EPS && t_a < 1.0 - SPLIT_EPS {
            result.push((t_a, proj_b(pt), pt));
        }
    }
    for pt in [p1, p2] {
        let tb = proj_b(pt);
        if tb > SPLIT_EPS && tb < 1.0 - SPLIT_EPS {
            result.push((proj_a(pt), tb, pt));
        }
    }
    result
}

/// Pairwise intersection dispatch (line/circle/arc only), mirroring `intersect`.
fn intersect(
    eid_a: &str,
    ea: &InputEntity,
    eid_b: &str,
    eb: &InputEntity,
    line_keys: &HashSet<String>,
    circle_keys: &HashSet<String>,
) -> Vec<(f64, f64, Vec2)> {
    let class = |eid: &str| -> char {
        if line_keys.contains(eid) {
            'l'
        } else if circle_keys.contains(eid) {
            'c'
        } else {
            'a'
        }
    };
    let ta = class(eid_a);
    let tb = class(eid_b);
    let ia = |e: &InputEntity, ang: f64| angle_in_arc(ang, e.angle_start.unwrap(), e.angle_end.unwrap());

    match (ta, tb) {
        ('l', 'l') => ll(ea.start.unwrap(), ea.end.unwrap(), eb.start.unwrap(), eb.end.unwrap())
            .into_iter()
            .collect(),
        ('l', 'c') => lc(ea.start.unwrap(), ea.end.unwrap(), eb.center.unwrap()[0], eb.center.unwrap()[1], eb.radius.unwrap()),
        ('c', 'l') => lc(eb.start.unwrap(), eb.end.unwrap(), ea.center.unwrap()[0], ea.center.unwrap()[1], ea.radius.unwrap())
            .into_iter()
            .map(|(t, ang, pt)| (ang, t, pt))
            .collect(),
        ('l', 'a') => lc(ea.start.unwrap(), ea.end.unwrap(), eb.center.unwrap()[0], eb.center.unwrap()[1], eb.radius.unwrap())
            .into_iter()
            .filter(|(_, ang, _)| ia(eb, *ang))
            .collect(),
        ('a', 'l') => lc(eb.start.unwrap(), eb.end.unwrap(), ea.center.unwrap()[0], ea.center.unwrap()[1], ea.radius.unwrap())
            .into_iter()
            .filter(|(_, ang, _)| ia(ea, *ang))
            .map(|(t, ang, pt)| (ang, t, pt))
            .collect(),
        ('c', 'c') => cc_of(ea, eb),
        ('c', 'a') => cc_of(ea, eb).into_iter().filter(|(_, a2, _)| ia(eb, *a2)).collect(),
        ('a', 'c') => cc_of(ea, eb).into_iter().filter(|(a1, _, _)| ia(ea, *a1)).collect(),
        ('a', 'a') => cc_of(ea, eb).into_iter().filter(|(a1, a2, _)| ia(ea, *a1) && ia(eb, *a2)).collect(),
        _ => vec![],
    }
}

fn cc_of(ea: &InputEntity, eb: &InputEntity) -> Vec<(f64, f64, Vec2)> {
    cc(
        ea.center.unwrap()[0],
        ea.center.unwrap()[1],
        ea.radius.unwrap(),
        eb.center.unwrap()[0],
        eb.center.unwrap()[1],
        eb.radius.unwrap(),
    )
}

// ─── Half-edge geometry constructors ───

fn line_eg(e: &InputEntity, t0: f64, t1: f64) -> EdgeGeom {
    let p1 = e.start.unwrap();
    let p2 = e.end.unwrap();
    EdgeGeom::Line {
        start: [p1[0] + t0 * (p2[0] - p1[0]), p1[1] + t0 * (p2[1] - p1[1])],
        end: [p1[0] + t1 * (p2[0] - p1[0]), p1[1] + t1 * (p2[1] - p1[1])],
    }
}

fn arc_eg(e: &InputEntity, a0: f64, a1: f64, ccw: bool) -> EdgeGeom {
    let cx = e.center.unwrap()[0];
    let cy = e.center.unwrap()[1];
    let r = e.radius.unwrap();
    EdgeGeom::Arc {
        center: [cx, cy],
        radius: r,
        angle_start_deg: degrees(a0),
        angle_end_deg: degrees(a1),
        ccw,
        start: [cx + r * a0.cos(), cy + r * a0.sin()],
        end: [cx + r * a1.cos(), cy + r * a1.sin()],
    }
}

fn bezier_point(p1: Vec2, c1: Vec2, c2: Vec2, p4: Vec2, t: f64) -> Vec2 {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let c = 3.0 * mt * t * t;
    let d = t * t * t;
    [
        a * p1[0] + b * c1[0] + c * c2[0] + d * p4[0],
        a * p1[1] + b * c1[1] + c * c2[1] + d * p4[1],
    ]
}

fn spline_eg(e: &InputEntity) -> EdgeGeom {
    EdgeGeom::Spline {
        start: e.start.unwrap(),
        end: e.end.unwrap(),
        c1: e.c1.unwrap(),
        c2: e.c2.unwrap(),
    }
}

fn sub_spline_eg(ctrl: &BezierCtrl) -> EdgeGeom {
    EdgeGeom::Spline {
        start: ctrl[0],
        c1: ctrl[1],
        c2: ctrl[2],
        end: ctrl[3],
    }
}

fn ellipse_arc_eg(e: &InputEntity, phi0: f64, phi1: f64, ccw: bool) -> EdgeGeom {
    let c = e.center.unwrap();
    let a = e.a.unwrap();
    let b = e.b.unwrap();
    let theta = e.theta.unwrap_or(0.0);
    EdgeGeom::EllipseArc {
        center: [c[0], c[1]],
        a,
        b,
        theta,
        angle_start_deg: degrees(phi0),
        angle_end_deg: degrees(phi1),
        ccw,
        start: ellipse_point_at([c[0], c[1]], a, b, theta, phi0),
        end: ellipse_point_at([c[0], c[1]], a, b, theta, phi1),
    }
}

fn rev(eg: &EdgeGeom) -> EdgeGeom {
    match *eg {
        EdgeGeom::Line { start, end } => EdgeGeom::Line { start: end, end: start },
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
        EdgeGeom::Ellipse { .. } => eg.clone(),
    }
}

fn depart(eg: &EdgeGeom) -> f64 {
    match *eg {
        EdgeGeom::Line { start, end } => (end[1] - start[1]).atan2(end[0] - start[0]),
        EdgeGeom::Spline { start, c1, end, .. } => {
            let mut dx = c1[0] - start[0];
            let mut dy = c1[1] - start[1];
            if dx.abs() < EPS && dy.abs() < EPS {
                dx = end[0] - start[0];
                dy = end[1] - start[1];
            }
            dy.atan2(dx)
        }
        EdgeGeom::EllipseArc {
            a,
            b,
            theta,
            angle_start_deg,
            ccw,
            ..
        } => {
            let th = radians(theta);
            let phi = radians(angle_start_deg);
            let s = if ccw { 1.0 } else { -1.0 };
            let dx = -a * phi.sin() * s;
            let dy = b * phi.cos() * s;
            (dx * th.sin() + dy * th.cos()).atan2(dx * th.cos() - dy * th.sin())
        }
        EdgeGeom::Arc {
            angle_start_deg, ccw, ..
        } => {
            let a = radians(angle_start_deg);
            let [tx, ty] = arc_tangent(a, ccw);
            ty.atan2(tx)
        }
        EdgeGeom::Ellipse { .. } => 0.0, // full ellipse never enters the half-edge graph
    }
}

/// Signed curvature (left turn positive) at the departure end of a half-edge, in
/// its stored traversal direction. Used only to break angular ties at a vertex
/// where two edges leave along the same tangent (a tangency cusp): the edge that
/// bends right is infinitesimally "before" the one that bends left, so ordering
/// ascending by (depart angle, bend) puts them in the geometrically correct CCW
/// order that pure first-derivative angle cannot resolve.
fn bend(eg: &EdgeGeom) -> f64 {
    match *eg {
        EdgeGeom::Line { .. } | EdgeGeom::Ellipse { .. } => 0.0,
        EdgeGeom::Arc { radius, ccw, .. } => {
            let s = if ccw { 1.0 } else { -1.0 };
            s / radius
        }
        EdgeGeom::EllipseArc {
            a, b, angle_start_deg, ccw, ..
        } => {
            // Curvature is rotation-invariant, so evaluate in the unrotated frame.
            let phi = radians(angle_start_deg);
            let s = if ccw { 1.0 } else { -1.0 };
            let dx = a * phi.sin();
            let dy = b * phi.cos();
            let speed2 = dx * dx + dy * dy;
            if speed2 < EPS {
                return 0.0;
            }
            s * a * b / speed2.powf(1.5)
        }
        EdgeGeom::Spline { start, c1, c2, .. } => {
            let d1 = [3.0 * (c1[0] - start[0]), 3.0 * (c1[1] - start[1])];
            let d2 = [
                6.0 * (start[0] - 2.0 * c1[0] + c2[0]),
                6.0 * (start[1] - 2.0 * c1[1] + c2[1]),
            ];
            let speed2 = d1[0] * d1[0] + d1[1] * d1[1];
            if speed2 < EPS {
                return 0.0; // degenerate tangent: no curvature signal to tie-break on
            }
            (d1[0] * d2[1] - d1[1] * d2[0]) / speed2.powf(1.5)
        }
    }
}

type HalfEdge = (String, String, EdgeGeom);

fn face_area(cycle: &[usize], hes: &[HalfEdge], verts: &Verts) -> f64 {
    let mut pts: Vec<Vec2> = Vec::new();
    for &i in cycle {
        let (vf, _, eg) = &hes[i];
        pts.push(verts.get(vf));
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
                for k in 1..8 {
                    pts.push(ellipse_point_at([center[0], center[1]], a, b, theta, p0 + (p1 - p0) * k as f64 / 8.0));
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

// ─── Classification ───

#[derive(Default)]
struct Classified {
    lines: Vec<(String, InputEntity)>,
    circles: Vec<(String, InputEntity)>,
    arcs: Vec<(String, InputEntity)>,
    splines: Vec<(String, InputEntity)>,
    ellipses: Vec<(String, InputEntity)>,
}

fn classify(geometry: &[(String, InputEntity)]) -> Classified {
    let mut c = Classified::default();
    for (eid, ent) in geometry {
        if ent.construction {
            continue;
        }
        let kind = ent.kind.as_deref();
        if kind == Some("spline") {
            c.splines.push((eid.clone(), ent.clone()));
        } else if kind == Some("ellipse") {
            c.ellipses.push((eid.clone(), ent.clone()));
        } else if ent.start.is_some() && ent.radius.is_some() {
            c.arcs.push((eid.clone(), ent.clone()));
        } else if ent.start.is_some() {
            c.lines.push((eid.clone(), ent.clone()));
        } else if ent.center.is_some() {
            c.circles.push((eid.clone(), ent.clone()));
        }
    }
    c
}

/// Normalize arcs (force CCW span <= pi by swapping endpoints) and seed splits.
#[allow(clippy::type_complexity)]
fn normalize_arcs_and_init_splits(
    arcs_in: &[(String, InputEntity)],
    arc_verts: &mut Verts,
) -> (HashMap<String, f64>, HashMap<String, Vec<Split>>, Vec<(String, InputEntity)>) {
    let mut arcs: Vec<(String, InputEntity)> = arcs_in.to_vec();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();

    for (_eid, e) in arcs.iter_mut() {
        let a0_rad = radians(e.angle_start.unwrap());
        let a1_rad = radians(e.angle_end.unwrap());
        let ccw_span = pymod(a1_rad - a0_rad, TWO_PI);
        if ccw_span > std::f64::consts::PI + EPS {
            let (as_, ae_) = (e.angle_end, e.angle_start);
            let (s_, en_) = (e.end, e.start);
            e.angle_start = as_;
            e.angle_end = ae_;
            e.start = s_;
            e.end = en_;
        }
    }

    for (eid, e) in &arcs {
        let a0 = radians(e.angle_start.unwrap());
        let a1 = norm_arc_param(radians(e.angle_end.unwrap()), a0);
        arc_a0.insert(eid.clone(), a0);
        splits.insert(
            eid.clone(),
            vec![(a0, arc_verts.vid(e.start.unwrap())), (a1, arc_verts.vid(e.end.unwrap()))],
        );
    }

    (arc_a0, splits, arcs)
}

#[allow(clippy::too_many_arguments)]
fn find_all_intersections(
    elist: &[(String, InputEntity)],
    line_keys: &HashSet<String>,
    circle_keys: &HashSet<String>,
    splits: &mut HashMap<String, Vec<Split>>,
    verts: &mut Verts,
    arc_a0: &HashMap<String, f64>,
) {
    for i in 0..elist.len() {
        let (eid_a, ea) = &elist[i];
        for (eid_b, eb) in elist.iter().skip(i + 1) {
            let mut results = intersect(eid_a, ea, eid_b, eb, line_keys, circle_keys);
            if results.is_empty() && line_keys.contains(eid_a) && line_keys.contains(eid_b) {
                results = collinear_overlap(ea, eb);
            }
            for (mut pa, mut pb, pt) in results {
                let v = verts.vid(pt);
                if let Some(a0) = arc_a0.get(eid_a) {
                    pa = norm_arc_param(pa, *a0);
                }
                if let Some(a0) = arc_a0.get(eid_b) {
                    pb = norm_arc_param(pb, *a0);
                }
                if !has_param(&splits[eid_a], pa) {
                    splits.get_mut(eid_a).unwrap().push((pa, v.clone()));
                }
                if !has_param(&splits[eid_b], pb) {
                    splits.get_mut(eid_b).unwrap().push((pb, v));
                }
            }
        }
    }
}

#[derive(Clone)]
struct Tagged {
    eid: String,
    e: InputEntity,
    kind: &'static str,
}

fn to_curve(kind: &str, e: &InputEntity) -> Curve {
    match kind {
        "line" => Curve::Line {
            p0: e.start.unwrap(),
            p1: e.end.unwrap(),
        },
        "circle" | "arc" => Curve::Circle {
            c: e.center.unwrap(),
            r: e.radius.unwrap(),
        },
        "ellipse" => Curve::Ellipse {
            c: e.center.unwrap(),
            a: e.a.unwrap(),
            b: e.b.unwrap(),
            theta: e.theta.unwrap_or(0.0),
        },
        _ => Curve::Bezier {
            p0: e.start.unwrap(),
            c1: e.c1.unwrap(),
            c2: e.c2.unwrap(),
            p3: e.end.unwrap(),
        },
    }
}

/// Register a curve-intersection hit param into the per-kind split convention.
fn register_hit(entry: &Tagged, t: f64, v: &str, splits: &mut HashMap<String, Vec<Split>>, arc_a0: &HashMap<String, f64>) {
    let spl = match splits.get_mut(&entry.eid) {
        Some(s) => s,
        None => return,
    };
    match entry.kind {
        "line" => {
            if !(-EPS..=1.0 + EPS).contains(&t) {
                return;
            }
            let tc = t.clamp(0.0, 1.0);
            if !has_param(spl, tc) {
                spl.push((tc, v.to_string()));
            }
        }
        "spline" => {
            if t <= SPLIT_EPS || t >= 1.0 - SPLIT_EPS {
                return; // endpoints already seeded
            }
            if !has_param(spl, t) {
                spl.push((t, v.to_string()));
            }
        }
        "circle" => {
            let a = if t > std::f64::consts::PI { t - TWO_PI } else { t };
            if !has_param(spl, a) {
                spl.push((a, v.to_string()));
            }
        }
        "ellipse" => {
            if !has_param(spl, t) {
                spl.push((t, v.to_string()));
            }
        }
        _ => {
            // arc: keep only hits within the arc span, normalized like the legacy pass.
            if !angle_in_arc(t, entry.e.angle_start.unwrap(), entry.e.angle_end.unwrap()) {
                return;
            }
            let p = norm_arc_param(t, *arc_a0.get(&entry.eid).unwrap_or(&0.0));
            if !has_param(spl, p) {
                spl.push((p, v.to_string()));
            }
        }
    }
}

fn add_curve_intersections(tagged: &[Tagged], splits: &mut HashMap<String, Vec<Split>>, verts: &mut Verts, arc_a0: &HashMap<String, f64>) {
    for i in 0..tagged.len() {
        for j in (i + 1)..tagged.len() {
            let a = &tagged[i];
            let b = &tagged[j];
            let involves_curve = a.kind == "ellipse" || a.kind == "spline" || b.kind == "ellipse" || b.kind == "spline";
            if !involves_curve {
                continue;
            }
            let hits = intersect_curves(&to_curve(a.kind, &a.e), &to_curve(b.kind, &b.e));
            for h in hits {
                let v = verts.vid(h.point);
                register_hit(a, h.t_a, &v, splits, arc_a0);
                register_hit(b, h.t_b, &v, splits, arc_a0);
            }
        }
    }
}

// Push one geometric edge as its two opposing half-edges (v0->v1 and v1->v0),
// tagging both with the owning entity id. Shared by every curve kind in
// build_half_edge_graph, which differ only in how they derive `eg`.
fn push_half_edge_pair(hes: &mut Vec<HalfEdge>, he_eid: &mut Vec<String>, eid: &str, v0: &str, v1: &str, eg: EdgeGeom) {
    let r = rev(&eg);
    hes.push((v0.to_string(), v1.to_string(), eg));
    hes.push((v1.to_string(), v0.to_string(), r));
    he_eid.push(eid.to_string());
    he_eid.push(eid.to_string());
}

#[allow(clippy::too_many_arguments)]
fn build_half_edge_graph(
    lines: &[(String, InputEntity)],
    circles: &[(String, InputEntity)],
    arcs: &[(String, InputEntity)],
    splits: &HashMap<String, Vec<Split>>,
    splines: &[(String, InputEntity)],
    ellipses: &[(String, InputEntity)],
) -> (Vec<HalfEdge>, Vec<String>) {
    let mut hes: Vec<HalfEdge> = Vec::new();
    let mut he_eid: Vec<String> = Vec::new();
    let mut seen_lines: HashSet<String> = HashSet::new();
    let empty: Vec<Split> = Vec::new();

    for (eid, e) in lines {
        let spl = dedup(splits.get(eid).unwrap_or(&empty));
        for k in 0..spl.len().saturating_sub(1) {
            let (t0, v0) = &spl[k];
            let (t1, v1) = &spl[k + 1];
            if v0 == v1 {
                continue;
            }
            let key = format!("{v0}\x00{v1}");
            let rkey = format!("{v1}\x00{v0}");
            if seen_lines.contains(&key) || seen_lines.contains(&rkey) {
                continue;
            }
            seen_lines.insert(key);
            seen_lines.insert(rkey);
            let eg = line_eg(e, *t0, *t1);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    for (eid, e) in arcs {
        let spl = dedup(splits.get(eid).unwrap_or(&empty));
        for k in 0..spl.len().saturating_sub(1) {
            let (a0, v0) = &spl[k];
            let (a1, v1) = &spl[k + 1];
            if v0 == v1 {
                continue;
            }
            let eg = arc_eg(e, *a0, *a1, true);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    // Circles and ellipses split the same way around a closed loop; only the
    // per-segment geometry constructor differs.
    let closed_arc_pass = |entities: &[(String, InputEntity)],
                           eg_fn: fn(&InputEntity, f64, f64, bool) -> EdgeGeom,
                           hes: &mut Vec<HalfEdge>,
                           he_eid: &mut Vec<String>| {
        for (eid, e) in entities {
            let spl = dedup(splits.get(eid).unwrap_or(&empty));
            if spl.len() < 2 {
                continue;
            }
            for k in 0..spl.len() {
                let (a0, v0) = &spl[k];
                let nxt = &spl[(k + 1) % spl.len()];
                let mut a1 = nxt.0;
                let v1 = &nxt.1;
                if v0 == v1 {
                    continue;
                }
                if a1 <= *a0 {
                    a1 += TWO_PI;
                }
                let eg = eg_fn(e, *a0, a1, true);
                push_half_edge_pair(hes, he_eid, eid, v0, v1, eg);
            }
        }
    };
    closed_arc_pass(circles, arc_eg, &mut hes, &mut he_eid);
    closed_arc_pass(ellipses, ellipse_arc_eg, &mut hes, &mut he_eid);

    for (eid, e) in splines {
        let spl = dedup(splits.get(eid).unwrap_or(&empty));
        if spl.len() < 2 {
            continue;
        }
        let ctrl: BezierCtrl = [e.start.unwrap(), e.c1.unwrap(), e.c2.unwrap(), e.end.unwrap()];
        for k in 0..spl.len().saturating_sub(1) {
            let (t0, v0) = &spl[k];
            let (t1, v1) = &spl[k + 1];
            if v0 == v1 || t1 <= t0 {
                continue;
            }
            let eg = if *t0 <= 0.0 && *t1 >= 1.0 {
                spline_eg(e)
            } else {
                sub_spline_eg(&subdivide_bezier(&ctrl, *t0, *t1))
            };
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    (hes, he_eid)
}

fn boundary_edge(eg: &EdgeGeom, id: &str, v0: &str, v1: &str) -> BoundaryEdge {
    BoundaryEdge {
        geom: eg.clone(),
        id: Some(id.to_string()),
        start_vertex: Some(v0.to_string()),
        end_vertex: Some(v1.to_string()),
    }
}

fn trace_face_cycles(hes: &[HalfEdge], he_eid: &[String], verts: &Verts) -> Vec<SurfaceOut> {
    let mut surfaces: Vec<SurfaceOut> = Vec::new();
    if hes.is_empty() {
        return surfaces;
    }

    let mut out_map: HashMap<String, Vec<(f64, f64, usize)>> = HashMap::new();
    for (i, (vf, _, eg)) in hes.iter().enumerate() {
        let angle = depart(eg);
        out_map.entry(vf.clone()).or_default().push((angle, bend(eg), i));
    }
    for outs in out_map.values_mut() {
        // Order CCW by departure angle. Two edges that leave along the same tangent
        // (a tangency cusp) have effectively equal angles; the first derivative
        // cannot separate them, so break the tie by signed curvature (the
        // right-bending edge precedes the left-bending one). ANGLE_TIE rounds away
        // the float noise between two analytically-equal tangent directions while
        // staying far below the gap between genuinely distinct crossing edges.
        const ANGLE_TIE: f64 = 1e-7;
        outs.sort_by(|a, b| {
            if (a.0 - b.0).abs() > ANGLE_TIE {
                a.0.partial_cmp(&b.0).unwrap()
            } else if a.1 != b.1 {
                a.1.partial_cmp(&b.1).unwrap()
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
        for pos in 0..outs.len() {
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
        if !cycle.is_empty() && cur == start && face_area(&cycle, hes, verts) > 1e-10 {
            let boundary: Vec<BoundaryEdge> = cycle
                .iter()
                .map(|&i| boundary_edge(&hes[i].2, &he_eid[i], &hes[i].0, &hes[i].1))
                .collect();
            let face_entity_ids: Vec<String> = cycle.iter().map(|&i| he_eid[i].clone()).collect();
            surfaces.push(SurfaceOut {
                boundary,
                face_entity_ids,
                holes: vec![],
            });
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

fn build_standalone_surfaces(circles: &[(String, InputEntity)], splits: &HashMap<String, Vec<Split>>) -> Vec<SurfaceOut> {
    let empty: Vec<Split> = Vec::new();
    let mut surfaces = Vec::new();
    for (eid, e) in circles {
        if dedup(splits.get(eid).unwrap_or(&empty)).len() >= 2 {
            continue;
        }
        let cx = e.center.unwrap()[0];
        let cy = e.center.unwrap()[1];
        let r = e.radius.unwrap();
        surfaces.push(SurfaceOut {
            boundary: circle_arcs(cx, cy, r, eid),
            face_entity_ids: vec![eid.clone()],
            holes: vec![],
        });
    }
    surfaces
}

fn build_standalone_ellipses(ellipses: &[(String, InputEntity)], splits: &HashMap<String, Vec<Split>>) -> Vec<SurfaceOut> {
    let empty: Vec<Split> = Vec::new();
    let mut surfaces = Vec::new();
    let mut seen: Vec<[f64; 5]> = Vec::new();
    for (eid, e) in ellipses {
        if dedup(splits.get(eid).unwrap_or(&empty)).len() >= 2 {
            continue;
        }
        let a = e.a.unwrap();
        let b = e.b.unwrap();
        // A degenerate ellipse (near-zero semi-axis) bounds no area; never a face.
        if a.abs() < MERGE || b.abs() < MERGE {
            continue;
        }
        let c = e.center.unwrap();
        let theta = e.theta.unwrap_or(0.0);
        let key = [c[0], c[1], a, b, theta];
        if seen.iter().any(|k| k.iter().zip(key.iter()).all(|(v, w)| (v - w).abs() < MERGE)) {
            continue;
        }
        seen.push(key);
        let boundary = vec![BoundaryEdge {
            geom: EdgeGeom::Ellipse {
                center: [c[0], c[1]],
                a,
                b,
                theta,
            },
            id: Some(eid.clone()),
            start_vertex: None,
            end_vertex: None,
        }];
        surfaces.push(SurfaceOut {
            boundary,
            face_entity_ids: vec![eid.clone()],
            holes: vec![],
        });
    }
    surfaces
}

fn build_standalone_splines(splines: &[(String, InputEntity)], splits: &HashMap<String, Vec<Split>>, verts: &mut Verts) -> Vec<SurfaceOut> {
    let empty: Vec<Split> = Vec::new();
    let mut surfaces = Vec::new();
    for (eid, e) in splines {
        if dedup(splits.get(eid).unwrap_or(&empty)).len() > 2 {
            continue;
        }
        let v0 = verts.vid(e.start.unwrap());
        let v1 = verts.vid(e.end.unwrap());
        if v0 != v1 {
            continue; // open spline: only closes a loop with other edges
        }
        let boundary = vec![BoundaryEdge {
            geom: EdgeGeom::Spline {
                start: e.start.unwrap(),
                end: e.end.unwrap(),
                c1: e.c1.unwrap(),
                c2: e.c2.unwrap(),
            },
            id: Some(eid.clone()),
            start_vertex: Some(v0.clone()),
            end_vertex: Some(v1),
        }];
        surfaces.push(SurfaceOut {
            boundary,
            face_entity_ids: vec![eid.clone()],
            holes: vec![],
        });
    }
    surfaces
}

/// Fold nested loops into the sketch-area model via `subdivide_loops`: every loop
/// stays its own area, carrying the loops immediately nested inside it as holes.
fn nest_surfaces(surfaces: Vec<SurfaceOut>) -> Vec<SurfaceOut> {
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

fn build_edge_queries(hes: &[HalfEdge], he_eid: &[String]) -> Vec<EdgeOut> {
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

// ─── Main entry point ───

pub fn detect_topology(geometry: &[(String, InputEntity)]) -> TopologyOut {
    let cls = classify(geometry);

    let mut verts = Verts::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();

    for (eid, e) in &cls.lines {
        splits.insert(
            eid.clone(),
            vec![(0.0, verts.vid(e.start.unwrap())), (1.0, verts.vid(e.end.unwrap()))],
        );
    }

    for (eid, _) in &cls.circles {
        splits.insert(eid.clone(), vec![]);
    }

    // Seed arc vertex registration with line-endpoint data so coincident arc/line
    // endpoints share vertex ids, then merge new arc vertices back.
    let mut arc_verts = verts.clone_verts();
    let (a0_from_norm, arc_splits, arcs) = normalize_arcs_and_init_splits(&cls.arcs, &mut arc_verts);
    for (k, v) in a0_from_norm {
        arc_a0.insert(k, v);
    }
    for (k, v) in arc_splits {
        splits.insert(k, v);
    }
    verts.map.extend(arc_verts.map.drain());

    for (eid, e) in &cls.splines {
        splits.insert(
            eid.clone(),
            vec![(0.0, verts.vid(e.start.unwrap())), (1.0, verts.vid(e.end.unwrap()))],
        );
    }

    for (eid, _) in &cls.ellipses {
        splits.insert(eid.clone(), vec![]);
    }

    let endpoint_vids = verts.keys();

    let line_keys: HashSet<String> = cls.lines.iter().map(|(k, _)| k.clone()).collect();
    let circle_keys: HashSet<String> = cls.circles.iter().map(|(k, _)| k.clone()).collect();

    let mut elist: Vec<(String, InputEntity)> = Vec::new();
    elist.extend(cls.lines.iter().cloned());
    elist.extend(cls.circles.iter().cloned());
    elist.extend(arcs.iter().cloned());
    find_all_intersections(&elist, &line_keys, &circle_keys, &mut splits, &mut verts, &arc_a0);

    // Second pass: every pair involving an ellipse or a spline.
    let mut tagged: Vec<Tagged> = Vec::new();
    for (eid, e) in &cls.lines {
        tagged.push(Tagged { eid: eid.clone(), e: e.clone(), kind: "line" });
    }
    for (eid, e) in &cls.circles {
        tagged.push(Tagged { eid: eid.clone(), e: e.clone(), kind: "circle" });
    }
    for (eid, e) in &arcs {
        tagged.push(Tagged { eid: eid.clone(), e: e.clone(), kind: "arc" });
    }
    for (eid, e) in &cls.ellipses {
        tagged.push(Tagged { eid: eid.clone(), e: e.clone(), kind: "ellipse" });
    }
    for (eid, e) in &cls.splines {
        tagged.push(Tagged { eid: eid.clone(), e: e.clone(), kind: "spline" });
    }
    add_curve_intersections(&tagged, &mut splits, &mut verts, &arc_a0);

    let (hes, he_eid) = build_half_edge_graph(&cls.lines, &cls.circles, &arcs, &splits, &cls.splines, &cls.ellipses);

    let mut surfaces = trace_face_cycles(&hes, &he_eid, &verts);
    surfaces.extend(build_standalone_surfaces(&cls.circles, &splits));
    surfaces.extend(build_standalone_ellipses(&cls.ellipses, &splits));
    surfaces.extend(build_standalone_splines(&cls.splines, &splits, &mut verts));
    surfaces = nest_surfaces(surfaces);

    let edges = build_edge_queries(&hes, &he_eid);

    let mut intersection_points: Vec<(String, Vec2)> = Vec::new();
    let mut vertices: Vec<(String, Vec2)> = Vec::new();
    for (k, v) in &verts.map {
        if !endpoint_vids.contains(k.as_str()) {
            intersection_points.push((k.clone(), *v));
        }
        vertices.push((k.clone(), *v));
    }

    TopologyOut {
        intersection_points,
        vertices,
        edges,
        surfaces,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: Vec2, end: Vec2) -> InputEntity {
        InputEntity {
            start: Some(start),
            end: Some(end),
            ..Default::default()
        }
    }
    fn circle(c: Vec2, r: f64) -> InputEntity {
        InputEntity {
            center: Some(c),
            radius: Some(r),
            ..Default::default()
        }
    }

    fn square(side: f64) -> Vec<(String, InputEntity)> {
        vec![
            ("a".into(), line([0.0, 0.0], [side, 0.0])),
            ("b".into(), line([side, 0.0], [side, side])),
            ("c".into(), line([side, side], [0.0, side])),
            ("d".into(), line([0.0, side], [0.0, 0.0])),
        ]
    }

    #[test]
    fn single_square_is_one_surface() {
        let t = detect_topology(&square(2.0));
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.surfaces[0].boundary.len(), 4);
        assert!(t.surfaces[0].holes.is_empty());
        assert_eq!(t.edges.len(), 4);
    }

    #[test]
    fn standalone_circle_is_one_surface_two_arcs() {
        let geom = vec![("c0".into(), circle([0.0, 0.0], 1.0))];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.surfaces[0].boundary.len(), 2);
        assert_eq!(t.surfaces[0].face_entity_ids, vec!["c0".to_string()]);
    }

    #[test]
    fn cc_exact_external_tangency_is_one_point() {
        let pts = cc(0.0, 0.0, 5.0, 10.0, 0.0, 5.0);
        assert_eq!(pts.len(), 1);
        assert!((pts[0].2[0] - 5.0).abs() < 1e-9 && pts[0].2[1].abs() < 1e-9);
    }

    #[test]
    fn cc_near_tangent_overlap_collapses_to_one_point() {
        // The solver leaves a hair of overlap at a tangency; the two analytic
        // roots are ~2.2e-3 apart and must collapse to the single foot at (5,0).
        let pts = cc(0.0, 0.0, 5.0, 10.0 - 1e-6, 0.0, 5.0);
        assert_eq!(pts.len(), 1);
        assert!((pts[0].2[0] - 5.0).abs() < 1e-3 && pts[0].2[1].abs() < 1e-3);
    }

    #[test]
    fn cc_internal_tangency_is_one_point() {
        let pts = cc(0.0, 0.0, 5.0, 3.0, 0.0, 2.0);  // d == r1 - r2
        assert_eq!(pts.len(), 1);
        assert!((pts[0].2[0] - 5.0).abs() < 1e-9 && pts[0].2[1].abs() < 1e-9);
    }

    #[test]
    fn cc_clear_crossing_keeps_two_points() {
        let pts = cc(0.0, 0.0, 5.0, 8.0, 0.0, 5.0);  // roots 6 apart, not tangent
        assert_eq!(pts.len(), 2);
    }

    #[test]
    fn cc_disjoint_circles_have_no_points() {
        assert!(cc(0.0, 0.0, 5.0, 20.0, 0.0, 5.0).is_empty());
    }

    #[test]
    fn near_tangent_circles_stay_two_standalone_faces() {
        // Regression for the white-line report: two "tangent" circles the solver
        // left a hair overlapping must NOT be sliced into half-edge arcs. The cc
        // collapse keeps one contact -> one split each -> both standalone, no edges.
        let geom = vec![
            ("cA".into(), circle([0.0, 0.0], 5.0)),
            ("cB".into(), circle([10.0 - 1e-6, 0.0], 5.0)),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 2);
        assert!(t.edges.is_empty(), "tangent circles must emit no split edges");
        assert_eq!(t.intersection_points.len(), 1, "one virtual tangent point");
    }

    #[test]
    fn concentric_circles_make_two_areas_outer_has_hole() {
        // The 4af0712 behavior: hole region becomes its own selectable area.
        let geom = vec![
            ("outer".into(), circle([0.0, 0.0], 2.0)),
            ("inner".into(), circle([0.0, 0.0], 1.0)),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 2);
        // The bigger circle carries the smaller as a hole; the smaller is its own area.
        let with_hole = t.surfaces.iter().filter(|s| !s.holes.is_empty()).count();
        assert_eq!(with_hole, 1);
    }

    #[test]
    fn two_crossing_lines_enclose_nothing() {
        let geom = vec![
            ("h".into(), line([-1.0, 0.0], [1.0, 0.0])),
            ("v".into(), line([0.0, -1.0], [0.0, 1.0])),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 0);
        // One intersection vertex at the origin.
        assert_eq!(t.intersection_points.len(), 1);
    }

    #[test]
    fn collinear_overlap_degenerate_and_normal() {
        // Ported from the deleted TS topology.test.ts collinearOverlap block.
        // Zero-length segment A -> no overlap.
        assert!(collinear_overlap(&line([1.0, 0.0], [1.0, 0.0]), &line([0.0, 0.0], [2.0, 0.0])).is_empty());
        // Zero-length segment B -> no overlap.
        assert!(collinear_overlap(&line([0.0, 0.0], [2.0, 0.0]), &line([1.0, 0.0], [1.0, 0.0])).is_empty());
        // Genuinely overlapping collinear segments -> overlap points.
        assert!(!collinear_overlap(&line([0.0, 0.0], [2.0, 0.0]), &line([1.0, 0.0], [3.0, 0.0])).is_empty());
    }

    #[test]
    fn three_mutually_tangent_circles_make_four_areas() {
        // Bug report tangential_sketch_area_building: three equal circles, each
        // pair externally tangent, must yield 4 areas (3 disks + 1 central
        // curvilinear triangle). The tangent vertices are cusps where two arcs
        // share a departure direction, so the face tracer must break the angular
        // tie by curvature or it merges/loses faces.
        let r = 2.61391544342041;
        let geom = vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("B".into(), circle([-5.223526954650879, -0.21208451688289642], r)),
            ("C".into(), circle([-2.4280929565429688, -4.629749298095703], r)),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 4, "expected 3 disks + 1 central triangle");
    }

    #[test]
    fn line_slashes_circle_into_two_areas() {
        let geom = vec![
            ("c0".into(), circle([0.0, 0.0], 1.0)),
            ("l0".into(), line([-2.0, 0.0], [2.0, 0.0])),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 2);
    }

    fn ellipse(center: Vec2, a: f64, b: f64, theta: f64) -> InputEntity {
        InputEntity {
            kind: Some("ellipse".into()),
            center: Some(center),
            a: Some(a),
            b: Some(b),
            theta: Some(theta),
            ..Default::default()
        }
    }

    fn spline_closed(start_end: Vec2, c1: Vec2, c2: Vec2) -> InputEntity {
        InputEntity {
            kind: Some("spline".into()),
            start: Some(start_end),
            end: Some(start_end),
            c1: Some(c1),
            c2: Some(c2),
            ..Default::default()
        }
    }

    #[test]
    fn standalone_ellipse_is_one_surface() {
        let geom = vec![("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 30.0))];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.surfaces[0].boundary.len(), 1);
        assert!(matches!(t.surfaces[0].boundary[0].geom, EdgeGeom::Ellipse { .. }));
    }

    #[test]
    fn closed_spline_is_one_surface() {
        // A cubic Bezier starting and ending at the same point.
        let geom = vec![("s0".into(), spline_closed([0.0, 0.0], [1.0, 2.0], [-1.0, 2.0]))];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.surfaces[0].boundary.len(), 1);
        assert!(matches!(t.surfaces[0].boundary[0].geom, EdgeGeom::Spline { .. }));
    }
}
