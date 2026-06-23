//! Pure curve-curve intersection for the sketch area builder — Rust port of
//! `frontend/src/kernel/curveIntersect.ts`. Plain numbers in, intersection
//! points + per-curve parameters out. No topology / query dependencies.
//!
//! Parameter conventions returned in each `Hit` (`t_a` on curve a, `t_b` on b):
//!   line     t in [0, 1]             along p0 -> p1
//!   circle   angle in [0, 2*pi)      geometric atan2 from the center
//!   ellipse  ecc. angle in [0, 2*pi) the Geom_Ellipse parameter phi
//!   bezier   t in [0, 1]
//!
//! Robustness rule: numeric pairs report only genuine sign-change crossings. A
//! tangency (a touch with no sign change) yields no point, so a single grazing
//! contact does not split a curve.

use super::curve_split::{bezier_point, ellipse_point_at};
use super::TOL_TOPOLOGY_MERGE;

pub type Vec2 = [f64; 2];

#[derive(Clone, Copy, Debug)]
pub enum Curve {
    Line { p0: Vec2, p1: Vec2 },
    Circle { c: Vec2, r: f64 },
    Ellipse { c: Vec2, a: f64, b: f64, theta: f64 },
    Bezier { p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2 },
}

#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub point: Vec2,
    pub t_a: f64,
    pub t_b: f64,
}

const TWO_PI: f64 = 2.0 * std::f64::consts::PI;
const POINT_MERGE: f64 = TOL_TOPOLOGY_MERGE; // two hits closer than this are the same

fn norm_2pi(a: f64) -> f64 {
    ((a % TWO_PI) + TWO_PI) % TWO_PI
}

fn deg2rad(d: f64) -> f64 {
    d * std::f64::consts::PI / 180.0
}

// ─── recover a curve's parameter from a point known to lie on it ───

fn param_of(curve: &Curve, p: Vec2) -> f64 {
    match *curve {
        Curve::Line { p0, p1 } => {
            let dx = p1[0] - p0[0];
            let dy = p1[1] - p0[1];
            let len2 = dx * dx + dy * dy;
            if len2 < 1e-18 {
                return 0.0;
            }
            ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / len2
        }
        Curve::Circle { c, .. } => norm_2pi((p[1] - c[1]).atan2(p[0] - c[0])),
        Curve::Ellipse { c, a, b, theta } => {
            let cr = deg2rad(theta).cos();
            let sr = deg2rad(theta).sin();
            let dx = p[0] - c[0];
            let dy = p[1] - c[1];
            // Un-rotate into the ellipse's local frame; the eccentric angle is
            // atan2(y'/b, x'/a) (NOT the geometric angle).
            let xl = dx * cr + dy * sr;
            let yl = -dx * sr + dy * cr;
            norm_2pi((yl / b).atan2(xl / a))
        }
        // bezier: not recoverable in closed form; callers that pair a bezier as
        // the "other" curve obtain its parameter directly.
        Curve::Bezier { .. } => f64::NAN,
    }
}

// ─── implicit residual of a conic at a point (zero on the curve) ───

fn conic_residual(curve: &Curve) -> Box<dyn Fn(Vec2) -> f64> {
    match *curve {
        Curve::Circle { c, r } => Box::new(move |p: Vec2| {
            let dx = p[0] - c[0];
            let dy = p[1] - c[1];
            dx * dx + dy * dy - r * r
        }),
        Curve::Ellipse { c, a, b, theta } => {
            let cr = deg2rad(theta).cos();
            let sr = deg2rad(theta).sin();
            Box::new(move |p: Vec2| {
                let dx = p[0] - c[0];
                let dy = p[1] - c[1];
                let xl = dx * cr + dy * sr;
                let yl = -dx * sr + dy * cr;
                (xl * xl) / (a * a) + (yl * yl) / (b * b) - 1.0
            })
        }
        _ => panic!("conic_residual: not a conic"),
    }
}

// ─── 1-D root finding by dense sampling + bisection (sign-change only) ───

const SCAN_SAMPLES: usize = 512;
const BISECT_ITERS: usize = 60;

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

/// Roots of g over [t0, t1] found by scanning for sign changes and refining. For
/// periodic curves pass the full period [0, 2pi); the seam is covered because the
/// endpoints coincide (g(0) == g(2pi)).
fn scan_roots(g: &dyn Fn(f64) -> f64, t0: f64, t1: f64) -> Vec<f64> {
    let mut roots = Vec::new();
    let step = (t1 - t0) / SCAN_SAMPLES as f64;
    let mut prev_t = t0;
    let mut prev_g = g(prev_t);
    for i in 1..=SCAN_SAMPLES {
        let cur_t = t0 + i as f64 * step;
        let cur_g = g(cur_t);
        if prev_g == 0.0 {
            roots.push(prev_t);
        } else if prev_g * cur_g < 0.0 {
            roots.push(bisect(g, prev_t, cur_t));
        }
        prev_t = cur_t;
        prev_g = cur_g;
    }
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

fn line_line(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2) -> Vec<Vec2> {
    let dx1 = a1[0] - a0[0];
    let dy1 = a1[1] - a0[1];
    let dx2 = b1[0] - b0[0];
    let dy2 = b1[1] - b0[1];
    let det = dx1 * dy2 - dy1 * dx2;
    if det.abs() < 1e-12 {
        return vec![];
    }
    let dx3 = b0[0] - a0[0];
    let dy3 = b0[1] - a0[1];
    let t = (dx3 * dy2 - dy3 * dx2) / det;
    let u = (dx3 * dy1 - dy3 * dx1) / det;
    if !(-1e-9..=1.0 + 1e-9).contains(&t) || !(-1e-9..=1.0 + 1e-9).contains(&u) {
        return vec![];
    }
    vec![[a0[0] + t * dx1, a0[1] + t * dy1]]
}

/// Line vs full circle: closed-form quadratic, segment-clamped.
fn line_circle(l0: Vec2, l1: Vec2, c: Vec2, r: f64) -> Vec<Vec2> {
    let dx = l1[0] - l0[0];
    let dy = l1[1] - l0[1];
    let fx = l0[0] - c[0];
    let fy = l0[1] - c[1];
    let aa = dx * dx + dy * dy;
    if aa < 1e-18 {
        return vec![];
    }
    let bb = 2.0 * (fx * dx + fy * dy);
    let cc = fx * fx + fy * fy - r * r;
    let disc = bb * bb - 4.0 * aa * cc;
    if disc < 0.0 {
        return vec![];
    }
    let sd = disc.sqrt();
    let mut pts = Vec::new();
    for sign in [-1.0, 1.0] {
        let t = (-bb + sign * sd) / (2.0 * aa);
        if (-1e-9..=1.0 + 1e-9).contains(&t) {
            pts.push([l0[0] + t * dx, l0[1] + t * dy]);
        }
    }
    pts
}

/// Line vs ellipse: map the line into the ellipse's local unit-circle space,
/// intersect the unit circle in closed form, map hit points back to world.
fn line_ellipse(l0: Vec2, l1: Vec2, c: Vec2, a: f64, b: f64, theta: f64) -> Vec<Vec2> {
    let cr = deg2rad(theta).cos();
    let sr = deg2rad(theta).sin();
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
    if aa < 1e-18 {
        return vec![];
    }
    let bb = 2.0 * (q0[0] * dx + q0[1] * dy);
    let cc = q0[0] * q0[0] + q0[1] * q0[1] - 1.0;
    let disc = bb * bb - 4.0 * aa * cc;
    if disc < 0.0 {
        return vec![];
    }
    let sd = disc.sqrt();
    let mut pts = Vec::new();
    for sign in [-1.0, 1.0] {
        let t = (-bb + sign * sd) / (2.0 * aa);
        if (-1e-9..=1.0 + 1e-9).contains(&t) {
            pts.push([l0[0] + t * (l1[0] - l0[0]), l0[1] + t * (l1[1] - l0[1])]);
        }
    }
    pts
}

fn circle_circle(ac: Vec2, ar: f64, bc: Vec2, br: f64) -> Vec<Vec2> {
    let dx = bc[0] - ac[0];
    let dy = bc[1] - ac[1];
    let d = dx.hypot(dy);
    if d < 1e-12 || d > ar + br + 1e-12 || d < (ar - br).abs() - 1e-12 {
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
    if h < 1e-12 {
        return vec![[mx, my]];
    }
    vec![[mx + ox, my - oy], [mx - ox, my + oy]]
}

/// Cubic Bezier vs line via the cubic the line's implicit form induces in t.
fn bezier_line(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, l0: Vec2, l1: Vec2) -> Vec<f64> {
    let nx = l1[1] - l0[1];
    let ny = -(l1[0] - l0[0]);
    let g = move |t: f64| -> f64 {
        let p = bezier_point(p0, c1, c2, p3, t);
        nx * (p[0] - l0[0]) + ny * (p[1] - l0[1])
    };
    scan_roots(&g, 0.0, 1.0)
}

// ─── bezier vs bezier by recursive AABB subdivision ───

type BzCtrl = [Vec2; 4];

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
    let mut out: Vec<Hit> = Vec::new();
    const FLAT: f64 = 1e-7;
    #[allow(clippy::too_many_arguments)]
    fn recurse(
        x: &BzCtrl,
        xt0: f64,
        xt1: f64,
        y: &BzCtrl,
        yt0: f64,
        yt1: f64,
        depth: u32,
        out: &mut Vec<Hit>,
    ) {
        let bx = bbox(x);
        let by = bbox(y);
        if !boxes_overlap(&bx, &by) {
            return;
        }
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
        recurse(&x0, xt0, xm, &y0, yt0, ym, depth + 1, out);
        recurse(&x0, xt0, xm, &y1, ym, yt1, depth + 1, out);
        recurse(&x1, xm, xt1, &y0, yt0, ym, depth + 1, out);
        recurse(&x1, xm, xt1, &y1, ym, yt1, depth + 1, out);
    }
    recurse(&ca, 0.0, 1.0, &cb, 0.0, 1.0, 0, &mut out);
    out
}

// ─── public entry point ───

/// Intersection points of two curves with the parameter on each. Order of a and
/// b is preserved (`t_a` refers to a, `t_b` to b). Tangencies report no point.
pub fn intersect_curves(a: &Curve, b: &Curve) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();

    // Push closed-form world points, recovering both params from each.
    let push = |points: Vec<Vec2>, hits: &mut Vec<Hit>| {
        for p in points {
            hits.push(Hit {
                point: p,
                t_a: param_of(a, p),
                t_b: param_of(b, p),
            });
        }
    };

    // Scan a parametric curve, recovering both params from each resulting point.
    let scan_with = |scanned: &Curve,
                     scanned_is_a: bool,
                     residual: Box<dyn Fn(Vec2) -> f64>,
                     hits: &mut Vec<Hit>| {
        let eval_at: Box<dyn Fn(f64) -> Vec2> = match *scanned {
            Curve::Circle { c, r } => Box::new(move |phi: f64| [c[0] + r * phi.cos(), c[1] + r * phi.sin()]),
            Curve::Ellipse { c, a, b, theta } => Box::new(move |phi: f64| ellipse_point_at(c, a, b, theta, phi)),
            Curve::Bezier { p0, c1, c2, p3 } => Box::new(move |t: f64| bezier_point(p0, c1, c2, p3, t)),
            Curve::Line { .. } => panic!("scan_with: unsupported scanned curve kind"),
        };
        let hi = match *scanned {
            Curve::Bezier { .. } => 1.0,
            _ => TWO_PI,
        };
        let g = |t: f64| residual(eval_at(t));
        let params = scan_roots(&g, 0.0, hi);
        for t in params {
            let pt = eval_at(t);
            hits.push(Hit {
                point: pt,
                t_a: if scanned_is_a { t } else { param_of(a, pt) },
                t_b: if scanned_is_a { param_of(b, pt) } else { t },
            });
        }
    };

    // Every scanned crossing is symmetric: scan one operand against the other's
    // conic residual. `scanned_is_a` picks which operand carries the parameter.
    let scan_conic = |scanned_is_a: bool, hits: &mut Vec<Hit>| {
        let (scanned, other) = if scanned_is_a { (a, b) } else { (b, a) };
        scan_with(scanned, scanned_is_a, conic_residual(other), hits);
    };

    // Bezier-vs-line is symmetric: identical crossing math, only the (t_a, t_b)
    // assignment flips depending on which operand is the bezier. `line` is the
    // line operand; segment params outside [0, 1] are off the finite segment.
    let bezier_line_hits = |p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, l0: Vec2, l1: Vec2, line: &Curve, bezier_is_a: bool, hits: &mut Vec<Hit>| {
        for t in bezier_line(p0, c1, c2, p3, l0, l1) {
            let p = bezier_point(p0, c1, c2, p3, t);
            let lp = param_of(line, p);
            if !(-1e-9..=1.0 + 1e-9).contains(&lp) {
                continue;
            }
            let (t_a, t_b) = if bezier_is_a { (t, lp) } else { (lp, t) };
            hits.push(Hit { point: p, t_a, t_b });
        }
    };

    match (a, b) {
        (Curve::Line { p0: a0, p1: a1 }, Curve::Line { p0: b0, p1: b1 }) => {
            push(line_line(*a0, *a1, *b0, *b1), &mut hits);
        }
        (Curve::Line { p0, p1 }, Curve::Circle { c, r })
        | (Curve::Circle { c, r }, Curve::Line { p0, p1 }) => {
            push(line_circle(*p0, *p1, *c, *r), &mut hits);
        }
        (Curve::Line { p0, p1 }, Curve::Ellipse { c, a, b, theta })
        | (Curve::Ellipse { c, a, b, theta }, Curve::Line { p0, p1 }) => {
            push(line_ellipse(*p0, *p1, *c, *a, *b, *theta), &mut hits);
        }
        (Curve::Circle { c: ac, r: ar }, Curve::Circle { c: bc, r: br }) => {
            push(circle_circle(*ac, *ar, *bc, *br), &mut hits);
        }
        (Curve::Circle { .. }, Curve::Ellipse { .. }) => scan_conic(false, &mut hits),
        (Curve::Ellipse { .. }, Curve::Circle { .. }) => scan_conic(true, &mut hits),
        (Curve::Ellipse { .. }, Curve::Ellipse { .. }) => scan_conic(true, &mut hits),
        (Curve::Bezier { p0, c1, c2, p3 }, Curve::Line { p0: l0, p1: l1 }) => {
            bezier_line_hits(*p0, *c1, *c2, *p3, *l0, *l1, b, true, &mut hits);
        }
        (Curve::Line { p0: l0, p1: l1 }, Curve::Bezier { p0, c1, c2, p3 }) => {
            bezier_line_hits(*p0, *c1, *c2, *p3, *l0, *l1, a, false, &mut hits);
        }
        (Curve::Bezier { .. }, Curve::Circle { .. }) | (Curve::Bezier { .. }, Curve::Ellipse { .. }) => {
            scan_conic(true, &mut hits)
        }
        (Curve::Circle { .. }, Curve::Bezier { .. }) | (Curve::Ellipse { .. }, Curve::Bezier { .. }) => {
            scan_conic(false, &mut hits)
        }
        (Curve::Bezier { p0: ap0, c1: ac1, c2: ac2, p3: ap3 }, Curve::Bezier { p0: bp0, c1: bc1, c2: bc2, p3: bp3 }) => {
            hits.extend(bezier_bezier([*ap0, *ac1, *ac2, *ap3], [*bp0, *bc1, *bc2, *bp3]));
        }
    }

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
    fn line_line_cross_at_center() {
        let h = intersect_curves(&line([-1.0, 0.0], [1.0, 0.0]), &line([0.0, -1.0], [0.0, 1.0]));
        assert_eq!(h.len(), 1);
        assert!((h[0].point[0]).abs() < 1e-12 && (h[0].point[1]).abs() < 1e-12);
        assert!((h[0].t_a - 0.5).abs() < 1e-12 && (h[0].t_b - 0.5).abs() < 1e-12);
    }

    #[test]
    fn parallel_lines_no_hit() {
        let h = intersect_curves(&line([0.0, 0.0], [1.0, 0.0]), &line([0.0, 1.0], [1.0, 1.0]));
        assert!(h.is_empty());
    }

    #[test]
    fn line_through_circle_two_points() {
        let c = Curve::Circle { c: [0.0, 0.0], r: 1.0 };
        let h = intersect_curves(&line([-2.0, 0.0], [2.0, 0.0]), &c);
        assert_eq!(h.len(), 2);
    }

    #[test]
    fn line_tangent_circle_one_point() {
        let c = Curve::Circle { c: [0.0, 0.0], r: 1.0 };
        let h = intersect_curves(&line([-2.0, 1.0], [2.0, 1.0]), &c);
        // Tangent touches once; the two quadratic roots coincide and dedup.
        assert_eq!(h.len(), 1);
        assert!((h[0].point[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn line_through_ellipse_center() {
        let e = Curve::Ellipse { c: [0.0, 0.0], a: 3.0, b: 1.0, theta: 0.0 };
        let h = intersect_curves(&line([-4.0, 0.0], [4.0, 0.0]), &e);
        assert_eq!(h.len(), 2);
        let mut xs: Vec<f64> = h.iter().map(|x| x.point[0]).collect();
        xs.sort_by(|p, q| p.partial_cmp(q).unwrap());
        assert!((xs[0] + 3.0).abs() < 1e-9 && (xs[1] - 3.0).abs() < 1e-9);
    }

    #[test]
    fn circle_circle_two_points() {
        let a = Curve::Circle { c: [0.0, 0.0], r: 1.0 };
        let b = Curve::Circle { c: [1.0, 0.0], r: 1.0 };
        let h = intersect_curves(&a, &b);
        assert_eq!(h.len(), 2);
        for hit in &h {
            assert!((hit.point[0] - 0.5).abs() < 1e-9);
        }
    }

    #[test]
    fn circle_ellipse_four_points() {
        let circ = Curve::Circle { c: [0.0, 0.0], r: 2.0 };
        let ell = Curve::Ellipse { c: [0.0, 0.0], a: 3.0, b: 1.0, theta: 0.0 };
        let h = intersect_curves(&circ, &ell);
        assert_eq!(h.len(), 4);
    }

    #[test]
    fn bezier_line_one_crossing() {
        let bz = Curve::Bezier { p0: [0.0, 0.0], c1: [1.0, 2.0], c2: [2.0, -2.0], p3: [3.0, 0.0] };
        let h = intersect_curves(&bz, &line([-1.0, 0.0], [4.0, 0.0]));
        // y=0 line crosses the symmetric S-curve at the two ends and the middle.
        assert!(!h.is_empty());
        for hit in &h {
            assert!(hit.point[1].abs() < 1e-6);
        }
    }

    #[test]
    fn bezier_bezier_cross() {
        let a = Curve::Bezier { p0: [-2.0, 0.0], c1: [-1.0, 0.0], c2: [1.0, 0.0], p3: [2.0, 0.0] };
        let b = Curve::Bezier { p0: [0.0, -2.0], c1: [0.0, -1.0], c2: [0.0, 1.0], p3: [0.0, 2.0] };
        let h = intersect_curves(&a, &b);
        assert_eq!(h.len(), 1);
        assert!(h[0].point[0].abs() < 1e-5 && h[0].point[1].abs() < 1e-5);
    }
}
