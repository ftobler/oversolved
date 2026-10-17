//! The coverage oracle: a grid flood fill over the sampled barrier with
//! builder-fusion-resolution gap tunnels, judging the cells it can decide
//! against the built faces.

use std::collections::BTreeMap;

use crate::topology::dcel::TopologyOut;
use crate::topology::profile_loops::Vec2;
use crate::topology::{TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE};

use super::geometry::{
    bbox_of, loop_polygon, point_in_polygon, sample_curve, seg_rect_dist, seg_seg_intersect,
    Sampled,
};
use super::holes::hole_expected;
use super::{Curve, Violation};

/// Cells along the bbox diagonal: the plan's `scale/200`.
pub(crate) const CELLS_PER_DIAGONAL: f64 = 200.0;
/// A cell is "on curve" when its rectangle comes within this many merge
/// tolerances of a curve; the plan's 3.
const BAND_MERGE: f64 = 3.0;
/// How far a gap tunnel reaches from the opening midpoint to find the free
/// cell on each side: comfortably past the band plus a cell, even for tiny
/// spans where the band can be wider than a cell.
const PASSAGE_REACH_CELLS: f64 = 3.0;
/// Cap on the points of one face polygon for cell containment. The cap is a
/// backstop against a pathological loop, not a sampling choice: a decimated
/// polygon can cut across a band between two nearby curves (the crescent of
/// two near-tangent circles is 0.03 wide), which would push cells inside a
/// face out of it. The chord-tolerance sampling already bounds a real face at
/// a few hundred points, so the cap sits far above that.
pub(crate) const FACE_POLY_MAX_PTS: usize = 1024;

struct Grid {
    nx: usize,
    ny: usize,
    x0: f64,
    y0: f64,
    cell: f64,
}

impl Grid {
    fn center(&self, i: usize, j: usize) -> Vec2 {
        [
            self.x0 + (i as f64 + 0.5) * self.cell,
            self.y0 + (j as f64 + 0.5) * self.cell,
        ]
    }
}

/// Does a straight segment miss the sampled barrier and every seal? The
/// barrier is bucketed per cell, so only the few segments near the segment
/// are tested. Both the gap tunnels and the optimistic fill's diagonal steps
/// go through here: a path that does not cross the samples is a genuine path
/// in the complement, up to the sampling's own resolution.
struct BarrierTest<'a> {
    grid: &'a Grid,
    index: &'a BTreeMap<usize, Vec<u32>>,
    barriers: &'a [(Vec2, Vec2)],
    seals: &'a [(Vec2, Vec2)],
}

impl BarrierTest<'_> {
    /// The tunnel and step endpoints are free-cell centers, more than the
    /// band (and so more than MERGE) from every curve and seal, so only an
    /// actual crossing matters: a touching distance test would be checking a
    /// point that cannot be near the barrier in the first place.
    fn segment_clear(&self, p: Vec2, q: Vec2) -> bool {
        let (i0, i1) = cell_range(p[0].min(q[0]), p[0].max(q[0]), self.grid, 0);
        let (j0, j1) = cell_range(p[1].min(q[1]), p[1].max(q[1]), self.grid, 1);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let Some(ids) = self.index.get(&(j * self.grid.nx + i)) else {
                    continue;
                };
                for &bi in ids {
                    let (s, t) = self.barriers[bi as usize];
                    if seg_seg_intersect(p, q, s, t) {
                        return false;
                    }
                }
            }
        }
        let (lo, hi) = (
            [p[0].min(q[0]), p[1].min(q[1])],
            [p[0].max(q[0]), p[1].max(q[1])],
        );
        for &(s, t) in self.seals {
            if lo[0] > s[0].max(t[0]) || hi[0] < s[0].min(t[0]) {
                continue;
            }
            if lo[1] > s[1].max(t[1]) || hi[1] < s[1].min(t[1]) {
                continue;
            }
            if seg_seg_intersect(p, q, s, t) {
                return false;
            }
        }
        true
    }
}

/// Flood-fill state over one grid: `blocked` cells stop the fill, everything
/// else is reached from the border outward. The pessimistic pass uses plain
/// 4-connectivity; the optimistic pass adds certified tunnels and, when
/// `diagonal` is given, corner steps that provably miss the barrier (a thin
/// diagonal corridor has no cell-aligned 4-step through it at all).
fn flood_reach(
    grid: &Grid,
    blocked: &[bool],
    tunnels: &BTreeMap<usize, Vec<usize>>,
    diagonal: Option<&BarrierTest<'_>>,
) -> Vec<bool> {
    let mut reached = vec![false; grid.nx * grid.ny];
    let mut stack: Vec<usize> = Vec::new();
    let idx = |i: usize, j: usize| j * grid.nx + i;
    for i in 0..grid.nx {
        for j in [0, grid.ny - 1] {
            let k = idx(i, j);
            if !blocked[k] && !reached[k] {
                reached[k] = true;
                stack.push(k);
            }
        }
    }
    for j in 0..grid.ny {
        for i in [0, grid.nx - 1] {
            let k = idx(i, j);
            if !blocked[k] && !reached[k] {
                reached[k] = true;
                stack.push(k);
            }
        }
    }
    while let Some(k) = stack.pop() {
        let i = k % grid.nx;
        let j = k / grid.nx;
        let c = grid.center(i, j);
        for (di, dj) in [
            (-1i64, 0i64),
            (1, 0),
            (0, -1),
            (0, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
            (1, 1),
        ] {
            let (ni, nj) = (i as i64 + di, j as i64 + dj);
            if ni < 0 || nj < 0 || ni >= grid.nx as i64 || nj >= grid.ny as i64 {
                continue;
            }
            let (ni, nj) = (ni as usize, nj as usize);
            let nk = idx(ni, nj);
            if blocked[nk] || reached[nk] {
                continue;
            }
            if di != 0 && dj != 0 {
                let Some(steps) = diagonal else {
                    continue;
                };
                // A curve crossing the step passes through a side cell's
                // rectangle; with both side cells free there is nothing to
                // test, which is the common case over open terrain.
                let side_a = idx((i as i64 + di) as usize, j);
                let side_b = idx(i, (j as i64 + dj) as usize);
                if (blocked[side_a] || blocked[side_b])
                    && !steps.segment_clear(c, grid.center(ni, nj))
                {
                    continue;
                }
            }
            reached[nk] = true;
            stack.push(nk);
        }
        if let Some(extra) = tunnels.get(&k) {
            for &nk in extra {
                if !blocked[nk] && !reached[nk] {
                    reached[nk] = true;
                    stack.push(nk);
                }
            }
        }
    }
    reached
}

/// One built face as the coverage check judges it: the boundary loop with its
/// holes subtracted, plus a bbox for the cheap reject.
pub(crate) struct FacePoly {
    outer: Vec<Vec2>,
    holes: Vec<Vec<Vec2>>,
    bbox: [f64; 4],
}

impl FacePoly {
    pub(crate) fn contains(&self, p: Vec2) -> bool {
        if p[0] < self.bbox[0] || p[0] > self.bbox[2] || p[1] < self.bbox[1] || p[1] > self.bbox[3]
        {
            return false;
        }
        if !point_in_polygon(p, &self.outer) {
            return false;
        }
        !self.holes.iter().any(|h| point_in_polygon(p, h))
    }
}

/// The built faces as the coverage check judges them: the boundary loop with
/// its holes subtracted, plus a bbox for the cheap reject.
pub(crate) fn face_polys(out: &TopologyOut, chord_tol: f64) -> Vec<FacePoly> {
    out.surfaces
        .iter()
        .map(|s| {
            let outer = loop_polygon(&s.boundary, chord_tol, FACE_POLY_MAX_PTS);
            let holes = s
                .holes
                .iter()
                .map(|h| loop_polygon(h, chord_tol, FACE_POLY_MAX_PTS))
                .collect();
            let bbox = bbox_of(&outer).unwrap_or([0.0, 0.0, 0.0, 0.0]);
            FacePoly { outer, holes, bbox }
        })
        .collect()
}

/// The coverage oracle. Judges cells far enough from every curve to be
/// decidable, against the faces the builder returned.
pub(crate) fn coverage_violations(
    curves: &[(String, Curve)],
    faces: &[FacePoly],
    chord_tol: f64,
    shells: &[super::holes::Chain],
) -> Vec<Violation> {
    let mut all: Vec<Vec2> = Vec::new();
    let sampled: Vec<Sampled> = curves
        .iter()
        .map(|(_, c)| sample_curve(c, chord_tol))
        .collect();
    let reach: Vec<f64> = curves.iter().map(|(_, c)| end_reach(c)).collect();
    for s in &sampled {
        all.extend_from_slice(&s.pts);
    }
    let Some(bbox) = bbox_of(&all) else {
        return vec![];
    };
    let (w, h) = (bbox[2] - bbox[0], bbox[3] - bbox[1]);
    let diag = w.hypot(h);
    if diag <= 0.0 {
        return vec![];
    }
    let cell = diag / CELLS_PER_DIAGONAL;
    // Three cells of padding on each side: one so a shape that fills its own
    // bbox still has a border to flood from, plus the free cell a gap tunnel
    // needs on the outside of a contour that runs along the bbox.
    let grid = Grid {
        nx: ((w / cell).ceil() as usize + 6).max(4),
        ny: ((h / cell).ceil() as usize + 6).max(4),
        x0: bbox[0] - 3.0 * cell,
        y0: bbox[1] - 3.0 * cell,
        cell,
    };

    // Barrier: a cell whose rectangle comes within the band of any curve.
    let band = BAND_MERGE * MERGE + chord_tol;
    let mut blocked = vec![false; grid.nx * grid.ny];
    for s in &sampled {
        let n = s.pts.len();
        if n < 2 {
            continue;
        }
        let last = if s.closed { n } else { n - 1 };
        let half_cell_diag = cell * std::f64::consts::SQRT_2 * 0.5;
        for k in 0..last {
            let a = s.pts[k];
            let b = s.pts[(k + 1) % n];
            // Cheap reject: a cell whose centre is farther from the segment's
            // midpoint than half the segment plus the band plus the cell's
            // half diagonal cannot come within the band.
            let mid = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
            let reach = 0.5 * (a[0] - b[0]).hypot(a[1] - b[1]) + band + half_cell_diag;
            let (mnx, mny, mxx, mxy) = (
                a[0].min(b[0]) - band,
                a[1].min(b[1]) - band,
                a[0].max(b[0]) + band,
                a[1].max(b[1]) + band,
            );
            let (i0, i1) = cell_range(mnx, mxx, &grid, 0);
            let (j0, j1) = cell_range(mny, mxy, &grid, 1);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    if blocked[j * grid.nx + i] {
                        continue;
                    }
                    let (x0, y0) = (grid.x0 + i as f64 * cell, grid.y0 + j as f64 * cell);
                    let c = [x0 + 0.5 * cell, y0 + 0.5 * cell];
                    if (c[0] - mid[0]).hypot(c[1] - mid[1]) > reach {
                        continue;
                    }
                    if seg_rect_dist(a, b, x0, y0, x0 + cell, y0 + cell) <= band {
                        blocked[j * grid.nx + i] = true;
                    }
                }
            }
        }
    }

    // A one-cell-wide digital curve does not stop a 4-connected fill: the
    // curve can step diagonally from one marked cell into another, leaving a
    // free pixel pair the fill slips through. So the pessimistic barrier is
    // the marked set DILATED by one cell, which blocks the fill; and the
    // optimistic barrier is the plain marked set plus the tunnels through the
    // openings no cell-wide step can cross (see `gap_tunnels`). A cell whose
    // reachability differs between the two fills sits somewhere the grid
    // cannot decide (behind such an opening) and is skipped rather than
    // judged.
    let barriers = barrier_segments(&sampled);
    let index = barrier_index(&barriers, &grid);
    let seals = gap_seals(&sampled, &reach);
    let test = BarrierTest {
        grid: &grid,
        index: &index,
        barriers: &barriers,
        seals: &seals,
    };
    let tunnels = gap_tunnels(&sampled, &reach, &test, &grid, &blocked, band);
    let pessimistic_blocked = dilate(&blocked, &grid);
    let reached = flood_reach(&grid, &pessimistic_blocked, &BTreeMap::new(), None);
    let reached_opt = flood_reach(&grid, &blocked, &tunnels, Some(&test));

    let mut face_union: Option<[f64; 4]> = None;
    for f in faces {
        face_union = Some(match face_union {
            None => f.bbox,
            Some(mut u) => {
                u[0] = u[0].min(f.bbox[0]);
                u[1] = u[1].min(f.bbox[1]);
                u[2] = u[2].max(f.bbox[2]);
                u[3] = u[3].max(f.bbox[3]);
                u
            }
        });
    }

    let mut unreached_missing = 0usize;
    let mut unreached_multi = 0usize;
    let mut unreached_example: Option<(Vec2, usize)> = None;
    let mut reached_inside = 0usize;
    let mut reached_example: Option<Vec2> = None;
    // Cells whose region the oracle's own even/odd rule reads as a hole but
    // which the builder filled anyway: the one way a hole region can be wrong
    // in the filling direction. (The other direction, a material region left
    // unfilled, lands in the lost-area count, because the oracle expects a
    // face there.)
    let mut hole_filled = 0usize;
    let mut hole_example: Option<Vec2> = None;
    for j in 0..grid.ny {
        for i in 0..grid.nx {
            let k = j * grid.nx + i;
            // A cell the two fills disagree on is skipped: a sub-cell channel
            // or a certified tunnel into it is exactly what the grid cannot
            // decide. The residual blind spot: a region reachable ONLY through
            // a certified tunnel is never judged, and on a curved target a
            // sub-MERGE opening measures up to the chord tolerance wider than
            // it is, so a fused opening can be left to the tunnel and its
            // region missed rather than falsely reported.
            if blocked[k] || reached[k] != reached_opt[k] {
                continue;
            }
            let p = grid.center(i, j);
            // Outside the union of every face bbox the count is trivially
            // zero, which is the common case over a padded grid.
            let inside = match face_union {
                Some(u) if p[0] >= u[0] && p[0] <= u[2] && p[1] >= u[1] && p[1] <= u[3] => {
                    faces.iter().filter(|f| f.contains(p)).count()
                }
                _ => 0,
            };
            if reached[k] {
                if inside > 0 {
                    reached_inside += 1;
                    reached_example.get_or_insert(p);
                }
                continue;
            }
            if hole_expected(p, shells) {
                if inside > 0 {
                    hole_filled += 1;
                    hole_example.get_or_insert(p);
                }
            } else if inside == 0 {
                unreached_missing += 1;
                unreached_example.get_or_insert((p, inside));
            } else if inside > 1 {
                unreached_multi += 1;
                unreached_example.get_or_insert((p, inside));
            }
        }
    }

    let mut out = Vec::new();
    if let Some((p, n)) = unreached_example {
        let class = if n == 0 {
            "coverage (lost area)"
        } else {
            "coverage (overlap)"
        };
        out.push(Violation::new(
            "coverage",
            format!(
                "{class}: {unreached_missing} cells read as bounded but sit in no face and \
                 {unreached_multi} sit in more than one, first at ({:.6}, {:.6}) with {n}",
                p[0], p[1]
            ),
        ));
    } else if unreached_missing > 0 || unreached_multi > 0 {
        unreachable!("counts only accumulate with an example");
    }
    if let Some(p) = hole_example {
        out.push(Violation::new(
            "coverage",
            format!(
                "coverage (hole region filled): {hole_filled} cells read as holes sit inside a \
                 face, first at ({:.6}, {:.6})",
                p[0], p[1]
            ),
        ));
    }
    if let Some(p) = reached_example {
        out.push(Violation::new(
            "coverage",
            format!(
                "coverage (phantom area): {reached_inside} cells reachable from the border sit \
                 inside a face, first at ({:.6}, {:.6})",
                p[0], p[1]
            ),
        ));
    }
    out
}

fn cell_range(lo: f64, hi: f64, grid: &Grid, axis: usize) -> (usize, usize) {
    let (origin, n) = if axis == 0 {
        (grid.x0, grid.nx)
    } else {
        (grid.y0, grid.ny)
    };
    let i0 = (((lo - origin) / grid.cell).floor().max(0.0) as usize).min(n - 1);
    let i1 = (((hi - origin) / grid.cell).ceil().max(0.0) as usize).min(n - 1);
    (i0, i1.max(i0))
}

/// One-cell 4-neighbour dilation: the pessimistic barrier.
fn dilate(blocked: &[bool], grid: &Grid) -> Vec<bool> {
    let mut out = blocked.to_vec();
    for j in 0..grid.ny {
        for i in 0..grid.nx {
            if !blocked[j * grid.nx + i] {
                continue;
            }
            if i > 0 {
                out[j * grid.nx + i - 1] = true;
            }
            if i + 1 < grid.nx {
                out[j * grid.nx + i + 1] = true;
            }
            if j > 0 {
                out[(j - 1) * grid.nx + i] = true;
            }
            if j + 1 < grid.ny {
                out[(j + 1) * grid.nx + i] = true;
            }
        }
    }
    out
}

/// The barrier as consecutive sample segments; zero-length ones (the wrap
/// point of a closed sample) are dropped.
fn barrier_segments(sampled: &[Sampled]) -> Vec<(Vec2, Vec2)> {
    let mut out = Vec::new();
    for s in sampled {
        let n = s.pts.len();
        if n < 2 {
            continue;
        }
        let last = if s.closed { n } else { n - 1 };
        for k in 0..last {
            let a = s.pts[k];
            let b = s.pts[(k + 1) % n];
            if (a[0] - b[0]).hypot(a[1] - b[1]) > EPS {
                out.push((a, b));
            }
        }
    }
    out
}

/// The foot of `p` on the segment `a..b` and its distance.
fn closest_on_segment(p: Vec2, a: Vec2, b: Vec2) -> (Vec2, f64) {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (a, (p[0] - a[0]).hypot(p[1] - a[1]));
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    let q = [a[0] + t * dx, a[1] + t * dy];
    (q, (p[0] - q[0]).hypot(p[1] - q[1]))
}

/// How far past an open end the builder's intersector can put a contact and
/// still register it: a line end is bound by the parameter window in
/// `dcel/intersect.rs` (`EPS` on `t` in `[0, 1]`, which is `EPS * length` in
/// world units), an arc end by the `MERGE / r` angle slack its span filter
/// allows (a world reach of at least MERGE along the carrier), and a spline
/// end's contact is dropped by `register_hit` wherever it lands at or past
/// the end. Circles and ellipses are closed, so they have no ends to reach
/// from.
fn end_reach(c: &Curve) -> f64 {
    match *c {
        Curve::Line { p0, p1 } => EPS * (p1[0] - p0[0]).hypot(p1[1] - p0[1]),
        Curve::Arc { .. } => MERGE,
        Curve::Spline { .. } => 0.0,
        Curve::Circle { .. } | Curve::Ellipse { .. } => 0.0,
    }
}

/// One candidate opening at an open curve's end: the barrier point it faces,
/// the gap distance, and whether the builder fuses the two there (see
/// `end_fuses`).
struct Opening {
    q: Vec2,
    d: f64,
    fused: bool,
}

/// Whether the builder fuses a contact that lands `d` from an open end and in
/// the interior of another curve. The carrier crossing sits `d / sin(theta)`
/// from the end along the end's carrier, so only a gap up to
/// `reach * sin(theta)` is inside the end's intersector window. The `MERGE`
/// cap is the vertex merge itself: above it a crossing is only fused when the
/// intersector clamps the minted point back onto the end, which depends on
/// the pair's operand order, so the oracle leaves such an opening to the
/// tunnel and skips its cells rather than judging them. The same modelling
/// gap applies to the target's own span window, which is only ever wider.
fn end_fuses(reach: f64, end_dir: Vec2, target_dir: Vec2, d: f64) -> bool {
    if d >= MERGE {
        return false;
    }
    let end_len = end_dir[0].hypot(end_dir[1]);
    let target_len = target_dir[0].hypot(target_dir[1]);
    if end_len <= EPS || target_len <= EPS {
        return false;
    }
    let cross = end_dir[0] * target_dir[1] - end_dir[1] * target_dir[0];
    d <= reach * cross.abs() / (end_len * target_len)
}

/// The barrier points an open curve's end could fuse with or gap against,
/// nearest first: one per other curve, plus the own curve's best loop-back. A
/// same-curve point whose along-curve distance is comparable to its Euclidean
/// distance is just the curve continuing past the end (it cannot be a passage:
/// any path "through" it crosses the curve), so only a real loop-back, where
/// the curve has travelled far to return close, is kept.
fn gap_candidates(sampled: &[Sampled], reach: &[f64], own: usize, end_idx: usize) -> Vec<Opening> {
    let own_curve = &sampled[own];
    let own_pt = own_curve.pts[end_idx];
    let n_own = own_curve.pts.len();
    let last_own = n_own - 1;
    let neighbour = if end_idx == 0 {
        own_curve.pts[1]
    } else {
        own_curve.pts[end_idx - 1]
    };
    let end_dir = [own_pt[0] - neighbour[0], own_pt[1] - neighbour[1]];
    let mut candidates: Vec<Opening> = Vec::new();
    let mut own_best: Option<(Vec2, f64)> = None;
    let mut along = 0.0;
    let consider_own = |k: usize, along: f64, own_best: &mut Option<(Vec2, f64)>| {
        let (a, b) = (own_curve.pts[k], own_curve.pts[k + 1]);
        let (q, d) = closest_on_segment(own_pt, a, b);
        if d > EPS && along >= 2.0 * d + MERGE && own_best.is_none_or(|(_, bd)| d < bd) {
            *own_best = Some((q, d));
        }
    };
    if end_idx == 0 {
        for k in 0..last_own {
            if k > 0 {
                // The incident segment is skipped: it starts at the end and
                // says nothing about where the curve comes back.
                consider_own(k, along, &mut own_best);
            }
            along += (own_curve.pts[k + 1][0] - own_curve.pts[k][0])
                .hypot(own_curve.pts[k + 1][1] - own_curve.pts[k][1]);
        }
    } else {
        let mut along_back = 0.0;
        for k in (0..last_own).rev() {
            if k < last_own - 1 {
                consider_own(k, along_back, &mut own_best);
            }
            along_back += (own_curve.pts[k + 1][0] - own_curve.pts[k][0])
                .hypot(own_curve.pts[k + 1][1] - own_curve.pts[k][1]);
        }
    }
    if let Some((q, d)) = own_best {
        // The builder never intersects an entity with itself, so the only
        // fusion the curve's own two ends can get is the vertex merge their
        // seeded ids already go through.
        let far = if end_idx == 0 {
            own_curve.pts[last_own]
        } else {
            own_curve.pts[0]
        };
        let own_end = (q[0] - far[0]).hypot(q[1] - far[1]) <= EPS;
        candidates.push(Opening {
            q,
            d,
            fused: own_end && d < MERGE,
        });
    }
    for (j, s) in sampled.iter().enumerate() {
        if j == own || s.pts.len() < 2 {
            continue;
        }
        let n = s.pts.len();
        let last = if s.closed { n } else { n - 1 };
        let mut best: Option<(Vec2, f64, Vec2)> = None;
        for k in 0..last {
            let (a, b) = (s.pts[k], s.pts[(k + 1) % n]);
            let (q, d) = closest_on_segment(own_pt, a, b);
            if d > EPS && best.is_none_or(|(_, bd, _)| d < bd) {
                best = Some((q, d, [b[0] - a[0], b[1] - a[1]]));
            }
        }
        let Some((q, d, target_dir)) = best else {
            continue;
        };
        // An open target's endpoint is a seeded vertex, so an approach there
        // is fused by the vertex merge alone, whatever the kinds.
        let target_end = !s.closed
            && ((q[0] - s.pts[0][0]).hypot(q[1] - s.pts[0][1]) <= EPS
                || (q[0] - s.pts[last][0]).hypot(q[1] - s.pts[last][1]) <= EPS);
        let fused = if target_end {
            d < MERGE
        } else {
            end_fuses(reach[own], end_dir, target_dir, d)
        };
        candidates.push(Opening { q, d, fused });
    }
    candidates.sort_by(|a, b| a.d.total_cmp(&b.d));
    candidates
}

/// Bucket the barrier segments by the cells their rectangles overlap, so a
/// diagonal step test only inspects the few segments near the step.
fn barrier_index(barriers: &[(Vec2, Vec2)], grid: &Grid) -> BTreeMap<usize, Vec<u32>> {
    let mut index: BTreeMap<usize, Vec<u32>> = BTreeMap::new();
    for (bi, &(a, b)) in barriers.iter().enumerate() {
        let (i0, i1) = cell_range(a[0].min(b[0]), a[0].max(b[0]), grid, 0);
        let (j0, j1) = cell_range(a[1].min(b[1]), a[1].max(b[1]), grid, 1);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let (x0, y0) = (
                    grid.x0 + i as f64 * grid.cell,
                    grid.y0 + j as f64 * grid.cell,
                );
                if seg_rect_dist(a, b, x0, y0, x0 + grid.cell, y0 + grid.cell) <= EPS {
                    index.entry(j * grid.nx + i).or_default().push(bi as u32);
                }
            }
        }
    }
    index
}

/// The seals: every opening the builder fuses into one vertex (see
/// `end_fuses` and the seeded-endpoint merge). No path may thread a sealed
/// opening, so a region behind one stays reportable as a lost area; an
/// opening the builder leaves open carries a tunnel instead and its region is
/// skipped, never judged from the grid's guess.
fn gap_seals(sampled: &[Sampled], reach: &[f64]) -> Vec<(Vec2, Vec2)> {
    let mut seals: Vec<(Vec2, Vec2)> = Vec::new();
    for (i, s) in sampled.iter().enumerate() {
        if s.closed || s.pts.len() < 2 {
            continue;
        }
        for end_idx in [0, s.pts.len() - 1] {
            for opening in gap_candidates(sampled, reach, i, end_idx) {
                if opening.fused {
                    seals.push((s.pts[end_idx], opening.q));
                }
            }
        }
    }
    seals
}

/// Certified passages through the openings the builder leaves open, as extra
/// fill edges between the free cells on their two sides. A fused opening is
/// sealed instead and gets none. Two hubs are offered per opening: the gap
/// midpoint (a straight crossing) and a point just past the end (the route
/// around the curve's tip, which is where a sub-cell opening is often
/// threaded). Every edge a hub adds is a pair of cells whose polylines
/// through the hub provably miss every sampled barrier piece and every seal,
/// so a tunnel can never pierce a closed boundary.
fn gap_tunnels(
    sampled: &[Sampled],
    reach: &[f64],
    test: &BarrierTest<'_>,
    grid: &Grid,
    blocked: &[bool],
    band: f64,
) -> BTreeMap<usize, Vec<usize>> {
    let mut tunnels: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    let passage_reach = PASSAGE_REACH_CELLS * (grid.cell + band);
    // Openings wider than this are resolved by the fill's own steps, so only
    // the nearest couple of candidates per end are worth a hub.
    let max_gap = 6.0 * grid.cell + 8.0 * MERGE;
    for (i, s) in sampled.iter().enumerate() {
        if s.closed || s.pts.len() < 2 {
            continue;
        }
        for end_idx in [0, s.pts.len() - 1] {
            let end = s.pts[end_idx];
            let neighbour = if end_idx == 0 {
                s.pts[1]
            } else {
                s.pts[s.pts.len() - 2]
            };
            let inward = [neighbour[0] - end[0], neighbour[1] - end[1]];
            let step_len = inward[0].hypot(inward[1]);
            if step_len <= EPS {
                continue;
            }
            for (ci, opening) in gap_candidates(sampled, reach, i, end_idx)
                .into_iter()
                .enumerate()
            {
                if opening.fused {
                    // Fused by the builder; keep looking for a farther
                    // genuine opening (a three-curve junction can close on
                    // one curve and open on another).
                    continue;
                }
                if ci >= 2 || opening.d > max_gap {
                    break;
                }
                hub_edges(
                    &mut tunnels,
                    grid,
                    blocked,
                    test,
                    [0.5 * (end[0] + opening.q[0]), 0.5 * (end[1] + opening.q[1])],
                    passage_reach,
                );
                // Just past the tip: far enough that the hub is off the
                // curve, near enough to stay on the end's side of the gap.
                let step = (0.5 * opening.d).clamp(4.0 * EPS, 0.5 * grid.cell);
                let past = [
                    end[0] - step * inward[0] / step_len,
                    end[1] - step * inward[1] / step_len,
                ];
                hub_edges(&mut tunnels, grid, blocked, test, past, passage_reach);
            }
        }
    }
    tunnels
}

/// Connect the free cells around one hub: every pair whose two polylines
/// through the hub clear the barrier gets a fill edge, so the fill can slip
/// through a sub-cell opening or around a curve's tip. Only the nearest cells
/// matter; a hub arm that reaches none, or only one, is harmless.
fn hub_edges(
    tunnels: &mut BTreeMap<usize, Vec<usize>>,
    grid: &Grid,
    blocked: &[bool],
    test: &BarrierTest<'_>,
    hub: Vec2,
    reach: f64,
) -> usize {
    let (i0, i1) = cell_range(hub[0] - reach, hub[0] + reach, grid, 0);
    let (j0, j1) = cell_range(hub[1] - reach, hub[1] + reach, grid, 1);
    let mut cells: Vec<(usize, f64)> = Vec::new();
    for j in j0..=j1 {
        for i in i0..=i1 {
            let k = j * grid.nx + i;
            if blocked[k] {
                continue;
            }
            let c = grid.center(i, j);
            let dm = (c[0] - hub[0]).hypot(c[1] - hub[1]);
            if dm > reach {
                continue;
            }
            if test.segment_clear(c, hub) {
                cells.push((k, dm));
            }
        }
    }
    cells.sort_by(|a, b| a.1.total_cmp(&b.1));
    cells.truncate(12);
    let n = cells.len();
    for x in 0..n {
        for y in (x + 1)..n {
            tunnels.entry(cells[x].0).or_default().push(cells[y].0);
            tunnels.entry(cells[y].0).or_default().push(cells[x].0);
        }
    }
    n
}
