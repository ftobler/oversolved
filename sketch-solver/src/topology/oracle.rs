//! Invariant oracle for the sketch area builder: an independent judge of
//! `detect_topology`'s OUTPUT that trusts neither the DCEL pass, nor the trace
//! order, nor the hole nesting. It re-derives the ground truth from the raw
//! input geometry alone (its own curve classification, its own sampling, its
//! own grid) and then asks whether the builder's faces are exactly the regions
//! those curves bound.
//!
//! Four checks:
//!
//! 1. Coverage (the strong one). Polygonize every real input curve at a chord
//!    tolerance tied to the grid, lay a grid over the bbox (a cell is
//!    `scale/200`), mark a cell "on curve" when its rectangle comes within
//!    `3 * TOL_TOPOLOGY_MERGE` of a curve, and flood fill the rest from the
//!    border. A cell the fill does not reach must lie inside exactly one built
//!    face (outer loop minus holes); a reached cell must lie inside none. This
//!    judges the result without trusting the builder at all.
//! 2. Structure: every loop closes and is non-self-intersecting, every face
//!    side lands on a registered vertex of its own geometry, every face side
//!    names a real non-construction input entity, every hole loop is the
//!    boundary of exactly one other face, each boundary side (half-edge)
//!    appears in exactly one cycle, each split edge piece is used by at most
//!    two sides.
//! 3. Euler: V - E + F = 1 + C over the split graph, the outer face counted in
//!    F, standalone loops counted as their own component.
//! 4. Determinism, entity-order independence and vertex jitter stability, as
//!    separate entry points the fuzz drives with its own seed.
//!
//! Near-merge gaps are a resolution limit of any grid: an opening narrower
//! than about a cell cannot be crossed by a cell-wide flood fill, yet the
//! builder is right to leave the chain there open. The oracle therefore runs
//! two fills: a pessimistic one whose barrier is dilated by a cell (so it
//! cannot slip through a diagonal), and an optimistic one with an explicit
//! TUNNEL between free cells on the two sides of every opening between a
//! curve end and its nearest barrier point. The decision is MERGE resolution,
//! not grid resolution: a gap closer than MERGE is a seal (the builder fuses
//! those endpoints into one vertex, so the chain is closed), a gap at or
//! beyond it is passable (a tunnel is attempted, and only certified when the
//! cell-to-midpoint polyline clears the sampled barrier and every seal). A
//! cell whose reachability differs between the two fills sits behind such an
//! opening and is skipped rather than judged; a genuinely enclosed region has
//! no end-to-barrier gap at or beyond MERGE to tunnel through, so it stays
//! reported. Tunnels are attempted for openings of any width (the narrow ones
//! are why they exist; wide ones either already pass or are harmless
//! shortcuts), because the grid alignment can hide openings several cells
//! wide at the corner of a contour.
//!
//! Known-limitation tags: a violation on an input containing a
//! self-intersecting spline or a line crossing both rings of concentric
//! circles carries `known:<backlog-slug>` and does not count as a failure. The
//! two held-out limitations are accepted behaviour, not bugs to report; the
//! classes they can plausibly corrupt are the geometry-consistency ones
//! (coverage, structure, euler, half-edge), while the pipeline-level checks
//! (determinism, order, stability) stay untagged because the held-out
//! limitations do not excuse those.
//!
//! Only the JSON entry the `fuzz` build exposes is reachable without
//! `cfg(test)`; the generator-facing helpers below are dead in that build.
//! The coverage, structure and geometry machinery lives in the submodules;
//! this file keeps the entry points and the shared vocabulary.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};

use super::dcel::{detect_topology, InputEntity, TopologyOut};
use super::profile_loops::Vec2;
use super::{TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE};
use crate::radians;

mod coverage;
mod geometry;
mod structure;

use coverage::{coverage_violations, face_polys};
use geometry::{bbox_of, sample_spline, seg_seg_intersect};
use structure::{check_loop, euler_violations, half_edge_usage_violations, hole_wiring_violations};

pub(crate) use coverage::{CELLS_PER_DIAGONAL, FACE_POLY_MAX_PTS};
pub(crate) use geometry::{compare_face_multisets, face_summaries, FaceSummary};
pub(crate) use geometry::{edge_polyline, loop_area_centroid, loop_polygon, point_in_polygon};
pub(crate) use structure::edge_end;

// ─── Violations and known-limitation slugs ───

/// Backlog slugs of the two held-out limitations (see feature/backlog.md).
pub(crate) const KNOWN_SELF_INTERSECTING_SPLINE: &str = "slice-spline-self-intersect";
pub(crate) const KNOWN_DONUT_SLICED_ACROSS_RINGS: &str = "donut-sliced-across-rings";

/// One invariant violation. `known` is the backlog slug of a held-out
/// limitation the input exhibits, and a tagged violation is not a failure.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Violation {
    pub(crate) class: &'static str,
    pub(crate) reason: String,
    pub(crate) known: Option<&'static str>,
}

impl Violation {
    pub(crate) fn new(class: &'static str, reason: String) -> Self {
        Violation {
            class,
            reason,
            known: None,
        }
    }

    pub(crate) fn is_pending(&self) -> bool {
        self.known.is_none()
    }

    /// The text the fuzz minimiser and the checked-in cases carry.
    pub(crate) fn render(&self) -> String {
        match self.known {
            Some(slug) => format!("{}: {} [known:{}]", self.class, self.reason, slug),
            None => format!("{}: {}", self.class, self.reason),
        }
    }
}

// ─── Ground-truth curve set ───

/// A real (non-construction) input curve, re-derived from the raw record by
/// the documented discriminating fields. Deliberately independent of the
/// builder's own `TryFrom` classification: a curve the oracle reads here and
/// the builder does not (or vice versa) is exactly the kind of divergence the
/// coverage check exists to catch.
#[derive(Clone, Debug, PartialEq)]
enum Curve {
    Line {
        p0: Vec2,
        p1: Vec2,
    },
    Circle {
        c: Vec2,
        r: f64,
    },
    Arc {
        c: Vec2,
        r: f64,
        a0: f64,
        a1: f64,
    },
    Ellipse {
        c: Vec2,
        a: f64,
        b: f64,
        theta: f64,
    },
    Spline {
        p0: Vec2,
        c1: Vec2,
        c2: Vec2,
        p3: Vec2,
    },
}

/// Classify one raw record, mirroring the input contract's discriminating
/// order (`spline`, `ellipse`, arc by start+radius, line by start, circle by
/// center). `None` for a record missing a field its kind needs: the builder
/// drops those, so they bound no area and the oracle must not expect any.
fn curve_of(e: &InputEntity) -> Option<Curve> {
    if e.kind.as_deref() == Some("spline") {
        let (Some(p0), Some(c1), Some(c2), Some(p3)) = (e.start, e.c1, e.c2, e.end) else {
            return None;
        };
        return Some(Curve::Spline { p0, c1, c2, p3 });
    }
    if e.kind.as_deref() == Some("ellipse") {
        let (Some(c), Some(a), Some(b)) = (e.center, e.a, e.b) else {
            return None;
        };
        return Some(Curve::Ellipse {
            c,
            a,
            b,
            theta: e.theta.unwrap_or(0.0),
        });
    }
    if e.start.is_some() && e.radius.is_some() {
        let (Some(c), Some(r), Some(a0), Some(a1)) =
            (e.center, e.radius, e.angle_start, e.angle_end)
        else {
            return None;
        };
        return Some(Curve::Arc { c, r, a0, a1 });
    }
    if e.start.is_some() {
        let (Some(p0), Some(p1)) = (e.start, e.end) else {
            return None;
        };
        return Some(Curve::Line { p0, p1 });
    }
    if e.center.is_some() {
        let (Some(c), Some(r)) = (e.center, e.radius) else {
            return None;
        };
        return Some(Curve::Circle { c, r });
    }
    None
}

/// The real curves of one input, in input order, with their entity ids.
fn real_curves(input: &[(String, InputEntity)]) -> Vec<(String, Curve)> {
    let mut out = Vec::new();
    for (eid, e) in input {
        if e.construction {
            continue;
        }
        if let Some(c) = curve_of(e) {
            out.push((eid.clone(), c));
        }
    }
    out
}

/// The held-out limitation slugs the input exhibits. Self-intersecting spline
/// first (its geometry poisons more checks), then the line across a washer.
pub(crate) fn known_slugs(input: &[(String, InputEntity)]) -> Vec<&'static str> {
    let curves = real_curves(input);
    let mut slugs = Vec::new();
    if curves.iter().any(|(_, c)| match c {
        Curve::Spline { p0, c1, c2, p3 } => {
            // Coarse sampling on purpose: a self-crossing is a feature-scale
            // event, and a merge-tight flattening of a large spline is tens of
            // thousands of points whose O(n^2) scan dominated the whole check.
            let span = bbox_of(&[*p0, *c1, *c2, *p3])
                .map(|b| (b[2] - b[0]).hypot(b[3] - b[1]))
                .unwrap_or(0.0);
            let s = sample_spline(*p0, *c1, *c2, *p3, chord_tol_for(span));
            let mut pts = s.pts;
            if pts.len() > 256 {
                let step = pts.len().div_ceil(256);
                pts = pts
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| i % step == 0)
                    .map(|(_, p)| *p)
                    .collect();
            }
            let n = pts.len();
            let segs = if s.closed { n } else { n - 1 };
            let mut crosses = false;
            'outer: for i in 0..segs {
                let a = pts[i];
                let b = pts[(i + 1) % n];
                for j in (i + 1)..segs {
                    if (i + 1) % n == j || (j + 1) % n == i {
                        continue;
                    }
                    let c = pts[j];
                    let d = pts[(j + 1) % n];
                    if seg_seg_intersect(a, b, c, d) {
                        let shared = [a, b].iter().any(|p| {
                            [c, d]
                                .iter()
                                .any(|q| (p[0] - q[0]).hypot(p[1] - q[1]) <= MERGE)
                        });
                        if !shared {
                            crosses = true;
                            break 'outer;
                        }
                    }
                }
            }
            crosses
        }
        _ => false,
    }) {
        slugs.push(KNOWN_SELF_INTERSECTING_SPLINE);
    }
    if line_crosses_both_rings_of_a_washer(&curves) {
        slugs.push(KNOWN_DONUT_SLICED_ACROSS_RINGS);
    }
    slugs
}

/// True when some line pierces both circles of a concentric pair (two proper
/// crossings each): the "line across a washer" case.
fn line_crosses_both_rings_of_a_washer(curves: &[(String, Curve)]) -> bool {
    let circles: Vec<(Vec2, f64)> = curves
        .iter()
        .filter_map(|(_, c)| match *c {
            Curve::Circle { c, r } if r > MERGE => Some((c, r)),
            _ => None,
        })
        .collect();
    let lines: Vec<(Vec2, Vec2)> = curves
        .iter()
        .filter_map(|(_, c)| match *c {
            Curve::Line { p0, p1 } => Some((p0, p1)),
            _ => None,
        })
        .collect();
    for i in 0..circles.len() {
        for j in (i + 1)..circles.len() {
            let ((c1, r1), (c2, r2)) = (circles[i], circles[j]);
            if (c1[0] - c2[0]).hypot(c1[1] - c2[1]) > MERGE || (r1 - r2).abs() <= MERGE {
                continue;
            }
            for (p0, p1) in &lines {
                if chord_count(*p0, *p1, c1, r1) == 2 && chord_count(*p0, *p1, c2, r2) == 2 {
                    return true;
                }
            }
        }
    }
    false
}

/// Number of proper crossings of the segment `p0..p1` with the circle.
fn chord_count(p0: Vec2, p1: Vec2, c: Vec2, r: f64) -> usize {
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    let fx = p0[0] - c[0];
    let fy = p0[1] - c[1];
    let a = dx * dx + dy * dy;
    if a <= 0.0 {
        return 0;
    }
    let b = 2.0 * (fx * dx + fy * dy);
    let cc = fx * fx + fy * fy - r * r;
    let disc = b * b - 4.0 * a * cc;
    if disc <= 0.0 {
        return 0;
    }
    let sq = disc.sqrt();
    let mut count = 0;
    for t in [(-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)] {
        if t > EPS && t < 1.0 - EPS {
            count += 1;
        }
    }
    count
}

/// A few points that bound a curve, for span measurements: the control points
/// for a spline, the centre/radius box for a circle or arc, a conservative box
/// for an ellipse, the endpoints for a line.
fn hull_points(c: &Curve) -> Vec<Vec2> {
    match *c {
        Curve::Line { p0, p1 } => vec![p0, p1],
        Curve::Circle { c, r } => vec![[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]],
        Curve::Arc { c, r, a0, a1 } => vec![
            [c[0] - r, c[1] - r],
            [c[0] + r, c[1] + r],
            [c[0] + r * radians(a0).cos(), c[1] + r * radians(a0).sin()],
            [c[0] + r * radians(a1).cos(), c[1] + r * radians(a1).sin()],
        ],
        Curve::Ellipse { c, a, b, theta: _ } => {
            let r = a.abs().max(b.abs());
            vec![[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]]
        }
        Curve::Spline { p0, c1, c2, p3 } => vec![p0, c1, c2, p3],
    }
}

/// Chord tolerance for the ground-truth sampling: the plan's "well below the
/// merge tolerance" made scale-adaptive. A fixed 1e-7 would emit hundreds of
/// thousands of segments for the r ~ 1000 motifs the generator reaches; tying
/// the tolerance to a hundredth of a cell keeps the segment counts in the
/// hundreds while staying far below a cell, which is all the grid checks need.
fn chord_tol_for(span: f64) -> f64 {
    (MERGE / 2.0).max(span / CELLS_PER_DIAGONAL / 100.0)
}

/// Judge one builder run against its input. `out` must be the output of
/// `detect_topology(input)`.
pub(crate) fn check_topology(input: &[(String, InputEntity)], out: &TopologyOut) -> Vec<Violation> {
    if input.is_empty() {
        return vec![];
    }
    let curves = real_curves(input);
    let input_ids: BTreeSet<String> = input.iter().map(|(id, _)| id.clone()).collect();
    let construction_ids: BTreeSet<String> = input
        .iter()
        .filter(|(_, e)| e.construction)
        .map(|(id, _)| id.clone())
        .collect();

    // One span for the whole run: the bbox diagonal of the real curves, so the
    // grid and every sampling tolerance agree. Bounding points only: sampling
    // every curve at a fine tolerance just to measure the span is the one
    // quadratic cost the oracle would otherwise pay per check.
    let mut pts: Vec<Vec2> = Vec::new();
    for (_, c) in &curves {
        pts.extend_from_slice(&hull_points(c));
    }
    let span = bbox_of(&pts)
        .map(|b| (b[2] - b[0]).hypot(b[3] - b[1]))
        .unwrap_or(0.0);
    let chord_tol = chord_tol_for(span);

    let mut violations = Vec::new();

    let faces = face_polys(out, chord_tol);

    if !curves.is_empty() {
        violations.extend(coverage_violations(&curves, &faces, chord_tol));
    }

    let verts: BTreeMap<String, Vec2> = out.vertices.iter().map(|(k, v)| (k.clone(), *v)).collect();
    for (si, s) in out.surfaces.iter().enumerate() {
        for (hi, hole) in s.holes.iter().enumerate() {
            check_loop(
                &format!("surface {si} hole {hi}"),
                hole,
                &verts,
                &input_ids,
                &construction_ids,
                chord_tol,
                &mut violations,
            );
        }
        check_loop(
            &format!("surface {si}"),
            &s.boundary,
            &verts,
            &input_ids,
            &construction_ids,
            chord_tol,
            &mut violations,
        );
    }
    violations.extend(hole_wiring_violations(out));
    violations.extend(half_edge_usage_violations(out));
    violations.extend(euler_violations(out));

    // Tag the geometry-consistency classes when the input exhibits a held-out
    // limitation; the pipeline-level classes never get tagged (see the module
    // comment).
    let slugs = known_slugs(input);
    if !slugs.is_empty() {
        for v in &mut violations {
            if matches!(v.class, "coverage" | "structure" | "euler" | "half-edge") {
                v.known = Some(slugs[0]);
            }
        }
    }
    violations
}

/// Convenience: run the builder and judge the result.
pub(crate) fn check_input(input: &[(String, InputEntity)]) -> Vec<Violation> {
    let out = detect_topology(input);
    check_topology(input, &out)
}

/// Determinism against an already-computed run: the vertex id sequence, the
/// edge identity sequence and every face's exact area, holes and centroid must
/// repeat bit-for-bit. Comparing those beats formatting the whole output (a
/// large sketch's debug string is tens of megabytes) and covers the same
/// classes: a randomized vertex pool or edge order changes the ids/indices,
/// a randomized merge changes the areas.
pub(crate) fn check_determinism_against(
    input: &[(String, InputEntity)],
    out: &TopologyOut,
) -> Vec<Violation> {
    let other = detect_topology(input);
    let ids_a: Vec<&String> = out.vertices.iter().map(|(k, _)| k).collect();
    let ids_b: Vec<&String> = other.vertices.iter().map(|(k, _)| k).collect();
    let edges_a: Vec<(&String, usize)> = out
        .edges
        .iter()
        .map(|e| (&e.entity_id, e.edge_index))
        .collect();
    let edges_b: Vec<(&String, usize)> = other
        .edges
        .iter()
        .map(|e| (&e.entity_id, e.edge_index))
        .collect();
    if ids_a == ids_b && edges_a == edges_b && face_summaries(out) == face_summaries(&other) {
        vec![]
    } else {
        vec![Violation::new(
            "determinism",
            "two runs of the same input differ".to_string(),
        )]
    }
}

/// Determinism: the same input twice, from scratch.
pub(crate) fn check_determinism(input: &[(String, InputEntity)]) -> Vec<Violation> {
    let out = detect_topology(input);
    check_determinism_against(input, &out)
}

/// Entity-order independence: the permuted input (out[i] = input[perm[i]]) must
/// produce the same face multiset within `1e-9` relative (ids may differ).
pub(crate) fn check_order_independence(
    input: &[(String, InputEntity)],
    perm: &[usize],
) -> Vec<Violation> {
    if perm.len() != input.len() {
        return vec![Violation::new(
            "order",
            "permutation length mismatch".into(),
        )];
    }
    let permuted: Vec<(String, InputEntity)> = perm.iter().map(|&i| input[i].clone()).collect();
    let base = face_summaries(&detect_topology(input));
    let other = face_summaries(&detect_topology(&permuted));
    // A reordering moves nothing; the only noise it can introduce is a merge
    // decision at sub-merge distances, so that is the perturbation the
    // comparison is allowed to explain.
    compare_face_multisets(
        "order",
        "entity permutation",
        &base,
        &other,
        1e-9,
        1e-9,
        MERGE / 100.0,
        MERGE,
    )
}

/// Jitter stability: `jittered` is the same input moved by at most
/// `MERGE / 10` per vertex. Face count and areas must hold within `1e-6`
/// relative.
pub(crate) fn check_stability(
    input: &[(String, InputEntity)],
    jittered: &[(String, InputEntity)],
) -> Vec<Violation> {
    let base = face_summaries(&detect_topology(input));
    let moved = face_summaries(&detect_topology(jittered));
    // Two endpoints can move towards each other by 2 * MERGE / 10; that is the
    // largest boundary motion the comparison must be able to explain.
    compare_face_multisets(
        "stability",
        "vertex jitter",
        &base,
        &moved,
        1e-6,
        1e-6,
        2.0 * MERGE / 10.0,
        4.0 * MERGE / 10.0,
    )
}

/// Move every defining point of every entity by the same per-entity delta, so a
/// jittered curve stays internally consistent (an arc's centre and endpoints
/// move together).
pub(crate) fn jitter_input(
    input: &[(String, InputEntity)],
    deltas: &[Vec2],
) -> Vec<(String, InputEntity)> {
    let shift = |p: &mut Option<Vec2>, d: Vec2| {
        if let Some(p) = p {
            p[0] += d[0];
            p[1] += d[1];
        }
    };
    input
        .iter()
        .zip(deltas.iter().cycle())
        .map(|((id, e), d)| {
            let mut j = e.clone();
            shift(&mut j.start, *d);
            shift(&mut j.end, *d);
            shift(&mut j.center, *d);
            shift(&mut j.c1, *d);
            shift(&mut j.c2, *d);
            (id.clone(), j)
        })
        .collect()
}

/// JSON of the violations for the node boundary: `[{class, reason, known}]`.
#[cfg(feature = "fuzz")]
pub(crate) fn violations_json(input: &[u8]) -> Result<Vec<u8>, String> {
    let geometry = super::codec::decode_input(input).map_err(|e| format!("{e:?}"))?;
    let violations = check_input(&geometry);
    let values: Vec<serde_json::Value> = violations
        .iter()
        .map(|v| {
            serde_json::json!({
                "class": v.class,
                "reason": v.reason,
                "known": v.known,
                "text": v.render(),
            })
        })
        .collect();
    serde_json::to_vec(&values).map_err(|e| e.to_string())
}

#[cfg(test)]
#[cfg(test)]
#[path = "oracle/tests.rs"]
mod tests;
