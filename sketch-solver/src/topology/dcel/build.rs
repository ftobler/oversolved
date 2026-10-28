use std::collections::{HashMap, HashSet};

use super::super::curve_intersect::{bezier_self_crossing, intersect_curves, Curve};
use super::super::curve_split::{ellipse_point_at, subdivide_bezier, BezierCtrl};
use super::super::profile_loops::{EdgeGeom, Vec2};
use super::super::{
    TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE, TOL_TOPOLOGY_SPLIT as SPLIT_EPS, TWO_PI,
};
use super::intersect::{collinear_overlap, intersect, Classified};
use super::{
    angle_in_arc, arc_is_full_turn, arc_tangent, dedup, degrees, has_param, norm_arc_param, Split,
    TopoEntity, Verts,
};
use crate::fit_spline::FitSpline;
use crate::radians;

// ─── Half-edge geometry constructors ───

/// These take the concrete geometry rather than the entity: callers destructure
/// the `TopoEntity` first, so the field presence is checked once at the call and
/// the constructors cannot receive a half-built curve.
fn line_eg(p1: Vec2, p2: Vec2, t0: f64, t1: f64) -> EdgeGeom {
    EdgeGeom::Line {
        start: [p1[0] + t0 * (p2[0] - p1[0]), p1[1] + t0 * (p2[1] - p1[1])],
        end: [p1[0] + t1 * (p2[0] - p1[0]), p1[1] + t1 * (p2[1] - p1[1])],
    }
}

fn arc_eg(c: Vec2, r: f64, a0: f64, a1: f64, ccw: bool) -> EdgeGeom {
    EdgeGeom::Arc {
        center: [c[0], c[1]],
        radius: r,
        angle_start_deg: degrees(a0),
        angle_end_deg: degrees(a1),
        ccw,
        start: [c[0] + r * a0.cos(), c[1] + r * a0.sin()],
        end: [c[0] + r * a1.cos(), c[1] + r * a1.sin()],
    }
}

fn spline_eg(start: Vec2, c1: Vec2, c2: Vec2, end: Vec2) -> EdgeGeom {
    EdgeGeom::Spline { start, c1, c2, end }
}

fn sub_spline_eg(ctrl: &BezierCtrl) -> EdgeGeom {
    EdgeGeom::Spline {
        start: ctrl[0],
        c1: ctrl[1],
        c2: ctrl[2],
        end: ctrl[3],
    }
}

/// The geometry of a fit-spline span between two piece-space parameters. The
/// chain's own `sub_chain` does the de Casteljau splits, so a cut end piece is
/// the same curve as the parent's.
fn fit_spline_eg(curve: &FitSpline, s0: f64, s1: f64) -> EdgeGeom {
    let (poles, knots) = curve.sub_chain(curve.u_at(s0), curve.u_at(s1));
    EdgeGeom::FitSpline { poles, knots }
}

fn ellipse_arc_eg(
    c: Vec2,
    a: f64,
    b: f64,
    theta: f64,
    phi0: f64,
    phi1: f64,
    ccw: bool,
) -> EdgeGeom {
    let cr = (theta * std::f64::consts::PI / 180.0).cos();
    let sr = (theta * std::f64::consts::PI / 180.0).sin();
    EdgeGeom::EllipseArc {
        center: [c[0], c[1]],
        a,
        b,
        theta,
        angle_start_deg: degrees(phi0),
        angle_end_deg: degrees(phi1),
        ccw,
        start: ellipse_point_at([c[0], c[1]], a, b, cr, sr, phi0),
        end: ellipse_point_at([c[0], c[1]], a, b, cr, sr, phi1),
    }
}

pub(super) fn rev(eg: &EdgeGeom) -> EdgeGeom {
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
        EdgeGeom::FitSpline {
            ref poles,
            ref knots,
        } => {
            let u_max = *knots.last().unwrap_or(&0.0);
            EdgeGeom::FitSpline {
                poles: poles.iter().rev().copied().collect(),
                knots: knots.iter().rev().map(|u| u_max - u).collect(),
            }
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

pub(super) fn depart(eg: &EdgeGeom) -> f64 {
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
        EdgeGeom::FitSpline { ref poles, .. } => {
            let mut dx = poles[1][0] - poles[0][0];
            let mut dy = poles[1][1] - poles[0][1];
            if dx.abs() < EPS && dy.abs() < EPS {
                dx = poles[3][0] - poles[0][0];
                dy = poles[3][1] - poles[0][1];
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
pub(super) fn bend(eg: &EdgeGeom) -> f64 {
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
        EdgeGeom::FitSpline { ref poles, .. } => {
            let (p0, p1, p2) = (poles[0], poles[1], poles[2]);
            let d1 = [3.0 * (p1[0] - p0[0]), 3.0 * (p1[1] - p0[1])];
            let d2 = [
                6.0 * (p0[0] - 2.0 * p1[0] + p2[0]),
                6.0 * (p0[1] - 2.0 * p1[1] + p2[1]),
            ];
            let speed2 = d1[0] * d1[0] + d1[1] * d1[1];
            if speed2 < EPS {
                return 0.0;
            }
            (d1[0] * d2[1] - d1[1] * d2[0]) / speed2 * speed2.sqrt()
        }
    }
}

pub(super) type HalfEdge = (String, String, EdgeGeom);

/// Seed the arc split lists from the authored sweep. An arc is CCW from
/// `angle_start` to `angle_end`, and that span may exceed pi: forcing the minor
/// complement would close the same endpoints on the other side and could
/// publish a region that is not in the sketch (a projected long body arc inside
/// a cutout was the "ghost area" report).
#[allow(clippy::type_complexity)]
pub(super) fn init_arc_splits(
    arcs_in: &[(String, TopoEntity)],
    arc_verts: &mut Verts,
) -> (
    HashMap<String, f64>,
    HashMap<String, Vec<Split>>,
    Vec<(String, TopoEntity)>,
) {
    let arcs: Vec<(String, TopoEntity)> = arcs_in.to_vec();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();

    for (eid, e) in &arcs {
        let TopoEntity::Arc {
            angle_start,
            angle_end,
            start,
            end,
            ..
        } = e
        else {
            continue;
        };
        let a0 = radians(*angle_start);
        let a1 = norm_arc_param(radians(*angle_end), a0);
        arc_a0.insert(eid.clone(), a0);
        splits.insert(
            eid.clone(),
            vec![(a0, arc_verts.vid(*start)), (a1, arc_verts.vid(*end))],
        );
    }

    (arc_a0, splits, arcs)
}

pub(super) fn find_all_intersections(
    elist: &[(String, TopoEntity)],
    splits: &mut HashMap<String, Vec<Split>>,
    verts: &mut Verts,
    arc_a0: &HashMap<String, f64>,
) {
    for i in 0..elist.len() {
        let (eid_a, ea) = &elist[i];
        for (eid_b, eb) in elist.iter().skip(i + 1) {
            let mut results = intersect(ea, eb);
            if results.is_empty()
                && matches!(ea, TopoEntity::Line { .. })
                && matches!(eb, TopoEntity::Line { .. })
            {
                results = collinear_overlap(ea, eb);
            }
            for (mut pa, mut pb, pt) in results {
                let v = verts.vid(pt);
                let mut keep_a = true;
                let mut keep_b = true;
                if let Some(a0) = arc_a0.get(eid_a) {
                    pa = norm_arc_param(pa, *a0);
                    keep_a = within_arc_span(ea, pa, *a0);
                }
                if let Some(a0) = arc_a0.get(eid_b) {
                    pb = norm_arc_param(pb, *a0);
                    keep_b = within_arc_span(eb, pb, *a0);
                }
                // A missing split bucket means the entity was not seeded (a
                // construction or dropped entity); skip it rather than index.
                if let Some(spl) = splits.get(eid_a) {
                    if keep_a && !has_param(spl, pa) {
                        if let Some(s) = splits.get_mut(eid_a) {
                            s.push((pa, v.clone()));
                        }
                    }
                }
                if let Some(spl) = splits.get(eid_b) {
                    if keep_b && !has_param(spl, pb) {
                        if let Some(s) = splits.get_mut(eid_b) {
                            s.push((pb, v));
                        }
                    }
                }
            }
        }
    }
}

/// True when a normalized arc parameter is still on the AUTHORED span.
///
/// A hit that `angle_in_arc` accepted through its endpoint slack can normalize
/// to the far end of `norm_arc_param`'s window: a contact a hair BELOW `a0`
/// (the rounding of a line tangent at an arc's endpoint) lands at
/// `a0 + 2*pi - eps`, the same point but a different split. The half-edge build
/// then emits the span between that split and the authored end, i.e. the
/// complement: a 90 degree corner read as 270 and closed into a full circle
/// (the DB9 report at a non-origin placement). Splitting only where the
/// authored sweep allows keeps the two representations apart.
fn within_arc_span(e: &TopoEntity, p: f64, a0: f64) -> bool {
    match *e {
        TopoEntity::Arc {
            radius,
            angle_start,
            angle_end,
            ..
        } => {
            // An arc whose angles coincide modulo a turn is the whole circle to
            // `angle_in_arc`: `norm_arc_param` maps its end back onto `a0`, so
            // the span check would drop every hit it accepted.
            if arc_is_full_turn(angle_start, angle_end) {
                return true;
            }
            let raw = radians(angle_end);
            // The same endpoint slack `angle_in_arc` grants, in the same units:
            // the angular width of a MERGE-world chord at this radius, floored
            // at EPS. A contact inside that window still belongs to the corner.
            let slack = (MERGE / radius.max(EPS)).max(EPS);
            p <= norm_arc_param(raw, a0) + slack
        }
        _ => true,
    }
}

#[derive(Clone)]
pub(super) struct Tagged {
    eid: String,
    e: TopoEntity,
}

/// Lift a complete entity to the carrier curve the numeric intersector scans.
/// The variant is the kind, so the old kind-string dispatch and its `Option`
/// result are both gone.
fn to_curve(e: &TopoEntity) -> Curve {
    match *e {
        TopoEntity::Line { start, end, .. } => Curve::Line { p0: start, p1: end },
        TopoEntity::Circle { center, radius, .. } | TopoEntity::Arc { center, radius, .. } => {
            Curve::Circle {
                c: center,
                r: radius,
            }
        }
        TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } => Curve::Ellipse {
            c: center,
            a,
            b,
            theta: theta.unwrap_or(0.0),
        },
        TopoEntity::Spline {
            start, c1, c2, end, ..
        } => Curve::Bezier {
            p0: start,
            c1,
            c2,
            p3: end,
        },
        // A fit spline is a chain, not one curve; every caller that can see one
        // goes through `curves_of`. The first piece is the honest single-curve
        // answer if one ever reaches here.
        TopoEntity::FitSpline { ref curve, .. } => {
            let ctrl = curve.piece(0);
            Curve::Bezier {
                p0: ctrl[0],
                c1: ctrl[1],
                c2: ctrl[2],
                p3: ctrl[3],
            }
        }
    }
}

/// The carrier curves of an entity, each tagged with its piece index. A plain
/// entity has one piece at index 0; a fit spline has one per cubic.
fn curves_of(e: &TopoEntity) -> Vec<(usize, Curve)> {
    match e {
        TopoEntity::FitSpline { curve, .. } => (0..curve.piece_count())
            .map(|i| {
                let ctrl = curve.piece(i);
                (
                    i,
                    Curve::Bezier {
                        p0: ctrl[0],
                        c1: ctrl[1],
                        c2: ctrl[2],
                        p3: ctrl[3],
                    },
                )
            })
            .collect(),
        _ => vec![(0, to_curve(e))],
    }
}

/// Register a curve-intersection hit param into the per-kind split convention.
fn register_hit(
    entry: &Tagged,
    piece: usize,
    t: f64,
    v: &str,
    splits: &mut HashMap<String, Vec<Split>>,
    arc_a0: &HashMap<String, f64>,
) {
    let spl = match splits.get_mut(&entry.eid) {
        Some(s) => s,
        None => return,
    };
    match entry.e {
        TopoEntity::Line { .. } => {
            if !(-EPS..=1.0 + EPS).contains(&t) {
                return;
            }
            let tc = t.clamp(0.0, 1.0);
            if !has_param(spl, tc) {
                spl.push((tc, v.to_string()));
            }
        }
        TopoEntity::Spline { .. } => {
            if t <= SPLIT_EPS || t >= 1.0 - SPLIT_EPS {
                return; // endpoints already seeded
            }
            if !has_param(spl, t) {
                spl.push((t, v.to_string()));
            }
        }
        TopoEntity::FitSpline { ref curve, .. } => {
            // The fit-spline split convention is piece-space: `piece + t`, so a
            // run between two hits is a contiguous sub-chain.
            let s = piece as f64 + t;
            let last = curve.piece_count() as f64;
            if !(-EPS..=last + EPS).contains(&s) {
                return;
            }
            let s = s.clamp(0.0, last);
            if !has_param(spl, s) {
                spl.push((s, v.to_string()));
            }
        }
        TopoEntity::Circle { .. } => {
            let a = if t > std::f64::consts::PI {
                t - TWO_PI
            } else {
                t
            };
            if !has_param(spl, a) {
                spl.push((a, v.to_string()));
            }
        }
        TopoEntity::Ellipse { .. } => {
            if !has_param(spl, t) {
                spl.push((t, v.to_string()));
            }
        }
        TopoEntity::Arc {
            radius,
            angle_start,
            angle_end,
            ..
        } => {
            // arc: keep only hits within the arc span, normalized like the legacy pass.
            if !angle_in_arc(t, radius, angle_start, angle_end) {
                return;
            }
            let p = norm_arc_param(t, *arc_a0.get(&entry.eid).unwrap_or(&0.0));
            if !within_arc_span(&entry.e, p, *arc_a0.get(&entry.eid).unwrap_or(&0.0)) {
                return;
            }
            if !has_param(spl, p) {
                spl.push((p, v.to_string()));
            }
        }
    }
}

/// Split each spline at its own crossing. A cubic whose branches meet again
/// (a figure-eight) has no other entity there to mint the vertex, so without
/// this pass the DCEL sees no vertex at the crossing, the lobes never close,
/// and the curve encloses nothing. Both parameters take the SAME minted
/// vertex, and the returned map (spline id -> that vertex) is what lets the
/// half-edge build tell the lobe's self-loop span apart from a span whose two
/// contacts merely fused into one vertex (a near-tangency pair, which must
/// stay skipped rather than become a phantom sliver face).
pub(super) fn add_spline_self_intersections(
    splines: &[(String, TopoEntity)],
    splits: &mut HashMap<String, Vec<Split>>,
    verts: &mut Verts,
) -> HashMap<String, String> {
    let mut lobe_vertex: HashMap<String, String> = HashMap::new();
    for (eid, e) in splines {
        let TopoEntity::Spline {
            start, c1, c2, end, ..
        } = *e
        else {
            continue;
        };
        let Some(cross) = bezier_self_crossing(&[start, c1, c2, end]) else {
            continue;
        };
        let v = verts.vid(cross.point);
        // A missing split bucket means the entity was not seeded; skip it
        // rather than index.
        let Some(spl) = splits.get_mut(eid) else {
            continue;
        };
        for t in [cross.t_lo, cross.t_hi] {
            if !has_param(spl, t) {
                spl.push((t, v.clone()));
            }
        }
        lobe_vertex.insert(eid.clone(), v);
    }
    lobe_vertex
}

/// Split each fit spline at its own crossings. Non-adjacent pieces are ordinary
/// curve pairs, so a figure-eight through points slices into its lobes. The
/// returned map is the lobe-vertex set per entity, the fit-spline counterpart of
/// `add_spline_self_intersections`' single lobe vertex.
pub(super) fn add_fit_spline_self_intersections(
    fit_splines: &[(String, TopoEntity)],
    splits: &mut HashMap<String, Vec<Split>>,
    verts: &mut Verts,
) -> HashMap<String, HashSet<String>> {
    let mut lobes: HashMap<String, HashSet<String>> = HashMap::new();
    for (eid, e) in fit_splines {
        let TopoEntity::FitSpline { .. } = e else {
            continue;
        };
        let pieces = curves_of(e);
        for i in 0..pieces.len() {
            for j in (i + 2)..pieces.len() {
                for h in intersect_curves(&pieces[i].1, &pieces[j].1) {
                    let v = verts.vid(h.point);
                    let s_i = i as f64 + h.t_a;
                    let s_j = j as f64 + h.t_b;
                    if let Some(spl) = splits.get_mut(eid) {
                        if !has_param(spl, s_i) {
                            spl.push((s_i, v.clone()));
                        }
                        if !has_param(spl, s_j) {
                            spl.push((s_j, v.clone()));
                        }
                    }
                    lobes.entry(eid.clone()).or_default().insert(v);
                }
            }
        }
    }
    lobes
}

pub(super) fn add_curve_intersections(
    tagged: &[Tagged],
    splits: &mut HashMap<String, Vec<Split>>,
    verts: &mut Verts,
    arc_a0: &HashMap<String, f64>,
) {
    for i in 0..tagged.len() {
        for j in (i + 1)..tagged.len() {
            let a = &tagged[i];
            let b = &tagged[j];
            let involves_curve = matches!(
                a.e,
                TopoEntity::Ellipse { .. }
                    | TopoEntity::Spline { .. }
                    | TopoEntity::FitSpline { .. }
            ) || matches!(
                b.e,
                TopoEntity::Ellipse { .. }
                    | TopoEntity::Spline { .. }
                    | TopoEntity::FitSpline { .. }
            );
            if !involves_curve {
                continue;
            }
            let curves_a = curves_of(&a.e);
            let curves_b = curves_of(&b.e);
            for (piece_a, ca) in &curves_a {
                for (piece_b, cb) in &curves_b {
                    for h in intersect_curves(ca, cb) {
                        let v = verts.vid(h.point);
                        register_hit(a, *piece_a, h.t_a, &v, splits, arc_a0);
                        register_hit(b, *piece_b, h.t_b, &v, splits, arc_a0);
                    }
                }
            }
        }
    }
}

/// Tag the buckets with their `TopoEntity`, which already carries the kind.
/// `arcs` comes in separately because the caller supplies the classified arcs
/// (the construction pass tags its own copy).
pub(super) fn tag_entities(cls: &Classified, arcs: &[(String, TopoEntity)]) -> Vec<Tagged> {
    let mut tagged: Vec<Tagged> = Vec::new();
    let mut push = |src: &[(String, TopoEntity)]| {
        for (eid, e) in src {
            tagged.push(Tagged {
                eid: eid.clone(),
                e: e.clone(),
            });
        }
    };
    push(&cls.lines);
    push(&cls.circles);
    push(arcs);
    push(&cls.ellipses);
    push(&cls.splines);
    push(&cls.fit_splines);
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
    match entry.e {
        TopoEntity::Line { .. } | TopoEntity::Spline { .. } => (-EPS..=1.0 + EPS).contains(&t),
        TopoEntity::FitSpline { ref curve, .. } => {
            (-EPS..=curve.piece_count() as f64 + EPS).contains(&t)
        }
        TopoEntity::Arc {
            radius,
            angle_start,
            angle_end,
            ..
        } => angle_in_arc(t, radius, angle_start, angle_end),
        TopoEntity::Circle { .. } | TopoEntity::Ellipse { .. } => true, // closed: every parameter is on it
    }
}

/// Every point where `a` and `b` cross, taking the same two dispatch paths the
/// real passes take (`intersect` for line/circle/arc, `intersect_curves` once an
/// ellipse, spline or fit spline is involved) but yielding only world points.
fn crossing_points(a: &Tagged, b: &Tagged) -> Vec<Vec2> {
    let curve_pair = matches!(
        a.e,
        TopoEntity::Ellipse { .. } | TopoEntity::Spline { .. } | TopoEntity::FitSpline { .. }
    ) || matches!(
        b.e,
        TopoEntity::Ellipse { .. } | TopoEntity::Spline { .. } | TopoEntity::FitSpline { .. }
    );
    if curve_pair {
        let mut points = Vec::new();
        for (_, ca) in curves_of(&a.e) {
            for (_, cb) in curves_of(&b.e) {
                points.extend(
                    intersect_curves(&ca, &cb)
                        .into_iter()
                        .filter(|h| hit_on_entity(a, h.t_a) && hit_on_entity(b, h.t_b))
                        .map(|h| h.point),
                );
            }
        }
        return points;
    }
    intersect(&a.e, &b.e)
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
pub(super) fn seed_construction_crossings(real: &[Tagged], con: &[Tagged], verts: &mut Verts) {
    for (i, c) in con.iter().enumerate() {
        for other in real.iter().chain(con[i + 1..].iter()) {
            for pt in crossing_points(c, other) {
                verts.vid(pt);
            }
        }
    }
}

// Push one geometric edge as its two opposing half-edges (v0->v1 and v1->v0),
// tagging both with the owning entity id. Shared by every curve kind in
// build_half_edge_graph, which differ only in how they derive `eg`.
pub(super) fn push_half_edge_pair(
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
pub(super) fn build_half_edge_graph(
    lines: &[(String, TopoEntity)],
    circles: &[(String, TopoEntity)],
    arcs: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
    splines: &[(String, TopoEntity)],
    fit_splines: &[(String, TopoEntity)],
    ellipses: &[(String, TopoEntity)],
    lobe_vertex: &HashMap<String, String>,
    fit_lobes: &HashMap<String, HashSet<String>>,
) -> (Vec<HalfEdge>, Vec<String>) {
    let mut hes: Vec<HalfEdge> = Vec::new();
    let mut he_eid: Vec<String> = Vec::new();
    let mut seen_lines: HashSet<String> = HashSet::new();
    let empty: Vec<Split> = Vec::new();

    for (eid, e) in lines {
        let TopoEntity::Line { start, end, .. } = *e else {
            continue;
        };
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
            let eg = line_eg(start, end, *t0, *t1);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    for (eid, e) in arcs {
        let TopoEntity::Arc { center, radius, .. } = *e else {
            continue;
        };
        let spl = dedup(splits.get(eid).unwrap_or(&empty));
        for k in 0..spl.len().saturating_sub(1) {
            let (a0, v0) = &spl[k];
            let (a1, v1) = &spl[k + 1];
            if v0 == v1 {
                continue;
            }
            let eg = arc_eg(center, radius, *a0, *a1, true);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    // Circles and ellipses split the same way around a closed loop; only the
    // per-segment geometry constructor differs.
    for (eid, e) in circles {
        let TopoEntity::Circle { center, radius, .. } = *e else {
            continue;
        };
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
            let eg = arc_eg(center, radius, *a0, a1, true);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    for (eid, e) in ellipses {
        let TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } = *e
        else {
            continue;
        };
        let theta = theta.unwrap_or(0.0);
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
            let eg = ellipse_arc_eg(center, a, b, theta, *a0, a1, true);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    for (eid, e) in splines {
        let TopoEntity::Spline {
            start, c1, c2, end, ..
        } = *e
        else {
            continue;
        };
        let spl = dedup(splits.get(eid).unwrap_or(&empty));
        if spl.len() < 2 {
            continue;
        }
        let ctrl: BezierCtrl = [start, c1, c2, end];
        for k in 0..spl.len().saturating_sub(1) {
            let (t0, v0) = &spl[k];
            let (t1, v1) = &spl[k + 1];
            if t1 <= t0 {
                continue;
            }
            if v0 == v1 {
                // A span that ends on its own start vertex is the lobe between
                // a self-crossing's two parameters: emitted as a self-loop
                // half-edge pair (its twin walks the same piece backwards).
                // Any other fused pair is two contacts merged into one vertex
                // (a near tangency); the span between them is a phantom sliver
                // and stays skipped, as before. The whole closed curve (0..1
                // with start == end) is the standalone pass's singleton.
                let is_lobe =
                    lobe_vertex.get(eid).is_some_and(|v| v == v0) && !(*t0 <= 0.0 && *t1 >= 1.0);
                if !is_lobe {
                    continue;
                }
                let eg = sub_spline_eg(&subdivide_bezier(&ctrl, *t0, *t1));
                push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
                continue;
            }
            let eg = if *t0 <= 0.0 && *t1 >= 1.0 {
                spline_eg(start, c1, c2, end)
            } else {
                sub_spline_eg(&subdivide_bezier(&ctrl, *t0, *t1))
            };
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    for (eid, e) in fit_splines {
        let TopoEntity::FitSpline { curve, .. } = e else {
            continue;
        };
        let spl = dedup(splits.get(eid).unwrap_or(&empty));
        if spl.len() < 2 {
            continue;
        }
        let m = curve.piece_count() as f64;
        for k in 0..spl.len().saturating_sub(1) {
            let (s0, v0) = &spl[k];
            let (s1, v1) = &spl[k + 1];
            if s1 <= s0 {
                continue;
            }
            if v0 == v1 {
                // The span between two parameters of one self-crossing is a
                // lobe. Any other fused pair is a near tangency, a phantom
                // sliver, and the whole closed curve is the standalone pass's.
                let is_lobe = fit_lobes.get(eid).is_some_and(|set| set.contains(v0))
                    && !(*s0 <= 0.0 && *s1 >= m);
                if !is_lobe {
                    continue;
                }
            }
            let eg = fit_spline_eg(curve, *s0, *s1);
            push_half_edge_pair(&mut hes, &mut he_eid, eid, v0, v1, eg);
        }
    }

    (hes, he_eid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arc(a0: f64, a1: f64) -> TopoEntity {
        TopoEntity::Arc {
            construction: false,
            center: [0.0, 0.0],
            radius: 5.0,
            angle_start: a0,
            angle_end: a1,
            start: [0.0, 0.0],
            end: [0.0, 0.0],
        }
    }

    #[test]
    fn the_split_span_check_agrees_with_angle_in_arc_on_full_turns() {
        // Every spelling `angle_in_arc` reads as the whole circle must keep
        // every hit here too, or a crossing the domain check accepted is
        // silently never split. A zero-span spelling is the case the old raw
        // "end - start is a turn" test missed.
        for (a0, a1) in [(0.0, 360.0), (90.0, 450.0), (30.0, 30.0), (200.0, -160.0)] {
            let e = arc(a0, a1);
            let start = radians(a0);
            for deg in [10.0, 100.0, 190.0, 280.0] {
                let p = norm_arc_param(radians(deg), start);
                assert!(angle_in_arc(radians(deg), 5.0, a0, a1));
                assert!(within_arc_span(&e, p, start), "{a0}..{a1} dropped {deg}");
            }
        }
    }

    #[test]
    fn a_hit_a_hair_below_the_start_is_not_split_at_the_far_end() {
        // The DB9 corner: a contact just under a0 normalizes to a0 + 2pi - eps,
        // past the authored end, and must not become a split.
        let e = arc(270.0, 360.0);
        let start = radians(270.0);
        // Past SPLIT_EPS below, so the normalization wraps it.
        let p = norm_arc_param(start - 1e-6, start);
        assert!(!within_arc_span(&e, p, start));
        let inside = norm_arc_param(radians(300.0), start);
        assert!(within_arc_span(&e, inside, start));
    }
}
