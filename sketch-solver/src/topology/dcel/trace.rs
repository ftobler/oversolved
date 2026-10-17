use std::collections::{HashMap, HashSet};

use super::super::curve_split::{bezier_point, ellipse_point_at};
use super::super::profile_loops::{
    loop_pts, point_in_polygon, point_polygon_dist, polygon_sagitta, subdivide_loops, BoundaryEdge,
    EdgeGeom, Vec2,
};
use super::super::{TOL_FACE_EXISTENCE_MIN_AREA, TOL_TOPOLOGY_MERGE as MERGE, TWO_PI};
use super::build::{bend, depart, HalfEdge};
use super::holes::HoleShell;
use super::{dedup, EdgeOut, Split, SurfaceOut, TopoEntity, Verts};
use crate::radians;

pub(super) fn face_area(cycle: &[usize], hes: &[HalfEdge], verts: &Verts) -> f64 {
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

/// Departure angles within this many radians of each other are the same
/// direction to the trace's resolution: at a tangency cusp the first derivative
/// cannot separate the edges, and only curvature can.
const ANGLE_TIE: f64 = 1e-7;

/// Quantise a departure angle into the tie window. A NaN angle (a poisoned
/// param that reached the geometry pass) has no direction to order by, so it
/// sorts before every real angle rather than comparing equal to everything the
/// way a raw `partial_cmp` would.
fn angle_bucket(angle: f64) -> i64 {
    if angle.is_nan() {
        return i64::MIN;
    }
    (angle / ANGLE_TIE).round() as i64
}

/// Total order for one vertex's departure fan: quantised angle, then signed
/// curvature, then the half-edge's own index. Quantising first is what makes
/// the key a genuine total order: comparing raw angles inside an epsilon window
/// is intransitive (a ~ b, b ~ c, but a not~ c), so the sorted fan depended on
/// the input permutation and could misorder `next_he` at a cusp. The index is
/// unique, so even identical (angle, curvature) pairs are fully determined.
///
/// Accepted edge behaviour: buckets are equal only when both angles round to
/// the same multiple of ANGLE_TIE, so a pair inside the window but straddling a
/// half-bucket boundary (angular mismatch within roughly 5e-8 to 1e-7) is
/// ordered by raw angle and the curvature tie-break never runs, where the old
/// epsilon-window comparator ordered it by curvature. Deterministic and
/// intended; a bucket-edge change shows up in the straddle test.
fn departure_order(a: &(f64, f64, usize), b: &(f64, f64, usize)) -> std::cmp::Ordering {
    angle_bucket(a.0)
        .cmp(&angle_bucket(b.0))
        .then_with(|| a.1.total_cmp(&b.1))
        .then_with(|| a.2.cmp(&b.2))
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

pub(super) fn trace_face_cycles(
    hes: &[HalfEdge],
    he_eid: &[String],
    verts: &Verts,
) -> Vec<SurfaceOut> {
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
        // Order CCW by departure angle. Two edges that leave along the same
        // tangent (a tangency cusp) have effectively equal angles that the
        // first derivative cannot separate, so the tie goes to signed curvature
        // (the right-bending edge precedes the left-bending one). See
        // `departure_order` for why the angle is quantised first: a NaN angle
        // or curvature falls back to a deterministic position instead of an
        // unordered fan, which would be a lost face.
        outs.sort_by(departure_order);
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
            // A single surviving side is a self-loop piece whose two ends are
            // the same vertex: a spline lobe between a self-crossing's
            // parameters. The area gate below is what filters a degenerate
            // one, not the length.
            if !cycle.is_empty() && face_area(&cycle, hes, verts) > TOL_FACE_EXISTENCE_MIN_AREA {
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

pub(super) fn circle_arcs(cx: f64, cy: f64, r: f64, eid: &str) -> Vec<BoundaryEdge> {
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
    entities: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
    max_keep: usize,
    mut boundary_of: F,
) -> Vec<SurfaceOut>
where
    F: FnMut(&str, &TopoEntity) -> Option<Vec<BoundaryEdge>>,
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

pub(super) fn build_standalone_surfaces(
    circles: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> Vec<SurfaceOut> {
    build_standalone(circles, splits, 1, |eid, e| {
        let TopoEntity::Circle { center, radius, .. } = *e else {
            return None;
        };
        Some(circle_arcs(center[0], center[1], radius, eid))
    })
}

pub(super) fn build_standalone_ellipses(
    ellipses: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> Vec<SurfaceOut> {
    let mut seen: Vec<[f64; 5]> = Vec::new();
    build_standalone(ellipses, splits, 1, move |eid, e| {
        let TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } = *e
        else {
            return None;
        };
        // A degenerate ellipse (near-zero semi-axis) bounds no area; never a face.
        if a.abs() < MERGE || b.abs() < MERGE {
            return None;
        }
        let theta = theta.unwrap_or(0.0);
        let key = [center[0], center[1], a, b, theta];
        if seen
            .iter()
            .any(|k| k.iter().zip(key.iter()).all(|(v, w)| (v - w).abs() < MERGE))
        {
            return None;
        }
        seen.push(key);
        Some(vec![BoundaryEdge {
            geom: EdgeGeom::Ellipse {
                center: [center[0], center[1]],
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

pub(super) fn build_standalone_splines(
    splines: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
    verts: &mut Verts,
) -> Vec<SurfaceOut> {
    build_standalone(splines, splits, 2, |eid, e| {
        let TopoEntity::Spline {
            start, c1, c2, end, ..
        } = *e
        else {
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

/// Samples per arc when the nesting pass reads a face's loop against a hole
/// region's boundary. Finer than the face-classification sampling because a
/// chord that cuts the corner here would decide coverage.
const HOLE_COVER_SAMPLES: usize = 64;
/// Samples per arc of a hole region's own boundary in the same test.
const FACE_CHAIN_SAMPLES: usize = 16;

/// Subtract the hole regions from the faces that own them, then fold nested
/// loops into the sketch-area model via `subdivide_loops`: every surviving loop
/// stays its own area, carrying the loops immediately nested inside it as
/// holes.
///
/// Ownership is the region's boundary lying inside the face's own loop (or on
/// it where the two share a side), NOT the face's interior merely reaching into
/// the region: a traced face's loop is a component of the same subdivision, so
/// a region the loop crosses or only touches is another face's, and subtracting
/// there cut regions the face never surrounded (the frontend's extrude of a
/// hole-bearing body face lost its hole that way). A standalone island owns the
/// shells nested inside its uncut loop under the same test.
///
/// The subtraction runs for EVERY face count, one included: on a sliced washer
/// no material face owns the bore (the ring halves never surround it), so it
/// is a no-op there, but on the arrangement where an UNsliced outer loop stayed
/// its own island face while a shell inside it was sliced, that island is the
/// single surface and its boundary encloses the bore; without the subtraction
/// its area would silently include a region the rule calls a hole.
pub(super) fn nest_surfaces(
    surfaces: Vec<SurfaceOut>,
    hole_shells: &[HoleShell],
) -> Vec<SurfaceOut> {
    let loops: Vec<Vec<BoundaryEdge>> = surfaces.iter().map(|s| s.boundary.clone()).collect();
    let sub = subdivide_loops(&loops);
    let mut out: Vec<SurfaceOut> = Vec::with_capacity(surfaces.len());
    for (oi, hole_idxs) in sub {
        let mut s = surfaces[oi].clone();
        if !hole_idxs.is_empty() {
            s.holes = hole_idxs.into_iter().map(|i| loops[i].clone()).collect();
        }
        // The face's own loop, finely sampled: a face owns a hole region when
        // the region lies inside it.
        let own: Vec<Vec2> = loop_pts(&s.boundary, HOLE_COVER_SAMPLES);
        // The face polygon is inscribed, so a point ON the true loop can sit up
        // to its sagitta outside the polygon; that is the width of "on it"
        // here. A merely ADJACENT region (one that shares an arc with the
        // face) has boundary points strictly outside the loop as well, and
        // `covers_region` keeps it from being subtracted from a face that
        // never surrounded it.
        let on_tol = polygon_sagitta(&own, HOLE_COVER_SAMPLES);
        for shell in hole_shells {
            for region in &shell.regions {
                // The region is one traced piece of the shell's interior; the
                // piece whose region this face owns is the wire to subtract
                // (the shell's whole loop would cross a face that covers only
                // part of it).
                if s.holes.iter().any(|h| same_loop(h, &region.boundary)) {
                    continue;
                }
                if covers_region(&own, &region.boundary, on_tol) {
                    s.holes.push(region.boundary.clone());
                }
            }
        }
        out.push(s);
    }
    out
}

/// True when the face loop `own` surrounds the region bounded by `region`:
/// every sample of the region's boundary lies inside the loop or on it, and at
/// least one lies strictly inside. A region the loop only crosses or touches
/// keeps some boundary point strictly outside and is not owned: the face's
/// area would otherwise swallow a region it does not surround. A boundary
/// lying entirely on the loop is the loop itself, not a hole.
///
/// A sample ON the loop says nothing: the loop is an inscribed polygon, so a
/// point on the true curve (a side the region SHARES with the face, like a
/// washer's ring and its bore) can read as either side, and a concave side puts
/// the polygon on the wrong one. The `on_tol` skip is what keeps such a shared
/// side from deciding the subtraction.
fn covers_region(own: &[Vec2], region: &[BoundaryEdge], on_tol: f64) -> bool {
    let mut strictly_inside = false;
    for p in region_samples(region, FACE_CHAIN_SAMPLES) {
        if point_polygon_dist(p, own) <= on_tol {
            continue;
        }
        if !point_in_polygon(p, own) {
            return false;
        }
        strictly_inside = true;
    }
    strictly_inside
}

/// Samples along a region's boundary, straight sides included. `loop_pts`
/// gives an edge's start plus its curve interior but nothing for a line; the
/// cover test needs points along every side, or a region whose only
/// outside-the-loop evidence sits mid-line would read as covered.
fn region_samples(region: &[BoundaryEdge], per_arc: usize) -> Vec<Vec2> {
    const LINE_SAMPLES: usize = 4;
    let mut pts = Vec::new();
    for be in region {
        if let EdgeGeom::Line { start, end } = be.geom {
            for k in 0..LINE_SAMPLES {
                let t = (k as f64 + 0.5) / LINE_SAMPLES as f64;
                pts.push([
                    start[0] + t * (end[0] - start[0]),
                    start[1] + t * (end[1] - start[1]),
                ]);
            }
        } else {
            pts.extend(loop_pts(std::slice::from_ref(be), per_arc));
        }
    }
    pts
}

/// Two loops are the same face boundary: the same sides in the same order,
/// compared by entity id and vertex pair (the traced faces carry both).
fn same_loop(a: &[BoundaryEdge], b: &[BoundaryEdge]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b.iter()).all(|(x, y)| {
            x.id == y.id && x.start_vertex == y.start_vertex && x.end_vertex == y.end_vertex
        })
}

pub(super) fn build_edge_queries(hes: &[HalfEdge], he_eid: &[String]) -> Vec<EdgeOut> {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic LCG knock-off: enough to shuffle a small fan, no crate
    // dependency, and the same seed gives the same clusters on every machine so
    // a failure is reproducible.
    fn prng(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (*state >> 33) ^ (*state >> 17)
    }

    fn unit(state: &mut u64) -> f64 {
        (prng(state) % 1_000_000) as f64 / 1_000_000.0
    }

    /// One cusp cluster: 3 to 7 departures whose angles all fall inside a
    /// ~2e-7 rad window, with curvatures that disagree with the angle order so
    /// the curvature tie-break actually runs. The old epsilon-window comparator
    /// is intransitive on such a set; the quantised key must produce one
    /// sequence for every input permutation.
    fn cusp_cluster(state: &mut u64) -> Vec<(f64, f64, usize)> {
        let base = unit(state) * 4.0 - 2.0;
        let k = 3 + (prng(state) % 5) as usize;
        (0..k)
            .map(|i| {
                let jitter = (unit(state) - 0.5) * 2.0e-7;
                let curvature = unit(state) * 10.0 - 5.0;
                (base + jitter, curvature, i)
            })
            .collect()
    }

    fn index_order(v: &[(f64, f64, usize)]) -> Vec<usize> {
        let mut c = v.to_vec();
        c.sort_by(departure_order);
        c.iter().map(|k| k.2).collect()
    }

    #[test]
    fn cusp_departure_order_is_a_total_order_under_every_permutation() {
        let mut state: u64 = 0x5eed_5eed;
        for _case in 0..256 {
            let cluster = cusp_cluster(&mut state);
            let expected = index_order(&cluster);
            for _perm in 0..24 {
                let mut shuffled = cluster.clone();
                for i in (1..shuffled.len()).rev() {
                    let j = (prng(&mut state) % (i as u64 + 1)) as usize;
                    shuffled.swap(i, j);
                }
                assert_eq!(
                    index_order(&shuffled),
                    expected,
                    "a permutation changed the departure order of {cluster:?}"
                );
            }
        }
    }

    #[test]
    fn cusp_cluster_orders_by_curvature_inside_the_window() {
        // Two departures the same direction to well under the tie window but
        // with opposite bends: the right-bending edge (negative curvature)
        // must precede the left-bending one regardless of which came first.
        let right = (0.3, -2.0, 7);
        let left = (0.3 + 1e-9, 2.0, 3);
        assert_eq!(index_order(&[right, left]), vec![7, 3]);
        assert_eq!(index_order(&[left, right]), vec![7, 3]);
    }

    #[test]
    fn a_straddled_bucket_edge_orders_by_angle_not_curvature() {
        // -0.55 and +0.45 in ANGLE_TIE units are 1e-7 apart, the full tie
        // window, but they round into adjacent buckets (-1 and 0), so the raw
        // angle decides and curvature never runs. The right-bending edge sits
        // in the later bucket, so a curvature order would reverse this pair;
        // pin the angle order accepted by `departure_order`.
        let earlier_left = (-0.55 * ANGLE_TIE, 2.0, 3);
        let later_right = (0.45 * ANGLE_TIE, -2.0, 7);
        assert_eq!(index_order(&[earlier_left, later_right]), vec![3, 7]);
        assert_eq!(index_order(&[later_right, earlier_left]), vec![3, 7]);
    }

    /// A closed line loop from polygon points.
    fn poly_loop(pts: &[Vec2]) -> Vec<BoundaryEdge> {
        let n = pts.len();
        (0..n)
            .map(|i| BoundaryEdge {
                geom: EdgeGeom::Line {
                    start: pts[i],
                    end: pts[(i + 1) % n],
                },
                id: Some("l".into()),
                start_vertex: Some(format!("_v{i}")),
                end_vertex: Some(format!("_v{}", (i + 1) % n)),
            })
            .collect()
    }

    #[test]
    fn a_shared_side_does_not_decide_the_subtraction() {
        // The face is a C (the polygon from the profile-loop tests): a region
        // inside its top bar sharing the bar's right and top sides must be
        // subtracted, and a region in its mouth sharing the mouth's sides must
        // not. The shared sides sit ON the face loop, where the inscribed
        // polygon reads a vertical side's points as OUTSIDE; skipping them is
        // what lets the region's own sides decide.
        let c = poly_loop(&[
            [0.0, 0.0],
            [0.0, 10.0],
            [10.0, 10.0],
            [10.0, 8.0],
            [2.0, 8.0],
            [2.0, 2.0],
            [10.0, 2.0],
            [10.0, 0.0],
        ]);
        let own = loop_pts(&c, HOLE_COVER_SAMPLES);
        let on_tol = polygon_sagitta(&own, HOLE_COVER_SAMPLES);
        let band = poly_loop(&[[8.0, 8.0], [10.0, 8.0], [10.0, 10.0], [8.0, 10.0]]);
        assert!(
            covers_region(&own, &band, on_tol),
            "a region inside the bar sharing two of its sides is covered"
        );
        let mouth = poly_loop(&[[2.0, 2.0], [10.0, 2.0], [10.0, 8.0], [2.0, 8.0]]);
        assert!(
            !covers_region(&own, &mouth, on_tol),
            "the C's mouth is outside the C, shared sides or not"
        );
    }

    #[test]
    fn a_nan_angle_sorts_before_every_real_angle() {
        // A poisoned param that reached the geometry pass has no direction to
        // order by; `angle_bucket` must park it in the lowest bucket rather
        // than let a raw comparison fall back to Equal (an unordered fan is a
        // lost face).
        assert_eq!(angle_bucket(f64::NAN), i64::MIN);
        let nan = (f64::NAN, 0.0, 5);
        let real = (-10.0, 0.0, 9);
        assert_eq!(index_order(&[nan, real]), vec![5, 9]);
        assert_eq!(index_order(&[real, nan]), vec![5, 9]);
    }
}
