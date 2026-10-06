use super::super::profile_loops::Vec2;
use super::super::{
    TOL_TOPOLOGY_EPS as EPS, TOL_TOPOLOGY_MERGE as MERGE, TOL_TOPOLOGY_SPLIT as SPLIT_EPS,
};
use super::{angle_in_arc, InputEntity, TopoEntity, TANGENT_COLLAPSE_REL, TANGENT_GAP_REL};

// ─── Intersection primitives ───

fn ll(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2) -> Option<(f64, f64, Vec2)> {
    let dx1 = p2[0] - p1[0];
    let dy1 = p2[1] - p1[1];
    let dx2 = p4[0] - p3[0];
    let dy2 = p4[1] - p3[1];
    let det = dx1 * dy2 - dy1 * dx2;
    if det.abs() < EPS {
        return None;
    }
    let dx3 = p3[0] - p1[0];
    let dy3 = p3[1] - p1[1];
    let mut t = (dx3 * dy2 - dy3 * dx2) / det;
    let mut u = (dx3 * dy1 - dy3 * dx1) / det;
    if !(-EPS..=1.0 + EPS).contains(&t) || !(-EPS..=1.0 + EPS).contains(&u) {
        return None;
    }
    t = t.clamp(0.0, 1.0);
    u = u.clamp(0.0, 1.0);
    Some((t, u, [p1[0] + t * dx1, p1[1] + t * dy1]))
}

fn lc(p1: Vec2, p2: Vec2, cx: f64, cy: f64, r: f64) -> Vec<(f64, f64, Vec2)> {
    let dx = p2[0] - p1[0];
    let dy = p2[1] - p1[1];
    let fx = p1[0] - cx;
    let fy = p1[1] - cy;
    let a = dx * dx + dy * dy;
    if a < EPS {
        return vec![];
    }
    let b = 2.0 * (fx * dx + fy * dy);
    let c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4.0 * a * c;
    // Virtual tangent point, `cc`'s rule in the line's terms (see TANGENT_GAP_REL):
    // a converged tangent constraint leaves `disc` a hair either side of zero, and
    // the MISS side (`disc < 0`) has no roots to offer, so the contact the region
    // closes on is simply lost (bugreports/bug-report-1788207174415).
    //
    // Only the miss side. A near-graze already carries two real roots, and they
    // need no help: closer together than MERGE the vertex merge fuses them, and
    // further apart they are an honest chord. Restricting the rule this way is
    // what makes a generous tolerance safe -- on a miss there is no crossing to
    // swallow, so widening it can only invent a contact where the curves come
    // within `gap` of touching, never erase one the user drew.
    let dist = (r * r - disc / (4.0 * a)).max(0.0).sqrt();
    if disc < 0.0 && (dist - r).abs() <= MERGE.max(TANGENT_GAP_REL * r) {
        let raw = -b / (2.0 * a);
        // The foot is bounded in WORLD units, not in the line parameter: a line
        // whose endpoint is constrained onto the rim it is tangent to has its
        // tangency AT that endpoint, and the solver residual leaves the foot a
        // sliver either side of it. `EPS` on the parameter (1e-9, ~7e-8 world on
        // a sketch-sized segment) is inside that sliver and would drop the very
        // contact this branch exists to keep; MERGE is the distance at which the
        // foot and the endpoint are already the same vertex. Bailing here is
        // exactly what the pre-collapse code did for a miss, and `disc < 0`
        // guarantees there is no real root being given up with it.
        let overhang = (-raw).max(raw - 1.0).max(0.0) * a.sqrt();
        if overhang > MERGE {
            return vec![];
        }
        let t = raw.clamp(0.0, 1.0);
        let ix = p1[0] + t * dx;
        let iy = p1[1] + t * dy;
        return vec![(t, (iy - cy).atan2(ix - cx), [ix, iy])];
    }
    if disc < 0.0 {
        return vec![];
    }
    let sd = disc.max(0.0).sqrt();
    let mut out = Vec::new();
    let mut seen: Vec<f64> = Vec::new();
    for sign in [-1.0, 1.0] {
        let raw = (-b + sign * sd) / (2.0 * a);
        if !(-EPS..=1.0 + EPS).contains(&raw) {
            continue;
        }
        let t = raw.clamp(0.0, 1.0);
        let key = (t * 1e7).round() / 1e7;
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let ix = p1[0] + t * dx;
        let iy = p1[1] + t * dy;
        out.push((t, (iy - cy).atan2(ix - cx), [ix, iy]));
    }
    out
}

pub(super) fn cc(
    cx1: f64,
    cy1: f64,
    r1: f64,
    cx2: f64,
    cy2: f64,
    r2: f64,
) -> Vec<(f64, f64, Vec2)> {
    let d = (cx2 - cx1).hypot(cy2 - cy1);
    if d < EPS {
        return vec![];
    }
    // Foot on the radical axis: the would-be tangent point, well defined on the
    // miss side too, where it is the midpoint of closest approach.
    let a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d);
    let mx = cx1 + (a * (cx2 - cx1)) / d;
    let my = cy1 + (a * (cy2 - cy1)) / d;

    // Miss side first. A converged tangency that landed a hair apart (d just
    // beyond r1 + r2, or just inside |r1 - r2|) has no roots, so the contact the
    // region closes on is lost. The gap is exactly the residual r_tangent drives
    // (residuals.rs), so asserting the foot within TANGENT_GAP_REL * r_min (MERGE
    // floor) restores the contact with pure headroom: a miss has no crossing to
    // swallow. This is cc's mirror of lc's miss-side rule.
    if d >= r1 + r2 {
        let gap = d - (r1 + r2);
        if gap <= MERGE.max(TANGENT_GAP_REL * r1.min(r2)) {
            return vec![(
                (my - cy1).atan2(mx - cx1),
                (my - cy2).atan2(mx - cx2),
                [mx, my],
            )];
        }
        return vec![];
    }
    if d <= (r1 - r2).abs() {
        let gap = (r1 - r2).abs() - d;
        if gap <= MERGE.max(TANGENT_GAP_REL * r1.min(r2)) {
            return vec![(
                (my - cy1).atan2(mx - cx1),
                (my - cy2).atan2(mx - cx2),
                [mx, my],
            )];
        }
        return vec![];
    }

    // Graze side (|r1 - r2| < d < r1 + r2): two real roots. Fold them into the
    // foot to stop a phantom sliver arc slicing two near-tangent circles
    // (near_tangent_circles_stay_two_standalone_faces). Threshold stays the
    // shipped h-form: on this side widening would swallow a real, if tiny, lens.
    let h2 = r1 * r1 - a * a;
    if h2 < 0.0 {
        return vec![];
    }
    let h = h2.max(0.0).sqrt();
    // Virtual tangent point: when the two roots are within tolerance of
    // coinciding, define the single contact at the foot [mx, my] (the exact
    // tangent point in the h == 0 limit) instead of emitting two near-duplicate
    // intersections that would slice both curves at a phantom sliver.
    if h <= TANGENT_COLLAPSE_REL * r1.min(r2).max(EPS) {
        return vec![(
            (my - cy1).atan2(mx - cx1),
            (my - cy2).atan2(mx - cx2),
            [mx, my],
        )];
    }
    let ox = (h * (cy2 - cy1)) / d;
    let oy = (h * (cx2 - cx1)) / d;
    let pts: Vec<Vec2> = vec![[mx + ox, my - oy], [mx - ox, my + oy]];
    pts.into_iter()
        .map(|[sx, sy]| {
            (
                (sy - cy1).atan2(sx - cx1),
                (sy - cy2).atan2(sx - cx2),
                [sx, sy],
            )
        })
        .collect()
}

pub(super) fn collinear_overlap(ea: &TopoEntity, eb: &TopoEntity) -> Vec<(f64, f64, Vec2)> {
    let (
        TopoEntity::Line {
            start: p1, end: p2, ..
        },
        TopoEntity::Line {
            start: q1, end: q2, ..
        },
    ) = (ea, eb)
    else {
        return vec![];
    };
    let (p1, p2, q1, q2) = (*p1, *p2, *q1, *q2);

    let dx1 = p2[0] - p1[0];
    let dy1 = p2[1] - p1[1];
    let dx2 = q2[0] - q1[0];
    let dy2 = q2[1] - q1[1];

    if (dx1 * dy2 - dy1 * dx2).abs() > EPS {
        return vec![];
    }
    let pos_cross = dx1 * (q1[1] - p1[1]) - dy1 * (q1[0] - p1[0]);
    if pos_cross.abs() > EPS {
        return vec![];
    }
    let len1sq = dx1 * dx1 + dy1 * dy1;
    if len1sq < EPS {
        return vec![];
    }
    let proj_a = |pt: Vec2| ((pt[0] - p1[0]) * dx1 + (pt[1] - p1[1]) * dy1) / len1sq;
    let len2sq = dx2 * dx2 + dy2 * dy2;
    if len2sq < EPS {
        return vec![];
    }
    let proj_b = |pt: Vec2| ((pt[0] - q1[0]) * dx2 + (pt[1] - q1[1]) * dy2) / len2sq;

    let mut tb0 = proj_a(q1);
    let mut tb1 = proj_a(q2);
    if tb0 > tb1 {
        std::mem::swap(&mut tb0, &mut tb1);
    }
    let lo = tb0.max(0.0);
    let hi = tb1.min(1.0);
    if hi - lo < SPLIT_EPS {
        return vec![];
    }

    let mut result = Vec::new();
    for pt in [q1, q2] {
        let t_a = proj_a(pt);
        if t_a > SPLIT_EPS && t_a < 1.0 - SPLIT_EPS {
            result.push((t_a, proj_b(pt), pt));
        }
    }
    for pt in [p1, p2] {
        let tb = proj_b(pt);
        if tb > SPLIT_EPS && tb < 1.0 - SPLIT_EPS {
            result.push((proj_a(pt), tb, pt));
        }
    }
    result
}

/// Pairwise intersection dispatch (line/circle/arc only), mirroring `intersect`.
/// The kind is the variant, so an entity that reaches here is complete and the
/// old "missing geometry yields no crossing" guards are gone with the `Option`s
/// they protected.
pub(super) fn intersect(ea: &TopoEntity, eb: &TopoEntity) -> Vec<(f64, f64, Vec2)> {
    match (ea, eb) {
        (
            TopoEntity::Line {
                start: ap0,
                end: ap1,
                ..
            },
            TopoEntity::Line {
                start: bp0,
                end: bp1,
                ..
            },
        ) => ll(*ap0, *ap1, *bp0, *bp1).into_iter().collect(),
        (
            TopoEntity::Line {
                start: p0, end: p1, ..
            },
            TopoEntity::Circle {
                center: c,
                radius: r,
                ..
            },
        ) => lc(*p0, *p1, c[0], c[1], *r),
        (
            TopoEntity::Circle {
                center: c,
                radius: r,
                ..
            },
            TopoEntity::Line {
                start: p0, end: p1, ..
            },
        ) => lc(*p0, *p1, c[0], c[1], *r)
            .into_iter()
            .map(|(t, ang, pt)| (ang, t, pt))
            .collect(),
        (
            TopoEntity::Line {
                start: p0, end: p1, ..
            },
            TopoEntity::Arc {
                center: c,
                radius: r,
                angle_start,
                angle_end,
                ..
            },
        ) => lc(*p0, *p1, c[0], c[1], *r)
            .into_iter()
            .filter(|(_, ang, _)| angle_in_arc(*ang, *r, *angle_start, *angle_end))
            .collect(),
        (
            TopoEntity::Arc {
                center: c,
                radius: r,
                angle_start,
                angle_end,
                ..
            },
            TopoEntity::Line {
                start: p0, end: p1, ..
            },
        ) => lc(*p0, *p1, c[0], c[1], *r)
            .into_iter()
            .filter(|(_, ang, _)| angle_in_arc(*ang, *r, *angle_start, *angle_end))
            .map(|(t, ang, pt)| (ang, t, pt))
            .collect(),
        (
            TopoEntity::Circle {
                center: ac,
                radius: ar,
                ..
            },
            TopoEntity::Circle {
                center: bc,
                radius: br,
                ..
            },
        ) => cc(ac[0], ac[1], *ar, bc[0], bc[1], *br),
        (
            TopoEntity::Circle {
                center: ac,
                radius: ar,
                ..
            },
            TopoEntity::Arc {
                center: bc,
                radius: br,
                angle_start,
                angle_end,
                ..
            },
        ) => cc(ac[0], ac[1], *ar, bc[0], bc[1], *br)
            .into_iter()
            .filter(|(_, a2, _)| angle_in_arc(*a2, *br, *angle_start, *angle_end))
            .collect(),
        (
            TopoEntity::Arc {
                center: ac,
                radius: ar,
                angle_start,
                angle_end,
                ..
            },
            TopoEntity::Circle {
                center: bc,
                radius: br,
                ..
            },
        ) => cc(ac[0], ac[1], *ar, bc[0], bc[1], *br)
            .into_iter()
            .filter(|(a1, _, _)| angle_in_arc(*a1, *ar, *angle_start, *angle_end))
            .collect(),
        (
            TopoEntity::Arc {
                center: ac,
                radius: ar,
                angle_start: aas,
                angle_end: aae,
                ..
            },
            TopoEntity::Arc {
                center: bc,
                radius: br,
                angle_start: bas,
                angle_end: bae,
                ..
            },
        ) => cc(ac[0], ac[1], *ar, bc[0], bc[1], *br)
            .into_iter()
            .filter(|(a1, a2, _)| {
                angle_in_arc(*a1, *ar, *aas, *aae) && angle_in_arc(*a2, *br, *bas, *bae)
            })
            .collect(),
        _ => vec![],
    }
}

// ─── Classification ───

#[derive(Default)]
pub(super) struct Classified {
    pub(super) lines: Vec<(String, TopoEntity)>,
    pub(super) circles: Vec<(String, TopoEntity)>,
    pub(super) arcs: Vec<(String, TopoEntity)>,
    pub(super) splines: Vec<(String, TopoEntity)>,
    pub(super) ellipses: Vec<(String, TopoEntity)>,
}

impl Classified {
    /// Split the buckets into the real geometry, which builds vertices, edges
    /// and faces exactly as it did before construction entities were let in,
    /// and the construction geometry, which only ever contributes crossings.
    /// `partition` keeps input order within each half, so the real half is
    /// byte-for-byte the list `classify` used to return.
    pub(super) fn split_construction(self) -> (Classified, Classified) {
        let part = |bucket: Vec<(String, TopoEntity)>| {
            bucket
                .into_iter()
                .partition::<Vec<_>, _>(|(_, e)| !e.construction())
        };
        let (r_lines, c_lines) = part(self.lines);
        let (r_circles, c_circles) = part(self.circles);
        let (r_arcs, c_arcs) = part(self.arcs);
        let (r_splines, c_splines) = part(self.splines);
        let (r_ellipses, c_ellipses) = part(self.ellipses);
        (
            Classified {
                lines: r_lines,
                circles: r_circles,
                arcs: r_arcs,
                splines: r_splines,
                ellipses: r_ellipses,
            },
            Classified {
                lines: c_lines,
                circles: c_circles,
                arcs: c_arcs,
                splines: c_splines,
                ellipses: c_ellipses,
            },
        )
    }

    pub(super) fn is_empty(&self) -> bool {
        self.lines.is_empty()
            && self.circles.is_empty()
            && self.arcs.is_empty()
            && self.splines.is_empty()
            && self.ellipses.is_empty()
    }
}

/// Complete the raw records and sort them into the buckets the passes consume.
/// Classification and the completeness gate now live in `TryFrom<InputEntity>`,
/// so this only routes each complete entity to its bucket by variant. A partial
/// record is dropped at the boundary, never demoted to a neighbouring kind.
pub(super) fn classify(geometry: &[(String, InputEntity)]) -> Classified {
    let mut c = Classified::default();
    for (eid, ent) in geometry {
        let Ok(entity) = TopoEntity::try_from(ent.clone()) else {
            continue;
        };
        match &entity {
            TopoEntity::Spline { .. } => c.splines.push((eid.clone(), entity)),
            TopoEntity::Ellipse { .. } => c.ellipses.push((eid.clone(), entity)),
            TopoEntity::Arc { .. } => c.arcs.push((eid.clone(), entity)),
            TopoEntity::Line { .. } => c.lines.push((eid.clone(), entity)),
            TopoEntity::Circle { .. } => c.circles.push((eid.clone(), entity)),
        }
    }
    c
}
