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
//!
//! The implementation is split by concern: `intersect` holds the pairwise
//! intersection primitives and the entity classifier, `build` seeds splits and
//! assembles the half-edge graph, `trace` walks face cycles and builds standalone
//! surfaces, and this module owns the shared types plus the `detect_topology`
//! entry point that drives them.

use std::collections::{HashMap, HashSet};

use super::profile_loops::{BoundaryEdge, EdgeGeom, Vec2};
use super::{
    TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE, TOL_TOPOLOGY_SPLIT as SPLIT_EPS, TWO_PI,
};
use crate::radians;

mod build;
mod intersect;
mod trace;

#[cfg(test)]
mod tests;

use build::{
    add_curve_intersections, build_half_edge_graph, find_all_intersections, normalize_arc_spans,
    normalize_arcs_and_init_splits, seed_construction_crossings, tag_entities,
};
use intersect::classify;
use trace::{
    build_edge_queries, build_standalone_ellipses, build_standalone_splines,
    build_standalone_surfaces, nest_surfaces, trace_face_cycles,
};

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
/// `richGeom` dict `enrichSketchEntity` produces. This is the DECODE ADAPTER:
/// `codec` fills it straight from JSON and `detect_topology` still accepts it,
/// but every record is converted to a `TopoEntity` before any geometry runs, so
/// the optional fields never reach the topology passes.
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

/// One classified, geometrically complete sketch entity. The variant is the
/// kind and each variant carries exactly the fields that kind's geometry pass
/// reads, so an entity cannot reach the builders truncated: the `Option` unwraps
/// the passes used to need are gone because the type cannot express the missing
/// state. `TryFrom<InputEntity>` is the only door in; it classifies by the same
/// discriminating fields `classifyEntities` uses and drops a record missing a
/// required field, so an incomplete entity contributes no edges rather than
/// killing the solve.
#[derive(Clone, Debug, PartialEq)]
enum TopoEntity {
    Line {
        construction: bool,
        start: Vec2,
        end: Vec2,
    },
    Circle {
        construction: bool,
        center: Vec2,
        radius: f64,
    },
    Arc {
        construction: bool,
        center: Vec2,
        radius: f64,
        angle_start: f64,
        angle_end: f64,
        start: Vec2,
        end: Vec2,
    },
    Spline {
        construction: bool,
        start: Vec2,
        c1: Vec2,
        c2: Vec2,
        end: Vec2,
    },
    Ellipse {
        construction: bool,
        center: Vec2,
        a: f64,
        b: f64,
        // Genuinely optional: an unrotated ellipse omits it.
        theta: Option<f64>,
    },
}

impl TopoEntity {
    fn construction(&self) -> bool {
        match *self {
            TopoEntity::Line { construction, .. }
            | TopoEntity::Circle { construction, .. }
            | TopoEntity::Arc { construction, .. }
            | TopoEntity::Spline { construction, .. }
            | TopoEntity::Ellipse { construction, .. } => construction,
        }
    }
}

/// Marker error: the decoded record was missing a field its kind requires.
#[derive(Debug)]
struct IncompleteEntity;

impl TryFrom<InputEntity> for TopoEntity {
    type Error = IncompleteEntity;

    /// Classify by the same discriminating fields the old stringly-typed
    /// `classifyEntities` path used (`kind == "spline"` first, then ellipse,
    /// then arc by start+radius, then line by start, then circle by center),
    /// then require the full field set for that kind. A record missing a
    /// required field is dropped, never demoted to a neighbouring kind.
    fn try_from(e: InputEntity) -> Result<Self, IncompleteEntity> {
        let construction = e.construction;
        if e.kind.as_deref() == Some("spline") {
            let (Some(start), Some(c1), Some(c2), Some(end)) = (e.start, e.c1, e.c2, e.end) else {
                return Err(IncompleteEntity);
            };
            return Ok(TopoEntity::Spline {
                construction,
                start,
                c1,
                c2,
                end,
            });
        }
        if e.kind.as_deref() == Some("ellipse") {
            let (Some(center), Some(a), Some(b)) = (e.center, e.a, e.b) else {
                return Err(IncompleteEntity);
            };
            return Ok(TopoEntity::Ellipse {
                construction,
                center,
                a,
                b,
                theta: e.theta,
            });
        }
        if e.start.is_some() && e.radius.is_some() {
            let (
                Some(center),
                Some(radius),
                Some(start),
                Some(end),
                Some(angle_start),
                Some(angle_end),
            ) = (
                e.center,
                e.radius,
                e.start,
                e.end,
                e.angle_start,
                e.angle_end,
            )
            else {
                return Err(IncompleteEntity);
            };
            return Ok(TopoEntity::Arc {
                construction,
                center,
                radius,
                angle_start,
                angle_end,
                start,
                end,
            });
        }
        if e.start.is_some() {
            let (Some(start), Some(end)) = (e.start, e.end) else {
                return Err(IncompleteEntity);
            };
            return Ok(TopoEntity::Line {
                construction,
                start,
                end,
            });
        }
        if e.center.is_some() {
            let (Some(center), Some(radius)) = (e.center, e.radius) else {
                return Err(IncompleteEntity);
            };
            return Ok(TopoEntity::Circle {
                construction,
                center,
                radius,
            });
        }
        Err(IncompleteEntity)
    }
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
        let TopoEntity::Line { start, end, .. } = *e else {
            continue;
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
        let TopoEntity::Spline { start, end, .. } = *e else {
            continue;
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

    let mut elist: Vec<(String, TopoEntity)> = Vec::new();
    elist.extend(cls.lines.iter().cloned());
    elist.extend(cls.circles.iter().cloned());
    elist.extend(arcs.iter().cloned());
    find_all_intersections(&elist, &mut splits, &mut verts, &arc_a0);

    // Second pass: every pair involving an ellipse or a spline.
    let tagged = tag_entities(&cls, &arcs);
    add_curve_intersections(&tagged, &mut splits, &mut verts, &arc_a0);

    if !con.is_empty() {
        let mut c_arcs = con.arcs.clone();
        normalize_arc_spans(&mut c_arcs);
        let c_tagged = tag_entities(&con, &c_arcs);
        seed_construction_crossings(&tagged, &c_tagged, &mut verts);
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
