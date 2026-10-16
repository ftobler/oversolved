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
//! so a graze never spuriously splits a curve. A crossing pair narrower than
//! one scan sample is not a graze either: the sampled valley's refinement lands
//! on the far side of zero and both roots are bisected out, unless the two sit
//! inside the collapse budget, where the model defines the single virtual
//! tangent point (see `tolerance`).

use super::curve_split::{bezier_point, ellipse_point_at};
use super::dcel::pymod;
use super::{TOL_TOPOLOGY_EPS, TOL_TOPOLOGY_MERGE, TWO_PI};
use crate::radians;
use crate::tolerance::{tangent_collapse_tol, tangent_gap_tol};
use crate::MIN_SEMI_AXIS_SQ;

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
/// extent. Squared, so it is the square of the 1e-9 length floor. Absolute on
/// purpose: a division guard for a degenerate direction, not a measure of how
/// close the solver converged (the resolution at the smallest modelled scale
/// is 1e-17, far below it).
const ZERO_LENGTH_SQ: f64 = 1e-18;

/// Tangent/coincidence budget for the circle-circle arm: a centre distance or
/// half-chord this small is the degenerate touch, not a transversal crossing.
/// Kept separate from the area notions because it is a length, not an area,
/// and absolute on purpose: it only has to catch carriers that are the same
/// curve to the f64 grid (1e-12 world is below the grid of a 1500-radius
/// circle and ~1e-10 of the smallest modelled sketch), far under anything the
/// resolution-derived budgets decide.
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

// ─── near-tangency and sub-sample-pair budgets for the sampled-root paths ───

/// Characteristic radius of a carrier curve for the tangency budgets (see
/// `tolerance::tangent_gap_tol` and `tangent_collapse_tol`). A circle
/// contributes its radius and an ellipse its smaller semi-axis (its tightest
/// curvature), which is the two-circle case of `cc`'s `r_min`. A bezier has no
/// radius, so half its control-polygon bounding-box diagonal stands in; a line
/// contributes 0, leaving the caller's absolute floor (its caller pairs it with
/// a curve that does have a scale).
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

/// What one sampled valley window turned out to hold: no contact, the foot of
/// a closest approach inside the pair's gap budget, or the two roots of a
/// crossing pair the samples did not separate.
enum Valley {
    None,
    Graze(f64),
    Pair(f64, f64),
}

/// The pair's world geometry as the scan sees it (how far `other` is at a
/// scanned parameter, how far apart two scanned parameters are) with the two
/// budgets the valley applies: the near-tangency gap budget, and the collapse
/// budget on the half-separation `h` the closed-form arms test.
struct PairGeom<'a> {
    gap_at: &'a dyn Fn(f64) -> Option<f64>,
    sep: &'a dyn Fn(f64, f64) -> f64,
    gap_tol: f64,
    collapse_h: f64,
}

/// One valley window `[lo, hi]` around a sample whose neighbours carry its
/// sign, with the three sample values (`prev`, `cur`, `next`): refine it and
/// say what it holds.
///
/// The refinement minimises the SIGNED residual (|g| on a window that keeps one
/// sign), so a minimum on the far side of zero from the window's samples is a
/// crossing pair hidden between two samples: both flanks change sign there, and
/// each is bisected to its exact root. A pair is then either the two roots or,
/// when they sit within the collapse budget of coinciding, the single virtual
/// tangent point a converged tangency leaves (the rule `cc` applies on its
/// graze side, one threshold rewritten; a foot here keeps a near-tangent pair
/// from slicing a phantom sliver out of both curves). A crossing pair wider
/// than that budget is geometry, not an ambiguity: both roots are reported
/// however narrow the lens is (a lens between samples used to lose one or both
/// of them to the near-tangency collapse). A window that stays one-signed is a
/// graze candidate, and only the gap budget decides whether it contacts.
fn valley_window(
    g: &dyn Fn(f64) -> f64,
    pair: &PairGeom,
    samples: [f64; 3],
    lo: f64,
    hi: f64,
) -> Valley {
    let [prev, cur, next] = samples;
    let same_sign = |x: f64, y: f64| (x > 0.0 && y > 0.0) || (x < 0.0 && y < 0.0);
    if !(same_sign(prev, cur) && same_sign(cur, next))
        || cur.abs() > prev.abs()
        || cur.abs() > next.abs()
    {
        return Valley::None;
    }
    let t_min = if cur > 0.0 {
        minimize(&|t: f64| g(t), lo, hi)
    } else {
        minimize(&|t: f64| -g(t), lo, hi)
    };
    let g_min = g(t_min);
    // A dip that comes out the far side of zero is a crossing pair hidden
    // between samples: both flanks change sign, so both roots are bisected
    // out rather than asserting a foot in the middle of a real lens. The one
    // exception is the pair the model defines as a converged tangency (inside
    // the collapse budget), which keeps the single virtual tangent point at
    // the dip's foot.
    if !(g_min == 0.0 || same_sign(g_min, cur)) {
        let (a, b) = (bisect(g, lo, t_min), bisect(g, t_min, hi));
        // `sep` is the full separation of the two roots; the rule is the
        // closed-form arms' half-separation `h`, hence the factor two.
        if (pair.sep)(a, b) <= 2.0 * pair.collapse_h {
            return Valley::Graze(t_min);
        }
        return Valley::Pair(a, b);
    }
    match (pair.gap_at)(t_min) {
        Some(gap) if gap <= pair.gap_tol => Valley::Graze(t_min),
        _ => Valley::None,
    }
}

/// Roots of g over [t0, t1] found by scanning for sign changes and refining,
/// plus the near-tangency contacts and the sub-sample crossing pairs.
///
/// A crossing pair narrower than one sample step is detected through the
/// sampled valley: the samples bracket it with one sign, the refinement lands
/// inside it, and the two bisections report both roots exactly. The scan's
/// DETECTION resolution is therefore its step (the samples must reveal the
/// pair, which the valley test and the 2-step window do), while the roots
/// themselves are exact, not a foot approximation. A graze is the "virtual
/// tangent point" a converged tangent constraint leaves (see the dcel
/// collapse): a sampled valley whose window keeps one sign and whose refined
/// minimum comes within the gap budget of the other curve yields that
/// minimum's parameter, and a true miss beyond the budget stays a miss. For
/// periodic curves pass the full period [0, 2pi) and `periodic`; the seam is
/// covered because the endpoints coincide.
///
/// Crossings come first in scan order, then the grazes, so a caller's hit list
/// only gains the new contacts at the end.
fn scan_roots_and_grazes(
    g: &dyn Fn(f64) -> f64,
    pair: &PairGeom,
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
    let mut grazes: Vec<f64> = Vec::new();
    // The two roots of every sub-sample crossing pair, in scan order. They are
    // crossings, so they join the sign-change roots rather than the grazes.
    let mut pairs: Vec<f64> = Vec::new();
    let wrap = |t: f64| if periodic { pymod(t, TWO_PI) } else { t };
    let mut take = |v: Valley| match v {
        Valley::Graze(t) => grazes.push(wrap(t)),
        Valley::Pair(a, b) => pairs.extend([wrap(a), wrap(b)]),
        Valley::None => {}
    };
    for i in 1..SCAN_SAMPLES {
        let v = valley_window(g, pair, [gs[i - 1], gs[i], gs[i + 1]], ts[i - 1], ts[i + 1]);
        take(v);
    }
    if periodic {
        // The seam sample: `ts[0]` and `ts[SCAN_SAMPLES]` are the same point,
        // so its window wraps and the refinement may land past t1; pymod folds
        // it back into [0, 2pi) for the split pass.
        let first = 1;
        let last = SCAN_SAMPLES - 1;
        let v = valley_window(
            g,
            pair,
            [gs[last], gs[0], gs[first]],
            ts[last],
            ts[first] + (t1 - t0),
        );
        take(v);
    }

    // A flat valley can present several sampled valleys around one true
    // minimum; keep one contact per cluster so the split list cannot gain a
    // phantom sliver segment between two params that name the same foot.
    grazes.sort_by(|a, b| a.total_cmp(b));
    let mut kept: Vec<f64> = Vec::new();
    for t in grazes {
        if kept.last().is_some_and(|&p| (t - p).abs() <= step) {
            continue;
        }
        kept.push(t);
    }
    roots.extend(pairs);
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
        // the pair's gap budget (see `tolerance::tangent_gap_tol`) and the foot
        // still lies on the finite segment. A miss has no crossing to swallow.
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
            Some(gap) if gap <= tangent_gap_tol(curve_scale(&ell), TOL_TOPOLOGY_MERGE) => vec![p],
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
/// line's normal length, and the bezier's own scale anchors the budgets.
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
    let sep = |t1: f64, t2: f64| -> f64 {
        let p = bezier_point(p0, c1, c2, p3, t1);
        let q = bezier_point(p0, c1, c2, p3, t2);
        (p[0] - q[0]).hypot(p[1] - q[1])
    };
    // The line contributes no radius, so the bezier's own scale anchors both
    // budgets, exactly as it anchored the gap budget alone.
    let scale = bezier_scale(&[p0, c1, c2, p3]);
    let pair = PairGeom {
        gap_at: &gap_at,
        sep: &sep,
        gap_tol: tangent_gap_tol(scale, TOL_TOPOLOGY_MERGE),
        collapse_h: tangent_collapse_tol(scale),
    };
    scan_roots_and_grazes(&g, &pair, 0.0, 1.0, false)
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
        let tol = tangent_gap_tol(bezier_scale(&ca).min(bezier_scale(&cb)), TOL_TOPOLOGY_MERGE);
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
    let sep = |t1: f64, t2: f64| {
        let p = eval_at(t1);
        let q = eval_at(t2);
        (p[0] - q[0]).hypot(p[1] - q[1])
    };
    // Both budgets read the pair's smaller characteristic radius, the same
    // `r_min` the closed-form `lc`/`cc` arms apply.
    let r_min = curve_scale(scanned).min(curve_scale(other));
    let pair = PairGeom {
        gap_at: &gap_at,
        sep: &sep,
        gap_tol: tangent_gap_tol(r_min, TOL_TOPOLOGY_MERGE),
        collapse_h: tangent_collapse_tol(r_min),
    };
    let params = scan_roots_and_grazes(&g, &pair, 0.0, hi, periodic);
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
mod tests;
