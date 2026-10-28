//! Ground-truth sampling and the exact face geometry: the oracle's own view of
//! the curves (chord chains within a tolerance), the planar predicates the
//! structural and coverage checks share, and the exact area/centroid summaries
//! the order and stability comparisons work on.

use super::Curve;
use super::Violation;
use crate::radians;
use crate::topology::dcel::{pymod, TopologyOut};
use crate::topology::profile_loops::{BoundaryEdge, EdgeGeom, Vec2};
use crate::topology::{
    TOL_FACE_EXISTENCE_MIN_AREA, TOL_NEAR_ZERO_AREA, TOL_TOPOLOGY_EPS as EPS,
    TOL_TOPOLOGY_MERGE as MERGE, TWO_PI,
};

// ─── Sampling ───

/// A sampled curve: points plus whether the first and last points join (a
/// closed ring has no repeated first point).
pub(crate) struct Sampled {
    pub(crate) pts: Vec<Vec2>,
    pub(crate) closed: bool,
}

/// Angular step whose chord sagitta is at most `tol`.
fn arc_step(r: f64, tol: f64) -> f64 {
    if r <= tol {
        return std::f64::consts::FRAC_PI_2;
    }
    (2.0 * (2.0 * tol / r).sqrt()).clamp(1e-4, std::f64::consts::FRAC_PI_2)
}

fn sample_arc(c: Vec2, r: f64, a0: f64, a1: f64, tol: f64) -> Sampled {
    let sweep = a1 - a0;
    let n = ((sweep.abs() / arc_step(r, tol)).ceil() as usize).max(1);
    let pts = (0..=n)
        .map(|k| {
            let a = a0 + sweep * k as f64 / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect();
    Sampled { pts, closed: false }
}

fn sample_ellipse(
    c: Vec2,
    a: f64,
    b: f64,
    theta_deg: f64,
    phi0: f64,
    phi1: f64,
    tol: f64,
) -> Sampled {
    let th = radians(theta_deg);
    let (cr, sr) = (th.cos(), th.sin());
    let r_max = a.abs().max(b.abs());
    let n = (((phi1 - phi0).abs() / arc_step(r_max, tol)).ceil() as usize).max(1);
    let pts = (0..=n)
        .map(|k| {
            let phi = phi0 + (phi1 - phi0) * k as f64 / n as f64;
            let ax = a * phi.cos();
            let ay = b * phi.sin();
            [c[0] + ax * cr - ay * sr, c[1] + ax * sr + ay * cr]
        })
        .collect();
    Sampled { pts, closed: false }
}

/// Flatten a cubic Bezier by recursive subdivision until its control net is
/// flat to `tol` (or the depth cap trips, which only happens for a pathological
/// control net; the cap keeps the oracle from stalling on hostile input).
pub(crate) fn sample_spline(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, tol: f64) -> Sampled {
    let mut pts = vec![p0];
    flatten_bezier(p0, c1, c2, p3, tol, 0, &mut pts);
    Sampled {
        pts,
        closed: (p0[0] - p3[0]).abs() < EPS && (p0[1] - p3[1]).abs() < EPS,
    }
}

/// Flattened points of a C0 cubic Bezier chain, in traversal order.
pub(crate) fn sample_fit_chain(poles: &[Vec2], tol: f64) -> Sampled {
    let mut pts = vec![poles[0]];
    for i in 0..poles.len() / 3 {
        flatten_bezier(
            poles[3 * i],
            poles[3 * i + 1],
            poles[3 * i + 2],
            poles[3 * i + 3],
            tol,
            0,
            &mut pts,
        );
    }
    let start = poles[0];
    let end = poles[poles.len() - 1];
    Sampled {
        pts,
        closed: (start[0] - end[0]).abs() < EPS && (start[1] - end[1]).abs() < EPS,
    }
}

fn flatten_bezier(
    p0: Vec2,
    c1: Vec2,
    c2: Vec2,
    p3: Vec2,
    tol: f64,
    depth: u32,
    out: &mut Vec<Vec2>,
) {
    // Distance of the off-curve handles from the chord; zero chord length (a
    // closed spline) falls back to the distance from the start point, so the
    // recursion still terminates on a small control net.
    let chord = (p3[0] - p0[0]).hypot(p3[1] - p0[1]);
    let flat = if chord > tol {
        let d1 = point_line_dist(c1, p0, p3);
        let d2 = point_line_dist(c2, p0, p3);
        d1.max(d2)
    } else {
        (c1[0] - p0[0])
            .hypot(c1[1] - p0[1])
            .max((c2[0] - p0[0]).hypot(c2[1] - p0[1]))
    };
    if flat <= tol || depth >= 18 {
        out.push(p3);
        return;
    }
    let mid = |a: Vec2, b: Vec2| [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
    let l1 = mid(p0, c1);
    let m = mid(c1, c2);
    let r2 = mid(c2, p3);
    let l2 = mid(l1, m);
    let r1 = mid(m, r2);
    let mid_all = mid(l2, r1);
    flatten_bezier(p0, l1, l2, mid_all, tol, depth + 1, out);
    flatten_bezier(mid_all, r1, r2, p3, tol, depth + 1, out);
}

pub(crate) fn sample_curve(c: &Curve, tol: f64) -> Sampled {
    match *c {
        Curve::Line { p0, p1 } => Sampled {
            pts: vec![p0, p1],
            closed: false,
        },
        Curve::Circle { c, r } => {
            // A ring has no ends: marking it closed keeps the wrap segment in
            // the barrier and keeps it out of the gap/seal search.
            let mut s = sample_arc(c, r, 0.0, TWO_PI, tol);
            s.closed = true;
            s
        }
        Curve::Arc { c, r, a0, a1 } => {
            // Input arc angles are degrees (the document convention); the
            // sampler works in radians. A start equal to the end (or a hair
            // apart, the same wrap `angle_in_arc`'s |s - e| < EPS arm treats
            // as a full turn) is the builder's full circle, so the sampler
            // must emit a ring, not a zero-length point.
            let start = radians(a0);
            let sweep = pymod(radians(a1) - start, TWO_PI);
            if !(EPS..=TWO_PI - EPS).contains(&sweep) {
                let mut s = sample_arc(c, r, start, start + TWO_PI, tol);
                s.closed = true;
                return s;
            }
            sample_arc(c, r, start, start + sweep, tol)
        }
        Curve::Ellipse { c, a, b, theta } => {
            let mut s = sample_ellipse(c, a, b, theta, 0.0, TWO_PI, tol);
            s.closed = true;
            s
        }
        Curve::Spline { p0, c1, c2, p3 } => sample_spline(p0, c1, c2, p3, tol),
    }
}

/// Sampled points of one boundary edge, in traversal order. A full ellipse is
/// a ring with no explicit repeat of the first point.
pub(crate) fn edge_polyline(eg: &EdgeGeom, tol: f64) -> Sampled {
    match *eg {
        EdgeGeom::Line { start, end } => Sampled {
            pts: vec![start, end],
            closed: false,
        },
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            ccw,
            start,
            end,
        } => {
            let a0 = radians(angle_start_deg);
            let a1 = radians(angle_end_deg);
            // The traversal is CCW or CW by the stored flag; the sweep keeps
            // that sign, so a reversed (CW) side samples towards the end
            // angle, not away from it.
            let sweep = if ccw {
                pymod(a1 - a0, TWO_PI)
            } else {
                -pymod(a0 - a1, TWO_PI)
            };
            let mut s = sample_arc(center, radius, a0, a0 + sweep, tol);
            // The stored endpoints are the builder's own values; anchoring the
            // sampled chain on them keeps the closure check meaningful even
            // when the angles and the endpoints disagree by rounding.
            if let Some(first) = s.pts.first_mut() {
                *first = start;
            }
            if let Some(last) = s.pts.last_mut() {
                *last = end;
            }
            s
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
        } => {
            let p0 = radians(angle_start_deg);
            let p1 = radians(angle_end_deg);
            let sweep = if ccw {
                pymod(p1 - p0, TWO_PI)
            } else {
                -pymod(p0 - p1, TWO_PI)
            };
            let mut s = sample_ellipse(center, a, b, theta, p0, p0 + sweep, tol);
            if let Some(first) = s.pts.first_mut() {
                *first = start;
            }
            if let Some(last) = s.pts.last_mut() {
                *last = end;
            }
            s
        }
        EdgeGeom::Spline { start, c1, c2, end } => sample_spline(start, c1, c2, end, tol),
        EdgeGeom::FitSpline { ref poles, .. } => sample_fit_chain(poles, tol),
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta,
        } => {
            let mut s = sample_ellipse(center, a, b, theta, 0.0, TWO_PI, tol);
            s.closed = true;
            s
        }
    }
}

/// One loop's polygon: the edges' points chained, consecutive duplicates (the
/// shared junction of two edges) and the wrap-around duplicate dropped.
pub(crate) fn loop_polygon(loop_edges: &[BoundaryEdge], tol: f64, max_pts: usize) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    for be in loop_edges {
        let s = edge_polyline(&be.geom, tol);
        for p in s.pts {
            // MERGE, not EPS: two sides of one loop meet at a vertex that each
            // computed from its own curve, so their coordinates can differ by
            // the solve's own noise. MERGE is the tolerance the whole pipeline
            // already treats as "the same point".
            if pts
                .last()
                .is_none_or(|q: &Vec2| (q[0] - p[0]).hypot(q[1] - p[1]) > MERGE)
            {
                pts.push(p);
            }
        }
    }
    if pts.len() > max_pts {
        // Decimate rather than truncate: a truncated polygon would have a
        // wrong area and a wrong self-intersection story.
        let step = pts.len().div_ceil(max_pts);
        pts = pts
            .iter()
            .enumerate()
            .filter(|(i, _)| i % step == 0)
            .map(|(_, p)| *p)
            .collect();
    }
    if pts.len() > 1 {
        let first = pts[0];
        if (pts[pts.len() - 1][0] - first[0]).hypot(pts[pts.len() - 1][1] - first[1]) <= MERGE {
            pts.pop();
        }
    }
    pts
}

// ─── Small geometry ───

pub(crate) fn point_line_dist(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len2.sqrt()
}

pub(crate) fn point_seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    let q = [a[0] + t * dx, a[1] + t * dy];
    (p[0] - q[0]).hypot(p[1] - q[1])
}

/// The segment's distance to an axis-aligned box, zero when it enters the box.
pub(crate) fn seg_rect_dist(a: Vec2, b: Vec2, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for i in 0..4 {
        if seg_seg_intersect(a, b, corners[i], corners[(i + 1) % 4]) {
            return 0.0;
        }
    }
    let point_rect = |p: Vec2| {
        let dx = (x0 - p[0]).max(p[0] - x1).max(0.0);
        let dy = (y0 - p[1]).max(p[1] - y1).max(0.0);
        dx.hypot(dy)
    };
    let mut best = point_rect(a).min(point_rect(b));
    for corner in corners {
        best = best.min(point_seg_dist(corner, a, b));
    }
    best
}

fn orient(a: Vec2, b: Vec2, c: Vec2) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Proper or touching intersection of two closed segments, shared endpoints
/// included (callers that must allow a shared vertex filter it out first).
pub(crate) fn seg_seg_intersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    if ((o1 > 0.0) != (o2 > 0.0)) && ((o3 > 0.0) != (o4 > 0.0)) {
        return true;
    }
    let on_seg = |p: Vec2, q: Vec2, r: Vec2| {
        r[0] >= p[0].min(q[0])
            && r[0] <= p[0].max(q[0])
            && r[1] >= p[1].min(q[1])
            && r[1] <= p[1].max(q[1])
    };
    (o1.abs() <= EPS && on_seg(a, b, c))
        || (o2.abs() <= EPS && on_seg(a, b, d))
        || (o3.abs() <= EPS && on_seg(c, d, a))
        || (o4.abs() <= EPS && on_seg(c, d, b))
}

pub(crate) fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// What two runs of the builder must agree on: one entry per face, by area
/// (boundary loop), the sorted hole areas and the boundary centroid.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FaceSummary {
    pub(crate) area: f64,
    pub(crate) holes: Vec<f64>,
    pub(crate) centroid: Vec2,
    /// `2 * area / perimeter`: how thick the face is on average. A face whose
    /// thickness is comparable to a perturbation cannot be a stability
    /// invariant (its area is a difference of nearly equal terms), so the
    /// comparisons below exempt it instead of reporting noise.
    pub(crate) thickness: f64,
}

pub(crate) fn face_summaries(out: &TopologyOut) -> Vec<FaceSummary> {
    // Exact area and centroid per loop (Green's theorem quadrature): the
    // comparisons below are 1e-9 relative, and a sampled polygon's area is
    // not continuous in the geometry at that scale.
    out.surfaces
        .iter()
        .map(|s| {
            let (area, centroid) = loop_area_centroid(&s.boundary);
            let mut holes: Vec<f64> = s
                .holes
                .iter()
                .map(|h| loop_area_centroid(h).0.abs())
                .collect();
            holes.sort_by(|a, b| a.total_cmp(b));
            // A coarse sampling for the perimeter: a face's thickness needs a
            // couple of percent, not merge-tight geometry, and a merge-tight
            // sampling of a large circle is tens of thousands of points.
            let coarse = (area.abs().sqrt() / 50.0).max(MERGE);
            let poly = loop_polygon(&s.boundary, coarse, 128);
            let mut perimeter = 0.0;
            for k in 0..poly.len() {
                let p = poly[k];
                let q = poly[(k + 1) % poly.len()];
                perimeter += (p[0] - q[0]).hypot(p[1] - q[1]);
            }
            let thickness = if perimeter > 0.0 {
                2.0 * area.abs() / perimeter
            } else {
                0.0
            };
            FaceSummary {
                area,
                holes,
                centroid,
                thickness,
            }
        })
        .collect()
}

/// Greedy multiset match between two runs, with a relative tolerance. Ids may
/// differ; only the geometry has to agree.
///
/// `area_perturbation` is the largest boundary motion the two runs may have
/// introduced (a sub-merge amount for a reordering, the jitter magnitude for
/// the stability check) and `centroid_perturbation` the largest distance a
/// face may have moved in response. A face thinner than
/// `10 * area_perturbation` is exempt: its area is a difference of nearly
/// equal terms, so that motion explains any change it shows. For a kept face
/// the same motion widens BOTH comparisons by the same relative factor
/// `4 * perturbation / thickness`: the area tolerance directly, and the
/// centroid budget by that factor times the run's own scale, because a
/// sliver's centroid is its first moment over a near-cancelled area and can
/// drift by `scale / thickness` times the boundary motion. Scaling only the
/// area made the check contradict itself: a face could pass on area and fail
/// on a centroid that the very motion it was allowed on area had carried it
/// by hundreds of times the fixed budget.
#[allow(clippy::too_many_arguments)]
pub(crate) fn compare_face_multisets(
    class: &'static str,
    label: &str,
    a: &[FaceSummary],
    b: &[FaceSummary],
    area_tol: f64,
    centroid_tol: f64,
    area_perturbation: f64,
    centroid_perturbation: f64,
) -> Vec<Violation> {
    let perturbation = area_perturbation;
    let min_thickness = 10.0 * perturbation;
    let a_kept: Vec<&FaceSummary> = a.iter().filter(|f| f.thickness >= min_thickness).collect();
    let b_kept: Vec<&FaceSummary> = b.iter().filter(|f| f.thickness >= min_thickness).collect();
    if a_kept.len() != b_kept.len() {
        return vec![Violation::new(
            class,
            format!(
                "{label}: face count {} != {} (faces at least {min_thickness:e} thick)",
                a_kept.len(),
                b_kept.len()
            ),
        )];
    }
    let scale = scale_of(a);
    let centroid_budget = |widen: f64| centroid_tol * scale + centroid_perturbation + widen * scale;
    let mut taken = vec![false; b_kept.len()];
    let mut out = Vec::new();
    for fa in &a_kept {
        // The same boundary motion the area tolerance allows: a sliver's
        // centroid is its first moment over a near-cancelled area, so it can
        // drift by `scale / thickness` times that motion.
        let widen = 4.0 * perturbation / fa.thickness.max(f64::MIN_POSITIVE);
        let tol = area_tol.max(widen);
        let area_delta = |fb: &FaceSummary| {
            (fa.area - fb.area).abs()
                / fa.area
                    .abs()
                    .max(fb.area.abs())
                    .max(TOL_FACE_EXISTENCE_MIN_AREA)
        };
        let holes_ok_for = |fb: &FaceSummary| {
            fa.holes.len() == fb.holes.len()
                && fa.holes.iter().zip(fb.holes.iter()).all(|(x, y)| {
                    (x - y).abs() <= tol * x.abs().max(y.abs()).max(TOL_FACE_EXISTENCE_MIN_AREA)
                })
        };
        let mut best: Option<usize> = None;
        for (i, fb) in b_kept.iter().enumerate() {
            if taken[i] || area_delta(fb) > tol || !holes_ok_for(fb) {
                continue;
            }
            let d = (fa.centroid[0] - fb.centroid[0]).hypot(fa.centroid[1] - fb.centroid[1]);
            if d <= centroid_budget(widen) {
                best = Some(i);
                break;
            }
        }
        match best {
            Some(i) => taken[i] = true,
            None => {
                // Name the field that failed: the closest candidate's area,
                // its holes, or its centroid. The reviewer's 252-order case
                // had matching areas and a differing hole list; "has no
                // match" alone never said so.
                let candidate = b_kept
                    .iter()
                    .min_by(|x, y| area_delta(x).total_cmp(&area_delta(y)));
                let note = match candidate {
                    None => "no candidate face at all".to_string(),
                    Some(fb) if area_delta(fb) > tol => {
                        format!(
                            "nearest candidate area {:.9} (outside the area tolerance)",
                            fb.area
                        )
                    }
                    Some(fb) if !holes_ok_for(fb) => format!(
                        "area {} matches but the hole list differs ({} vs {} holes)",
                        fb.area,
                        fa.holes.len(),
                        fb.holes.len()
                    ),
                    Some(fb) => {
                        let d = (fa.centroid[0] - fb.centroid[0])
                            .hypot(fa.centroid[1] - fb.centroid[1]);
                        format!(
                            "area matches but the centroid moved {d:.3e} \
                             (candidate ({:.6}, {:.6}), budget {:.3e})",
                            fb.centroid[0],
                            fb.centroid[1],
                            centroid_budget(widen)
                        )
                    }
                };
                out.push(Violation::new(
                    class,
                    format!(
                        "{label}: face with area {:.9} and centroid ({:.6}, {:.6}) has no \
                         match: {note}",
                        fa.area, fa.centroid[0], fa.centroid[1]
                    ),
                ));
            }
        }
    }
    out
}

fn scale_of(faces: &[FaceSummary]) -> f64 {
    let mut scale: f64 = 0.0;
    for f in faces {
        scale = scale
            .max(f.centroid[0].abs())
            .max(f.centroid[1].abs())
            .max(f.area.abs().sqrt());
    }
    scale.max(MERGE)
}

/// 16-point Gauss-Legendre nodes and weights on [-1, 1]. The loop integrals
/// below are trigonometric or polynomial and smooth, so fixed-order quadrature
/// is essentially exact AND continuous in the geometry: a sampled polygon's
/// area jumps whenever its point count crosses a threshold, which is exactly
/// what a 1e-9 relative comparison cannot tolerate.
const GL_NODES: [f64; 8] = [
    0.09501250983763744,
    0.2816035507792589,
    0.45801677765722737,
    0.6178762444026438,
    0.755404408355003,
    0.8656312023878318,
    0.9445750230732326,
    0.9894009349916499,
];
const GL_WEIGHTS: [f64; 8] = [
    0.1894506104550685,
    0.18260341504492358,
    0.16915651939500254,
    0.14959598881657674,
    0.12462897125553388,
    0.09515851168249279,
    0.062253523938647894,
    0.027152459411754096,
];

/// Integrate three integrands at once over `t in [0, 1]` with the 16-point
/// rule: the Green's theorem integrands of one edge, evaluated in one pass.
fn gl01_3(mut f: impl FnMut(f64) -> (f64, f64, f64)) -> (f64, f64, f64) {
    let mut sum = (0.0, 0.0, 0.0);
    for (node, weight) in GL_NODES.iter().zip(GL_WEIGHTS.iter()) {
        for t in [0.5 - 0.5 * node, 0.5 + 0.5 * node] {
            let v = f(t);
            sum = (
                sum.0 + weight * v.0,
                sum.1 + weight * v.1,
                sum.2 + weight * v.2,
            );
        }
    }
    (0.5 * sum.0, 0.5 * sum.1, 0.5 * sum.2)
}

/// The three Green's-theorem integrals of one cubic Bezier in its traversal
/// direction. A cubic's derivative is quadratic, so the integrands are degree
/// five polynomials and the 16-point rule is exact, not approximate.
fn bezier_integrals(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2) -> (f64, f64, f64) {
    let integrand = |p: Vec2, dp: Vec2| (p[0] * dp[1], p[0] * p[0] * dp[1], p[1] * p[1] * dp[0]);
    gl01_3(|t| {
        let p = crate::topology::curve_split::bezier_point(p0, c1, c2, p3, t);
        let d0 = [3.0 * (c1[0] - p0[0]), 3.0 * (c1[1] - p0[1])];
        let d1 = [
            6.0 * (p0[0] - 2.0 * c1[0] + c2[0]),
            6.0 * (p0[1] - 2.0 * c1[1] + c2[1]),
        ];
        let d2 = [
            3.0 * (p3[0] - 3.0 * c2[0] + 3.0 * c1[0] - p0[0]),
            3.0 * (p3[1] - 3.0 * c2[1] + 3.0 * c1[1] - p0[1]),
        ];
        let dp = [
            d0[0] + d1[0] * t + d2[0] * t * t,
            d0[1] + d1[1] * t + d2[1] * t * t,
        ];
        integrand(p, dp)
    })
}

/// The three Green's-theorem integrals of one boundary edge in its traversal
/// direction: `(integral x dy, integral x^2 dy, integral y^2 dx)`.
fn edge_integrals(eg: &EdgeGeom) -> (f64, f64, f64) {
    // `dp` is the derivative with respect to the unit parameter `t`.
    let integrand = |p: Vec2, dp: Vec2| (p[0] * dp[1], p[0] * p[0] * dp[1], p[1] * p[1] * dp[0]);
    match *eg {
        EdgeGeom::Line { start, end } => {
            let dp = [end[0] - start[0], end[1] - start[1]];
            gl01_3(|t| {
                let p = [start[0] + t * dp[0], start[1] + t * dp[1]];
                integrand(p, dp)
            })
        }
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            ccw,
            ..
        } => {
            let a0 = radians(angle_start_deg);
            let a1 = radians(angle_end_deg);
            let sweep = if ccw {
                pymod(a1 - a0, TWO_PI)
            } else {
                -pymod(a0 - a1, TWO_PI)
            };
            gl01_3(|t| {
                let theta = a0 + t * sweep;
                let p = [
                    center[0] + radius * theta.cos(),
                    center[1] + radius * theta.sin(),
                ];
                let dp = [-radius * theta.sin() * sweep, radius * theta.cos() * sweep];
                integrand(p, dp)
            })
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
            let th = radians(theta);
            let (cr, sr) = (th.cos(), th.sin());
            let p0 = radians(angle_start_deg);
            let p1 = radians(angle_end_deg);
            let sweep = if ccw {
                pymod(p1 - p0, TWO_PI)
            } else {
                -pymod(p0 - p1, TWO_PI)
            };
            gl01_3(|t| {
                let phi = p0 + t * sweep;
                let (c, s) = (phi.cos(), phi.sin());
                let p = [
                    center[0] + a * c * cr - b * s * sr,
                    center[1] + a * c * sr + b * s * cr,
                ];
                let dp = [
                    (-a * s * cr - b * c * sr) * sweep,
                    (-a * s * sr + b * c * cr) * sweep,
                ];
                integrand(p, dp)
            })
        }
        EdgeGeom::Spline { start, c1, c2, end } => bezier_integrals(start, c1, c2, end),
        EdgeGeom::FitSpline { ref poles, .. } => {
            let mut total = (0.0, 0.0, 0.0);
            for i in 0..poles.len() / 3 {
                let (a, b, c) = bezier_integrals(
                    poles[3 * i],
                    poles[3 * i + 1],
                    poles[3 * i + 2],
                    poles[3 * i + 3],
                );
                total.0 += a;
                total.1 += b;
                total.2 += c;
            }
            total
        }
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta: _,
        } => {
            // A full ellipse is closed; rotation does not change its area and
            // its centroid is the centre, so the closed forms are exact.
            let area = std::f64::consts::PI * a * b;
            (area, 2.0 * center[0] * area, -2.0 * center[1] * area)
        }
    }
}

/// Exact signed area and area-weighted centroid of one loop, in the loop's
/// stored traversal direction (CCW faces are positive).
pub(crate) fn loop_area_centroid(loop_edges: &[BoundaryEdge]) -> (f64, Vec2) {
    let mut integrals = (0.0, 0.0, 0.0);
    for be in loop_edges {
        let (a, b, c) = edge_integrals(&be.geom);
        integrals.0 += a;
        integrals.1 += b;
        integrals.2 += c;
    }
    let area = integrals.0;
    if area.abs() < TOL_NEAR_ZERO_AREA {
        let first = loop_edges.first().and_then(|be| be.geom.start());
        return (area, first.unwrap_or([0.0, 0.0]));
    }
    (
        area,
        [integrals.1 / (2.0 * area), -integrals.2 / (2.0 * area)],
    )
}

pub(crate) fn bbox_of(pts: &[Vec2]) -> Option<[f64; 4]> {
    let mut it = pts.iter();
    let first = it.next()?;
    let mut b = [first[0], first[1], first[0], first[1]];
    for p in it {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    Some(b)
}
