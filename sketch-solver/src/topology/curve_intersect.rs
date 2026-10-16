//! Pure curve-curve intersection for the sketch area builder, ported from the
//! former `frontend/src/kernel/curveIntersect.ts` (deleted once this port
//! reached parity). Plain numbers in, intersection points + per-curve
//! parameters out. No topology / query dependencies.
//!
//! Parameter conventions returned in each `Hit` (`t_a` on curve a, `t_b` on b):
//!   line     t in [0, 1]             along p0 -> p1
//!   circle   angle in [0, 2*pi)      geometric atan2 from the center
//!   ellipse  ecc. angle in [0, 2*pi) the Geom_Ellipse parameter phi
//!   bezier   t in [0, 1]
//!
//! Robustness rule: numeric pairs report genuine sign-change crossings, and a
//! no-sign-change approach inside the near-tangent gap budget reports the foot
//! of its closest approach as a contact, mirroring the line/circle collapse in
//! the dcel. A true miss, further apart than that budget, still reports nothing,
//! so a graze never spuriously splits a curve.

use super::curve_split::{bezier_point, ellipse_point_at};
use super::dcel::{pymod, TANGENT_GAP_REL};
use super::{TOL_TOPOLOGY_EPS, TOL_TOPOLOGY_MERGE, TWO_PI};
use crate::{radians, MIN_SEMI_AXIS_SQ};

pub use super::Vec2;

/// One of the four carrier curves the area builder intersects. `Vec2` fields are
/// the shared 2D point type from the topology module.
#[derive(Clone, Copy, Debug)]
pub enum Curve {
    Line {
        p0: Vec2,
        p1: Vec2,
    },
    Circle {
        c: Vec2,
        r: f64,
    },
    Ellipse {
        c: Vec2,
        a: f64,
        b: f64,
        theta: f64,
    },
    Bezier {
        p0: Vec2,
        c1: Vec2,
        c2: Vec2,
        p3: Vec2,
    },
}

/// A crossing of two curves: the world point plus each curve's parameter at it.
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub point: Vec2,
    pub t_a: f64,
    pub t_b: f64,
}

const POINT_MERGE: f64 = TOL_TOPOLOGY_MERGE; // two hits closer than this are the same

/// A squared direction/length below which the segment is treated as having no
/// extent. Squared, so it is the square of the 1e-9 length floor.
const ZERO_LENGTH_SQ: f64 = 1e-18;

/// Tangent/coincidence budget for the circle-circle arm: a centre distance or
/// half-chord this small is the degenerate touch, not a transversal crossing.
/// Kept separate from the area notions because it is a length, not an area.
const CIRCLE_TANGENT_EPS: f64 = 1e-12;

// ─── recover a curve's parameter from a point known to lie on it ───

fn param_of(curve: &Curve, p: Vec2) -> f64 {
    match *curve {
        Curve::Line { p0, p1 } => {
            let dx = p1[0] - p0[0];
            let dy = p1[1] - p0[1];
            let len2 = dx * dx + dy * dy;
            if len2 < ZERO_LENGTH_SQ {
                return 0.0;
            }
            ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / len2
        }
        Curve::Circle { c, .. } => pymod((p[1] - c[1]).atan2(p[0] - c[0]), TWO_PI),
        Curve::Ellipse { c, a, b, theta } => {
            let cr = radians(theta).cos();
            let sr = radians(theta).sin();
            let dx = p[0] - c[0];
            let dy = p[1] - c[1];
            // Un-rotate into the ellipse's local frame; the eccentric angle is
            // atan2(y'/b, x'/a) (NOT the geometric angle).
            let xl = dx * cr + dy * sr;
            let yl = -dx * sr + dy * cr;
            pymod((yl / b).atan2(xl / a), TWO_PI)
        }
        // bezier: not recoverable in closed form; callers that pair a bezier as
        // the "other" curve obtain its parameter directly.
        Curve::Bezier { .. } => f64::NAN,
    }
}

// ─── implicit residual of a conic at a point (zero on the curve) ───

fn conic_residual(curve: &Curve) -> Option<Box<dyn Fn(Vec2) -> f64>> {
    match *curve {
        Curve::Circle { c, r } => Some(Box::new(move |p: Vec2| {
            let dx = p[0] - c[0];
            let dy = p[1] - c[1];
            dx * dx + dy * dy - r * r
        })),
        Curve::Ellipse { c, a, b, theta } => {
            let cr = radians(theta).cos();
            let sr = radians(theta).sin();
            Some(Box::new(move |p: Vec2| {
                let dx = p[0] - c[0];
                let dy = p[1] - c[1];
                let xl = dx * cr + dy * sr;
                let yl = -dx * sr + dy * cr;
                // Same degenerate-semi-axis floor the solver residual uses: a
                // NaN here would propagate into split params and vertex ids.
                (xl * xl) / (a * a).max(MIN_SEMI_AXIS_SQ)
                    + (yl * yl) / (b * b).max(MIN_SEMI_AXIS_SQ)
                    - 1.0
            }))
        }
        // A line or bezier has no implicit conic residual. The scan dispatch
        // never pairs one as the "other" curve, so return None rather than
        // aborting the worker if a future caller does.
        _ => None,
    }
}

// ─── near-tangency budget for the sampled-root paths ───

/// World-space budget for reading a no-sign-change approach as a contact:
/// `MERGE.max(TANGENT_GAP_REL * scale)`, the same rule `lc`/`cc` apply on their
/// miss side. `scale` is the pair's smaller characteristic radius; see
/// `curve_scale`. On a true miss there is no crossing to swallow, so the budget
/// can only invent a contact where the curves come within it of touching, never
/// erase a crossing the user drew.
fn tangent_gap_tol(scale: f64) -> f64 {
    TOL_TOPOLOGY_MERGE.max(TANGENT_GAP_REL * scale)
}

/// Characteristic radius of a carrier curve for the gap budget. A circle
/// contributes its radius and an ellipse its smaller semi-axis (its tightest
/// curvature), which is the two-circle case of `cc`'s `r_min`. A bezier has no
/// radius, so half its control-polygon bounding-box diagonal stands in; a line
/// contributes 0, leaving the `MERGE` floor (its caller pairs it with a curve
/// that does have a scale).
fn curve_scale(curve: &Curve) -> f64 {
    match *curve {
        Curve::Circle { r, .. } => r.abs(),
        Curve::Ellipse { a, b, .. } => a.abs().min(b.abs()),
        Curve::Bezier { p0, c1, c2, p3 } => bezier_scale(&[p0, c1, c2, p3]),
        Curve::Line { .. } => 0.0,
    }
}

fn bezier_scale(c: &BzCtrl) -> f64 {
    let b = bbox(c);
    0.5 * (b[2] - b[0]).hypot(b[3] - b[1])
}

/// World-space distance from a point to a conic, read off the residual's
/// first-order (normal) form `|F| / |grad F|`. For the circle this is exactly
/// the radial gap `|p - c| - r`, which is what `lc`'s `dist - r` measures, and
/// near the curve it is the distance to the nearest point on it. `None` where
/// the gradient vanishes (the ellipse centre) or the residual is not finite.
fn conic_gap(curve: &Curve, p: Vec2) -> Option<f64> {
    match *curve {
        Curve::Circle { c, r } => {
            let d = (p[0] - c[0]).hypot(p[1] - c[1]);
            if d.is_finite() {
                Some((d - r).abs())
            } else {
                None
            }
        }
        Curve::Ellipse { c, a, b, theta } => {
            let cr = radians(theta).cos();
            let sr = radians(theta).sin();
            let dx = p[0] - c[0];
            let dy = p[1] - c[1];
            let xl = dx * cr + dy * sr;
            let yl = -dx * sr + dy * cr;
            let aa = (a * a).max(MIN_SEMI_AXIS_SQ);
            let bb = (b * b).max(MIN_SEMI_AXIS_SQ);
            let f = xl * xl / aa + yl * yl / bb - 1.0;
            let gx = 2.0 * xl / aa;
            let gy = 2.0 * yl / bb;
            let m = gx.hypot(gy);
            if f.is_finite() && m.is_finite() && m > 0.0 {
                Some(f.abs() / m)
            } else {
                None
            }
        }
        _ => None,
    }
}

// ─── 1-D root finding by dense sampling + bisection, plus near-tangency minima ───

const SCAN_SAMPLES: usize = 512;
const BISECT_ITERS: usize = 60;
/// Ternary iterations for a sampled valley: (2/3)^48 shrinks one sampling
/// bracket (~1e-2 rad) below any parameter difference the split pass can see.
const TERNARY_ITERS: usize = 48;

fn bisect(g: &dyn Fn(f64) -> f64, lo: f64, hi: f64) -> f64 {
    let mut a = lo;
    let mut b = hi;
    let mut ga = g(a);
    for _ in 0..BISECT_ITERS {
        let m = 0.5 * (a + b);
        let gm = g(m);
        if gm == 0.0 {
            return m;
        }
        if ga * gm < 0.0 {
            b = m;
        } else {
            a = m;
            ga = gm;
        }
    }
    0.5 * (a + b)
}

/// Ternary minimisation of a locally unimodal function over a small bracket.
fn minimize(f: &dyn Fn(f64) -> f64, lo: f64, hi: f64) -> f64 {
    let mut a = lo;
    let mut b = hi;
    for _ in 0..TERNARY_ITERS {
        let m1 = a + (b - a) / 3.0;
        let m2 = b - (b - a) / 3.0;
        if f(m1) <= f(m2) {
            b = m2;
        } else {
            a = m1;
        }
    }
    0.5 * (a + b)
}

/// Roots of g over [t0, t1] found by scanning for sign changes and refining,
/// plus the near-tangency contacts: a sampled valley of |g| whose window keeps
/// one sign (so no crossing lives in it) and whose refined minimum comes within
/// `gap_tol` world units of the other curve yields that minimum's parameter.
/// For periodic curves pass the full period [0, 2pi) and `periodic`; the seam
/// is covered because the endpoints coincide.
///
/// Crossings come first in scan order, then the grazes, so a caller's hit list
/// only gains the new contacts at the end. A graze is the "virtual tangent
/// point" a converged tangent constraint leaves (see the dcel collapse): the
/// region it closes can only build on that foot, and a true miss beyond the
/// budget stays a miss.
fn scan_roots_and_grazes(
    g: &dyn Fn(f64) -> f64,
    gap_at: &dyn Fn(f64) -> Option<f64>,
    gap_tol: f64,
    t0: f64,
    t1: f64,
    periodic: bool,
) -> Vec<f64> {
    let step = (t1 - t0) / SCAN_SAMPLES as f64;
    let ts: Vec<f64> = (0..=SCAN_SAMPLES).map(|i| t0 + i as f64 * step).collect();
    let gs: Vec<f64> = ts.iter().map(|&t| g(t)).collect();

    let mut roots = Vec::new();
    for i in 0..SCAN_SAMPLES {
        if gs[i] == 0.0 {
            roots.push(ts[i]);
        } else if gs[i] * gs[i + 1] < 0.0 {
            roots.push(bisect(g, ts[i], ts[i + 1]));
        }
    }

    // A sampled valley is a sample below both neighbours. The one-sign window
    // rejects the pseudo-valleys on either side of a root, where |g| is also
    // locally minimal but the contact is the crossing itself, already emitted.
    let same_sign = |x: f64, y: f64| (x > 0.0 && y > 0.0) || (x < 0.0 && y < 0.0);
    let mut grazes: Vec<(f64, f64)> = Vec::new();
    // The valley test and the hidden-crossing guard, shared by the interior
    // windows and the wrapped seam window: a seam that skipped the guard could
    // emit a phantom foot in the middle of a sub-sample crossing pair.
    let consider = |prev: usize, i: usize, next: usize, lo: f64, hi: f64| -> Option<(f64, f64)> {
        if !(same_sign(gs[prev], gs[i]) && same_sign(gs[i], gs[next]))
            || gs[i].abs() > gs[prev].abs()
            || gs[i].abs() > gs[next].abs()
        {
            return None;
        }
        let t_min = minimize(&|t: f64| g(t).abs(), lo, hi);
        let g_min = g(t_min);
        // A dip that comes out the far side of zero is a crossing pair hidden
        // between samples, not a graze: the pair has no foot to assert, and a
        // contact in its middle would split a sliver out of a real crossing.
        if !(g_min == 0.0 || same_sign(g_min, gs[i])) {
            return None;
        }
        let gap = gap_at(t_min)?;
        (gap <= gap_tol).then_some((t_min, gap))
    };
    for i in 1..SCAN_SAMPLES {
        if let Some((t_min, gap)) = consider(i - 1, i, i + 1, ts[i - 1], ts[i + 1]) {
            let t = if periodic {
                pymod(t_min, TWO_PI)
            } else {
                t_min
            };
            grazes.push((t, gap));
        }
    }
    if periodic {
        // The seam sample: `ts[0]` and `ts[SCAN_SAMPLES]` are the same point,
        // so its window wraps and the refinement may land past t1; pymod folds
        // it back into [0, 2pi) for the split pass.
        let first = 1;
        let last = SCAN_SAMPLES - 1;
        if let Some((t_min, gap)) = consider(last, 0, first, ts[last], ts[first] + (t1 - t0)) {
            grazes.push((pymod(t_min, TWO_PI), gap));
        }
    }

    // A flat valley can present several sampled valleys around one true
    // minimum; keep one contact per cluster so the split list cannot gain a
    // phantom sliver segment between two params that name the same foot.
    grazes.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut kept: Vec<f64> = Vec::new();
    for (t, _) in grazes {
        if kept.last().is_some_and(|&p| (t - p).abs() <= step) {
            continue;
        }
        kept.push(t);
    }
    roots.extend(kept);
    roots
}

// ─── point de-dup ───

fn dedup_hits(hits: Vec<Hit>) -> Vec<Hit> {
    let mut out: Vec<Hit> = Vec::new();
    for h in hits {
        if out.iter().any(|o| {
            (o.point[0] - h.point[0]).abs() < POINT_MERGE
                && (o.point[1] - h.point[1]).abs() < POINT_MERGE
        }) {
            continue;
        }
        out.push(h);
    }
    out
}

// ─── closed-form pairs ───

/// Line vs ellipse: map the line into the ellipse's local unit-circle space,
/// intersect the unit circle in closed form, map hit points back to world. A
/// miss-side near tangency is collapsed to its foot, mirroring `lc`: the solver
/// leaves a converged tangent a hair short of the rim, and the region closes on
/// that contact.
fn line_ellipse(l0: Vec2, l1: Vec2, c: Vec2, a: f64, b: f64, theta: f64) -> Vec<Vec2> {
    let cr = radians(theta).cos();
    let sr = radians(theta).sin();
    let to_local = |p: Vec2| -> Vec2 {
        let dx = p[0] - c[0];
        let dy = p[1] - c[1];
        [(dx * cr + dy * sr) / a, (-dx * sr + dy * cr) / b]
    };
    let q0 = to_local(l0);
    let q1 = to_local(l1);
    let dx = q1[0] - q0[0];
    let dy = q1[1] - q0[1];
    let aa = dx * dx + dy * dy;
    if aa < ZERO_LENGTH_SQ {
        return vec![];
    }
    let bb = 2.0 * (q0[0] * dx + q0[1] * dy);
    let cc = q0[0] * q0[0] + q0[1] * q0[1] - 1.0;
    let disc = bb * bb - 4.0 * aa * cc;
    if disc < 0.0 {
        // Virtual tangent point, `lc`'s rule in the ellipse's terms: the foot
        // of the closest approach, kept when the world gap it leaves is inside
        // `MERGE.max(TANGENT_GAP_REL * r)` of the rim and the foot still lies
        // on the finite segment. A miss has no crossing to swallow.
        let raw = -bb / (2.0 * aa);
        let seg = (l1[0] - l0[0]).hypot(l1[1] - l0[1]);
        let overhang = (-raw).max(raw - 1.0).max(0.0) * seg;
        if overhang > TOL_TOPOLOGY_MERGE {
            return vec![];
        }
        let t = raw.clamp(0.0, 1.0);
        let p = [l0[0] + t * (l1[0] - l0[0]), l0[1] + t * (l1[1] - l0[1])];
        let ell = Curve::Ellipse { c, a, b, theta };
        return match conic_gap(&ell, p) {
            Some(gap) if gap <= tangent_gap_tol(curve_scale(&ell)) => vec![p],
            _ => vec![],
        };
    }
    let sd = disc.sqrt();
    let mut pts = Vec::new();
    for sign in [-1.0, 1.0] {
        let t = (-bb + sign * sd) / (2.0 * aa);
        if (-TOL_TOPOLOGY_EPS..=1.0 + TOL_TOPOLOGY_EPS).contains(&t) {
            pts.push([l0[0] + t * (l1[0] - l0[0]), l0[1] + t * (l1[1] - l0[1])]);
        }
    }
    pts
}

fn circle_circle(ac: Vec2, ar: f64, bc: Vec2, br: f64) -> Vec<Vec2> {
    let dx = bc[0] - ac[0];
    let dy = bc[1] - ac[1];
    let d = dx.hypot(dy);
    if d < CIRCLE_TANGENT_EPS
        || d > ar + br + CIRCLE_TANGENT_EPS
        || d < (ar - br).abs() - CIRCLE_TANGENT_EPS
    {
        return vec![];
    }
    let x = (ar * ar - br * br + d * d) / (2.0 * d);
    let h2 = ar * ar - x * x;
    if h2 < 0.0 {
        return vec![];
    }
    let h = h2.max(0.0).sqrt();
    let mx = ac[0] + (x * dx) / d;
    let my = ac[1] + (x * dy) / d;
    let ox = (h * dy) / d;
    let oy = (h * dx) / d;
    if h < CIRCLE_TANGENT_EPS {
        return vec![[mx, my]];
    }
    vec![[mx + ox, my - oy], [mx - ox, my + oy]]
}

/// Cubic Bezier vs line via the cubic the line's implicit form induces in t.
/// The graze side mirrors `lc`: the world gap is the residual divided by the
/// line's normal length, and the bezier's own scale anchors the tolerance.
fn bezier_line(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, l0: Vec2, l1: Vec2) -> Vec<f64> {
    let nx = l1[1] - l0[1];
    let ny = -(l1[0] - l0[0]);
    let len = nx.hypot(ny);
    let g = move |t: f64| -> f64 {
        let p = bezier_point(p0, c1, c2, p3, t);
        nx * (p[0] - l0[0]) + ny * (p[1] - l0[1])
    };
    let gap_at = |t: f64| -> Option<f64> {
        let v = g(t);
        if len > 0.0 && v.is_finite() {
            Some(v.abs() / len)
        } else {
            None
        }
    };
    let tol = tangent_gap_tol(curve_scale(&Curve::Bezier { p0, c1, c2, p3 }));
    scan_roots_and_grazes(&g, &gap_at, tol, 0.0, 1.0, false)
}

// ─── bezier vs bezier by recursive AABB subdivision ───

type BzCtrl = [Vec2; 4];

// Recursion budget for the subdivision search. Two cubics cross at most nine
// times (Bezout), and even a nasty near-tangential pair resolves within a few
// thousand node visits, so this cap sits orders of magnitude above anything a
// legitimate pair can spend. Coincident splines are the opposite: every split
// pair's AABBs keep touching (boxes_overlap counts touching as overlap) down
// to the FLAT cutoff, roughly 2^27 nodes on a sketch-sized curve, which used
// to exhaust the wasm heap before the >10 discard ever saw the output. The
// hit cap mirrors that same discard: once this many raw leaf points exist the
// result can only be degenerate overlap, so there is nothing worth searching.
const NODE_BUDGET: u32 = 50_000;
const HIT_CAP: usize = 1_024;

/// Search bookkeeping shared by the recursion: how many overlapping-node
/// visits remain, and whether the search stopped with unexplored overlap
/// left over (which makes any collected hits unreliable).
struct BbBudget {
    visits_left: u32,
    truncated: bool,
}

/// True when both splines carry essentially the same shape: each corresponding
/// control-point pair sits within POINT_MERGE, so the curves run on top of
/// each other along their whole length and cannot produce a transversal
/// crossing. This is the copy-paste-duplicate case, reported as no crossing
/// consistent with the degenerate-overlap policy rather than searched.
fn ctrl_polygons_coincident(a: &BzCtrl, b: &BzCtrl) -> bool {
    a.iter()
        .zip(b.iter())
        .all(|(p, q)| (p[0] - q[0]).abs() < POINT_MERGE && (p[1] - q[1]).abs() < POINT_MERGE)
}

fn bz_split(c: &BzCtrl, t: f64) -> (BzCtrl, BzCtrl) {
    let lerp = |p: Vec2, q: Vec2| -> Vec2 { [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])] };
    let ab = lerp(c[0], c[1]);
    let bc = lerp(c[1], c[2]);
    let cd = lerp(c[2], c[3]);
    let abc = lerp(ab, bc);
    let bcd = lerp(bc, cd);
    let abcd = lerp(abc, bcd);
    ([c[0], ab, abc, abcd], [abcd, bcd, cd, c[3]])
}

fn bbox(c: &BzCtrl) -> [f64; 4] {
    let xs = [c[0][0], c[1][0], c[2][0], c[3][0]];
    let ys = [c[0][1], c[1][1], c[2][1], c[3][1]];
    let minx = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let miny = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let maxx = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let maxy = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    [minx, miny, maxx, maxy]
}

fn boxes_overlap(a: &[f64; 4], b: &[f64; 4]) -> bool {
    !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1])
}

fn bezier_bezier(ca: BzCtrl, cb: BzCtrl) -> Vec<Hit> {
    if ctrl_polygons_coincident(&ca, &cb) {
        return vec![];
    }
    let mut out: Vec<Hit> = Vec::new();
    const FLAT: f64 = 1e-7;
    let mut budget = BbBudget {
        visits_left: NODE_BUDGET,
        truncated: false,
    };
    #[allow(clippy::too_many_arguments)]
    fn recurse(
        x: &BzCtrl,
        xt0: f64,
        xt1: f64,
        y: &BzCtrl,
        yt0: f64,
        yt1: f64,
        depth: u32,
        budget: &mut BbBudget,
        out: &mut Vec<Hit>,
    ) {
        let bx = bbox(x);
        let by = bbox(y);
        if !boxes_overlap(&bx, &by) {
            return;
        }
        // Overlapping boxes plus an empty budget means unexplored overlap
        // remains, so the collected hits are a partial ring of phantom split
        // points; flag it and let the caller apply the degenerate-overlap
        // policy instead of reporting them.
        if budget.visits_left == 0 || out.len() >= HIT_CAP {
            budget.truncated = true;
            return;
        }
        budget.visits_left -= 1;
        let size_x = (bx[2] - bx[0]).max(bx[3] - bx[1]);
        let size_y = (by[2] - by[0]).max(by[3] - by[1]);
        if (size_x < FLAT && size_y < FLAT) || depth > 50 {
            out.push(Hit {
                point: [(x[0][0] + x[3][0]) / 2.0, (x[0][1] + x[3][1]) / 2.0],
                t_a: 0.5 * (xt0 + xt1),
                t_b: 0.5 * (yt0 + yt1),
            });
            return;
        }
        let xm = 0.5 * (xt0 + xt1);
        let ym = 0.5 * (yt0 + yt1);
        let (x0, x1) = bz_split(x, 0.5);
        let (y0, y1) = bz_split(y, 0.5);
        recurse(&x0, xt0, xm, &y0, yt0, ym, depth + 1, budget, out);
        recurse(&x0, xt0, xm, &y1, ym, yt1, depth + 1, budget, out);
        recurse(&x1, xm, xt1, &y0, yt0, ym, depth + 1, budget, out);
        recurse(&x1, xm, xt1, &y1, ym, yt1, depth + 1, budget, out);
    }
    recurse(&ca, 0.0, 1.0, &cb, 0.0, 1.0, 0, &mut budget, &mut out);
    // Same policy as the >10 discard in intersect_curves: truncation can only
    // happen for (near-)coincident carriers whose points are phantom split
    // artifacts, so report nothing rather than a partial ring of fake hits.
    if budget.truncated {
        return vec![];
    }
    if out.is_empty() {
        // The boxes never overlapped, so the pair either crosses nowhere or
        // grazes: a solver-driven tangency can leave exactly this picture, and
        // only the foot lets the region close.
        let tol = tangent_gap_tol(bezier_scale(&ca).min(bezier_scale(&cb)));
        if let Some(hit) = bezier_near_touch(&ca, &cb, tol) {
            out.push(hit);
        }
    }
    out
}

// Coarse sample count for the near-touch search; the alternating refinement
// below starts from one coarse cell, so this only has to beat one cell.
const NEAR_TOUCH_SAMPLES: usize = 64;
// A within-tolerance stretch longer than this many coarse samples is two
// curves running together (the degenerate overlap the AABB search already
// handles), not a local graze.
const NEAR_TOUCH_RUN: usize = 8;

/// A near-touch of two splines that never crosses: coarse samples locate the
/// closest cell, then alternating ternary refinements slide the pair onto the
/// foot of the closest approach. The contact is emitted only when the refined
/// gap is inside `tol` and the near approach stayed local. The midpoint of the
/// refined pair is the virtual tangent point, mirroring `lc`/`cc`.
fn bezier_near_touch(ca: &BzCtrl, cb: &BzCtrl, tol: f64) -> Option<Hit> {
    let at = |c: &BzCtrl, t: f64| bezier_point(c[0], c[1], c[2], c[3], t);
    let mut ti = 0.0;
    let mut ui = 0.0;
    let mut best = f64::INFINITY;
    let mut near_run = 0usize;
    for i in 0..=NEAR_TOUCH_SAMPLES {
        let t = i as f64 / NEAR_TOUCH_SAMPLES as f64;
        let pa = at(ca, t);
        let mut nearest = f64::INFINITY;
        for j in 0..=NEAR_TOUCH_SAMPLES {
            let u = j as f64 / NEAR_TOUCH_SAMPLES as f64;
            let pb = at(cb, u);
            let d = (pa[0] - pb[0]).hypot(pa[1] - pb[1]);
            if d < nearest {
                nearest = d;
                if d < best {
                    best = d;
                    ti = t;
                    ui = u;
                }
            }
        }
        if nearest <= tol {
            near_run += 1;
        }
    }
    if near_run > NEAR_TOUCH_RUN {
        return None;
    }
    let win = 1.0 / NEAR_TOUCH_SAMPLES as f64;
    for _ in 0..12 {
        let (lo, hi) = ((ui - win).max(0.0), (ui + win).min(1.0));
        ui = minimize(
            &|u: f64| {
                let pb = at(cb, u);
                let pa = at(ca, ti);
                (pa[0] - pb[0]).hypot(pa[1] - pb[1])
            },
            lo,
            hi,
        );
        let (lo, hi) = ((ti - win).max(0.0), (ti + win).min(1.0));
        ti = minimize(
            &|t: f64| {
                let pa = at(ca, t);
                let pb = at(cb, ui);
                (pa[0] - pb[0]).hypot(pa[1] - pb[1])
            },
            lo,
            hi,
        );
    }
    let pa = at(ca, ti);
    let pb = at(cb, ui);
    if (pa[0] - pb[0]).hypot(pa[1] - pb[1]) > tol {
        return None;
    }
    Some(Hit {
        point: [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0],
        t_a: ti,
        t_b: ui,
    })
}

// ─── public entry point ───

/// Push closed-form world points, recovering both params from each.
fn push_points(a: &Curve, b: &Curve, points: Vec<Vec2>, hits: &mut Vec<Hit>) {
    for p in points {
        hits.push(Hit {
            point: p,
            t_a: param_of(a, p),
            t_b: param_of(b, p),
        });
    }
}

/// Scan one parametric curve against the other's implicit residual, recovering
/// both params from each resulting point. A line is never scanned: its closed
/// forms handle every pair it takes part in, so bail out rather than abort the
/// worker if a caller ever scans one.
fn scan_curve(
    a: &Curve,
    b: &Curve,
    scanned: &Curve,
    other: &Curve,
    scanned_is_a: bool,
    residual: Box<dyn Fn(Vec2) -> f64>,
    hits: &mut Vec<Hit>,
) {
    let eval_at: Box<dyn Fn(f64) -> Vec2> = match *scanned {
        Curve::Circle { c, r } => {
            Box::new(move |phi: f64| [c[0] + r * phi.cos(), c[1] + r * phi.sin()])
        }
        Curve::Ellipse { c, a, b, theta } => {
            let cr = (theta * std::f64::consts::PI / 180.0).cos();
            let sr = (theta * std::f64::consts::PI / 180.0).sin();
            Box::new(move |phi: f64| ellipse_point_at(c, a, b, cr, sr, phi))
        }
        Curve::Bezier { p0, c1, c2, p3 } => Box::new(move |t: f64| bezier_point(p0, c1, c2, p3, t)),
        Curve::Line { .. } => return,
    };
    let hi = match *scanned {
        Curve::Bezier { .. } => 1.0,
        _ => TWO_PI,
    };
    let periodic = !matches!(*scanned, Curve::Bezier { .. });
    let g = |t: f64| residual(eval_at(t));
    let gap_at = |t: f64| conic_gap(other, eval_at(t));
    let tol = tangent_gap_tol(curve_scale(scanned).min(curve_scale(other)));
    let params = scan_roots_and_grazes(&g, &gap_at, tol, 0.0, hi, periodic);
    for t in params {
        let pt = eval_at(t);
        hits.push(Hit {
            point: pt,
            t_a: if scanned_is_a { t } else { param_of(a, pt) },
            t_b: if scanned_is_a { param_of(b, pt) } else { t },
        });
    }
}

/// Every scanned crossing is symmetric: scan one operand against the other's
/// conic residual. `scanned_is_a` picks which operand carries the parameter.
fn scan_conic(a: &Curve, b: &Curve, scanned_is_a: bool, hits: &mut Vec<Hit>) {
    let (scanned, other) = if scanned_is_a { (a, b) } else { (b, a) };
    if let Some(residual) = conic_residual(other) {
        scan_curve(a, b, scanned, other, scanned_is_a, residual, hits);
    }
}

/// Bezier-vs-line is symmetric: identical crossing math, only the (t_a, t_b)
/// assignment flips depending on which operand is the bezier. `line` is the
/// line operand; segment params outside [0, 1] are off the finite segment.
#[allow(clippy::too_many_arguments)]
fn bezier_line_pair(
    p0: Vec2,
    c1: Vec2,
    c2: Vec2,
    p3: Vec2,
    l0: Vec2,
    l1: Vec2,
    line: &Curve,
    bezier_is_a: bool,
    hits: &mut Vec<Hit>,
) {
    for t in bezier_line(p0, c1, c2, p3, l0, l1) {
        let p = bezier_point(p0, c1, c2, p3, t);
        let lp = param_of(line, p);
        if !(-TOL_TOPOLOGY_EPS..=1.0 + TOL_TOPOLOGY_EPS).contains(&lp) {
            continue;
        }
        let (t_a, t_b) = if bezier_is_a { (t, lp) } else { (lp, t) };
        hits.push(Hit { point: p, t_a, t_b });
    }
}

/// Dispatch one unordered pair to its closed-form or scanned arm. Line/line and
/// line/circle pairs never reach here: the only production callers (the dcel
/// intersection passes) dispatch those through their own `ll`/`lc` helpers and
/// call here only once an ellipse or spline is involved. They fall through to
/// the empty arm rather than duplicating the dcel-side epsilons.
fn intersect_pair(a: &Curve, b: &Curve, hits: &mut Vec<Hit>) {
    match (a, b) {
        (
            Curve::Line { p0, p1 },
            Curve::Ellipse {
                c,
                a: ea,
                b: eb,
                theta,
            },
        )
        | (
            Curve::Ellipse {
                c,
                a: ea,
                b: eb,
                theta,
            },
            Curve::Line { p0, p1 },
        ) => {
            push_points(a, b, line_ellipse(*p0, *p1, *c, *ea, *eb, *theta), hits);
        }
        (Curve::Circle { c: ac, r: ar }, Curve::Circle { c: bc, r: br }) => {
            push_points(a, b, circle_circle(*ac, *ar, *bc, *br), hits);
        }
        (Curve::Circle { .. }, Curve::Ellipse { .. }) => scan_conic(a, b, false, hits),
        (Curve::Ellipse { .. }, Curve::Circle { .. }) => scan_conic(a, b, true, hits),
        (Curve::Ellipse { .. }, Curve::Ellipse { .. }) => scan_conic(a, b, true, hits),
        (Curve::Bezier { p0, c1, c2, p3 }, Curve::Line { p0: l0, p1: l1 }) => {
            bezier_line_pair(*p0, *c1, *c2, *p3, *l0, *l1, b, true, hits);
        }
        (Curve::Line { p0: l0, p1: l1 }, Curve::Bezier { p0, c1, c2, p3 }) => {
            bezier_line_pair(*p0, *c1, *c2, *p3, *l0, *l1, a, false, hits);
        }
        (Curve::Bezier { .. }, Curve::Circle { .. })
        | (Curve::Bezier { .. }, Curve::Ellipse { .. }) => scan_conic(a, b, true, hits),
        (Curve::Circle { .. }, Curve::Bezier { .. })
        | (Curve::Ellipse { .. }, Curve::Bezier { .. }) => scan_conic(a, b, false, hits),
        (
            Curve::Bezier {
                p0: ap0,
                c1: ac1,
                c2: ac2,
                p3: ap3,
            },
            Curve::Bezier {
                p0: bp0,
                c1: bc1,
                c2: bc2,
                p3: bp3,
            },
        ) => {
            hits.extend(bezier_bezier(
                [*ap0, *ac1, *ac2, *ap3],
                [*bp0, *bc1, *bc2, *bp3],
            ));
        }
        _ => {}
    }
}

/// Intersection points of two curves with the parameter on each. Order of a and
/// b is preserved (`t_a` refers to a, `t_b` to b). A transversal crossing is
/// reported once, from either a closed form or the sign-change scan; a
/// no-sign-change approach inside the near-tangent gap budget is reported at
/// the foot of its closest approach instead of being dropped as a tangency
/// (see `scan_roots_and_grazes` and `line_ellipse`'s miss side), while a true
/// miss beyond the budget reports nothing.
pub fn intersect_curves(a: &Curve, b: &Curve) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    intersect_pair(a, b, &mut hits);

    // A clean pair crosses in few points. A blow-up past 10 means the carriers
    // are (near-)coincident -- a degenerate overlap, not a transversal crossing
    // -- so report nothing rather than a ring of phantom split points.
    let out = dedup_hits(hits);
    if out.len() > 10 {
        vec![]
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(p0: Vec2, p1: Vec2) -> Curve {
        Curve::Line { p0, p1 }
    }

    #[test]
    fn line_through_ellipse_center() {
        let e = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 1.0,
            theta: 0.0,
        };
        let h = intersect_curves(&line([-4.0, 0.0], [4.0, 0.0]), &e);
        assert_eq!(h.len(), 2);
        let mut xs: Vec<f64> = h.iter().map(|x| x.point[0]).collect();
        xs.sort_by(|p, q| p.total_cmp(q));
        assert!((xs[0] + 3.0).abs() < 1e-9 && (xs[1] - 3.0).abs() < 1e-9);
    }

    #[test]
    fn circle_circle_two_points() {
        let a = Curve::Circle {
            c: [0.0, 0.0],
            r: 1.0,
        };
        let b = Curve::Circle {
            c: [1.0, 0.0],
            r: 1.0,
        };
        let h = intersect_curves(&a, &b);
        assert_eq!(h.len(), 2);
        for hit in &h {
            assert!((hit.point[0] - 0.5).abs() < 1e-9);
        }
    }

    #[test]
    fn circle_circle_tangent_reports_one_point() {
        // A coincident double root is a real contact for the closed-form arms,
        // unlike the sign-change scan's no-tangency rule. The two rims touch at
        // exactly (1,0).
        let a = Curve::Circle {
            c: [0.0, 0.0],
            r: 1.0,
        };
        let b = Curve::Circle {
            c: [2.0, 0.0],
            r: 1.0,
        };
        let h = intersect_curves(&a, &b);
        assert_eq!(h.len(), 1);
        assert!((h[0].point[0] - 1.0).abs() < 1e-9 && (h[0].point[1]).abs() < 1e-9);
    }

    #[test]
    fn line_tangent_to_ellipse_reports_one_point() {
        // Zero discriminant in the closed-form line/ellipse arm: y = 1 touches
        // the ellipse a=2, b=1 at (0,1) and must report the double root once.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 2.0,
            b: 1.0,
            theta: 0.0,
        };
        let h = intersect_curves(&line([-3.0, 1.0], [3.0, 1.0]), &ell);
        assert_eq!(h.len(), 1);
        assert!((h[0].point[0]).abs() < 1e-9 && (h[0].point[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn line_near_tangent_to_ellipse_reports_the_foot() {
        // The solver leaves a converged line/ellipse tangency a hair short of
        // the rim; the miss-side collapse must report that foot, or the region
        // the line closes never builds. lc's rule in the ellipse's terms.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 2.0,
            b: 1.0,
            theta: 0.0,
        };
        for gap in [1e-9, 1e-7, 5e-6, 9e-6] {
            let h = intersect_curves(&line([-3.0, 1.0 + gap], [3.0, 1.0 + gap]), &ell);
            assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
            assert!(
                h[0].point[0].abs() < 1e-6 && (h[0].point[1] - 1.0).abs() < 1e-4,
                "gap {gap:e}: the foot of the closest approach: {:?}",
                h[0].point
            );
        }
    }

    #[test]
    fn line_clear_of_an_ellipse_stays_a_miss() {
        // Ten times the budget: no sign change and no collapse, so a genuine
        // miss still reports nothing and cannot split either curve.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 2.0,
            b: 1.0,
            theta: 0.0,
        };
        for gap in [1.1e-5, 1e-4, 1e-3, 1e-1] {
            let h = intersect_curves(&line([-3.0, 1.0 + gap], [3.0, 1.0 + gap]), &ell);
            assert!(h.is_empty(), "gap {gap:e} stays a miss");
        }
    }

    #[test]
    fn line_near_tangent_off_its_segment_switches_at_the_merge_overhang() {
        // The foot of the closest approach falls before the segment's start by
        // `overhang` world units. Within MERGE the foot is clamped to the end
        // vertex and still contacts; past MERGE there is nothing to clamp to
        // and the pair stays a miss, even though the end vertex itself sits
        // well inside the gap budget. The existing off-segment test pins the
        // far 1.0 overhang; these pin the switch just around MERGE.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 2.0,
            b: 1.0,
            theta: 0.0,
        };
        let gap = 1e-6;
        let just_inside = intersect_curves(&line([5e-6, 1.0 + gap], [2.0, 1.0 + gap]), &ell);
        assert_eq!(just_inside.len(), 1, "half-MERGE overhang still contacts");
        assert!(
            (just_inside[0].point[0] - 5e-6).abs() < 1e-9,
            "the clamped end vertex, not the true foot: {:?}",
            just_inside[0].point
        );
        let just_outside = intersect_curves(&line([2e-5, 1.0 + gap], [2.0, 1.0 + gap]), &ell);
        assert!(
            just_outside.is_empty(),
            "twice-MERGE overhang has no contact to make"
        );
    }

    #[test]
    fn line_near_tangent_off_its_segment_stays_a_miss() {
        // The foot falls beyond the segment end by well over MERGE, so there
        // is nothing to contact: the collapse must not extend the segment.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 2.0,
            b: 1.0,
            theta: 0.0,
        };
        let h = intersect_curves(&line([1.0, 1.0000001], [3.0, 1.0000001]), &ell);
        assert!(h.is_empty());
    }

    #[test]
    fn spline_near_tangent_to_ellipse_reports_the_foot() {
        // The sampled-root half of the same bug: a spline approaching the
        // ellipse's top vertex tangentially with no sign change used to report
        // nothing. The sampled valley must collapse to its foot.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 2.0,
            theta: 0.0,
        };
        // Symmetric cubic whose horizontal tangent at t = 1/2 dips to y = g.
        let spline = |g: f64| Curve::Bezier {
            p0: [-2.0, 4.0 + g],
            c1: [-1.0, 4.0 / 3.0 + g],
            c2: [1.0, 4.0 / 3.0 + g],
            p3: [2.0, 4.0 + g],
        };
        for gap in [0.0, 1e-7] {
            let h = intersect_curves(&spline(gap), &ell);
            assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
            assert!(
                h[0].point[0].abs() < 1e-6 && (h[0].point[1] - 2.0).abs() < 1e-5,
                "gap {gap:e}: the foot at the ellipse apex: {:?}",
                h[0].point
            );
        }
    }

    #[test]
    fn spline_clear_of_an_ellipse_stays_a_miss() {
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 2.0,
            theta: 0.0,
        };
        let spline = Curve::Bezier {
            p0: [-2.0, 4.01],
            c1: [-1.0, 4.0 / 3.0 + 0.01],
            c2: [1.0, 4.0 / 3.0 + 0.01],
            p3: [2.0, 4.01],
        };
        assert!(intersect_curves(&spline, &ell).is_empty());
    }

    #[test]
    fn circle_near_tangent_to_ellipse_reports_the_foot() {
        // Conic-conic through the same sampled scan: the circle's bottom rim
        // stops `gap` short of the ellipse apex.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 2.0,
            theta: 0.0,
        };
        for gap in [1e-7, 5e-6] {
            let circ = Curve::Circle {
                c: [0.0, 3.0 + gap],
                r: 1.0,
            };
            let h = intersect_curves(&circ, &ell);
            assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
            assert!(
                h[0].point[0].abs() < 1e-6 && (h[0].point[1] - 2.0).abs() < 1e-4,
                "gap {gap:e}: the foot at the rim: {:?}",
                h[0].point
            );
        }
        let circ = Curve::Circle {
            c: [0.0, 3.0 + 1e-2],
            r: 1.0,
        };
        assert!(intersect_curves(&circ, &ell).is_empty(), "a real miss");
    }

    #[test]
    fn bezier_bezier_near_touch_reports_the_foot() {
        // Two splines that never cross but come within the budget: the AABB
        // search prunes them (only a tangency leaves this picture), so the
        // near-touch fallback must produce the foot.
        let a = Curve::Bezier {
            p0: [-1.0, 0.0],
            c1: [0.0, 0.0],
            c2: [1.0, 0.0],
            p3: [2.0, 0.0],
        };
        let b = |g: f64| Curve::Bezier {
            p0: [0.0, 1.0 + g],
            c1: [1.0 / 3.0, -1.0 / 3.0 + g],
            c2: [2.0 / 3.0, -1.0 / 3.0 + g],
            p3: [1.0, 1.0 + g],
        };
        for gap in [0.0, 1e-7, 1e-6] {
            let h = intersect_curves(&a, &b(gap));
            assert_eq!(h.len(), 1, "gap {gap:e}: one virtual tangent point");
            assert!(
                (h[0].point[0] - 0.5).abs() < 1e-3 && h[0].point[1].abs() < 1e-4,
                "gap {gap:e}: the foot at (0.5, 0): {:?}",
                h[0].point
            );
        }
        assert!(
            intersect_curves(&a, &b(1e-2)).is_empty(),
            "a real miss stays a miss"
        );
    }

    #[test]
    fn bezier_bezier_gap_just_inside_and_outside_the_budget_splits_cleanly() {
        // A genuine spline pair (control points far apart, so the coincident
        // short-circuit cannot answer) whose minimum distance to the straight
        // carrier is 8e-6 or 2e-5 against a 1.5e-5 budget: the inside case must
        // report its foot, the outside case must stay a miss.
        let a = Curve::Bezier {
            p0: [-1.0, 0.0],
            c1: [0.0, 0.0],
            c2: [1.0, 0.0],
            p3: [2.0, 0.0],
        };
        // Symmetric cubic whose midpoint dips to y = g.
        let b = |g: f64| Curve::Bezier {
            p0: [0.0, 4.0 + g],
            c1: [1.0 / 3.0, -4.0 / 3.0 + g],
            c2: [2.0 / 3.0, -4.0 / 3.0 + g],
            p3: [1.0, 4.0 + g],
        };
        let inside = intersect_curves(&a, &b(8e-6));
        assert_eq!(inside.len(), 1, "8e-6 is inside the budget: {inside:?}");
        assert!(
            (inside[0].point[0] - 0.5).abs() < 1e-3 && inside[0].point[1].abs() < 1e-5,
            "the foot at (0.5, 0): {:?}",
            inside[0].point
        );
        assert!(
            intersect_curves(&a, &b(2e-5)).is_empty(),
            "2e-5 is outside the budget and stays a miss"
        );
    }

    #[test]
    fn bezier_near_touch_rejects_a_run_together_beyond_the_coincident_shortcut() {
        // Two long offset copies: their control points sit 5e-4 apart, forty
        // times POINT_MERGE, so `ctrl_polygons_coincident` cannot answer and
        // the fallback runs. Every coarse sample of one sits within the 1e-3
        // budget of the other, so the run heuristic must read the pair as two
        // curves running together and report no contact.
        let a: BzCtrl = [[-100.0, 0.0], [-50.0, 20.0], [50.0, -20.0], [100.0, 0.0]];
        let b: BzCtrl = [
            [-100.0, 5e-4],
            [-50.0, 20.0 + 5e-4],
            [50.0, -20.0 + 5e-4],
            [100.0, 5e-4],
        ];
        assert!(!ctrl_polygons_coincident(&a, &b));
        let tol = tangent_gap_tol(bezier_scale(&a).min(bezier_scale(&b)));
        assert!(tol > 5e-4, "the offset must sit inside the budget: {tol:e}");
        assert!(
            bezier_near_touch(&a, &b, tol).is_none(),
            "a run together is not a graze"
        );
    }

    #[test]
    fn a_shallow_lens_never_reports_a_third_contact() {
        // A pair that really crosses in a shallow lens reports its crossings,
        // not a phantom graze in the middle of the lens: a third point between
        // the two crossings would slice a sliver out of both curves.
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 2.0,
            theta: 0.0,
        };
        for r in [1.0, 1.0003] {
            for depth in [1e-2, 1e-3, 1e-4] {
                let circ = Curve::Circle {
                    c: [0.0, r + 2.0 - depth],
                    r,
                };
                let h = intersect_curves(&circ, &ell);
                assert!(
                    h.len() <= 2,
                    "r {r} depth {depth:e}: no third point, got {h:?}"
                );
                for hit in &h {
                    assert!(
                        (hit.point[1] - 1.9998).abs() < 2e-3,
                        "r {r} depth {depth:e}: contact near the apex, got {:?}",
                        hit.point
                    );
                }
            }
        }
    }

    #[test]
    fn nearly_parallel_beziers_stay_no_contact() {
        // Two long near-parallel splines within the budget along a stretch are
        // a degenerate overlap, not a graze: the fallback must not invent a
        // contact point for them.
        let a = Curve::Bezier {
            p0: [0.0, 0.0],
            c1: [1.0, 2.0],
            c2: [2.0, -2.0],
            p3: [3.0, 0.0],
        };
        let b = Curve::Bezier {
            p0: [0.0, 1e-6],
            c1: [1.0, 2.0 + 1e-6],
            c2: [2.0, -2.0 + 1e-6],
            p3: [3.0, 1e-6],
        };
        let h = intersect_curves(&a, &b);
        assert!(h.is_empty(), "a run together is not a graze: {h:?}");
    }

    #[test]
    fn a_near_tangency_at_the_scanned_ellipses_seam_reports_the_foot() {
        // The periodic scan's seam window wraps ts[0] between its neighbours, so
        // a foot sitting exactly on the 0/2pi seam is found by that window
        // alone. A circle whose rim stops 5e-6 short of the ellipse's +a apex:
        // no crossing anywhere, minimum gap on the seam.
        let gap = 5e-6;
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 2.0,
            b: 1.0,
            theta: 0.0,
        };
        let circ = Curve::Circle {
            c: [3.0 + gap, 0.0],
            r: 1.0,
        };
        let h = intersect_curves(&ell, &circ);
        assert_eq!(h.len(), 1, "one virtual tangent point on the seam: {h:?}");
        assert!(
            (h[0].point[0] - 2.0).abs() < 1e-6 && h[0].point[1].abs() < 1e-6,
            "the foot at the ellipse apex: {:?}",
            h[0].point
        );
    }

    #[test]
    fn sub_sample_crossing_lens_is_not_resolved_by_the_scan() {
        // Known limitation, parked with the solver-tolerance model
        // (feature/kernel-tolerances.md): a real two-crossing lens whose whole
        // crossing pair falls between two scan samples never trips the
        // sign-change scan. The near-tangent collapse reads the sampled valley
        // through the hidden-crossing guard, and the ternary lands essentially
        // on a crossing, so the sign it stops at decides between 0 contacts
        // (rejected as a hidden pair) and 1 (reported as a foot); the second
        // crossing is lost either way. Measured on the review fixture, a
        // 3000/2000 ellipse and a 4000-radius circle whose rim dips 0.01 into
        // its +a apex (rim gap inside the 0.02 budget), sliding the circle
        // along the tangent moves the outcome over 0, 1, 1 where dense
        // sampling sees two crossings. Pin "never both", not the 0/1 split:
        // that split is decided at the last ternary step.
        let a = 3000.0;
        let b = 2000.0;
        let r = 4000.0;
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a,
            b,
            theta: 0.0,
        };
        let circ = |y0: f64| Curve::Circle {
            c: [a + r - 0.01, y0],
            r,
        };
        let dense_crossings = |y0: f64| -> usize {
            // 4e4 samples puts ~14 of them across the lens, far denser than
            // the scan's 512 and cheap enough for a unit test.
            let n = 40_000usize;
            let cc = [a + r - 0.01, y0];
            let mut prev = f64::NAN;
            let mut count = 0usize;
            for i in 0..=n {
                let phi = TWO_PI * i as f64 / n as f64;
                let p = [a * phi.cos(), b * phi.sin()];
                let g = (p[0] - cc[0]).hypot(p[1] - cc[1]) - r;
                if !prev.is_nan() && (prev > 0.0) != (g > 0.0) {
                    count += 1;
                }
                prev = g;
            }
            count
        };
        for y0 in [9.5, 9.75, 10.0] {
            assert_eq!(dense_crossings(y0), 2, "y0 {y0}: the lens is real");
            let h = intersect_curves(&ell, &circ(y0));
            assert!(
                h.len() <= 1,
                "y0 {y0}: at most one of the two crossings may be reported, got {h:?}"
            );
        }
    }

    #[test]
    fn circle_ellipse_four_points() {
        let circ = Curve::Circle {
            c: [0.0, 0.0],
            r: 2.0,
        };
        let ell = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 1.0,
            theta: 0.0,
        };
        let h = intersect_curves(&circ, &ell);
        assert_eq!(h.len(), 4);
    }

    #[test]
    fn collapsed_ellipse_conic_produces_no_nan_hits() {
        // b == 0 makes the conic residual divide by zero; the resulting NaN is
        // never a sign change, so the scan must simply report nothing (or a
        // finite point), never a NaN coordinate feeding the vertex merge.
        let flat = Curve::Ellipse {
            c: [0.0, 0.0],
            a: 3.0,
            b: 0.0,
            theta: 0.0,
        };
        let circ = Curve::Circle {
            c: [0.0, 0.0],
            r: 2.0,
        };
        let g = conic_residual(&flat).expect("a flat ellipse is still a conic");
        assert!(
            g([1.0, 0.5]).is_finite(),
            "conic residual off the flat axis"
        );
        assert!(g([1.0, 0.0]).is_finite(), "conic residual on the flat axis");
        for hit in intersect_curves(&circ, &flat) {
            assert!(
                hit.point[0].is_finite() && hit.point[1].is_finite() && hit.t_a.is_finite(),
                "degenerate ellipse produced {hit:?}"
            );
        }
    }

    #[test]
    fn conic_residual_returns_none_for_non_conics() {
        // A line or bezier has no implicit conic form. Returning None lets the
        // scan dispatch skip it instead of aborting the worker.
        assert!(conic_residual(&line([0.0, 0.0], [1.0, 0.0])).is_none());
        let bz = Curve::Bezier {
            p0: [0.0, 0.0],
            c1: [1.0, 0.0],
            c2: [0.0, 1.0],
            p3: [1.0, 1.0],
        };
        assert!(conic_residual(&bz).is_none());
    }

    #[test]
    fn bezier_line_one_crossing() {
        let bz = Curve::Bezier {
            p0: [0.0, 0.0],
            c1: [1.0, 2.0],
            c2: [2.0, -2.0],
            p3: [3.0, 0.0],
        };
        let h = intersect_curves(&bz, &line([-1.0, 0.0], [4.0, 0.0]));
        // y=0 line crosses the symmetric S-curve at the two ends and the middle.
        assert!(!h.is_empty());
        for hit in &h {
            assert!(hit.point[1].abs() < 1e-6);
        }
    }

    #[test]
    fn bezier_bezier_cross() {
        let a = Curve::Bezier {
            p0: [-2.0, 0.0],
            c1: [-1.0, 0.0],
            c2: [1.0, 0.0],
            p3: [2.0, 0.0],
        };
        let b = Curve::Bezier {
            p0: [0.0, -2.0],
            c1: [0.0, -1.0],
            c2: [0.0, 1.0],
            p3: [0.0, 2.0],
        };
        let h = intersect_curves(&a, &b);
        assert_eq!(h.len(), 1);
        assert!(h[0].point[0].abs() < 1e-5 && h[0].point[1].abs() < 1e-5);
    }

    #[test]
    fn bezier_bezier_three_crossings() {
        // A wiggling spline through a straight-as-bezier segment crosses three
        // times; none of those transversal hits may be lost to the recursion
        // budget or its degenerate-overlap policy.
        let a = Curve::Bezier {
            p0: [-3.0, 0.0],
            c1: [-1.0, 0.0],
            c2: [1.0, 0.0],
            p3: [3.0, 0.0],
        };
        let b = Curve::Bezier {
            p0: [0.0, -2.0],
            c1: [4.0, 6.0],
            c2: [-4.0, -6.0],
            p3: [0.0, 2.0],
        };
        let h = intersect_curves(&a, &b);
        assert_eq!(h.len(), 3);
        for hit in &h {
            assert!(hit.point[1].abs() < 1e-6);
            assert!((-3.0..=3.0).contains(&hit.point[0]));
        }
    }

    #[test]
    fn identical_beziers_terminate_and_report_nothing() {
        // Pasting a spline onto itself used to explode the AABB subdivision:
        // every split pair's boxes keep touching until the FLAT cutoff,
        // pushing ~10^8 phantom leaves into an unbounded Vec on the wasm
        // heap. It must now return promptly under the degenerate-overlap
        // policy (no points), not hang or abort.
        let bz = Curve::Bezier {
            p0: [0.0, 0.0],
            c1: [1.0, 2.0],
            c2: [2.0, -2.0],
            p3: [3.0, 0.0],
        };
        let h = intersect_curves(&bz, &bz);
        assert!(h.is_empty());
    }

    #[test]
    fn heavily_overlapping_beziers_stay_bounded() {
        // The same shape nudged past the control-polygon short-circuit: the
        // search must stay inside its budget and its output inside the >10
        // discard bound, whatever the exact crossing count turns out to be.
        let a = Curve::Bezier {
            p0: [0.0, 0.0],
            c1: [1.0, 2.0],
            c2: [2.0, -2.0],
            p3: [3.0, 0.0],
        };
        let b = Curve::Bezier {
            p0: [0.005, 0.0],
            c1: [1.005, 2.0],
            c2: [2.005, -2.0],
            p3: [3.005, 0.0],
        };
        let h = intersect_curves(&a, &b);
        assert!(h.len() <= 10);
    }
}
