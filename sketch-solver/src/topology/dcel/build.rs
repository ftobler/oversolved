use std::collections::{HashMap, HashSet};

use super::super::curve_intersect::{intersect_curves, Curve};
use super::super::curve_split::{ellipse_point_at, subdivide_bezier, BezierCtrl};
use super::super::profile_loops::{EdgeGeom, Vec2};
use super::super::{TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_SPLIT as SPLIT_EPS, TWO_PI};
use super::intersect::{collinear_overlap, intersect, Classified};
use super::{
    angle_in_arc, arc_tangent, dedup, degrees, has_param, norm_arc_param, pymod, Split, TopoEntity,
    Verts,
};
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
    }
}

pub(super) type HalfEdge = (String, String, EdgeGeom);

/// Force each arc's CCW span <= pi by swapping its endpoints. Every consumer of
/// `angle_start`/`angle_end` (the split params, `angle_in_arc`) reads the
/// normalized form, so construction arcs run through this too before their
/// crossings are tested.
pub(super) fn normalize_arc_spans(arcs: &mut [(String, TopoEntity)]) {
    for (_eid, e) in arcs.iter_mut() {
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
        let a0_rad = radians(*angle_start);
        let a1_rad = radians(*angle_end);
        let ccw_span = pymod(a1_rad - a0_rad, TWO_PI);
        if ccw_span > std::f64::consts::PI + EPS {
            std::mem::swap(angle_start, angle_end);
            std::mem::swap(start, end);
        }
    }
}

/// Normalize arcs (force CCW span <= pi by swapping endpoints) and seed splits.
#[allow(clippy::type_complexity)]
pub(super) fn normalize_arcs_and_init_splits(
    arcs_in: &[(String, TopoEntity)],
    arc_verts: &mut Verts,
) -> (
    HashMap<String, f64>,
    HashMap<String, Vec<Split>>,
    Vec<(String, TopoEntity)>,
) {
    let mut arcs: Vec<(String, TopoEntity)> = arcs_in.to_vec();
    let mut arc_a0: HashMap<String, f64> = HashMap::new();
    let mut splits: HashMap<String, Vec<Split>> = HashMap::new();

    normalize_arc_spans(&mut arcs);

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
            if !has_param(spl, p) {
                spl.push((p, v.to_string()));
            }
        }
    }
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
            let involves_curve =
                matches!(a.e, TopoEntity::Ellipse { .. } | TopoEntity::Spline { .. })
                    || matches!(b.e, TopoEntity::Ellipse { .. } | TopoEntity::Spline { .. });
            if !involves_curve {
                continue;
            }
            let hits = intersect_curves(&to_curve(&a.e), &to_curve(&b.e));
            for h in hits {
                let v = verts.vid(h.point);
                register_hit(a, h.t_a, &v, splits, arc_a0);
                register_hit(b, h.t_b, &v, splits, arc_a0);
            }
        }
    }
}

/// Tag the buckets with their `TopoEntity`, which already carries the kind.
/// `arcs` comes in separately because the caller tags the span-normalized arc
/// copies, not the raw `cls.arcs`.
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
/// ellipse or a spline is involved) but yielding only world points.
fn crossing_points(a: &Tagged, b: &Tagged) -> Vec<Vec2> {
    if matches!(a.e, TopoEntity::Ellipse { .. } | TopoEntity::Spline { .. })
        || matches!(b.e, TopoEntity::Ellipse { .. } | TopoEntity::Spline { .. })
    {
        return intersect_curves(&to_curve(&a.e), &to_curve(&b.e))
            .into_iter()
            .filter(|h| hit_on_entity(a, h.t_a) && hit_on_entity(b, h.t_b))
            .map(|h| h.point)
            .collect();
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
    ellipses: &[(String, TopoEntity)],
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
            if v0 == v1 || t1 <= t0 {
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

    (hes, he_eid)
}
