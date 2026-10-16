//! Seeded generator and minimiser for the area-builder fuzz. Test-only: this
//! module is compiled under `cfg(test)` only, and the oracle it drives is the
//! one reachable from the `fuzz` feature build.
//!
//! One seed draws a whole sketch: a scale factor, one to six realistic motifs
//! snapped to a 0.5 mm grid (so every seed replays byte-identically on every
//! machine), placed deliberately overlapping half the time, then a few
//! degeneracy injectors. The result runs through `detect_topology` and the
//! oracle; any untagged violation is a finding, gets minimised (drop entities
//! to a fixpoint, then whole motifs) and can be checked in under
//! `dcel/tests/fuzz_cases/<seed>.json` plus a `<seed>.txt` carrying the
//! violation text.
//!
//! The PRNG is mulberry32 ported 1:1 from
//! `frontend/src/hooks/__tests__/fuzzHarness.ts` `makePrng`: the same seed
//! names the same sequence in both harnesses, and the port is pinned against
//! recorded JS output values so a drift cannot pass silently.

use std::collections::BTreeSet;
use std::path::PathBuf;

use super::dcel::{detect_topology, InputEntity};
use super::oracle::{
    check_determinism_against, check_topology, compare_face_multisets, face_summaries,
    jitter_input, Violation,
};
use super::TOL_TOPOLOGY_MERGE as MERGE;

// ─── PRNG ───

/// mulberry32 over 32 bits of state: one multiply-xor round per draw.
pub(crate) struct Prng {
    state: u32,
}

impl Prng {
    pub(crate) fn new(seed: u32) -> Self {
        Prng { state: seed }
    }

    pub(crate) fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }

    fn below(&mut self, n: usize) -> usize {
        let n = n.max(1);
        ((self.next_f64() * n as f64) as usize).min(n - 1)
    }

    fn chance(&mut self, p: f64) -> bool {
        self.next_f64() < p
    }

    /// A dimension in grid steps, both ends inclusive.
    fn steps(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.below((hi - lo + 1) as usize) as i32)
    }
}

// ─── Motifs ───

/// Half a millimetre: every authored coordinate is a multiple of this before
/// the per-seed scale factor is applied.
fn g(steps: i32) -> f64 {
    steps as f64 * 0.5
}

fn snap(v: f64) -> f64 {
    (v / 0.5).round() * 0.5
}

fn line(p0: [f64; 2], p1: [f64; 2]) -> InputEntity {
    InputEntity {
        start: Some(p0),
        end: Some(p1),
        ..Default::default()
    }
}

fn circle(c: [f64; 2], r: f64) -> InputEntity {
    InputEntity {
        center: Some(c),
        radius: Some(r),
        ..Default::default()
    }
}

fn arc(c: [f64; 2], r: f64, a0: f64, a1: f64) -> InputEntity {
    let at = |deg: f64| {
        let a = deg * std::f64::consts::PI / 180.0;
        [c[0] + r * a.cos(), c[1] + r * a.sin()]
    };
    InputEntity {
        center: Some(c),
        radius: Some(r),
        start: Some(at(a0)),
        end: Some(at(a1)),
        angle_start: Some(a0),
        angle_end: Some(a1),
        ..Default::default()
    }
}

fn ellipse(c: [f64; 2], a: f64, b: f64, theta: f64) -> InputEntity {
    InputEntity {
        kind: Some("ellipse".into()),
        center: Some(c),
        a: Some(a),
        b: Some(b),
        theta: Some(theta),
        ..Default::default()
    }
}

fn spline(p0: [f64; 2], c1: [f64; 2], c2: [f64; 2], p3: [f64; 2]) -> InputEntity {
    InputEntity {
        kind: Some("spline".into()),
        start: Some(p0),
        end: Some(p3),
        c1: Some(c1),
        c2: Some(c2),
        ..Default::default()
    }
}

/// The motif kinds, in a frozen order: a seed picks by index, so adding a kind
/// at the end never re-rolls the earlier seeds (it only changes the last one).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Rectangle,
    FilletedRectangle,
    Slot,
    Circle,
    ConcentricCircles,
    OverlappingRectangleAndCircle,
    LineThroughCircleCentre,
    LineArcChain,
    TJunction,
    ThreeEdgesAtVertex,
    CollinearOverlap,
    TangentCircles,
    EllipseWithLines,
    OpenSplineCrossingRectangle,
    CShapeWithCircleInNotch,
}

const KINDS: [Kind; 15] = [
    Kind::Rectangle,
    Kind::FilletedRectangle,
    Kind::Slot,
    Kind::Circle,
    Kind::ConcentricCircles,
    Kind::OverlappingRectangleAndCircle,
    Kind::LineThroughCircleCentre,
    Kind::LineArcChain,
    Kind::TJunction,
    Kind::ThreeEdgesAtVertex,
    Kind::CollinearOverlap,
    Kind::TangentCircles,
    Kind::EllipseWithLines,
    Kind::OpenSplineCrossingRectangle,
    Kind::CShapeWithCircleInNotch,
];

/// A motif's local geometry, in grid steps (0.5 mm units).
fn build_motif(kind: Kind, rnd: &mut Prng) -> Vec<InputEntity> {
    match kind {
        Kind::Rectangle => {
            let (w, h) = (g(rnd.steps(2, 24)), g(rnd.steps(2, 24)));
            vec![
                line([0.0, 0.0], [w, 0.0]),
                line([w, 0.0], [w, h]),
                line([w, h], [0.0, h]),
                line([0.0, h], [0.0, 0.0]),
            ]
        }
        Kind::FilletedRectangle => {
            // Tangent arc cusps: the arc meets its line at exactly one point
            // with a common tangent, which is the fixed comparator's home turf.
            let (w, h) = (g(rnd.steps(4, 24)), g(rnd.steps(4, 24)));
            let r = g(rnd.steps(1, (w.min(h) / 1.0) as i32 / 2 - 1));
            vec![
                line([r, 0.0], [w - r, 0.0]),
                arc([w - r, r], r, -90.0, 0.0),
                line([w, r], [w, h - r]),
                arc([w - r, h - r], r, 0.0, 90.0),
                line([w - r, h], [r, h]),
                arc([r, h - r], r, 90.0, 180.0),
                line([0.0, h - r], [0.0, r]),
                arc([r, r], r, 180.0, 270.0),
            ]
        }
        Kind::Slot => {
            let (len, r) = (g(rnd.steps(3, 20)), g(rnd.steps(1, 6)));
            let y = 2.0 * r;
            vec![
                line([r, 0.0], [len - r, 0.0]),
                arc([len - r, r], r, -90.0, 90.0),
                line([len - r, y], [r, y]),
                arc([r, r], r, 90.0, 270.0),
            ]
        }
        Kind::Circle => {
            let r = g(rnd.steps(1, 16));
            vec![circle([0.0, 0.0], r)]
        }
        Kind::ConcentricCircles => {
            let r1 = g(rnd.steps(3, 20));
            let r2 = g(rnd.steps(1, (r1 / 0.5) as i32 - 1));
            vec![circle([0.0, 0.0], r1), circle([0.0, 0.0], r2)]
        }
        Kind::OverlappingRectangleAndCircle => {
            let (w, h) = (g(rnd.steps(3, 20)), g(rnd.steps(3, 20)));
            let r = g(rnd.steps(1, (w.min(h) / 0.5) as i32 - 1));
            vec![
                line([0.0, 0.0], [w, 0.0]),
                line([w, 0.0], [w, h]),
                line([w, h], [0.0, h]),
                line([0.0, h], [0.0, 0.0]),
                circle([w / 2.0, h / 2.0], r),
            ]
        }
        Kind::LineThroughCircleCentre => {
            let r = g(rnd.steps(2, 12));
            let len = g(rnd.steps(((r / 0.5) as i32) + 1, 20));
            let vertical = rnd.chance(0.5);
            let (p0, p1) = if vertical {
                ([0.0, -len], [0.0, len])
            } else {
                ([-len, 0.0], [len, 0.0])
            };
            vec![circle([0.0, 0.0], r), line(p0, p1)]
        }
        Kind::LineArcChain => {
            // Closed by exactly coincident endpoints, lines and arcs alternating.
            let (w, h) = (g(rnd.steps(4, 20)), g(rnd.steps(2, 12)));
            let r = h / 2.0;
            vec![
                line([0.0, 0.0], [w, 0.0]),
                arc([w, r], r, -90.0, 90.0),
                line([w, h], [0.0, h]),
                arc([0.0, r], r, 90.0, 270.0),
            ]
        }
        Kind::TJunction => {
            // A stem whose endpoint sits exactly on another edge's interior.
            let (w, h) = (g(rnd.steps(3, 20)), g(rnd.steps(3, 16)));
            vec![
                line([0.0, 0.0], [w, 0.0]),
                line([0.0, 0.0], [0.0, h]),
                line([0.0, h], [w, h]),
                line([w, h], [w, 0.0]),
                line([snap(w / 2.0), 0.0], [snap(w / 2.0), h]),
            ]
        }
        Kind::ThreeEdgesAtVertex => {
            let (w, h) = (g(rnd.steps(3, 16)), g(rnd.steps(3, 16)));
            let k = rnd.steps(2, 3); // 3 or 4 edges out of the shared vertex
            let mut out = vec![
                line([0.0, 0.0], [w, 0.0]),
                line([0.0, 0.0], [0.0, h]),
                line([0.0, 0.0], [w, h]),
                line([w, 0.0], [w, h]),
            ];
            if k == 4 {
                out.push(line([0.0, 0.0], [g(rnd.steps(1, 8)), -h]));
            }
            out
        }
        Kind::CollinearOverlap => {
            // The bottom edge is drawn as two collinear segments that overlap
            // in the middle, so the rectangle's boundary is covered twice there.
            let (w, h) = (g(rnd.steps(4, 20)), g(rnd.steps(3, 16)));
            let a = g((w / 0.5) as i32 * 6 / 10);
            let b = g((w / 0.5) as i32 * 4 / 10);
            vec![
                line([0.0, 0.0], [a, 0.0]),
                line([b, 0.0], [w, 0.0]),
                line([0.0, 0.0], [0.0, h]),
                line([0.0, h], [w, h]),
                line([w, h], [w, 0.0]),
            ]
        }
        Kind::TangentCircles => {
            let r1 = g(rnd.steps(2, 12));
            let r2 = g(rnd.steps(1, (r1 / 0.5) as i32));
            if rnd.chance(0.5) {
                // External tangency.
                vec![circle([0.0, 0.0], r1), circle([r1 + r2, 0.0], r2)]
            } else {
                // Internal tangency.
                vec![circle([0.0, 0.0], r1), circle([r1 - r2, 0.0], r2)]
            }
        }
        Kind::EllipseWithLines => {
            // The crossing line goes through the centre, the tangent line
            // grazes the major-axis side. That graze is the known "line
            // tangent to an ellipse yields no contact" case.
            let a_steps = rnd.steps(6, 16);
            let (a, b) = (g(a_steps), g(rnd.steps(1, a_steps - 1)));
            let theta_deg = if rnd.chance(0.3) { 90.0 } else { 0.0 };
            let angle = g(rnd.steps(1, 6)) * 15.0;
            let dir = [angle.to_radians().cos(), angle.to_radians().sin()];
            let reach = a.max(b) * 1.5;
            let crossing = line(
                [-reach * dir[0], -reach * dir[1]],
                [reach * dir[0], reach * dir[1]],
            );
            let tangent = if theta_deg == 0.0 {
                line([-reach, b], [reach, b])
            } else {
                line([a, -reach], [a, reach])
            };
            vec![ellipse([0.0, 0.0], a, b, theta_deg), crossing, tangent]
        }
        Kind::OpenSplineCrossingRectangle => {
            let (w, h) = (g(rnd.steps(4, 20)), g(rnd.steps(3, 16)));
            let mut out = vec![
                line([0.0, 0.0], [w, 0.0]),
                line([w, 0.0], [w, h]),
                line([w, h], [0.0, h]),
                line([0.0, h], [0.0, 0.0]),
            ];
            let up = if rnd.chance(0.5) { 1.0 } else { -1.0 };
            out.push(spline(
                [-g(2), h / 2.0],
                [w * 0.25, h / 2.0 + up * h],
                [w * 0.75, h / 2.0 - up * h],
                [w + g(2), h / 2.0],
            ));
            out
        }
        Kind::CShapeWithCircleInNotch => {
            let (w, h, t) = (g(rnd.steps(4, 20)), g(rnd.steps(4, 20)), g(rnd.steps(1, 4)));
            let back = snap(t * 1.5).max(t + 0.5);
            let mut out = vec![
                line([0.0, 0.0], [0.0, h]),
                line([0.0, h], [w, h]),
                line([w, h], [w, h - t]),
                line([w, h - t], [back, h - t]),
                line([back, h - t], [back, t]),
                line([back, t], [w, t]),
                line([w, t], [w, 0.0]),
                line([w, 0.0], [0.0, 0.0]),
            ];
            // The circle in the notch: inside the mouth, outside the material.
            let r = g(rnd.steps(1, 2));
            out.push(circle([snap((back + w) / 2.0), h / 2.0], r));
            out
        }
    }
}

// ─── Generation ───

/// The scales the plan names: tiny, unit, and two far-from-origin.
const SCALES: [f64; 4] = [0.01, 1.0, 100.0, 1500.0];

pub(crate) struct Generated {
    pub(crate) entities: Vec<(String, InputEntity)>,
    /// Motif key per entity index: the minimiser's group axis.
    pub(crate) motif_of: Vec<String>,
    /// One entry per placed motif, in placement order.
    pub(crate) kinds: Vec<Kind>,
}

fn bbox_of(entities: &[(String, InputEntity)]) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    let mut add = |p: [f64; 2]| {
        b = Some(match b {
            None => [p[0], p[1], p[0], p[1]],
            Some(mut b) => {
                b[0] = b[0].min(p[0]);
                b[1] = b[1].min(p[1]);
                b[2] = b[2].max(p[0]);
                b[3] = b[3].max(p[1]);
                b
            }
        });
    };
    for (_, e) in entities {
        for p in [e.start, e.end, e.center, e.c1, e.c2].into_iter().flatten() {
            add(p);
        }
    }
    b
}

/// Shift every point of a `InputEntity`.
fn shift_entity(e: &mut InputEntity, d: [f64; 2]) {
    for p in [
        &mut e.start,
        &mut e.end,
        &mut e.center,
        &mut e.c1,
        &mut e.c2,
    ]
    .into_iter()
    .flatten()
    {
        p[0] += d[0];
        p[1] += d[1];
    }
}

/// One seed's whole sketch: scale, motifs, placement, injectors.
pub(crate) fn generate(seed: u32) -> Generated {
    let mut rnd = Prng::new(seed);
    let scale = SCALES[rnd.below(SCALES.len())];
    let count = 1 + rnd.below(6);

    let mut entities: Vec<(String, InputEntity)> = Vec::new();
    let mut motif_of: Vec<String> = Vec::new();
    let mut kinds: Vec<Kind> = Vec::new();
    let mut placed: Option<[f64; 4]> = None;
    for m in 0..count {
        let kind = KINDS[rnd.below(KINDS.len())];
        let mut local = build_motif(kind, &mut rnd);
        if local.is_empty() {
            continue;
        }
        let own = bbox_of(
            &local
                .iter()
                .cloned()
                .enumerate()
                .map(|(k, e)| (k.to_string(), e))
                .collect::<Vec<_>>(),
        );
        let (dx, dy) = match (placed, own) {
            (Some(bb), Some(own)) => {
                if rnd.chance(0.5) {
                    // Deliberate overlap: put the motif's centre on a point
                    // drawn inside the geometry placed so far.
                    let cx = bb[0] + rnd.next_f64() * (bb[2] - bb[0]).max(0.5);
                    let cy = bb[1] + rnd.next_f64() * (bb[3] - bb[1]).max(0.5);
                    (
                        snap(cx - 0.5 * (own[0] + own[2])),
                        snap(cy - 0.5 * (own[1] + own[3])),
                    )
                } else {
                    // Beside it, with a visible gap so the two do not touch.
                    (snap(bb[2] - own[0] + 2.0), 0.0)
                }
            }
            _ => (0.0, 0.0),
        };
        let key = format!("m{m}");
        kinds.push(kind);
        for (k, mut e) in local.drain(..).enumerate() {
            shift_entity(&mut e, [dx, dy]);
            entities.push((format!("{key}_{k}"), e));
            motif_of.push(key.clone());
        }
        if let Some(b) = bbox_of(&entities) {
            placed = Some(b);
        }
    }

    // The injectors drive the world-space tolerances (MERGE is absolute), so
    // they run after the per-seed scale factor. Lengths scale, angles do not.
    for (_, e) in entities.iter_mut() {
        for p in [
            &mut e.start,
            &mut e.end,
            &mut e.center,
            &mut e.c1,
            &mut e.c2,
        ]
        .into_iter()
        .flatten()
        {
            // Authored coordinates are already on the 0.5 mm grid by
            // construction (every dimension is an integer number of half
            // steps), so only the scale applies. Snapping here would round a
            // radius half (an arc centre at h/2 = 1.75) away from its own
            // stored endpoints and hand the builder a broken entity.
            p[0] *= scale;
            p[1] *= scale;
        }
        // Lengths scale but are NOT snapped: an arc's radius is half its
        // chord's height, so snapping it independently of the endpoints
        // (r = 1.75 would round to 2.0) would move the arc off its own
        // stored endpoints and hand the builder a broken entity.
        for v in [&mut e.radius, &mut e.a, &mut e.b].into_iter().flatten() {
            *v *= scale;
        }
    }
    inject(&mut rnd, &mut entities, &mut motif_of);
    Generated {
        entities,
        motif_of,
        kinds,
    }
}

// ─── Degeneracy injectors ───

const FIELD_START: usize = 0;
const FIELD_END: usize = 1;
const FIELD_CENTER: usize = 2;
const FIELD_C1: usize = 3;
const FIELD_C2: usize = 4;
const FIELDS: [usize; 5] = [FIELD_START, FIELD_END, FIELD_CENTER, FIELD_C1, FIELD_C2];

fn field_ref(e: &InputEntity, field: usize) -> Option<[f64; 2]> {
    match field {
        FIELD_START => e.start,
        FIELD_END => e.end,
        FIELD_CENTER => e.center,
        FIELD_C1 => e.c1,
        FIELD_C2 => e.c2,
        _ => None,
    }
}

fn field_mut(e: &mut InputEntity, field: usize) -> Option<&mut [f64; 2]> {
    match field {
        FIELD_START => e.start.as_mut(),
        FIELD_END => e.end.as_mut(),
        FIELD_CENTER => e.center.as_mut(),
        FIELD_C1 => e.c1.as_mut(),
        FIELD_C2 => e.c2.as_mut(),
        _ => None,
    }
}

/// One point of an entity that some curve passes through: (entity, field,
/// point, is_endpoint). A `start`/`end` of an open curve is a curve end; a
/// center or control point is not.
struct PointRef {
    entity: usize,
    field: usize,
    p: [f64; 2],
    endpoint: bool,
}

fn points_of(entities: &[(String, InputEntity)]) -> Vec<PointRef> {
    let mut out = Vec::new();
    for (i, (_, e)) in entities.iter().enumerate() {
        for field in FIELDS {
            if let Some(p) = field_ref(e, field) {
                // A start/end pair is a curve end for every open kind (line,
                // arc, spline); a centre or a control point is interior.
                let endpoint = matches!(field, FIELD_START | FIELD_END)
                    && e.start.is_some()
                    && e.end.is_some();
                out.push(PointRef {
                    entity: i,
                    field,
                    p,
                    endpoint,
                });
            }
        }
    }
    out
}

fn inject(rnd: &mut Prng, entities: &mut Vec<(String, InputEntity)>, motif_of: &mut Vec<String>) {
    endpoint_onto_curve(rnd, entities);
    near_miss_gap(rnd, entities);
    perturb_tangency(rnd, entities);
    duplicate_entity(rnd, entities, motif_of);
}

/// Move one curve end exactly onto another curve (a line's interior or a
/// circle's rim), the authored "snapped" contact. Only lines and splines are
/// moved: for those the stored endpoint IS the geometry, while an arc's
/// geometry comes from its centre/radius/angles, so moving only its endpoint
/// would break the entity rather than snap it.
fn endpoint_onto_curve(rnd: &mut Prng, entities: &mut [(String, InputEntity)]) {
    if !rnd.chance(0.3) {
        return;
    }
    let movable: Vec<usize> = (0..entities.len())
        .filter(|&i| {
            let e = &entities[i].1;
            e.start.is_some()
                && e.end.is_some()
                && e.center.is_none()
                && e.kind.as_deref() != Some("ellipse")
        })
        .collect();
    let pts = points_of(entities);
    let ends: Vec<&PointRef> = pts
        .iter()
        .filter(|p| p.endpoint && movable.contains(&p.entity))
        .collect();
    if ends.is_empty() {
        return;
    }
    let pick = ends[rnd.below(ends.len())];
    let targets: Vec<usize> = (0..entities.len()).filter(|&i| i != pick.entity).collect();
    if targets.is_empty() {
        return;
    }
    let target = targets[rnd.below(targets.len())];
    let te = &entities[target].1;
    let projected = if let (Some(s), Some(e)) = (te.start, te.end) {
        let (dx, dy) = (e[0] - s[0], e[1] - s[1]);
        let len2 = dx * dx + dy * dy;
        if len2 <= 0.0 {
            return;
        }
        let t = (((pick.p[0] - s[0]) * dx + (pick.p[1] - s[1]) * dy) / len2).clamp(0.0, 1.0);
        [s[0] + t * dx, s[1] + t * dy]
    } else if let (Some(c), Some(r)) = (te.center, te.radius) {
        if r <= 0.0 {
            return;
        }
        let (dx, dy) = (pick.p[0] - c[0], pick.p[1] - c[1]);
        let d = dx.hypot(dy);
        if d <= 0.0 {
            return;
        }
        [c[0] + r * dx / d, c[1] + r * dy / d]
    } else {
        return;
    };
    // Keep a line from collapsing onto its own other end.
    if let Some(other) = other_end(entities[pick.entity].1.clone(), pick.field) {
        if (projected[0] - other[0]).hypot(projected[1] - other[1]) <= MERGE {
            return;
        }
    }
    if let Some(p) = field_mut(&mut entities[pick.entity].1, pick.field) {
        *p = projected;
    }
}

fn other_end(e: InputEntity, field: usize) -> Option<[f64; 2]> {
    match field {
        FIELD_START => e.end,
        FIELD_END => e.start,
        _ => None,
    }
}

/// Offset one shared endpoint by 0.5x or 2x the merge tolerance: the first gap
/// still merges, the second leaves the loop open.
fn near_miss_gap(rnd: &mut Prng, entities: &mut [(String, InputEntity)]) {
    if !rnd.chance(0.4) {
        return;
    }
    let pts = points_of(entities);
    let mut candidates: Vec<(&PointRef, &PointRef)> = Vec::new();
    for (i, a) in pts.iter().enumerate() {
        for b in pts.iter().skip(i + 1) {
            if a.entity == b.entity {
                continue;
            }
            let d = (a.p[0] - b.p[0]).hypot(a.p[1] - b.p[1]);
            if d <= MERGE {
                candidates.push((a, b));
            }
        }
    }
    if candidates.is_empty() {
        return;
    }
    let (_, b) = candidates[rnd.below(candidates.len())];
    let factor = if rnd.chance(0.5) { 0.5 } else { 2.0 };
    let angle = rnd.next_f64() * std::f64::consts::TAU;
    let delta = [factor * MERGE * angle.cos(), factor * MERGE * angle.sin()];
    if let Some(p) = field_mut(&mut entities[b.entity].1, b.field) {
        *p = [b.p[0] + delta[0], b.p[1] + delta[1]];
    }
}

/// Nudge a tangency by +-1e-9 of the radius, the scale of the wire noise the
/// solver leaves on a solved tangency (far below the merge tolerance).
fn perturb_tangency(rnd: &mut Prng, entities: &mut [(String, InputEntity)]) {
    if !rnd.chance(0.4) {
        return;
    }
    // A line tangent to a circle: push the line along its normal.
    for i in 0..entities.len() {
        let (Some(c), Some(r)) = (entities[i].1.center, entities[i].1.radius) else {
            continue;
        };
        for (j, other) in entities.iter().enumerate() {
            if i == j {
                continue;
            }
            let (Some(s), Some(e)) = (other.1.start, other.1.end) else {
                continue;
            };
            let (dx, dy) = (e[0] - s[0], e[1] - s[1]);
            let len = dx.hypot(dy);
            if len <= 0.0 {
                continue;
            }
            let dist = ((c[0] - s[0]) * dy - (c[1] - s[1]) * dx).abs() / len;
            if (dist - r).abs() > 10.0 * MERGE {
                continue;
            }
            let sign = if rnd.chance(0.5) { 1.0 } else { -1.0 };
            let delta = sign * 1e-9 * r;
            let n = [-dy / len, dx / len];
            let side = if ((c[0] - s[0]) * n[0] + (c[1] - s[1]) * n[1]) >= 0.0 {
                1.0
            } else {
                -1.0
            };
            let shift = [side * delta * n[0], side * delta * n[1]];
            shift_entity(&mut entities[j].1, shift);
            return;
        }
    }
}

/// Clone one entity under a fresh id: the duplicate-entity degeneracy.
fn duplicate_entity(
    rnd: &mut Prng,
    entities: &mut Vec<(String, InputEntity)>,
    motif_of: &mut Vec<String>,
) {
    if !rnd.chance(0.25) || entities.is_empty() {
        return;
    }
    let i = rnd.below(entities.len());
    let (id, e) = entities[i].clone();
    entities.push((format!("{id}_dup"), e));
    motif_of.push(motif_of[i].clone());
}

/// One sketched entity list, as it crosses the input boundary.
pub(crate) type EntityList = Vec<(String, InputEntity)>;

/// One minimised reproduction: the class it still exhibits, the minimal input,
/// and the violation texts that input produces.
pub(crate) type MinimisedCase = (String, EntityList, Vec<String>);

/// The minimiser's failure predicate: does this candidate still exhibit the
/// violation being minimised? Must be a pure function of the candidate.
pub(crate) type Fails<'a> = dyn Fn(&[(String, InputEntity)]) -> bool + 'a;

// ─── Minimiser ───

/// Greedy delta minimisation: drop one entity at a time, accept while the
/// violation persists, repeat to a fixpoint, then drop whole motifs and run
/// the entity pass once more. Same shape as
/// `frontend/src/hooks/__tests__/fuzzMinimizer.ts`. The predicate must be a
/// pure function of the candidate; the caller guarantees the input fails and
/// the minimiser returns it unchanged otherwise.
pub(crate) fn minimise(
    input: &[(String, InputEntity)],
    motif_of: &[String],
    still_fails: &Fails<'_>,
) -> EntityList {
    let mut current: EntityList = input.to_vec();
    let mut groups: Vec<String> = motif_of.to_vec();
    if !still_fails(&current) {
        return current;
    }
    loop {
        let mut reduced = false;
        for i in 0..current.len() {
            let mut cand = current.clone();
            cand.remove(i);
            let mut cg = groups.clone();
            cg.remove(i);
            if still_fails(&cand) {
                current = cand;
                groups = cg;
                reduced = true;
                break;
            }
        }
        if !reduced {
            break;
        }
    }
    let keys: Vec<String> = groups
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    for key in keys {
        let cand: Vec<(String, InputEntity)> = current
            .iter()
            .zip(groups.iter())
            .filter(|(_, g)| **g != key)
            .map(|(e, _)| e.clone())
            .collect();
        if cand.len() < current.len() && still_fails(&cand) {
            current = cand;
            groups.retain(|g| *g != key);
        }
    }
    loop {
        let mut reduced = false;
        for i in 0..current.len() {
            let mut cand = current.clone();
            cand.remove(i);
            if still_fails(&cand) {
                current = cand;
                reduced = true;
                break;
            }
        }
        if !reduced {
            break;
        }
    }
    current
}

// ─── One seed's full check ───

/// Every invariant check for one generated sketch: the oracle, determinism, a
/// seeded permutation, and a seeded jitter. The permutation and the jitter
/// draw from their own stream so the generator's draws stay stable.
pub(crate) fn check_generated(entities: &[(String, InputEntity)], seed: u32) -> Vec<Violation> {
    // Every check is measured against this one base run, so a seed costs four
    // builds of the sketch rather than the six a per-check helper would.
    let out = detect_topology(entities);
    let mut violations = check_topology(entities, &out);
    violations.extend(check_determinism_against(entities, &out));
    let base = face_summaries(&out);

    let mut rnd = Prng::new(seed ^ 0x5eed_1234);
    let n = entities.len();
    let mut perm: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        let j = rnd.below(i + 1);
        perm.swap(i, j);
    }
    let permuted: Vec<(String, InputEntity)> = perm.iter().map(|&i| entities[i].clone()).collect();
    let permuted_faces = face_summaries(&detect_topology(&permuted));
    violations.extend(compare_face_multisets(
        "order",
        "entity permutation",
        &base,
        &permuted_faces,
        1e-9,
        1e-9,
        MERGE / 100.0,
        MERGE,
    ));

    let deltas: Vec<[f64; 2]> = (0..n)
        .map(|_| {
            let angle = rnd.next_f64() * std::f64::consts::TAU;
            let mag = MERGE / 10.0 * (0.2 + 0.8 * rnd.next_f64());
            [mag * angle.cos(), mag * angle.sin()]
        })
        .collect();
    let jittered = jitter_input(entities, &deltas);
    let jittered_faces = face_summaries(&detect_topology(&jittered));
    violations.extend(compare_face_multisets(
        "stability",
        "vertex jitter",
        &base,
        &jittered_faces,
        1e-6,
        1e-6,
        2.0 * MERGE / 10.0,
        4.0 * MERGE / 10.0,
    ));
    violations
}

pub(crate) fn has_pending(violations: &[Violation]) -> bool {
    violations.iter().any(|v| v.is_pending())
}

/// Minimise every pending violation class of one seed. Returns the minimised
/// inputs with the class they still exhibit.
pub(crate) fn minimise_seed(
    generated: &Generated,
    seed: u32,
    violations: &[Violation],
) -> Vec<MinimisedCase> {
    let mut classes: Vec<&'static str> = violations
        .iter()
        .filter(|v| v.is_pending())
        .map(|v| v.class)
        .collect();
    classes.sort_unstable();
    classes.dedup();
    let mut out = Vec::new();
    for class in classes {
        let fails = |cand: &[(String, InputEntity)]| -> bool {
            check_generated(cand, seed)
                .iter()
                .any(|v| v.is_pending() && v.class == class)
        };
        let minimal = minimise(&generated.entities, &generated.motif_of, &fails);
        let texts: Vec<String> = check_generated(&minimal, seed)
            .iter()
            .filter(|v| v.is_pending() && v.class == class)
            .map(|v| v.render())
            .collect();
        out.push((class.to_string(), minimal, texts));
    }
    out
}

// ─── Case files ───

pub(crate) fn fuzz_cases_dir() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("src/topology/dcel/tests/fuzz_cases");
    p
}

/// The `detect_topology_bytes` input format: `[[eid, geom], ...]`.
pub(crate) fn input_json(entities: &[(String, InputEntity)]) -> Vec<u8> {
    let values: Vec<serde_json::Value> = entities
        .iter()
        .map(|(id, e)| {
            let mut g = serde_json::Map::new();
            if let Some(kind) = &e.kind {
                g.insert("kind".into(), serde_json::json!(kind));
            }
            if e.construction {
                g.insert("construction".into(), serde_json::json!(true));
            }
            for (key, value) in [
                ("start", e.start),
                ("end", e.end),
                ("center", e.center),
                ("c1", e.c1),
                ("c2", e.c2),
            ] {
                if let Some(p) = value {
                    g.insert(key.into(), serde_json::json!([p[0], p[1]]));
                }
            }
            if let Some(r) = e.radius {
                g.insert("radius".into(), serde_json::json!(r));
            }
            if let Some(a) = e.angle_start {
                g.insert("angle_start".into(), serde_json::json!(a));
            }
            if let Some(a) = e.angle_end {
                g.insert("angle_end".into(), serde_json::json!(a));
            }
            for (key, value) in [("a", e.a), ("b", e.b), ("theta", e.theta)] {
                if let Some(v) = value {
                    g.insert(key.into(), serde_json::json!(v));
                }
            }
            serde_json::json!([id, serde_json::Value::Object(g)])
        })
        .collect();
    serde_json::to_vec_pretty(&values).expect("input encodes")
}

/// One seed's checked-in cases, if any: `{seed}*.json` in the case directory.
pub(crate) fn case_files_for(seed: u32) -> Vec<PathBuf> {
    let dir = fuzz_cases_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };
    let prefix = format!("{seed}.");
    let dash = format!("{seed}-");
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|x| x == "json")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&prefix) || n.starts_with(&dash))
        })
        .collect();
    out.sort();
    out
}

/// Check in one minimised case: the input JSON plus the violation text. Only
/// called when `SKETCH_FUZZ_WRITE` is set, so a plain test run never writes.
pub(crate) fn write_case(
    seed: u32,
    class: &str,
    input: &[(String, InputEntity)],
    texts: &[String],
) {
    let dir = fuzz_cases_dir();
    std::fs::create_dir_all(&dir).expect("fuzz_cases dir");
    let suffix = if class == "coverage" {
        String::new()
    } else {
        format!("-{class}")
    };
    let base = dir.join(format!("{seed}{suffix}"));
    std::fs::write(base.with_extension("json"), input_json(input)).expect("write case json");
    std::fs::write(
        base.with_extension("txt"),
        format!("{}\n", texts.join("\n")),
    )
    .expect("write case text");
}

// ─── Tests ───

#[cfg(test)]
#[path = "fuzz/tests.rs"]
mod tests;
