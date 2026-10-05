//! Post-solve surface detection, ported from the geometry pipeline of the
//! former `frontend/src/kernel/topology.ts` (`detectTopology`, deleted once
//! this port reached parity). Pairwise intersections
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
use super::curve_split::{bezier_point, ellipse_point_at, subdivide_bezier, BezierCtrl};
use super::profile_loops::{subdivide_loops, BoundaryEdge, EdgeGeom, Vec2};
use super::{
    TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE, TOL_TOPOLOGY_SPLIT as SPLIT_EPS,
};
use crate::radians;

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

// `lc` asserts the same virtual tangent point for a line, but keyed on the
// PERPENDICULAR GAP `|dist - r|` rather than the root separation `h`. The two
// are one threshold rewritten (`gap == h * h / (dist + r)`), but the gap is what
// a tangent residual drives linearly where `h ~ sqrt(2 * r * gap)` is its square
// root, so the gap is the form that can be compared against a solve and tested.
// Applies to a MISS only, so it swallows no geometry and can be sized purely for
// headroom: it is the distance by which a line may fail to reach a rim and still
// be read as touching it. Relative to the radius so it tracks model scale, with
// MERGE as the floor for tiny radii. That leaves ~1000x over the reported
// sketch's 9e-8 residual, where the previous `h`-form rule left 52x -- and under
// a square root 52x is thin, which is what an area flickering in and out of a
// dragged sketch looks like from the outside. `cc` reuses the same constant for
// its miss-side rule: two circles whose centre distance falls a hair beyond
// r1 + r2 (or a hair inside |r1 - r2|) get their single foot asserted within
// the same budget, for the same reason -- the gap is the residual the tangent
// solver drives to zero.
const TANGENT_GAP_REL: f64 = 1e-5;

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

fn degrees(rad: f64) -> f64 {
    rad * 180.0 / std::f64::consts::PI
}
/// Python float modulo (result takes the sign of the divisor).
pub fn pymod(a: f64, b: f64) -> f64 {
    ((a % b) + b) % b
}

fn angle_in_arc(a_rad: f64, r: f64, start_deg: f64, end_deg: f64) -> bool {
    let s = pymod(radians(start_deg), TWO_PI);
    let e = pymod(radians(end_deg), TWO_PI);
    let a = pymod(a_rad, TWO_PI);
    if (s - e).abs() < EPS || (s - e).abs() > TWO_PI - EPS {
        return true;
    }
    // The endpoint slack is the angular width of a MERGE-world chord at this
    // radius, floored at EPS so the window is never tighter than the old fixed
    // radian slack. The old EPS-radians window was 1e-9 * r world wide: four
    // orders tighter than the 1e-5 world vertex merge, so a tangent line whose
    // contact landed a hair past an arc endpoint (the ordinary slot corner) was
    // dropped while the same miss against a full circle was fused.
    let slack = (MERGE / r.max(EPS)).max(EPS);
    if s < e {
        s - slack <= a && a <= e + slack
    } else {
        a >= s - slack || a <= e + slack
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
        Verts {
            map: HashMap::new(),
        }
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
    /// Look up a registered vertex. Returns `None` for an unknown id instead of
    /// aborting: a half-edge naming a vertex that is not in the pool bounds no
    /// area, and the worker must survive that rather than trap.
    fn get(&self, k: &str) -> Option<Vec2> {
        self.map.get(k).copied()
    }
    fn keys(&self) -> HashSet<String> {
        self.map.keys().cloned().collect()
    }
}

type Split = (f64, String);

fn has_param(spl: &[Split], p: f64) -> bool {
    spl.iter().any(|(s, _)| (s - p).abs() < SPLIT_EPS)
}

// Largest |a0| for which the +-TWO_PI step walk stays meaningful. Two floors
// bite as |a0| grows: from ~2^56 rad on, a full turn is below one ulp of a0,
// so `p += TWO_PI` rounds straight back onto p and the loops absorb every
// step even for p == a0; long before that, SPLIT_EPS (1e-7) drops below
// ulp(a0) (~1.2e-7 at 1e9), so the walk's epsilon comparisons stop
// resolving. Real sketch angles (golden corpora live near +-2*pi) sit orders
// of magnitude below.
const WALKABLE_A0: f64 = 1e9;

fn norm_arc_param(p: f64, a0: f64) -> f64 {
    // The step walks below are the bit-exact code path for anything they can
    // finish: frozen golden payloads depend on that arithmetic. But their
    // iteration count scales with |a0 - p| rather than geometry, and decoded
    // arc angles are untrusted magnitude -- angle_start = 3e38 is finite,
    // passes every solver gate, and would spin ~9e35 single-turn iterations,
    // wedging the Worker permanently (its watchdog is Infinity). Anything the
    // walk cannot finish (or even step through, see WALKABLE_A0) jumps
    // straight to the same landing zone via modulo instead.
    if (p - a0).abs() <= 4.0 * TWO_PI && a0.abs() <= WALKABLE_A0 {
        let mut p = p;
        while p < a0 - SPLIT_EPS {
            p += TWO_PI;
        }
        while p >= a0 + TWO_PI - SPLIT_EPS {
            p -= TWO_PI;
        }
        return p;
    }
    let q = pymod(p - a0, TWO_PI) + a0;
    // Keep the walk's landing interval [a0 - SPLIT_EPS, a0 + TWO_PI - SPLIT_EPS)
    // so split params stay comparable across both paths.
    if q >= a0 + TWO_PI - SPLIT_EPS {
        q - TWO_PI
    } else {
        q
    }
}

/// Sort splits by (param, vid), drop consecutive near-equal params.
fn dedup(spl: &[Split]) -> Vec<Split> {
    if spl.is_empty() {
        return vec![];
    }
    let mut out: Vec<Split> = spl.to_vec();
    out.sort_by(|x, y| {
        if x.0 != y.0 {
            x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            x.1.cmp(&y.1)
        }
    });
    out.dedup_by(|a, b| (a.0 - b.0).abs() <= SPLIT_EPS);
    out
}

// A closed curve anchors its params at a seam (circle at +-pi, ellipse at
// 0/2pi). Two contacts that merge into one vertex can land on opposite sides of
// that seam, so their params sit about 2pi apart and `dedup` (which only
// compares consecutive sorted entries) keeps both. The pair then emits no
// half-edge: both segments hit the `v0 == v1` skip in the closed pass, and the
// list no longer fits the standalone `max_keep` count, so a curve that plainly
// bounds an area reports none. One vertex is no subdivision, so collapse the
// list to its single split and let the standalone path take it.
fn collapse_seam_splits(spl: &mut Vec<Split>) {
    if let Some(first) = spl.first() {
        if spl.iter().all(|s| s.1 == first.1) {
            let first = first.clone();
            *spl = vec![first];
        }
    }
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
    // Virtual tangent point, `cc`'s rule in the line's terms (see TANGENT_GAP_REL):
    // a converged tangent constraint leaves `disc` a hair either side of zero, and
    // the MISS side (`disc < 0`) has no roots to offer, so the contact the region
    // closes on is simply lost (bugreports/bug-report-1788207174415).
    //
    // Only the miss side. A near-graze already carries two real roots, and they
    // need no help: closer together than MERGE the vertex merge fuses them, and
    // further apart they are an honest chord. Restricting the rule this way is
    // what makes a generous tolerance safe -- on a miss there is no crossing to
    // swallow, so widening it can only invent a contact where the curves come
    // within `gap` of touching, never erase one the user drew.
    let dist = (r * r - disc / (4.0 * a)).max(0.0).sqrt();
    if disc < 0.0 && (dist - r).abs() <= MERGE.max(TANGENT_GAP_REL * r) {
        let raw = -b / (2.0 * a);
        // The foot is bounded in WORLD units, not in the line parameter: a line
        // whose endpoint is constrained onto the rim it is tangent to has its
        // tangency AT that endpoint, and the solver residual leaves the foot a
        // sliver either side of it. `EPS` on the parameter (1e-9, ~7e-8 world on
        // a sketch-sized segment) is inside that sliver and would drop the very
        // contact this branch exists to keep; MERGE is the distance at which the
        // foot and the endpoint are already the same vertex. Bailing here is
        // exactly what the pre-collapse code did for a miss, and `disc < 0`
        // guarantees there is no real root being given up with it.
        let overhang = (-raw).max(raw - 1.0).max(0.0) * a.sqrt();
        if overhang > MERGE {
            return vec![];
        }
        let t = raw.clamp(0.0, 1.0);
        let ix = p1[0] + t * dx;
        let iy = p1[1] + t * dy;
        return vec![(t, (iy - cy).atan2(ix - cx), [ix, iy])];
    }
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
    if d < EPS {
        return vec![];
    }
    // Foot on the radical axis: the would-be tangent point, well defined on the
    // miss side too, where it is the midpoint of closest approach.
    let a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    let mx = cx1 + (a * (cx2 - cx1)) / d;
    let my = cy1 + (a * (cy2 - cy1)) / d;

    // Miss side first. A converged tangency that landed a hair apart (d just
    // beyond r1 + r2, or just inside |r1 - r2|) has no roots, so the contact the
    // region closes on is lost. The gap is exactly the residual r_tangent drives
    // (residuals.rs), so asserting the foot within TANGENT_GAP_REL * r_min (MERGE
    // floor) restores the contact with pure headroom: a miss has no crossing to
    // swallow. This is cc's mirror of lc's miss-side rule.
    if d >= r1 + r2 {
        let gap = d - (r1 + r2);
        if gap <= MERGE.max(TANGENT_GAP_REL * r1.min(r2)) {
            return vec![(
                (my - cy1).atan2(mx - cx1),
                (my - cy2).atan2(mx - cx2),
                [mx, my],
            )];
        }
        return vec![];
    }
    if d <= (r1 - r2).abs() {
        let gap = (r1 - r2).abs() - d;
        if gap <= MERGE.max(TANGENT_GAP_REL * r1.min(r2)) {
            return vec![(
                (my - cy1).atan2(mx - cx1),
                (my - cy2).atan2(mx - cx2),
                [mx, my],
            )];
        }
        return vec![];
    }

    // Graze side (|r1 - r2| < d < r1 + r2): two real roots. Fold them into the
    // foot to stop a phantom sliver arc slicing two near-tangent circles
    // (near_tangent_circles_stay_two_standalone_faces). Threshold stays the
    // shipped h-form: on this side widening would swallow a real, if tiny, lens.
    let h2 = r1 * r1 - a * a;
    if h2 < 0.0 {
        return vec![];
    }
    let h = h2.max(0.0).sqrt();
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
    let (Some(p1), Some(p2), Some(q1), Some(q2)) = (ea.start, ea.end, eb.start, eb.end) else {
        return vec![];
    };

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
    // Missing geometry yields no crossing rather than an abort: `classify` drops
    // incomplete entities, so these are defence in depth against a stale record.
    let line_ends = |e: &InputEntity| -> Option<(Vec2, Vec2)> { Some((e.start?, e.end?)) };
    let circle_cr = |e: &InputEntity| -> Option<(Vec2, f64)> { Some((e.center?, e.radius?)) };
    let ia = |e: &InputEntity, ang: f64| match (e.radius, e.angle_start, e.angle_end) {
        (Some(r), Some(s), Some(en)) => angle_in_arc(ang, r, s, en),
        _ => false,
    };

    match (ta, tb) {
        ('l', 'l') => match (line_ends(ea), line_ends(eb)) {
            (Some((p1, p2)), Some((q1, q2))) => ll(p1, p2, q1, q2).into_iter().collect(),
            _ => vec![],
        },
        ('l', 'c') => match (line_ends(ea), circle_cr(eb)) {
            (Some((p1, p2)), Some((c, r))) => lc(p1, p2, c[0], c[1], r),
            _ => vec![],
        },
        ('c', 'l') => match (line_ends(eb), circle_cr(ea)) {
            (Some((p1, p2)), Some((c, r))) => lc(p1, p2, c[0], c[1], r)
                .into_iter()
                .map(|(t, ang, pt)| (ang, t, pt))
                .collect(),
            _ => vec![],
        },
        ('l', 'a') => match (line_ends(ea), circle_cr(eb)) {
            (Some((p1, p2)), Some((c, r))) => lc(p1, p2, c[0], c[1], r)
                .into_iter()
                .filter(|(_, ang, _)| ia(eb, *ang))
                .collect(),
            _ => vec![],
        },
        ('a', 'l') => match (line_ends(eb), circle_cr(ea)) {
            (Some((p1, p2)), Some((c, r))) => lc(p1, p2, c[0], c[1], r)
                .into_iter()
                .filter(|(_, ang, _)| ia(ea, *ang))
                .map(|(t, ang, pt)| (ang, t, pt))
                .collect(),
            _ => vec![],
        },
        ('c', 'c') => cc_of(ea, eb),
        ('c', 'a') => cc_of(ea, eb)
            .into_iter()
            .filter(|(_, a2, _)| ia(eb, *a2))
            .collect(),
        ('a', 'c') => cc_of(ea, eb)
            .into_iter()
            .filter(|(a1, _, _)| ia(ea, *a1))
            .collect(),
        ('a', 'a') => cc_of(ea, eb)
            .into_iter()
            .filter(|(a1, a2, _)| ia(ea, *a1) && ia(eb, *a2))
            .collect(),
        _ => vec![],
    }
}

fn cc_of(ea: &InputEntity, eb: &InputEntity) -> Vec<(f64, f64, Vec2)> {
    let (Some(ce), Some(re), Some(cb), Some(rb)) = (ea.center, ea.radius, eb.center, eb.radius)
    else {
        return vec![];
    };
    cc(ce[0], ce[1], re, cb[0], cb[1], rb)
}

// ─── Half-edge geometry constructors ───

fn line_eg(e: &InputEntity, t0: f64, t1: f64) -> Option<EdgeGeom> {
    let (Some(p1), Some(p2)) = (e.start, e.end) else {
        return None;
    };
    Some(EdgeGeom::Line {
        start: [p1[0] + t0 * (p2[0] - p1[0]), p1[1] + t0 * (p2[1] - p1[1])],
        end: [p1[0] + t1 * (p2[0] - p1[0]), p1[1] + t1 * (p2[1] - p1[1])],
    })
}

fn arc_eg(e: &InputEntity, a0: f64, a1: f64, ccw: bool) -> Option<EdgeGeom> {
    let (Some(c), Some(r)) = (e.center, e.radius) else {
        return None;
    };
    Some(EdgeGeom::Arc {
        center: [c[0], c[1]],
        radius: r,
        angle_start_deg: degrees(a0),
        angle_end_deg: degrees(a1),
        ccw,
        start: [c[0] + r * a0.cos(), c[1] + r * a0.sin()],
        end: [c[0] + r * a1.cos(), c[1] + r * a1.sin()],
    })
}

fn spline_eg(e: &InputEntity) -> Option<EdgeGeom> {
    let (Some(start), Some(end), Some(c1), Some(c2)) = (e.start, e.end, e.c1, e.c2) else {
        return None;
    };
    Some(EdgeGeom::Spline { start, end, c1, c2 })
}

fn sub_spline_eg(ctrl: &BezierCtrl) -> EdgeGeom {
    EdgeGeom::Spline {
        start: ctrl[0],
        c1: ctrl[1],
        c2: ctrl[2],
        end: ctrl[3],
    }
}

fn ellipse_arc_eg(e: &InputEntity, phi0: f64, phi1: f64, ccw: bool) -> Option<EdgeGeom> {
    let (Some(c), Some(a), Some(b)) = (e.center, e.a, e.b) else {
        return None;
    };
    let theta = e.theta.unwrap_or(0.0);
    let cr = (theta * std::f64::consts::PI / 180.0).cos();
    let sr = (theta * std::f64::consts::PI / 180.0).sin();
    Some(EdgeGeom::EllipseArc {
        center: [c[0], c[1]],
        a,
        b,
        theta,
        angle_start_deg: degrees(phi0),
        angle_end_deg: degrees(phi1),
        ccw,
        start: ellipse_point_at([c[0], c[1]], a, b, cr, sr, phi0),
        end: ellipse_point_at([c[0], c[1]], a, b, cr, sr, phi1),
    })
}

fn rev(eg: &EdgeGeom) -> EdgeGeom {
    match *eg {
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
            angle_start_deg,
            ccw,
            ..
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
            a,
            b,
            angle_start_deg,
            ccw,
            ..
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
            s * a * b / speed2 * speed2.sqrt()
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
            (d1[0] * d2[1] - d1[1] * d2[0]) / speed2 * speed2.sqrt()
        }
    }
}

type HalfEdge = (String, String, EdgeGeom);

fn face_area(cycle: &[usize], hes: &[HalfEdge], verts: &Verts) -> f64 {
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

// ─── Classification ───

#[derive(Default)]
struct Classified {
    lines: Vec<(String, InputEntity)>,
    circles: Vec<(String, InputEntity)>,
    arcs: Vec<(String, InputEntity)>,
    splines: Vec<(String, InputEntity)>,
    ellipses: Vec<(String, InputEntity)>,
}

impl Classified {
    /// Split the buckets into the real geometry, which builds vertices, edges
    /// and faces exactly as it did before construction entities were let in,
    /// and the construction geometry, which only ever contributes crossings.
    /// `partition` keeps input order within each half, so the real half is
    /// byte-for-byte the list `classify` used to return.
    fn split_construction(self) -> (Classified, Classified) {
        let part = |bucket: Vec<(String, InputEntity)>| {
            bucket
                .into_iter()
                .partition::<Vec<_>, _>(|(_, e)| !e.construction)
        };
        let (r_lines, c_lines) = part(self.lines);
        let (r_circles, c_circles) = part(self.circles);
        let (r_arcs, c_arcs) = part(self.arcs);
        let (r_splines, c_splines) = part(self.splines);
        let (r_ellipses, c_ellipses) = part(self.ellipses);
        (
            Classified {
                lines: r_lines,
                circles: r_circles,
                arcs: r_arcs,
                splines: r_splines,
                ellipses: r_ellipses,
            },
            Classified {
                lines: c_lines,
                circles: c_circles,
                arcs: c_arcs,
                splines: c_splines,
                ellipses: c_ellipses,
            },
        )
    }

    fn is_empty(&self) -> bool {
        self.lines.is_empty()
            && self.circles.is_empty()
            && self.arcs.is_empty()
            && self.splines.is_empty()
            && self.ellipses.is_empty()
    }
}

/// The fields the geometry pass unwraps for each kind. Everything downstream of
/// `classify` (split seeding, the half-edge builders, the standalone-face
/// builders) dereferences these without asking, so an entity that arrives
/// truncated or stale would panic the Worker mid-pass. Requiring the full set
/// here drops the bad record instead: a partial entity contributes no edges
/// rather than killing the solve.
fn has_required_fields(kind: &str, e: &InputEntity) -> bool {
    match kind {
        "spline" => e.start.is_some() && e.end.is_some() && e.c1.is_some() && e.c2.is_some(),
        // `theta` is genuinely optional (unrotated ellipses omit it).
        "ellipse" => e.center.is_some() && e.a.is_some() && e.b.is_some(),
        "arc" => {
            e.center.is_some()
                && e.radius.is_some()
                && e.start.is_some()
                && e.end.is_some()
                && e.angle_start.is_some()
                && e.angle_end.is_some()
        }
        "line" => e.start.is_some() && e.end.is_some(),
        _ => e.center.is_some() && e.radius.is_some(), // circle
    }
}

fn classify(geometry: &[(String, InputEntity)]) -> Classified {
    let mut c = Classified::default();
    for (eid, ent) in geometry {
        let kind = ent.kind.as_deref();
        // Which bucket an entity belongs to is decided by the same discriminating
        // fields `classifyEntities` uses; completeness is a separate question, so
        // an incomplete arc is a dropped arc, never demoted to a line.
        let (bucket, kind_name): (&mut Vec<(String, InputEntity)>, &str) = if kind == Some("spline")
        {
            (&mut c.splines, "spline")
        } else if kind == Some("ellipse") {
            (&mut c.ellipses, "ellipse")
        } else if ent.start.is_some() && ent.radius.is_some() {
            (&mut c.arcs, "arc")
        } else if ent.start.is_some() {
            (&mut c.lines, "line")
        } else if ent.center.is_some() {
            (&mut c.circles, "circle")
        } else {
            continue;
        };
        if !has_required_fields(kind_name, ent) {
            continue;
        }
        bucket.push((eid.clone(), ent.clone()));
    }
    c
}

/// Force each arc's CCW span <= pi by swapping its endpoints. Every consumer of
/// `angle_start`/`angle_end` (the split params, `angle_in_arc`) reads the
/// normalized form, so construction arcs run through this too before their
/// crossings are tested.
fn normalize_arc_spans(arcs: &mut [(String, InputEntity)]) {
    for (_eid, e) in arcs.iter_mut() {
        let (Some(start), Some(end)) = (e.angle_start, e.angle_end) else {
            continue; // incomplete arc: nothing to normalize
        };
        let a0_rad = radians(start);
        let a1_rad = radians(end);
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
}

/// Normalize arcs (force CCW span <= pi by swapping endpoints) and seed splits.
#[allow(clippy::type_complexity)]
fn normalize_arcs_and_init_splits(
    arcs_in: &[(String, InputEntity)],
    arc_verts: &mut Verts,
) -> (
    HashMap<String, f64>,
    HashMap<String, Vec<Split>>,
    Vec<(String, InputEntity)>,
) {
    let mut arcs: Vec<(String, InputEntity)> = arcs_in.to_vec();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();

    normalize_arc_spans(&mut arcs);

    for (eid, e) in &arcs {
        let (Some(as_), Some(ae), Some(start), Some(end)) =
            (e.angle_start, e.angle_end, e.start, e.end)
        else {
            continue; // incomplete arc: no split seed, no vertex
        };
        let a0 = radians(as_);
        let a1 = norm_arc_param(radians(ae), a0);
        arc_a0.insert(eid.clone(), a0);
        splits.insert(
            eid.clone(),
            vec![(a0, arc_verts.vid(start)), (a1, arc_verts.vid(end))],
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
                // A missing split bucket means the entity was not seeded (a
                // construction or dropped entity); skip it rather than index.
                if let Some(spl) = splits.get(eid_a) {
                    if !has_param(spl, pa) {
                        if let Some(s) = splits.get_mut(eid_a) {
                            s.push((pa, v.clone()));
                        }
                    }
                }
                if let Some(spl) = splits.get(eid_b) {
                    if !has_param(spl, pb) {
                        if let Some(s) = splits.get_mut(eid_b) {
                            s.push((pb, v));
                        }
                    }
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

fn to_curve(kind: &str, e: &InputEntity) -> Option<Curve> {
    match kind {
        "line" => {
            let (Some(p0), Some(p1)) = (e.start, e.end) else {
                return None;
            };
            Some(Curve::Line { p0, p1 })
        }
        "circle" | "arc" => {
            let (Some(c), Some(r)) = (e.center, e.radius) else {
                return None;
            };
            Some(Curve::Circle { c, r })
        }
        "ellipse" => {
            let (Some(c), Some(a), Some(b)) = (e.center, e.a, e.b) else {
                return None;
            };
            Some(Curve::Ellipse {
                c,
                a,
                b,
                theta: e.theta.unwrap_or(0.0),
            })
        }
        _ => {
            let (Some(p0), Some(c1), Some(c2), Some(p3)) = (e.start, e.c1, e.c2, e.end) else {
                return None;
            };
            Some(Curve::Bezier { p0, c1, c2, p3 })
        }
    }
}

/// Register a curve-intersection hit param into the per-kind split convention.
fn register_hit(
    entry: &Tagged,
    t: f64,
    v: &str,
    splits: &mut HashMap<String, Vec<Split>>,
    arc_a0: &HashMap<String, f64>,
) {
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
            let a = if t > std::f64::consts::PI {
                t - TWO_PI
            } else {
                t
            };
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
            let (Some(r), Some(s), Some(en)) =
                (entry.e.radius, entry.e.angle_start, entry.e.angle_end)
            else {
                return;
            };
            if !angle_in_arc(t, r, s, en) {
                return;
            }
            let p = norm_arc_param(t, *arc_a0.get(&entry.eid).unwrap_or(&0.0));
            if !has_param(spl, p) {
                spl.push((p, v.to_string()));
            }
        }
    }
}

fn add_curve_intersections(
    tagged: &[Tagged],
    splits: &mut HashMap<String, Vec<Split>>,
    verts: &mut Verts,
    arc_a0: &HashMap<String, f64>,
) {
    for i in 0..tagged.len() {
        for j in (i + 1)..tagged.len() {
            let a = &tagged[i];
            let b = &tagged[j];
            let involves_curve = a.kind == "ellipse"
                || a.kind == "spline"
                || b.kind == "ellipse"
                || b.kind == "spline";
            if !involves_curve {
                continue;
            }
            let (Some(ca), Some(cb)) = (to_curve(a.kind, &a.e), to_curve(b.kind, &b.e)) else {
                continue;
            };
            let hits = intersect_curves(&ca, &cb);
            for h in hits {
                let v = verts.vid(h.point);
                register_hit(a, h.t_a, &v, splits, arc_a0);
                register_hit(b, h.t_b, &v, splits, arc_a0);
            }
        }
    }
}

/// Tag a bucket set with the kind names the intersection passes dispatch on.
/// `arcs` comes in separately because the caller tags the span-normalized arc
/// copies, not the raw `cls.arcs`.
fn tag_entities(cls: &Classified, arcs: &[(String, InputEntity)]) -> Vec<Tagged> {
    let mut tagged: Vec<Tagged> = Vec::new();
    let mut push = |src: &[(String, InputEntity)], kind: &'static str| {
        for (eid, e) in src {
            tagged.push(Tagged {
                eid: eid.clone(),
                e: e.clone(),
                kind,
            });
        }
    };
    push(&cls.lines, "line");
    push(&cls.circles, "circle");
    push(arcs, "arc");
    push(&cls.ellipses, "ellipse");
    push(&cls.splines, "spline");
    tagged
}

/// The domain checks `register_hit` applies before it accepts a hit, without the
/// split bookkeeping: a crossing counts only where it truly lies on the entity.
/// Line, circle and ellipse mirror `register_hit` exactly. The spline arm is
/// deliberately wider: `register_hit` drops a hit within `SPLIT_EPS` of either
/// end because a real spline's endpoints are already seeded as vertices, and a
/// construction spline's are not, so an endpoint contact here is a genuinely new
/// reference point rather than a duplicate split.
///
/// The arc arm is the one that does the clipping in practice: `intersect_curves`
/// reaches an arc only as the full `Curve::Circle` it scans over 0..2pi. Its
/// line and bezier paths already clamp to the finite segment, so those arms are
/// defence in depth against a future closed-form path that does not.
fn hit_on_entity(entry: &Tagged, t: f64) -> bool {
    match entry.kind {
        "line" | "spline" => (-EPS..=1.0 + EPS).contains(&t),
        "arc" => match (entry.e.radius, entry.e.angle_start, entry.e.angle_end) {
            (Some(r), Some(s), Some(en)) => angle_in_arc(t, r, s, en),
            _ => false,
        },
        _ => true, // a circle or an ellipse is closed: every parameter is on it
    }
}

/// Every point where `a` and `b` cross, taking the same two dispatch paths the
/// real passes take (`intersect` for line/circle/arc, `intersect_curves` once an
/// ellipse or a spline is involved) but yielding only world points.
fn crossing_points(
    a: &Tagged,
    b: &Tagged,
    line_keys: &HashSet<String>,
    circle_keys: &HashSet<String>,
) -> Vec<Vec2> {
    if matches!(a.kind, "ellipse" | "spline") || matches!(b.kind, "ellipse" | "spline") {
        let (Some(ca), Some(cb)) = (to_curve(a.kind, &a.e), to_curve(b.kind, &b.e)) else {
            return vec![];
        };
        return intersect_curves(&ca, &cb)
            .into_iter()
            .filter(|h| hit_on_entity(a, h.t_a) && hit_on_entity(b, h.t_b))
            .map(|h| h.point)
            .collect();
    }
    intersect(&a.eid, &a.e, &b.eid, &b.e, line_keys, circle_keys)
        .into_iter()
        .map(|(_, _, pt)| pt)
        .collect()
}

/// Construction geometry contributes reference points, never area: each
/// construction entity is crossed against the real geometry and against the
/// construction entities after it, and every hit is minted as a vertex and
/// nothing else. No split is pushed into any entity, so real edge counts,
/// `edge:N` indices and surface ancestries stay byte-identical to a document
/// with the construction geometry deleted. Two collinear lines are deliberately
/// not overlapped here: a construction line laid along a real one adds no
/// reference point its own endpoints do not already offer.
///
/// Call after `endpoint_vids` is captured, so the minted ids also surface as
/// intersection points, and before the half-edge build, which never sees these
/// entities at all. One consequence of that ordering: a construction entity's
/// own endpoint landing mid-span on a real curve mints a NEW `_vN` and reports
/// it as an intersection point, where the same geometry drawn real would have
/// been seeded first and merged into an existing endpoint vertex. Harmless
/// downstream (`inferredContactCandidates` drops an intersection coinciding
/// with a sketch vertex), but it is why the counts differ from the real case.
fn seed_construction_crossings(
    real: &[Tagged],
    con: &[Tagged],
    line_keys: &HashSet<String>,
    circle_keys: &HashSet<String>,
    verts: &mut Verts,
) {
    for (i, c) in con.iter().enumerate() {
        for other in real.iter().chain(con[i + 1..].iter()) {
            for pt in crossing_points(c, other, line_keys, circle_keys) {
                verts.vid(pt);
            }
        }
    }
}

// Push one geometric edge as its two opposing half-edges (v0->v1 and v1->v0),
// tagging both with the owning entity id. Shared by every curve kind in
// build_half_edge_graph, which differ only in how they derive `eg`.
fn push_half_edge_pair(
    hes: &mut Vec<HalfEdge>,
    he_eid: &mut Vec<String>,
    eid: &str,
    v0: &str,
    v1: &str,
    eg: EdgeGeom,
) {
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
            let Some(eg) = line_eg(e, *t0, *t1) else {
                continue; // incomplete line: no edge to emit
            };
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
            let Some(eg) = arc_eg(e, *a0, *a1, true) else {
                continue; // incomplete arc: no edge to emit
            };
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    // Circles and ellipses split the same way around a closed loop; only the
    // per-segment geometry constructor differs.
    let closed_arc_pass = |entities: &[(String, InputEntity)],
                           eg_fn: fn(&InputEntity, f64, f64, bool) -> Option<EdgeGeom>,
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
                let Some(eg) = eg_fn(e, *a0, a1, true) else {
                    continue; // incomplete closed curve: no edge to emit
                };
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
        let ctrl: BezierCtrl = match (e.start, e.c1, e.c2, e.end) {
            (Some(start), Some(c1), Some(c2), Some(end)) => [start, c1, c2, end],
            _ => continue, // incomplete spline: no edge to emit
        };
        for k in 0..spl.len().saturating_sub(1) {
            let (t0, v0) = &spl[k];
            let (t1, v1) = &spl[k + 1];
            if v0 == v1 || t1 <= t0 {
                continue;
            }
            let eg = if *t0 <= 0.0 && *t1 >= 1.0 {
                spline_eg(e)
            } else {
                Some(sub_spline_eg(&subdivide_bezier(&ctrl, *t0, *t1)))
            };
            let Some(eg) = eg else {
                continue;
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

fn trace_face_cycles(hes: &[HalfEdge], he_eid: &[String], verts: &Verts) -> Vec<SurfaceOut> {
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
            if cycle.len() >= 2 && face_area(&cycle, hes, verts) > 1e-10 {
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
    entities: &[(String, InputEntity)],
    splits: &HashMap<String, Vec<Split>>,
    max_keep: usize,
    mut boundary_of: F,
) -> Vec<SurfaceOut>
where
    F: FnMut(&str, &InputEntity) -> Option<Vec<BoundaryEdge>>,
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

fn build_standalone_surfaces(
    circles: &[(String, InputEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> Vec<SurfaceOut> {
    build_standalone(circles, splits, 1, |eid, e| {
        let (Some(c), Some(r)) = (e.center, e.radius) else {
            return None;
        };
        Some(circle_arcs(c[0], c[1], r, eid))
    })
}

fn build_standalone_ellipses(
    ellipses: &[(String, InputEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> Vec<SurfaceOut> {
    let mut seen: Vec<[f64; 5]> = Vec::new();
    build_standalone(ellipses, splits, 1, move |eid, e| {
        let (Some(c), Some(a), Some(b)) = (e.center, e.a, e.b) else {
            return None;
        };
        // A degenerate ellipse (near-zero semi-axis) bounds no area; never a face.
        if a.abs() < MERGE || b.abs() < MERGE {
            return None;
        }
        let theta = e.theta.unwrap_or(0.0);
        let key = [c[0], c[1], a, b, theta];
        if seen
            .iter()
            .any(|k| k.iter().zip(key.iter()).all(|(v, w)| (v - w).abs() < MERGE))
        {
            return None;
        }
        seen.push(key);
        Some(vec![BoundaryEdge {
            geom: EdgeGeom::Ellipse {
                center: [c[0], c[1]],
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

fn build_standalone_splines(
    splines: &[(String, InputEntity)],
    splits: &HashMap<String, Vec<Split>>,
    verts: &mut Verts,
) -> Vec<SurfaceOut> {
    build_standalone(splines, splits, 2, |eid, e| {
        let (Some(start), Some(end), Some(c1), Some(c2)) = (e.start, e.end, e.c1, e.c2) else {
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
    // Construction entities are split off here and rejoin only in the crossing
    // pass below, so every stage that builds real geometry sees exactly the list
    // it saw when `classify` dropped them outright.
    let (cls, con) = classify(geometry).split_construction();

    let mut verts = Verts::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();

    for (eid, e) in &cls.lines {
        let (Some(start), Some(end)) = (e.start, e.end) else {
            continue; // incomplete line: no split seed
        };
        splits.insert(
            eid.clone(),
            vec![(0.0, verts.vid(start)), (1.0, verts.vid(end))],
        );
    }

    for (eid, _) in &cls.circles {
        splits.insert(eid.clone(), vec![]);
    }

    // Seed arc vertex registration with line-endpoint data so coincident arc/line
    // endpoints share vertex ids, then merge new arc vertices back.
    let mut arc_verts = verts.clone_verts();
    let (a0_from_norm, arc_splits, arcs) =
        normalize_arcs_and_init_splits(&cls.arcs, &mut arc_verts);
    for (k, v) in a0_from_norm {
        arc_a0.insert(k, v);
    }
    for (k, v) in arc_splits {
        splits.insert(k, v);
    }
    verts.map.extend(arc_verts.map.drain());

    for (eid, e) in &cls.splines {
        let (Some(start), Some(end)) = (e.start, e.end) else {
            continue; // incomplete spline: no split seed
        };
        splits.insert(
            eid.clone(),
            vec![(0.0, verts.vid(start)), (1.0, verts.vid(end))],
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
    find_all_intersections(
        &elist,
        &line_keys,
        &circle_keys,
        &mut splits,
        &mut verts,
        &arc_a0,
    );

    // Second pass: every pair involving an ellipse or a spline.
    let tagged = tag_entities(&cls, &arcs);
    add_curve_intersections(&tagged, &mut splits, &mut verts, &arc_a0);

    if !con.is_empty() {
        let mut c_arcs = con.arcs.clone();
        normalize_arc_spans(&mut c_arcs);
        let c_tagged = tag_entities(&con, &c_arcs);
        // `intersect` reads its line/circle/arc dispatch off these key sets, so
        // they have to name the construction entities as well.
        let mut all_line_keys = line_keys.clone();
        let mut all_circle_keys = circle_keys.clone();
        all_line_keys.extend(con.lines.iter().map(|(k, _)| k.clone()));
        all_circle_keys.extend(con.circles.iter().map(|(k, _)| k.clone()));
        seed_construction_crossings(
            &tagged,
            &c_tagged,
            &all_line_keys,
            &all_circle_keys,
            &mut verts,
        );
    }

    // Closed curves wrap at a seam, so a pair of contacts that fused into one
    // vertex can straddle it. Collapse before both the half-edge build and the
    // standalone count read the split list.
    for (eid, _) in cls.circles.iter().chain(cls.ellipses.iter()) {
        if let Some(spl) = splits.get_mut(eid) {
            collapse_seam_splits(spl);
        }
    }

    let (hes, he_eid) = build_half_edge_graph(
        &cls.lines,
        &cls.circles,
        &arcs,
        &splits,
        &cls.splines,
        &cls.ellipses,
    );

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
        let pts = cc(0.0, 0.0, 5.0, 3.0, 0.0, 2.0); // d == r1 - r2
        assert_eq!(pts.len(), 1);
        assert!((pts[0].2[0] - 5.0).abs() < 1e-9 && pts[0].2[1].abs() < 1e-9);
    }

    #[test]
    fn cc_clear_crossing_keeps_two_points() {
        let pts = cc(0.0, 0.0, 5.0, 8.0, 0.0, 5.0); // roots 6 apart, not tangent
        assert_eq!(pts.len(), 2);
    }

    #[test]
    fn cc_disjoint_circles_have_no_points() {
        assert!(cc(0.0, 0.0, 5.0, 20.0, 0.0, 5.0).is_empty());
    }

    #[test]
    fn cc_external_miss_within_tolerance_is_one_point() {
        // A converged tangency that landed a hair apart has no analytic roots, so
        // the contact the area builder closes on is lost. The miss gap IS the
        // r_tangent residual, so a miss within the tolerance must assert the foot.
        let r: f64 = 5.0;
        let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
        for gap in [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 0.5 * tol] {
            let pts = cc(0.0, 0.0, r, 2.0 * r + gap, 0.0, r);
            assert_eq!(
                pts.len(),
                1,
                "gap {gap:e}: a miss within tolerance is one point"
            );
            // The foot is the midpoint of closest approach, gap/2 past the ideal
            // touch point, so the horizontal budget must scale with the gap.
            assert!(
                (pts[0].2[0] - r).abs() < 1e-6 + gap && pts[0].2[1].abs() < 1e-9,
                "gap {gap:e}: foot at the tangent point"
            );
        }
    }

    #[test]
    fn cc_external_miss_past_tolerance_stays_empty() {
        // The cliff pinned from the far side so a widened constant cannot pass
        // unnoticed: a genuine separation keeps zero contact.
        let r: f64 = 5.0;
        let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
        for gap in [2.0 * tol, 1e-3, 1e-2] {
            assert!(
                cc(0.0, 0.0, r, 2.0 * r + gap, 0.0, r).is_empty(),
                "gap {gap:e}: a real miss stays a miss"
            );
        }
    }

    #[test]
    fn cc_internal_miss_within_tolerance_is_one_point() {
        // Internal mirror: B nested a hair short of touching A from inside.
        let (r1, r2): (f64, f64) = (5.0, 2.0);
        let tol = MERGE.max(TANGENT_GAP_REL * r1.min(r2));
        for gap in [1e-9, 1e-7, 0.5 * tol] {
            let pts = cc(0.0, 0.0, r1, r1 - r2 - gap, 0.0, r2);
            assert_eq!(
                pts.len(),
                1,
                "gap {gap:e}: an internal miss within tolerance is one point"
            );
            // The internal foot sits at the radical-axis a, which grows a hair
            // past r1 as the miss deepens, so the budget scales with the gap.
            assert!(
                (pts[0].2[0] - r1).abs() < 1e-6 + gap && pts[0].2[1].abs() < 1e-9,
                "gap {gap:e}: foot at the tangent point"
            );
        }
    }

    #[test]
    fn cc_internal_miss_past_tolerance_stays_empty() {
        let (r1, r2): (f64, f64) = (5.0, 2.0);
        let tol = MERGE.max(TANGENT_GAP_REL * r1.min(r2));
        let gap = 2.0 * tol;
        assert!(cc(0.0, 0.0, r1, r1 - r2 - gap, 0.0, r2).is_empty());
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
        assert!(
            t.edges.is_empty(),
            "tangent circles must emit no split edges"
        );
        assert_eq!(t.intersection_points.len(), 1, "one virtual tangent point");
    }

    #[test]
    fn near_tangent_lines_at_the_circle_seam_keep_the_disk_face() {
        // A disk touched by two near-tangent lines whose virtual contacts land a
        // hair either side of the atan2 branch cut at +-pi. The contacts merge
        // into one vertex but their params sit ~2pi apart, so the split list kept
        // both, every segment hit the v0 == v1 skip, and the standalone max_keep
        // guard dropped the face: a clear disk reported no area. Pin the face.
        let r: f64 = 50.0;
        let gap: f64 = 1e-6;
        let delta: f64 = 5e-8;
        let tangent_line = |theta: f64| {
            let n = [theta.cos(), theta.sin()];
            let d = [-theta.sin(), theta.cos()];
            let p = [r * n[0] + gap * n[0], r * n[1] + gap * n[1]];
            line([p[0] - d[0], p[1] - d[1]], [p[0] + d[0], p[1] + d[1]])
        };
        let geom = vec![
            ("c0".into(), circle([0.0, 0.0], r)),
            ("l1".into(), tangent_line(std::f64::consts::PI - delta)),
            ("l2".into(), tangent_line(-std::f64::consts::PI + delta)),
        ];
        let t = detect_topology(&geom);
        assert!(
            t.surfaces
                .iter()
                .any(|s| s.face_entity_ids == vec!["c0".to_string()]),
            "the disk face must survive two near-tangent contacts at the seam"
        );
    }

    // One incomplete entity per kind, each missing a field the geometry pass
    // unwraps. The Worker is fed by structured-clone postMessage and cannot
    // trust its input, so a truncated record must be dropped, not panicked on.
    #[test]
    fn incomplete_entities_are_dropped_per_kind() {
        let cases: Vec<(&str, InputEntity)> = vec![
            (
                "line without end",
                InputEntity {
                    start: Some([0.0, 0.0]),
                    ..Default::default()
                },
            ),
            (
                "circle without radius",
                InputEntity {
                    center: Some([0.0, 0.0]),
                    ..Default::default()
                },
            ),
            (
                "arc without angle_start",
                InputEntity {
                    start: Some([1.0, 0.0]),
                    end: Some([0.0, 1.0]),
                    center: Some([0.0, 0.0]),
                    radius: Some(1.0),
                    angle_end: Some(90.0),
                    ..Default::default()
                },
            ),
            (
                "arc without end",
                InputEntity {
                    start: Some([1.0, 0.0]),
                    center: Some([0.0, 0.0]),
                    radius: Some(1.0),
                    angle_start: Some(0.0),
                    angle_end: Some(90.0),
                    ..Default::default()
                },
            ),
            (
                "spline without c1",
                InputEntity {
                    kind: Some("spline".into()),
                    start: Some([0.0, 0.0]),
                    end: Some([2.0, 0.0]),
                    c2: Some([1.5, 1.0]),
                    ..Default::default()
                },
            ),
            (
                "ellipse without b",
                InputEntity {
                    kind: Some("ellipse".into()),
                    center: Some([0.0, 0.0]),
                    a: Some(3.0),
                    ..Default::default()
                },
            ),
        ];
        for (label, ent) in cases {
            let t = detect_topology(&[("bad".into(), ent)]);
            assert!(t.edges.is_empty(), "{label} must contribute no edges");
            assert!(t.surfaces.is_empty(), "{label} must contribute no surfaces");
        }
    }

    #[test]
    fn incomplete_geometry_helpers_degrade_instead_of_panicking() {
        // The builders behind the classify gate must each survive a truncated
        // record on their own: if `has_required_fields` ever loosened, these are
        // the sites that used to unwrap. None/empty is the drop signal.
        let empty = InputEntity::default();
        assert!(line_eg(&empty, 0.0, 1.0).is_none());
        assert!(arc_eg(&empty, 0.0, 1.0, true).is_none());
        assert!(spline_eg(&empty).is_none());
        assert!(ellipse_arc_eg(&empty, 0.0, 1.0, true).is_none());
        assert!(to_curve("line", &empty).is_none());
        assert!(to_curve("circle", &empty).is_none());
        assert!(to_curve("ellipse", &empty).is_none());
        assert!(to_curve("spline", &empty).is_none());
        assert!(collinear_overlap(&empty, &empty).is_empty());
        assert!(cc_of(&empty, &empty).is_empty());

        let mut line_keys = HashSet::new();
        line_keys.insert("a".to_string());
        line_keys.insert("b".to_string());
        assert!(intersect("a", &empty, "b", &empty, &line_keys, &HashSet::new()).is_empty());

        let tagged = Tagged {
            eid: "a".into(),
            e: empty.clone(),
            kind: "arc",
        };
        assert!(!hit_on_entity(&tagged, 0.5));
    }

    #[test]
    fn face_area_drops_a_cycle_naming_an_unknown_vertex() {
        // `Verts::get` used to panic on a missing id; an unknown vertex must
        // bound no area instead, so the cycle is dropped.
        let verts = Verts::new();
        let hes: Vec<HalfEdge> = vec![(
            "_v0".to_string(),
            "_v1".to_string(),
            EdgeGeom::Line {
                start: [0.0, 0.0],
                end: [1.0, 0.0],
            },
        )];
        assert_eq!(face_area(&[0], &hes, &verts), 0.0);
    }

    #[test]
    fn nan_departure_angle_does_not_panic_the_cycle_tracer() {
        // A NaN param (from a poisoned solve) reaching the half-edge graph gives
        // an edge a NaN departure angle AND a NaN curvature. Ordering the edges
        // leaving that vertex must degrade to "equal", not unwrap a None.
        let mut verts = Verts::new();
        let v0 = verts.vid([0.0, 0.0]);
        let v1 = verts.vid([1.0, 0.0]);
        let v2 = verts.vid([0.0, 1.0]);
        let straight = EdgeGeom::Line {
            start: [0.0, 0.0],
            end: [1.0, 0.0],
        };
        let poisoned = EdgeGeom::Arc {
            center: [0.0, 0.0],
            radius: f64::NAN,
            angle_start_deg: f64::NAN,
            angle_end_deg: f64::NAN,
            ccw: true,
            start: [0.0, 0.0],
            end: [0.0, 1.0],
        };
        let mut hes: Vec<HalfEdge> = Vec::new();
        let mut he_eid: Vec<String> = Vec::new();
        push_half_edge_pair(&mut hes, &mut he_eid, "good", &v0, &v1, straight);
        push_half_edge_pair(&mut hes, &mut he_eid, "bad", &v0, &v2, poisoned);
        // The result is meaningless geometry; the point is that it returns.
        let _ = trace_face_cycles(&hes, &he_eid, &verts);
    }

    #[test]
    fn norm_arc_param_matches_the_reference_walk_for_sane_inputs() {
        // Frozen golden payloads depend on the original +-2*pi step arithmetic,
        // so the walk must stay the exact code path for every input it can
        // finish in bounded time. Only magnitudes it could never walk may take
        // a shortcut.
        fn walk(mut p: f64, a0: f64) -> f64 {
            while p < a0 - SPLIT_EPS {
                p += TWO_PI;
            }
            while p >= a0 + TWO_PI - SPLIT_EPS {
                p -= TWO_PI;
            }
            p
        }
        let cases = [
            (-1.0, 0.0),
            (0.0, 0.0),
            (5.0, -1.0),
            (-1.0, 1.0),
            (TWO_PI, 0.0),
            (0.0, TWO_PI),
            (3.5, -2.5),
        ];
        for (p, a0) in cases {
            assert_eq!(norm_arc_param(p, a0), walk(p, a0));
        }
    }

    #[test]
    fn norm_arc_param_lands_in_the_walk_window_for_huge_inputs() {
        // Decoded arc angles are untrusted magnitude: 3e38 degrees is finite,
        // passes every solver gate, and used to mean ~9e35 single-step loop
        // iterations here (or an absorbed-step spin at equal angles: the walk's
        // own threshold collapses onto p once a turn is below one ulp). At
        // 3e38 the landing interval itself is degenerate below ulp(a0), so
        // there only finiteness can be asserted; at 1e15 degrees the interval
        // is representable and must hold exactly.
        let a0 = radians(3e38);
        for deg in [-3e38, -1e300, -1e15, 1e15, 1e150, 3e38] {
            let p = norm_arc_param(radians(deg), a0);
            assert!(p.is_finite(), "radians({deg}) must normalize finite");
        }
        let a0 = radians(1e15);
        for deg in [-1e300, -720.0, 0.0, 720.0, 1e15, 1e150] {
            let p = norm_arc_param(radians(deg), a0);
            assert!(p.is_finite(), "radians({deg}) must normalize finite");
            assert!(
                p >= a0 - SPLIT_EPS && p < a0 + TWO_PI - SPLIT_EPS,
                "radians({deg}) landed outside the split window"
            );
        }
    }

    fn arc(center: Vec2, r: f64, a0: f64, a1: f64) -> InputEntity {
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
    fn slot_corner(r: f64, end_deg: f64) -> Vec<(String, InputEntity)> {
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

    #[test]
    fn line_tangent_exactly_at_arc_endpoint_closes_the_slot() {
        // The exact-endpoint contract (passes today; guards the change): a line
        // tangent at the arc end must close the slot corner as one surface and
        // emit no degenerate sliver arc edge below MERGE/r of angular span.
        let r: f64 = 2.0;
        let t = detect_topology(&slot_corner(r, 90.0));
        assert_eq!(
            t.surfaces.len(),
            1,
            "exact-endpoint tangent closes the slot"
        );
        for e in &t.edges {
            if let EdgeGeom::Arc {
                angle_start_deg,
                angle_end_deg,
                ..
            } = e.geom
            {
                let span = (radians(angle_end_deg - angle_start_deg)).abs();
                assert!(
                    span >= MERGE / r,
                    "no sliver arc edge below MERGE/r (span {span:e})"
                );
            }
        }
    }

    #[test]
    fn arc_endpoint_tangency_tolerance_is_world_scaled() {
        // The headline: the endpoint slack is the angular width of a MERGE-world
        // chord at this radius (MERGE / r), not a bare 1e-9 radians (which was
        // 1e-9 * r world -- four orders tighter than the vertex merge). A tangent
        // contact within MERGE world of the arc end keeps the slot closed; one a
        // hair further (2 * MERGE) leaves it open, matching the vertex merge.
        let r: f64 = 2.0;
        for delta_world in [MERGE / 2.0, MERGE] {
            let end_deg = degrees(radians(90.0) - delta_world / r);
            assert!(
                angle_in_arc(radians(90.0), r, 0.0, end_deg),
                "delta_world {delta_world:e}: a contact within MERGE of the arc end is inside the sweep"
            );
            let t = detect_topology(&slot_corner(r, end_deg));
            assert_eq!(
                t.surfaces.len(),
                1,
                "delta_world {delta_world:e}: the slot still closes"
            );
        }
        let delta_world = 2.0 * MERGE;
        let end_deg = degrees(radians(90.0) - delta_world / r);
        assert!(
            !angle_in_arc(radians(90.0), r, 0.0, end_deg),
            "a contact 2x MERGE past the arc end is outside the sweep"
        );
        let t = detect_topology(&slot_corner(r, end_deg));
        assert_eq!(
            t.surfaces.len(),
            0,
            "a real miss past MERGE leaves the slot open"
        );
    }

    #[test]
    fn arc_with_huge_decoded_angles_completes_and_keeps_the_square_intact() {
        // angle_start = 3e38 echoes through normalize_arcs_and_init_splits for
        // an unconstrained arc whose seed survives LM. Normalization walked one
        // 2*pi step per iteration (~9e35 steps): detect_topology effectively
        // never returned and the Worker wedged. The square alongside must still
        // resolve exactly as without the hostile arc.
        let mut geom = square(2.0);
        geom.push(("bad".into(), arc([50.0, 50.0], 1.0, 3e38, 3e38)));
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.surfaces[0].boundary.len(), 4);
        assert_eq!(t.edges.len(), 4);
    }

    #[test]
    fn incomplete_entity_does_not_take_down_its_neighbours() {
        // A stale record alongside good geometry loses only itself: the square
        // still resolves to its one surface.
        let mut geom = square(2.0);
        geom.push((
            "stale".into(),
            InputEntity {
                center: Some([0.5, 0.5]),
                ..Default::default()
            },
        ));
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.edges.len(), 4);
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
        assert!(
            collinear_overlap(&line([1.0, 0.0], [1.0, 0.0]), &line([0.0, 0.0], [2.0, 0.0]))
                .is_empty()
        );
        // Zero-length segment B -> no overlap.
        assert!(
            collinear_overlap(&line([0.0, 0.0], [2.0, 0.0]), &line([1.0, 0.0], [1.0, 0.0]))
                .is_empty()
        );
        // Genuinely overlapping collinear segments -> overlap points.
        assert!(
            !collinear_overlap(&line([0.0, 0.0], [2.0, 0.0]), &line([1.0, 0.0], [3.0, 0.0]))
                .is_empty()
        );
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
            (
                "B".into(),
                circle([-5.223526954650879, -0.21208451688289642], r),
            ),
            (
                "C".into(),
                circle([-2.4280929565429688, -4.629749298095703], r),
            ),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 4, "expected 3 disks + 1 central triangle");
    }

    // Two equal circles tangent externally, centre distance 2r + gap: gap > 0 is
    // a miss (apart), gap < 0 is a graze (overlap). gap is the external residual
    // the solver drives, so walking it walks the collapse rule the way a sketch
    // degrades as the solve loosens.
    fn circle_pair_offset_by(r: f64, gap: f64) -> Vec<(String, InputEntity)> {
        vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("B".into(), circle([2.0 * r + gap, 0.0], r)),
        ]
    }

    #[test]
    fn near_tangent_circle_pair_miss_side_stays_two_standalone_faces() {
        // The miss-side mirror of near_tangent_circles_stay_two_standalone_faces
        // and the direct end-to-end regression for finding 1: two tangent circles
        // the solver left a hair APART must still close as two standalone disks
        // with one virtual tangent point, not zero contact.
        let r: f64 = 5.0;
        let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
        for gap in [1e-9, 1e-7, 0.5 * tol] {
            let t = detect_topology(&circle_pair_offset_by(r, gap));
            assert_eq!(t.surfaces.len(), 2, "gap {gap:e}: two standalone disks");
            assert!(
                t.edges.is_empty(),
                "gap {gap:e}: no split edges at a tangency"
            );
            assert_eq!(
                t.intersection_points.len(),
                1,
                "gap {gap:e}: one virtual tangent point"
            );
        }
    }

    #[test]
    fn three_circles_a_hair_apart_still_make_four_areas() {
        // The three_mutually_tangent_circles geometry pushed a hair apart: the
        // reported "4 -> 3 surfaces" cliff was the collapse never firing on the
        // miss side. An equilateral centre spacing of 2r + gap keeps every pair
        // a miss within tolerance, so the central triangle must still build.
        let r: f64 = 2.61391544342041;
        let tol = MERGE.max(TANGENT_GAP_REL * r.min(r));
        for gap in [1e-7, 0.5 * tol] {
            let s = 2.0 * r + gap;
            let geom = vec![
                ("A".into(), circle([0.0, 0.0], r)),
                ("B".into(), circle([s, 0.0], r)),
                ("C".into(), circle([s / 2.0, 3.0f64.sqrt() * s / 2.0], r)),
            ];
            let t = detect_topology(&geom);
            assert_eq!(
                t.surfaces.len(),
                4,
                "gap {gap:e}: 3 disks + 1 central triangle"
            );
        }
    }

    #[test]
    fn tangent_line_between_two_circles_closes_its_own_area() {
        // Bug report bug-report-1788207174415: a venn of two circles plus an
        // external tangent line spanning them bounds a fifth region (line + the
        // two arcs it touches). A converged tangent constraint leaves the
        // line/circle discriminant a hair NEGATIVE (here -7.6e-4 and -8.8e-5,
        // i.e. the line misses each rim by ~1e-7), so the old `disc < 0` bail
        // split neither circle at its tangent point and that region never closed.
        let geom = vec![
            ("A".into(), circle([0.0, 0.0], 9.5)),
            ("B".into(), circle([0.0, 10.0], 4.0)),
            (
                "L".into(),
                line([3.340658664703369, 12.2], [7.9340643882751465, 5.225]),
            ),
        ];
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            4,
            "2 crescents + lens + the tangent region"
        );

        // The vertical line from B's centre down through A's centre cuts the lens
        // in two; both of its ends are free, so neither crescent is divided.
        let mut with_chord = geom.clone();
        with_chord.push(("V".into(), line([0.0, 10.0], [0.0, 0.0])));
        let t2 = detect_topology(&with_chord);
        assert_eq!(t2.surfaces.len(), 5, "the chord splits only the lens");
    }

    /// The report's two circles plus their external tangent line, with the line
    /// displaced `gap` along its own normal: `gap > 0` pulls it clear of both
    /// rims, `gap < 0` pushes it in to cut two real chords. `gap` IS the quantity
    /// the solver's tangent residual drives, so this walks the collapse rule
    /// across its tolerance the way the sketch degrades as a solve gets looser.
    fn tangent_pair_offset_by(gap: f64) -> Vec<(String, InputEntity)> {
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

    #[test]
    fn tangent_collapse_holds_across_the_solver_residual_band() {
        // Exact tangency, and a miss an order of magnitude past anything a
        // converged solve leaves (the report's own solve sits at gap 9e-8): the
        // collapse must carry all of them, or the tangent region stops building
        // as soon as a drag loosens the solve. This is the side that needs the
        // rule -- only a near-MISS has no roots to work from.
        for gap in [0.0, 1e-9, 9e-8, 1e-6, 1e-5, 4e-5] {
            let t = detect_topology(&tangent_pair_offset_by(gap));
            assert_eq!(
                t.surfaces.len(),
                4,
                "gap {gap:e}: tangent region must build"
            );
        }
        // The near-GRAZE side needs no tolerance to close the region -- the two
        // roots are real -- but taking both would slice each rim into a phantom
        // sliver arc. Inside tolerance the collapse asserts the single foot, and
        // past it the chords are honest geometry: 4 either way, never a
        // degenerate extra face.
        for gap in [-1e-5, -1e-4, -1e-2] {
            let t = detect_topology(&tangent_pair_offset_by(gap));
            assert_eq!(t.surfaces.len(), 4, "gap {gap:e}: no sliver face");
        }
        // Past tolerance on the miss side the line touches nothing, leaving just
        // the venn's own 3 regions. The cliff is `TANGENT_GAP_REL * r` of the
        // SMALLER circle (4e-5 here) since the region needs both contacts; it is
        // pinned from both sides so widening the constant cannot pass unnoticed.
        for gap in [4.1e-5, 1e-3, 1e-2, 0.1] {
            let t = detect_topology(&tangent_pair_offset_by(gap));
            assert_eq!(t.surfaces.len(), 3, "gap {gap:e}: a real miss stays a miss");
        }
    }

    #[test]
    fn a_crossing_survives_a_foot_that_lies_off_the_segment() {
        // The collapse must never cost a real root. A line running from just past
        // the foot of its own perpendicular to beyond the rim crosses the circle
        // for real, but its foot sits off the segment -- when the collapse also
        // ran on the graze side, that combination short-circuited and the whole
        // crossing was dropped, which is worse than never having collapsed at all.
        let r: f64 = 100.0;
        for gap in [9e-4, 1e-3] {
            let y = r - gap; // chord `gap` inside the rim
            let half = (r * r - y * y).sqrt();
            let g = vec![
                ("A".into(), circle([0.0, 0.0], r)),
                ("H".into(), line([0.1, y], [half + 0.5, y])), // foot at x=0, off-segment
            ];
            let t = detect_topology(&g);
            assert_eq!(
                t.intersection_points.len(),
                1,
                "gap {gap:e}: the crossing is real"
            );
        }
    }

    #[test]
    fn a_near_miss_whose_foot_is_off_the_segment_stays_a_miss() {
        // The other side of the same branch: the line misses the rim by less than
        // tolerance, but its tangency would fall beyond the segment's end, so
        // there is nothing to contact.
        let r: f64 = 100.0;
        let y = r + 1e-4; // inside the 1e-3 budget for r=100
        let g = vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("H".into(), line([5.0, y], [40.0, y])), // foot at x=0, well off the segment
        ];
        let t = detect_topology(&g);
        assert!(t.intersection_points.is_empty());
    }

    #[test]
    fn venn_chord_splits_lens_into_four_areas() {
        // Bug report sketch_area_building: two overlapping circles (a venn diagram)
        // with a line connecting their two intersection points must yield 4 areas
        // (the 2 outer crescents + the lens split in two by the chord). The solver
        // leaves each circle/circle intersection ~1e-6 from the coincident line
        // endpoint, so the vertex merge must be looser than that residual or the
        // chord's corner vertices fail to fuse, the planar graph tears, and the
        // tracer collapses to a single face. Geometry is the report's solved values.
        let geom = vec![
            (
                "A".into(),
                circle(
                    [-49.890132904052734, -0.0206315740942955],
                    23.889873504638672,
                ),
            ),
            (
                "B".into(),
                circle(
                    [-28.857667922973633, 3.3534867763519287],
                    23.889873504638672,
                ),
            ),
            (
                "L".into(),
                line(
                    [-42.76115417480469, 22.780765533447266],
                    [-35.98664855957031, -19.44791030883789],
                ),
            ),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 4, "2 crescents + 2 lens halves");
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

    #[test]
    fn center_to_center_line_bounds_no_spike() {
        // Bug report bug-report-1788364894806: two overlapping circles plus a
        // line joining their two centres. Each circle centre is an interior point,
        // so the line dangles into both crescents and the face tracer used to
        // carry the dangling segment back and forth as a zero-width slit. OCC
        // cannot build a face from that boundary, so the picked "big circle minus
        // the venn" area extruded as a thin plane instead of the crescent. The
        // crescents must be clean 3-edge loops (the chord still splits the lens
        // in two, so 4 areas total).
        let geom = vec![
            ("A".into(), circle([0.0, 0.0], 9.5)),
            ("B".into(), circle([0.0, 10.0], 4.0)),
            ("V".into(), line([0.0, 10.0], [0.0, 0.0])),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 4, "2 crescents + 2 lens halves");
        // The line only divides the lens, so it must appear in exactly the two
        // lens-half faces, never in a crescent it merely dangled into.
        let with_line = t
            .surfaces
            .iter()
            .filter(|s| s.face_entity_ids.contains(&"V".to_string()))
            .count();
        assert_eq!(with_line, 2, "the chord bounds only the lens halves");
        for s in &t.surfaces {
            assert_eq!(s.boundary.len(), 3, "no dangling slit in any boundary");
        }
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
        assert!(matches!(
            t.surfaces[0].boundary[0].geom,
            EdgeGeom::Ellipse { .. }
        ));
    }

    #[test]
    fn closed_spline_is_one_surface() {
        // A cubic Bezier starting and ending at the same point.
        let geom = vec![(
            "s0".into(),
            spline_closed([0.0, 0.0], [1.0, 2.0], [-1.0, 2.0]),
        )];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 1);
        assert_eq!(t.surfaces[0].boundary.len(), 1);
        assert!(matches!(
            t.surfaces[0].boundary[0].geom,
            EdgeGeom::Spline { .. }
        ));
    }

    fn as_construction(mut e: InputEntity) -> InputEntity {
        e.construction = true;
        e
    }

    /// Coordinates of every emitted vertex, keyed by id, for the construction
    /// tests that pin which `_vN` slots the real geometry keeps.
    fn vert_map(t: &TopologyOut) -> HashMap<String, Vec2> {
        t.vertices.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    fn has_point(pts: &[(String, Vec2)], p: Vec2) -> bool {
        pts.iter()
            .any(|(_, v)| (v[0] - p[0]).abs() < 1e-6 && (v[1] - p[1]).abs() < 1e-6)
    }

    #[test]
    fn construction_corner_diagonal_adds_no_crossing() {
        // The frozen-fixture case: a construction diagonal whose endpoints are
        // already real corners contributes nothing, so the golden stays valid.
        let mut geom = square(2.0);
        geom.push(("diag".into(), as_construction(line([0.0, 0.0], [2.0, 2.0]))));
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            1,
            "the construction diagonal does not divide the face"
        );
        assert_eq!(t.intersection_points.len(), 0);
        assert_eq!(t.vertices.len(), 4);
        assert_eq!(t.edges.len(), 4);
    }

    #[test]
    fn construction_crossbar_yields_two_snap_points_and_one_face() {
        // The headline regression: the crossings come back as snap points while
        // the sides they cross stay single edges (the Design-B parity pin).
        let mut geom = square(2.0);
        geom.push(("bar".into(), as_construction(line([-1.0, 1.0], [3.0, 1.0]))));
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            1,
            "a construction line never splits a face"
        );
        assert_eq!(t.intersection_points.len(), 2);
        assert!(has_point(&t.intersection_points, [0.0, 1.0]));
        assert!(has_point(&t.intersection_points, [2.0, 1.0]));
        assert_eq!(t.edges.len(), 4, "the crossed sides are not over-segmented");
        assert_eq!(t.vertices.len(), 6, "four corners plus two crossings");
    }

    #[test]
    fn construction_crossbar_does_not_renumber_real_vertices() {
        // Construction crossings are minted last, so the real corners hold the
        // same `_vN` slots whatever position the construction line takes in the
        // input list. Saved queries against `_v0.._v3` keep resolving.
        // The slot-by-slot mapping `square()`'s endpoint seeding produces, not
        // merely "some corner": a swap of _v0 and _v2 IS the renumbering this
        // test exists to catch.
        let corners: [(&str, Vec2); 4] = [
            ("_v0", [0.0, 0.0]),
            ("_v1", [2.0, 0.0]),
            ("_v2", [2.0, 2.0]),
            ("_v3", [0.0, 2.0]),
        ];
        let bar = (
            "bar".to_string(),
            as_construction(line([-1.0, 1.0], [3.0, 1.0])),
        );

        let mut appended = square(2.0);
        appended.push(bar.clone());
        let mut prepended = vec![bar];
        prepended.extend(square(2.0));

        for geom in [appended, prepended] {
            let vm = vert_map(&detect_topology(&geom));
            assert_eq!(
                vm.len(),
                6,
                "four corners plus the two crossings, nothing else"
            );
            for (id, corner) in corners {
                let v = vm.get(id).unwrap_or_else(|| panic!("{id} missing"));
                assert!(
                    (corner[0] - v[0]).abs() < 1e-9 && (corner[1] - v[1]).abs() < 1e-9,
                    "{id} moved to {v:?}, expected {corner:?}"
                );
            }
            // The crossings take the slots after the real geometry, in either order.
            let mut minted = [vm["_v4"], vm["_v5"]];
            minted.sort_by(|p, q| p[0].total_cmp(&q[0]));
            assert!(
                (minted[0][0]).abs() < 1e-9 && (minted[0][1] - 1.0).abs() < 1e-9,
                "_v4/_v5 hold (0,1)"
            );
            assert!(
                (minted[1][0] - 2.0).abs() < 1e-9 && (minted[1][1] - 1.0).abs() < 1e-9,
                "_v4/_v5 hold (2,1)"
            );
        }
    }

    #[test]
    fn construction_circle_alone_emits_nothing() {
        let geom = vec![("c0".into(), as_construction(circle([0.0, 0.0], 1.0)))];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 0);
        assert_eq!(t.intersection_points.len(), 0);
        assert_eq!(t.edges.len(), 0);
        assert_eq!(t.vertices.len(), 0);
    }

    #[test]
    fn construction_circle_crossing_line_yields_two_snap_points_no_face() {
        // A pitch or clearance circle: its rim crossings are exactly the points
        // a user aligns to, and the line it crosses stays one edge.
        let geom = vec![
            ("l0".into(), line([-2.0, 0.0], [2.0, 0.0])),
            ("c0".into(), as_construction(circle([0.0, 0.0], 1.0))),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 0);
        assert_eq!(t.intersection_points.len(), 2);
        assert!(has_point(&t.intersection_points, [1.0, 0.0]));
        assert!(has_point(&t.intersection_points, [-1.0, 0.0]));
        assert_eq!(
            t.edges.len(),
            1,
            "the real line is not split by the construction rim"
        );
    }

    #[test]
    fn two_crossing_construction_lines_yield_one_snap_point() {
        // The crossing of two centerlines is a legitimate reference point even
        // though neither line is real geometry.
        let geom = vec![
            ("x".into(), as_construction(line([0.0, 0.0], [2.0, 2.0]))),
            ("y".into(), as_construction(line([0.0, 2.0], [2.0, 0.0]))),
        ];
        let t = detect_topology(&geom);
        assert_eq!(t.surfaces.len(), 0);
        assert_eq!(t.intersection_points.len(), 1);
        assert!(has_point(&t.intersection_points, [1.0, 1.0]));
        assert_eq!(t.edges.len(), 0);
    }

    #[test]
    fn construction_arc_crosses_line_only_inside_its_sweep() {
        // The crossing pass must reuse `angle_in_arc`, so the half of the full
        // circle the arc does not sweep yields nothing. Built inline rather than
        // through the `arc()` helper, which pins `end` at 180 degrees whatever
        // `angle_end` says.
        let quarter = as_construction(InputEntity {
            center: Some([0.0, 0.0]),
            radius: Some(1.0),
            start: Some([1.0, 0.0]),
            end: Some([0.0, 1.0]),
            angle_start: Some(0.0),
            angle_end: Some(90.0),
            ..Default::default()
        });
        let inside = vec![
            ("l0".into(), line([0.5, -2.0], [0.5, 2.0])),
            ("a0".into(), quarter.clone()),
        ];
        let t = detect_topology(&inside);
        assert_eq!(
            t.intersection_points.len(),
            1,
            "only the first-quadrant crossing is on the arc"
        );
        assert!(has_point(&t.intersection_points, [0.5, (0.75f64).sqrt()]));

        let outside = vec![
            ("l0".into(), line([-2.0, -0.5], [2.0, -0.5])),
            ("a0".into(), quarter),
        ];
        assert_eq!(
            detect_topology(&outside).intersection_points.len(),
            0,
            "crossings past the sweep end are not snap points"
        );
    }

    #[test]
    fn construction_ellipse_crossing_is_clipped_to_the_line_segment() {
        // The `intersect_curves` half of the pass, which had no construction
        // coverage at all. The conic meets the line's infinite extension at
        // (4,0) and (-4,0); only (4,0) is on the drawn segment, and a snap point
        // off the end of the line the user drew would be a phantom.
        let geom = vec![
            ("l0".into(), line([2.5, 0.0], [10.0, 0.0])),
            (
                "e0".into(),
                as_construction(ellipse([0.0, 0.0], 4.0, 2.0, 0.0)),
            ),
        ];
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            0,
            "a construction ellipse encloses nothing"
        );
        assert_eq!(t.intersection_points.len(), 1);
        assert!(has_point(&t.intersection_points, [4.0, 0.0]));
        assert_eq!(
            t.edges.len(),
            1,
            "the real line is not split by the construction conic"
        );
    }

    #[test]
    fn construction_arc_crossing_a_real_ellipse_is_clipped_to_its_sweep() {
        // The clip `hit_on_entity` actually performs: a circle of radius 3 meets this
        // ellipse in all four quadrants, and the quarter arc claims only the
        // first. The real ellipse keeps its face and stays one edge.
        let quarter = as_construction(InputEntity {
            center: Some([0.0, 0.0]),
            radius: Some(3.0),
            start: Some([3.0, 0.0]),
            end: Some([0.0, 3.0]),
            angle_start: Some(0.0),
            angle_end: Some(90.0),
            ..Default::default()
        });
        let geom = vec![
            ("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 0.0)),
            ("a0".into(), quarter),
        ];
        let t = detect_topology(&geom);
        assert_eq!(
            t.surfaces.len(),
            1,
            "the real ellipse still encloses its area"
        );
        assert_eq!(
            t.intersection_points.len(),
            1,
            "only the first-quadrant crossing is on the arc"
        );
        let (x, y) = (f64::sqrt(20.0 / 3.0), f64::sqrt(7.0 / 3.0));
        assert!(has_point(&t.intersection_points, [x, y]));
    }
}
