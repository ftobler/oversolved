//! Post-solve surface detection, ported from the geometry pipeline of the
//! former `frontend/src/kernel/topology.ts` (`detectTopology`, deleted once
//! this port reached parity). Pairwise intersections
//! -> entity splitting -> planar half-edge DCEL -> face-cycle traversal -> CCW
//! bounded surfaces, plus standalone closed loops and hole nesting. Which of
//! those bounded faces are fillable is the even/odd rule over the closed
//! carriers (`holes`): the interiors of nested shells alternate material and
//! hole, so a washer sliced across yields its two ring halves rather than four
//! regions, and the bore's halves are published as `hole_regions` instead of
//! surfaces (an untouched shell keeps the standalone model, where its bore is
//! its own selectable area). A face no chain holds is a void (`void_regions`),
//! and an exterior-facing face is always material.
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
use crate::fit_spline::FitSpline;
use crate::radians;

mod build;
mod chains;
mod contacts;
mod holes;
mod intersect;
mod trace;

#[cfg(test)]
mod tests;

use build::{
    add_curve_intersections, add_fit_spline_self_intersections, add_spline_self_intersections,
    build_half_edge_graph, find_all_intersections, init_arc_splits, seed_construction_crossings,
    tag_entities,
};
use chains::{authored_chains, split_chains, FaceMeta};
use contacts::End;
use holes::split_hole_faces;
use intersect::classify;
use trace::{
    build_edge_queries, build_standalone_ellipses, build_standalone_fit_splines,
    build_standalone_splines, build_standalone_surfaces, nest_surfaces, trace_face_cycles_detailed,
};

// The two near-tangency rules the area builder applies -- the gap budget for a
// miss and the root-separation collapse for a pair of analytic roots -- are the
// resolution-derived pair `tolerance::tangent_gap_tol` / `tangent_collapse_tol`.
// Both are relative to the smaller characteristic radius of the pair, for the
// reason stated there: a tangency's ambiguity is a world distance on the curve
// the constraint drove, not on the sketch, and a fixed world budget would
// swallow real features on a small sketch and be lost in the solver's noise on
// a large one.

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
    /// Fit-spline input: the fit points in order, plus the optional handles as
    /// absolute points (D2). The chain is built in `TryFrom<InputEntity>`.
    pub points: Option<Vec<Vec2>>,
    pub handle_start: Option<Vec2>,
    pub handle_end: Option<Vec2>,
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
    /// An interpolating fit spline, kept as one entity: the chain is its own
    /// geometry and every pass reads the pieces from `curve`, so a run between
    /// two real intersections is one edge and the piece joints are never
    /// vertices at all.
    FitSpline {
        construction: bool,
        curve: FitSpline,
    },
}

impl TopoEntity {
    fn construction(&self) -> bool {
        match *self {
            TopoEntity::Line { construction, .. }
            | TopoEntity::Circle { construction, .. }
            | TopoEntity::Arc { construction, .. }
            | TopoEntity::Spline { construction, .. }
            | TopoEntity::Ellipse { construction, .. }
            | TopoEntity::FitSpline { construction, .. } => construction,
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
        if e.kind.as_deref() == Some("fit_spline") {
            let Some(points) = e.points else {
                return Err(IncompleteEntity);
            };
            let curve = FitSpline::new(&points, e.handle_start, e.handle_end)
                .map_err(|_| IncompleteEntity)?;
            return Ok(TopoEntity::FitSpline {
                construction,
                curve,
            });
        }
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

// ─── Declared contacts (the author's constraints, lowered) ───

/// One operand of a declared contact. `point` is `Some("start" | "end")` only
/// for an entity ENDPOINT; a bare ref (`None`) names the whole curve as a
/// locus, which is how a point-on-curve coincident and every tangent operand
/// arrive.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ContactRef {
    pub entity: String,
    pub point: Option<String>,
}

/// What the author declared between the two operands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ContactKind {
    /// A vertex-vertex coincident: the two endpoints are ONE vertex whatever
    /// the solver's realised gap, up to the sketch's verdict width.
    #[default]
    Join,
    /// A point-on-curve coincident: the endpoint is split onto the host curve
    /// at the foot of its closest approach (the T-junction).
    On,
    /// A tangent. `join` is true when a Join already ties the two curves at
    /// their shared endpoint (the contact is AT the joint), false for a free
    /// tangency.
    Tangent { join: bool },
}

/// One declared contact lowered from the document's constraints. The area
/// builder reads these INSTEAD of trusting the solver's numerics: the solver
/// satisfies a coincidence to its own width, which at a large sketch is wider
/// than the builder's absolute merge, and a converged tangency is zero or two
/// intersections, never one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Contact {
    /// The authored constraint id, so an unmet contact can be named in the
    /// feature's error instead of an anonymous gap.
    pub id: String,
    pub kind: ContactKind,
    pub a: ContactRef,
    pub b: ContactRef,
}

/// A declared contact the geometry did not actually meet: the realised gap
/// exceeds the sketch's verdict width, so the builder refuses to weld it and
/// reports it instead of papering over the miss.
#[derive(Clone, Debug, PartialEq)]
pub struct UnmetContact {
    pub id: String,
    pub a: Vec2,
    pub b: Vec2,
    pub gap: f64,
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
    /// The traced DCEL faces the even/odd rule reads as holes (their region is
    /// the interior of a shell nested in another shell, see `holes`). They are
    /// part of the planar subdivision but are not fillable, so they are not
    /// surfaces; they are published for the oracle, which counts them in the
    /// Euler identity and checks their cells stay empty.
    pub hole_regions: Vec<SurfaceOut>,
    /// The traced faces the material rule reads as void: regions fenced off by
    /// material on every side and inside no drawn loop (the centre of a frame
    /// of four rectangles, the gap between three tangent circles). They are
    /// part of the planar subdivision for the same reason as `hole_regions`,
    /// but never fillable. Deliberately not serialized: the TS side sees only
    /// `surfaces`, so a void is simply absent from the profile.
    // The only reader is the test oracle, which the production build does not
    // compile, so the dead-code lint has to be relaxed there.
    #[cfg_attr(not(any(test, feature = "fuzz")), allow(dead_code))]
    pub void_regions: Vec<SurfaceOut>,
    /// Declared contacts the realised geometry did not meet (the gap exceeded
    /// the sketch's verdict width). They are NOT welded, so the loop they were
    /// meant to close stays open; the downstream error names them instead of
    /// the anonymous "nearest open ends" pair.
    pub unmet_contacts: Vec<UnmetContact>,
}

// ─── small helpers ───

fn degrees(rad: f64) -> f64 {
    rad * 180.0 / std::f64::consts::PI
}
/// Python float modulo (result takes the sign of the divisor).
pub fn pymod(a: f64, b: f64) -> f64 {
    ((a % b) + b) % b
}

/// True when an arc's stored angles coincide modulo a turn, which the builder
/// reads as the whole circle (every angle is on it). Shared by `angle_in_arc`
/// and the split-span check so the two never disagree about which arcs have no
/// endpoints to clip at.
fn arc_is_full_turn(start_deg: f64, end_deg: f64) -> bool {
    let s = pymod(radians(start_deg), TWO_PI);
    let e = pymod(radians(end_deg), TWO_PI);
    (s - e).abs() < EPS || (s - e).abs() > TWO_PI - EPS
}

fn angle_in_arc(a_rad: f64, r: f64, start_deg: f64, end_deg: f64) -> bool {
    if arc_is_full_turn(start_deg, end_deg) {
        return true;
    }
    let s = pymod(radians(start_deg), TWO_PI);
    let e = pymod(radians(end_deg), TWO_PI);
    let a = pymod(a_rad, TWO_PI);
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

/// The merged vertex pool, kept in insertion order. A point within MERGE of two
/// registered vertices joins the one registered first; scanning a `HashMap`
/// instead let its randomized iteration order pick, so the same sketch could
/// name its vertices differently from run to run.
#[derive(Clone)]
struct Verts {
    pts: Vec<(String, Vec2)>,
    index: HashMap<String, usize>,
}
impl Verts {
    fn new() -> Self {
        Verts {
            pts: Vec::new(),
            index: HashMap::new(),
        }
    }
    /// Merge a point into the pool, returning its `_vN` id (mirrors `vid`).
    fn vid(&mut self, pt: Vec2) -> String {
        for (k, v) in &self.pts {
            if (v[0] - pt[0]).powi(2) + (v[1] - pt[1]).powi(2) < MERGE * MERGE {
                return k.clone();
            }
        }
        let k = format!("_v{}", self.pts.len());
        self.index.insert(k.clone(), self.pts.len());
        self.pts.push((k.clone(), [pt[0], pt[1]]));
        k
    }
    /// Look up a registered vertex. Returns `None` for an unknown id instead of
    /// aborting: a half-edge naming a vertex that is not in the pool bounds no
    /// area, and the worker must survive that rather than trap.
    fn get(&self, k: &str) -> Option<Vec2> {
        self.index.get(k).map(|&i| self.pts[i].1)
    }
    /// The id of the vertex at `pt` under the merge identity, without minting
    /// one. The drawn-loop builder reads authored endpoints after the graph is
    /// built and must not extend the pool (that would change the published
    /// vertex order).
    fn find(&self, pt: Vec2) -> Option<&str> {
        self.pts
            .iter()
            .find(|(_, v)| (v[0] - pt[0]).powi(2) + (v[1] - pt[1]).powi(2) < MERGE * MERGE)
            .map(|(k, _)| k.as_str())
    }
    fn keys(&self) -> HashSet<String> {
        self.index.keys().cloned().collect()
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

pub fn detect_topology(geometry: &[(String, InputEntity)], contacts: &[Contact]) -> TopologyOut {
    // Construction entities are split off here and rejoin only in the crossing
    // pass below, so every stage that builds real geometry sees exactly the list
    // it saw when `classify` dropped them outright.
    let (cls, con) = classify(geometry).split_construction();
    let mut contact_plan = contacts::plan(geometry, &cls, contacts);

    let mut verts = Verts::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();
    // The vertex each declared endpoint was registered at, so an `on` contact
    // can weld its host split to that same vertex.
    let mut end_vids: HashMap<contacts::EndKey, String> = HashMap::new();

    for (eid, e) in &cls.lines {
        let TopoEntity::Line { start, end, .. } = *e else {
            continue;
        };
        let vs = verts.vid(contact_plan.pos(eid, End::Start, start));
        let ve = verts.vid(contact_plan.pos(eid, End::End, end));
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::Start,
            },
            vs.clone(),
        );
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::End,
            },
            ve.clone(),
        );
        splits.insert(eid.clone(), vec![(0.0, vs), (1.0, ve)]);
    }

    for (eid, _) in &cls.circles {
        splits.insert(eid.clone(), vec![]);
    }

    // Seed arc vertex registration with line-endpoint data so coincident arc/line
    // endpoints share vertex ids, then merge new arc vertices back.
    let mut arc_verts = verts.clone();
    let (a0_from_norm, arc_splits, arcs) =
        init_arc_splits(&cls.arcs, &mut arc_verts, &contact_plan);
    for (k, v) in a0_from_norm {
        arc_a0.insert(k, v);
    }
    for (k, v) in arc_splits {
        splits.insert(k, v);
    }
    // `arc_verts` started as a copy of `verts` and only ever appended to it,
    // so it already is the merged pool.
    verts = arc_verts;
    for (eid, e) in &arcs {
        let TopoEntity::Arc { start, end, .. } = *e else {
            continue;
        };
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::Start,
            },
            verts.vid(contact_plan.pos(eid, End::Start, start)),
        );
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::End,
            },
            verts.vid(contact_plan.pos(eid, End::End, end)),
        );
    }

    for (eid, e) in &cls.splines {
        let TopoEntity::Spline { start, end, .. } = *e else {
            continue;
        };
        let vs = verts.vid(contact_plan.pos(eid, End::Start, start));
        let ve = verts.vid(contact_plan.pos(eid, End::End, end));
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::Start,
            },
            vs.clone(),
        );
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::End,
            },
            ve.clone(),
        );
        splits.insert(eid.clone(), vec![(0.0, vs), (1.0, ve)]);
    }

    // A fit spline's split parameter is piece-space: `piece + t`, so a run
    // between two real contacts is a contiguous sub-chain. The piece joints are
    // not split params, which is why they never become vertices or edges.
    for (eid, e) in &cls.fit_splines {
        let TopoEntity::FitSpline { curve, .. } = e else {
            continue;
        };
        let start = curve.eval(curve.knots()[0]);
        let end = curve.eval(curve.knots()[curve.point_count() - 1]);
        let vs = verts.vid(contact_plan.pos(eid, End::Start, start));
        let ve = verts.vid(contact_plan.pos(eid, End::End, end));
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::Start,
            },
            vs.clone(),
        );
        end_vids.insert(
            contacts::EndKey {
                eid: eid.clone(),
                end: End::End,
            },
            ve.clone(),
        );
        splits.insert(
            eid.clone(),
            vec![(0.0, vs), (curve.piece_count() as f64, ve)],
        );
    }

    for (eid, _) in &cls.ellipses {
        splits.insert(eid.clone(), vec![]);
    }

    // A declared point-on-curve contact splits its host at the foot and welds
    // the endpoint's vertex there. It runs after every endpoint is registered,
    // before the pairwise passes, so no intersection can mint a competing
    // vertex first.
    for on in &contact_plan.ons {
        let Some(vid) = end_vids.get(&on.endpoint) else {
            continue;
        };
        let Some(spl) = splits.get_mut(&on.host) else {
            continue;
        };
        let mut p = on.param;
        if let Some(a0) = arc_a0.get(&on.host) {
            p = norm_arc_param(p, *a0);
        }
        // Weld, not just add: if the host already has a split at this foot (its
        // own endpoint, or a contact seeded earlier) the declared endpoint takes
        // that vertex's identity.
        if let Some(existing) = spl.iter_mut().find(|(s, _)| (s - p).abs() < SPLIT_EPS) {
            existing.1 = vid.clone();
        } else {
            spl.push((p, vid.clone()));
        }
    }

    let endpoint_vids = verts.keys();

    // A spline's own crossing is geometry no other entity can supply, so it is
    // seeded before the pairwise passes add their contacts. It runs after
    // `endpoint_vids` is captured: a crossing is a real intersection point for
    // the snapshot list, not an endpoint.
    let lobe_vertex = add_spline_self_intersections(&cls.splines, &mut splits, &mut verts);
    let fit_lobes = add_fit_spline_self_intersections(&cls.fit_splines, &mut splits, &mut verts);

    let mut elist: Vec<(String, TopoEntity)> = Vec::new();
    elist.extend(cls.lines.iter().cloned());
    elist.extend(cls.circles.iter().cloned());
    elist.extend(arcs.iter().cloned());
    find_all_intersections(&elist, &mut splits, &mut verts, &arc_a0, &mut contact_plan);

    // Second pass: every pair involving an ellipse or a spline.
    let tagged = tag_entities(&cls, &arcs);
    add_curve_intersections(&tagged, &mut splits, &mut verts, &arc_a0, &mut contact_plan);

    if !con.is_empty() {
        let c_arcs = con.arcs.clone();
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
        &cls.fit_splines,
        &cls.ellipses,
        &lobe_vertex,
        &fit_lobes,
    );

    // The even/odd rule classifies every face, traced or standalone: an
    // UNcut shell whose interior is inside a cut shell's bore is a hole too
    // (the standalone island survives only where no cut shell surrounds it).
    let (mut faces, mut metas) = trace_face_cycles_detailed(&hes, &he_eid, &verts);
    faces.extend(build_standalone_surfaces(&cls.circles, &splits));
    faces.extend(build_standalone_ellipses(&cls.ellipses, &splits));
    faces.extend(build_standalone_splines(&cls.splines, &splits, &mut verts));
    faces.extend(build_standalone_fit_splines(
        &cls.fit_splines,
        &splits,
        &mut verts,
    ));
    // Standalone loops are drawn areas in their own right; their shells decide
    // the fill, so they need no material probe.
    metas.resize(faces.len(), FaceMeta::default());

    // The loops the lines and arcs draw. Only they can say whether a face the
    // carriers do not cover is a drawn region or a void the arrangement fenced
    // off between loops.
    let line_arc_ids: HashSet<&str> = cls
        .lines
        .iter()
        .chain(arcs.iter())
        .map(|(id, _)| id.as_str())
        .collect();
    // Two views of the drawn loops: whole entities joined at their authored
    // endpoints (a crossing does not cut them) and split pieces joined at
    // merged vertices (a loop that closes at a mid-entity contact).
    let mut drawn = authored_chains(&cls.lines, &arcs, &verts);
    drawn.extend(split_chains(&hes, &he_eid, &line_arc_ids));

    let (mut surfaces, hole_shells, void_regions) = split_hole_faces(
        faces,
        &metas,
        &he_eid,
        &cls.circles,
        &cls.ellipses,
        &cls.splines,
        &splits,
        &drawn,
    );
    let hole_regions: Vec<SurfaceOut> = hole_shells
        .iter()
        .flat_map(|s| s.regions.iter().cloned())
        .collect();
    surfaces = nest_surfaces(surfaces, &hole_shells);

    let edges = build_edge_queries(&hes, &he_eid);

    let mut intersection_points: Vec<(String, Vec2)> = Vec::new();
    let mut vertices: Vec<(String, Vec2)> = Vec::new();
    for (k, v) in &verts.pts {
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
        hole_regions,
        void_regions,
        unmet_contacts: contact_plan.unmet,
    }
}
