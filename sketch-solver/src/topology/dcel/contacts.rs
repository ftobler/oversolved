//! The declared contacts the author lowered, resolved against the solved
//! geometry: the area builder's identity rule, read from the constraints
//! instead of from the solver's numerics.
//!
//! A satisfied solve satisfies a coincidence to its verdict width, which grows
//! with the sketch and crosses the builder's absolute `TOL_TOPOLOGY_MERGE` at a
//! 100 mm sketch; a converged tangency is numerically zero or two
//! intersections, never one. Both are exactly what the author did NOT say, so
//! this module turns the declared rows into contact positions the geometry
//! passes can weld:
//!
//! - `Join` unions the two endpoint vertices in `Verts`, up to the sketch's
//!   verdict width (`crate::tolerance::verdict_tol`), whatever their distance.
//! - `On` splits the host curve at the foot of the endpoint and welds the
//!   endpoint's vertex there.
//! - `Tangent` names the pair the passes must treat as ONE contact: at the
//!   joint when a join ties their ends, or at the foot of closest approach when
//!   free.
//!
//! A contact whose realised gap exceeds the verdict width is NOT welded. It is
//! returned in `unmet`, so the feature can name the constraint that was not
//! met rather than only the nearest open ends.

use std::collections::HashMap;

use super::super::curve_intersect::{usable_semi_axis, Curve};
use super::super::curve_split::{bezier_point, ellipse_point_at};
use super::super::profile_loops::Vec2;
use super::super::{TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE, TWO_PI};
use super::angle_in_arc;
use super::intersect::Classified;
use super::pymod;
use super::{Contact, ContactKind, ContactRef, InputEntity, TopoEntity, UnmetContact};
use crate::tolerance::verdict_tol;

/// Which end of a curve a contact ref names. Only curve ENDPOINTS take part:
/// a closed carrier (a circle or a full ellipse) is a locus, never a join.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum End {
    Start,
    End,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct EndKey {
    pub eid: String,
    pub end: End,
}

/// A point-on-curve contact resolved to the host parameter the split pass
/// registers.
#[derive(Clone, Debug)]
pub(super) struct ResolvedOn {
    pub endpoint: EndKey,
    pub host: String,
    pub param: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TangentMode {
    /// No join ties the pair: exactly one contact, at the foot of closest
    /// approach.
    Free,
    /// A join ties the pair at a shared endpoint: that vertex is the only
    /// contact, and any computed crossing within the gap budget of it is a
    /// numeric artefact.
    Join,
}

#[derive(Clone, Debug)]
pub(super) struct ResolvedTangent {
    pub id: String,
    pub mode: TangentMode,
    /// The joint the pair is tied at, for `Join`.
    pub joint: Vec2,
}

/// The resolved declared contacts, plus the one scale every weld is read
/// against.
pub(super) struct ContactPlan {
    /// The representative position of every endpoint inside a declared join
    /// group. An endpoint absent here keeps its own authored position.
    canonical: HashMap<EndKey, Vec2>,
    pub(super) ons: Vec<ResolvedOn>,
    tangents: HashMap<(String, String), ResolvedTangent>,
    pub(super) unmet: Vec<UnmetContact>,
    /// The sketch's verdict width, derived from the solved geometry's own
    /// bounding box. A declared contact whose realised gap exceeds it is not
    /// welded.
    pub(super) cap: f64,
}

impl ContactPlan {
    /// The position a joined endpoint must be registered at, or its authored
    /// position when no join covers it.
    pub(super) fn pos(&self, eid: &str, end: End, authored: Vec2) -> Vec2 {
        self.canonical
            .get(&EndKey {
                eid: eid.to_string(),
                end,
            })
            .copied()
            .unwrap_or(authored)
    }

    /// The tangent rule for an unordered entity pair.
    pub(super) fn tangent(&self, a: &str, b: &str) -> Option<&ResolvedTangent> {
        let key = pair_key(a, b);
        self.tangents.get(&key)
    }

    pub(super) fn record_unmet(&mut self, id: &str, a: Vec2, b: Vec2, gap: f64) {
        self.unmet.push(UnmetContact {
            id: id.to_string(),
            a,
            b,
            gap,
        });
    }
}

fn pair_key(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Both endpoints of an open curve, in authored order. `None` for a closed
/// carrier (circle, full ellipse) and for a dropped record.
fn endpoints(e: &TopoEntity) -> Option<(Vec2, Vec2)> {
    match *e {
        TopoEntity::Line { start, end, .. }
        | TopoEntity::Arc { start, end, .. }
        | TopoEntity::Spline { start, end, .. } => Some((start, end)),
        TopoEntity::FitSpline { ref curve, .. } => Some((
            curve.eval(curve.knots()[0]),
            curve.eval(curve.knots()[curve.point_count() - 1]),
        )),
        TopoEntity::Circle { .. } | TopoEntity::Ellipse { .. } => None,
    }
}

/// Whether an endpoint is pinned to its curve, so it wins a merged position
/// over a free end. Mirrors the profile handoff's anchored-kind rule
/// (`ANCHORED_KINDS` in `kernel/profileLoops.ts`): an arc or fit-spline end
/// stays where its authored sweep puts it, a line/spline end moves.
fn anchored(e: &TopoEntity) -> bool {
    matches!(
        e,
        TopoEntity::Arc { .. } | TopoEntity::FitSpline { .. } | TopoEntity::Ellipse { .. }
    )
}

/// Resolve a ref to `(end, entity)` when it names an endpoint of a known
/// non-construction open curve.
fn endpoint_ref<'a>(
    entities: &'a HashMap<&'a str, &'a TopoEntity>,
    r: &ContactRef,
) -> Option<(End, &'a TopoEntity)> {
    let e = *entities.get(r.entity.as_str())?;
    if e.construction() {
        return None;
    }
    let end = match r.point.as_deref() {
        Some("start") => End::Start,
        Some("end") => End::End,
        _ => return None,
    };
    endpoints(e)?;
    Some((end, e))
}

fn endpoint_point(e: &TopoEntity, end: End) -> Vec2 {
    let (s, t) = endpoints(e).expect("endpoint_ref checked the curve has endpoints");
    match end {
        End::Start => s,
        End::End => t,
    }
}

/// The curve as the numeric intersector sees it, for the closest-approach
/// search.
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
        // A fit spline is a chain; callers that can see one use its pieces.
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

/// The closest point on one entity to `p`, in that entity's split convention:
/// a line parameter in [0, 1], a circle/arc angle in [0, 2pi), an ellipse
/// eccentric angle in [0, 2pi), a spline parameter in [0, 1] and a fit-spline
/// piece-space parameter in [0, piece_count]. `None` when the foot lies past a
/// finite end (the caller treats that as an unmet contact and lets the normal
/// intersection pass decide).
fn closest_param(e: &TopoEntity, p: Vec2) -> Option<f64> {
    match *e {
        TopoEntity::Line { start, end, .. } => {
            let dx = end[0] - start[0];
            let dy = end[1] - start[1];
            let len2 = dx * dx + dy * dy;
            if len2 <= EPS * EPS {
                return None;
            }
            let t = ((p[0] - start[0]) * dx + (p[1] - start[1]) * dy) / len2;
            if !(0.0..=1.0).contains(&t) {
                return None;
            }
            Some(t)
        }
        TopoEntity::Circle { center, .. } => {
            Some(pymod((p[1] - center[1]).atan2(p[0] - center[0]), TWO_PI))
        }
        TopoEntity::Arc {
            center,
            radius,
            angle_start,
            angle_end,
            ..
        } => {
            let raw = (p[1] - center[1]).atan2(p[0] - center[0]);
            if !angle_in_arc(raw, radius, angle_start, angle_end) {
                return None;
            }
            Some(pymod(raw, TWO_PI))
        }
        TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } => {
            let cr = crate::radians(theta.unwrap_or(0.0)).cos();
            let sr = crate::radians(theta.unwrap_or(0.0)).sin();
            let dx = p[0] - center[0];
            let dy = p[1] - center[1];
            let xl = dx * cr + dy * sr;
            let yl = -dx * sr + dy * cr;
            let raw = (yl / usable_semi_axis(b, EPS)).atan2(xl / usable_semi_axis(a, EPS));
            // The eccentric-angle parameter is periodic; refine the coarse
            // angle against the true nearest point so a heavily eccentric
            // ellipse does not weld at the wrong foot.
            let mut best = pymod(raw, TWO_PI);
            let mut best_d = curve_point(&to_curve(e), best)
                .map(|q| (q[0] - p[0]).hypot(q[1] - p[1]))
                .unwrap_or(f64::INFINITY);
            let step = TWO_PI / 64.0;
            for k in -1..=1 {
                let start = best + k as f64 * step;
                let t = minimize_param(&to_curve(e), p, start - step, start + step);
                if let Some(q) = curve_point(&to_curve(e), t) {
                    let d = (q[0] - p[0]).hypot(q[1] - p[1]);
                    if d < best_d {
                        best_d = d;
                        best = pymod(t, TWO_PI);
                    }
                }
            }
            Some(best)
        }
        TopoEntity::Spline {
            start, c1, c2, end, ..
        } => {
            let t = minimize_param(
                &Curve::Bezier {
                    p0: start,
                    c1,
                    c2,
                    p3: end,
                },
                p,
                0.0,
                1.0,
            );
            Some(t.clamp(0.0, 1.0))
        }
        TopoEntity::FitSpline { ref curve, .. } => {
            let hit = curve.closest(p);
            let piece = curve.piece_at(hit.u);
            let h = curve.knots()[piece + 1] - curve.knots()[piece];
            let t = if h > 0.0 {
                ((hit.u - curve.knots()[piece]) / h).clamp(0.0, 1.0)
            } else {
                0.0
            };
            Some(piece as f64 + t)
        }
    }
}

fn curve_point(c: &Curve, t: f64) -> Option<Vec2> {
    match *c {
        Curve::Line { p0, p1 } => Some([p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])]),
        Curve::Circle { c, r } => Some([c[0] + r * t.cos(), c[1] + r * t.sin()]),
        Curve::Ellipse { c, a, b, theta } => {
            let cr = crate::radians(theta).cos();
            let sr = crate::radians(theta).sin();
            Some(ellipse_point_at(c, a, b, cr, sr, t))
        }
        Curve::Bezier { p0, c1, c2, p3 } => Some(bezier_point(p0, c1, c2, p3, t)),
    }
}

/// Ternary refinement of the distance from `p` to `c` over `[lo, hi]`.
fn minimize_param(c: &Curve, p: Vec2, lo: f64, hi: f64) -> f64 {
    let dist = |t: f64| -> f64 {
        curve_point(c, t)
            .map(|q| (q[0] - p[0]).hypot(q[1] - p[1]))
            .unwrap_or(f64::INFINITY)
    };
    let (mut a, mut b) = (lo, hi);
    for _ in 0..40 {
        let m1 = a + (b - a) / 3.0;
        let m2 = b - (b - a) / 3.0;
        if dist(m1) <= dist(m2) {
            b = m2;
        } else {
            a = m1;
        }
    }
    0.5 * (a + b)
}

/// The foot point of a host parameter, in world coordinates.
fn param_point(e: &TopoEntity, param: f64) -> Option<Vec2> {
    match *e {
        TopoEntity::Line { start, end, .. } => Some([
            start[0] + param * (end[0] - start[0]),
            start[1] + param * (end[1] - start[1]),
        ]),
        TopoEntity::Circle { center, radius, .. } | TopoEntity::Arc { center, radius, .. } => {
            Some([
                center[0] + radius * param.cos(),
                center[1] + radius * param.sin(),
            ])
        }
        TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } => {
            let cr = crate::radians(theta.unwrap_or(0.0)).cos();
            let sr = crate::radians(theta.unwrap_or(0.0)).sin();
            Some(ellipse_point_at(center, a, b, cr, sr, param))
        }
        TopoEntity::Spline {
            start, c1, c2, end, ..
        } => Some(bezier_point(start, c1, c2, end, param)),
        TopoEntity::FitSpline { ref curve, .. } => {
            if !(0.0..=curve.piece_count() as f64).contains(&param) {
                return None;
            }
            Some(curve.eval(curve.u_at(param)))
        }
    }
}

/// The sketch's characteristic length from the SOLVED real geometry: the bbox
/// diagonal of every defining point, padded by a radius or semi-axis, exactly
/// the shape the solver's `geometry_scale` measures on its seeds. Construction
/// entities are excluded because they bound no area and the area builder never
/// sees them.
pub(super) fn contact_scale(geometry: &[(String, InputEntity)]) -> f64 {
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    let mut grow = |p: Vec2, pad: f64| {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k] - pad);
            hi[k] = hi[k].max(p[k] + pad);
        }
    };
    for (_, e) in geometry {
        if e.construction {
            continue;
        }
        if e.kind.as_deref() == Some("fit_spline") {
            if let Some(points) = &e.points {
                for p in points {
                    grow(*p, 0.0);
                }
            }
            for p in [e.handle_start, e.handle_end].into_iter().flatten() {
                grow(p, 0.0);
            }
            continue;
        }
        if let (Some(center), Some(radius)) = (e.center, e.radius) {
            grow(center, radius.abs());
            continue;
        }
        if let (Some(center), Some(a), Some(b)) = (e.center, e.a, e.b) {
            grow(center, a.abs().max(b.abs()));
            continue;
        }
        if e.kind.as_deref() == Some("spline") {
            for p in [e.start, e.c1, e.c2, e.end].into_iter().flatten() {
                grow(p, 0.0);
            }
            continue;
        }
        if let Some(start) = e.start {
            grow(start, 0.0);
            if let Some(end) = e.end {
                grow(end, 0.0);
            }
        }
    }
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2)).sqrt();
    if diag.is_finite() && diag > 0.0 {
        diag
    } else {
        1.0
    }
}

/// Resolve every authored contact against the classified geometry.
pub(super) fn plan(
    geometry: &[(String, InputEntity)],
    cls: &Classified,
    contacts: &[Contact],
) -> ContactPlan {
    let order: HashMap<&str, usize> = geometry
        .iter()
        .enumerate()
        .map(|(i, (id, _))| (id.as_str(), i))
        .collect();
    let mut entities: HashMap<&str, &TopoEntity> = HashMap::new();
    for bucket in [
        &cls.lines,
        &cls.circles,
        &cls.arcs,
        &cls.splines,
        &cls.fit_splines,
        &cls.ellipses,
    ] {
        for (eid, e) in bucket {
            entities.insert(eid.as_str(), e);
        }
    }

    let scale = contact_scale(geometry);
    // The solver's verdict width is the bound a declared contact is read
    // against, but the builder's own absolute merge is already the identity
    // floor: a gap under MERGE is one vertex whatever the declaration says, so
    // the cap cannot be tighter than that without reporting a contact the
    // distance merge will weld anyway.
    let cap = verdict_tol(scale).max(MERGE);
    let mut plan = ContactPlan {
        canonical: HashMap::new(),
        ons: Vec::new(),
        tangents: HashMap::new(),
        unmet: Vec::new(),
        cap,
    };

    // Union-find over the joined endpoints. The group's representative is the
    // earliest ANCHORED endpoint (an arc/fit-spline end cannot move without
    // changing the curve), else the earliest endpoint; that is the position
    // the profile handoff will keep for the merged vertex.
    struct UnionFind {
        parent: Vec<usize>,
        rank: Vec<u8>,
        keys: Vec<EndKey>,
        index: HashMap<EndKey, usize>,
    }
    impl UnionFind {
        fn new() -> Self {
            UnionFind {
                parent: Vec::new(),
                rank: Vec::new(),
                keys: Vec::new(),
                index: HashMap::new(),
            }
        }
        fn intern(&mut self, key: EndKey) -> usize {
            if let Some(&i) = self.index.get(&key) {
                return i;
            }
            let i = self.keys.len();
            self.index.insert(key.clone(), i);
            self.keys.push(key);
            self.parent.push(i);
            self.rank.push(0);
            i
        }
        fn root(&mut self, mut i: usize) -> usize {
            while self.parent[i] != i {
                self.parent[i] = self.parent[self.parent[i]];
                i = self.parent[i];
            }
            i
        }
        fn union(&mut self, a: EndKey, b: EndKey) {
            let ia = self.intern(a);
            let ib = self.intern(b);
            let ra = self.root(ia);
            let rb = self.root(ib);
            if ra == rb {
                return;
            }
            if self.rank[ra] < self.rank[rb] {
                self.parent[ra] = rb;
            } else if self.rank[ra] > self.rank[rb] {
                self.parent[rb] = ra;
            } else {
                self.parent[rb] = ra;
                self.rank[ra] += 1;
            }
        }
    }
    let mut sets = UnionFind::new();
    let mut joins: Vec<(EndKey, EndKey, Vec2)> = Vec::new();
    for c in contacts {
        let ContactKind::Join = c.kind else {
            continue;
        };
        let (Some((enda, ta)), Some((endb, tb))) =
            (endpoint_ref(&entities, &c.a), endpoint_ref(&entities, &c.b))
        else {
            continue;
        };
        let ea = c.a.entity.as_str();
        let eb = c.b.entity.as_str();
        if ea == eb && enda == endb {
            continue;
        }
        let pa = endpoint_point(ta, enda);
        let pb = endpoint_point(tb, endb);
        let gap = (pa[0] - pb[0]).hypot(pa[1] - pb[1]);
        if gap > cap {
            plan.record_unmet(&c.id, pa, pb, gap);
            continue;
        }
        let ka = EndKey {
            eid: ea.to_string(),
            end: enda,
        };
        let kb = EndKey {
            eid: eb.to_string(),
            end: endb,
        };
        sets.union(ka.clone(), kb.clone());
        joins.push((ka, kb, [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5]));
    }

    // Group the endpoints and pick each group's representative position.
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..sets.keys.len() {
        let r = sets.root(i);
        groups.entry(r).or_default().push(i);
    }
    for group in groups.values() {
        let mut best: Option<(usize, (bool, usize))> = None;
        for &i in group {
            let key = &sets.keys[i];
            let Some(e) = entities.get(key.eid.as_str()) else {
                continue;
            };
            let ord = *order.get(key.eid.as_str()).unwrap_or(&usize::MAX);
            let rank = (!anchored(e), ord);
            let better = match best {
                None => true,
                Some((_, b)) => rank < b,
            };
            if better {
                best = Some((i, rank));
            }
        }
        let Some((best_i, _)) = best else {
            continue;
        };
        let key = &sets.keys[best_i];
        let Some(e) = entities.get(key.eid.as_str()) else {
            continue;
        };
        let position = endpoint_point(e, key.end);
        for &i in group {
            plan.canonical.insert(sets.keys[i].clone(), position);
        }
    }

    // A point-on-curve coincident: split the host at the foot and weld the
    // endpoint's vertex there.
    for c in contacts {
        if c.kind != ContactKind::On {
            continue;
        }
        let (ep_ref, locus_ref) = if endpoint_ref(&entities, &c.a).is_some() {
            (&c.a, &c.b)
        } else if endpoint_ref(&entities, &c.b).is_some() {
            (&c.b, &c.a)
        } else {
            continue;
        };
        if locus_ref.point.is_some() {
            continue;
        }
        let Some((end, e)) = endpoint_ref(&entities, ep_ref) else {
            continue;
        };
        let eid = ep_ref.entity.as_str();
        let Some(host) = entities.get(locus_ref.entity.as_str()) else {
            continue;
        };
        if host.construction() || locus_ref.entity == eid {
            continue;
        }
        let authored = endpoint_point(e, end);
        let p = plan.pos(eid, end, authored);
        let Some(param) = closest_param(host, p) else {
            continue;
        };
        let Some(foot) = param_point(host, param) else {
            continue;
        };
        let gap = (p[0] - foot[0]).hypot(p[1] - foot[1]);
        if gap > cap {
            plan.record_unmet(&c.id, p, foot, gap);
            continue;
        }
        // Match each host's split-parameter convention: a circle anchors at
        // +-pi in `register_hit` (angles above pi map to the negative side), an
        // ellipse keeps [0, 2pi), and an arc is normalized against its a0 when
        // the split is registered.
        let param = if matches!(host, TopoEntity::Circle { .. }) && param > std::f64::consts::PI {
            param - TWO_PI
        } else {
            param
        };
        plan.ons.push(ResolvedOn {
            endpoint: EndKey {
                eid: eid.to_string(),
                end,
            },
            host: locus_ref.entity.clone(),
            param,
        });
    }

    // Tangents. A tangent is AT a joint when a join (or a point-on-curve
    // contact) ties the same pair; otherwise it is free. The author's `join`
    // flag says what the document intended, but the resolved contacts are what
    // the builder can actually weld at, so the resolved pair wins; a flag whose
    // join was not lowered (a dropped ref) falls back to a free tangency.
    for c in contacts {
        let ContactKind::Tangent { .. } = c.kind else {
            continue;
        };
        let Some(a) = entities.get(c.a.entity.as_str()) else {
            continue;
        };
        let Some(b) = entities.get(c.b.entity.as_str()) else {
            continue;
        };
        if a.construction() || b.construction() {
            continue;
        }
        let joint = joins.iter().find_map(|(ka, kb, pos)| {
            let same = (ka.eid == c.a.entity && kb.eid == c.b.entity)
                || (ka.eid == c.b.entity && kb.eid == c.a.entity);
            same.then_some(*pos)
        });
        let on_joint = plan.ons.iter().find_map(|on| {
            let same = (on.host == c.a.entity && on.endpoint.eid == c.b.entity)
                || (on.host == c.b.entity && on.endpoint.eid == c.a.entity);
            if !same {
                return None;
            }
            let key = &on.endpoint;
            Some(plan.canonical.get(key).copied().unwrap_or_else(|| {
                entities
                    .get(key.eid.as_str())
                    .and_then(|e| {
                        endpoints(e).map(|(s, t)| match key.end {
                            End::Start => s,
                            End::End => t,
                        })
                    })
                    .unwrap_or([0.0, 0.0])
            }))
        });
        let (mode, joint) = match joint.or(on_joint) {
            Some(j) => (TangentMode::Join, j),
            None => (TangentMode::Free, [0.0, 0.0]),
        };
        plan.tangents.insert(
            pair_key(&c.a.entity, &c.b.entity),
            ResolvedTangent {
                id: c.id.clone(),
                mode,
                joint,
            },
        );
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_scale_ignores_construction_and_matches_the_bbox_diagonal() {
        let geometry = vec![
            (
                "a".to_string(),
                InputEntity {
                    start: Some([0.0, 0.0]),
                    end: Some([3.0, 4.0]),
                    ..Default::default()
                },
            ),
            (
                "far".to_string(),
                InputEntity {
                    start: Some([0.0, 0.0]),
                    end: Some([1e6, 0.0]),
                    construction: true,
                    ..Default::default()
                },
            ),
        ];
        assert!((contact_scale(&geometry) - 5.0).abs() < 1e-12);
    }

    #[test]
    fn a_negative_semi_axis_welds_the_contact_at_its_own_end() {
        // Direct Rust only: the solved-size rule keeps a negative-axis ellipse
        // out of a profile, so no document reaches this. The shared axis rule
        // still must not fold the sign and weld the contact at the opposite end.
        let e = TopoEntity::Ellipse {
            construction: false,
            center: [0.0, 0.0],
            a: -3.0,
            b: 1.0,
            theta: Some(0.0),
        };
        let t = closest_param(&e, [-3.0, 0.0]).expect("the foot is a finite end");
        assert!(t.abs() < 1e-6, "welded at {t}, the far end");
    }
}
