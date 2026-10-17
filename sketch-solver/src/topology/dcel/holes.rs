//! The even/odd hole rule for the traced DCEL faces.
//!
//! Every traced face is a connected region of the plane cut by the sketch's
//! curves. Which of those regions are FILLED is decided here, by the even/odd
//! rule over the closed carriers: a closed carrier (a circle, a full ellipse,
//! a spline whose end merged back onto its start) is one shell, and a shell
//! strictly inside another alternates the fill of its interior. The outer
//! shell's interior is material (a washer), the interior of a shell nested in
//! material is a hole (the washer's bore), the interior of a shell nested in a
//! hole is material again (an island in the bore). A face no shell encloses is
//! material: the arrangement can fence a region off on its own (the
//! curvilinear triangle between three tangent circles has no shell around it
//! and is still a face).
//!
//! This is the even/odd model the former TS `nestSurfaces` applied to
//! standalone loops, moved onto the traced faces, where connected geometry had
//! made it decide nothing: a washer sliced across by a line used to emit four
//! faces (two ring halves and two bore halves), because each half's boundary
//! loop is contained in no other loop, while the region the hole rule is about
//! is the bore the ring halves collectively surround. The rule is therefore
//! stated on the CLOSED CARRIERS, not on the traced loops: the sliced washer's
//! outer and inner circles are still two shells, whatever the line did to
//! their loops.
//!
//! Two shells that meet (a crossing, a tangency, a fused contact) share a
//! vertex in the split graph, and a fused pair never nests. That is the same
//! identity rule the vertex merge applies everywhere else in the builder: the
//! shells are the same curve at that point, so the fill cannot alternate
//! across it.
//!
//! Nested-hole wiring (`subdivide_loops` / `loop_containment`) is untouched:
//! every surviving loop keeps its own area, carrying the loops nested inside it
//! as holes. The standalone faces go through the fill rule here too, and the
//! exemption above is what keeps an unsliced washer's bore its own island
//! (its shell was never cut); slicing that washer changes how the bore is
//! reported, from its own area to a non-fillable hole region.

use std::collections::{HashMap, HashSet};

use super::super::profile_loops::{
    loop_pts, point_in_polygon, point_polygon_dist, polygon_sagitta, BoundaryEdge, EdgeGeom, Vec2,
};
use super::super::TOL_TOPOLOGY_MERGE as MERGE;
use super::{Split, SurfaceOut, TopoEntity};
use crate::radians;
use crate::tolerance::on_carrier_tol;
use crate::MIN_SEMI_AXIS_SQ;

/// Polygon resolution for a spline shell: uniform samples per cubic. A spline
/// has no closed-form region test, and the containment question needs an
/// absolute resolution (a hairline gap must not flip a nesting), so the sample
/// count is sized for the sagitta rather than for a look: 256 points on a
/// cubic of radius `r` leave a sagitta under `r / 13000`.
const SPLINE_CHAIN_SAMPLES: usize = 256;

/// Samples per arc when a traced face's own boundary is read against the
/// shells. The carriers' tests are exact for circles and ellipses and carry
/// their own tolerance for a spline polygon, so this only has to land points
/// on every side of a face, concave or not.
const FACE_CHAIN_SAMPLES: usize = 64;

/// The closed carrier of one chain: the region test that decides whether a
/// point lies strictly inside it.
enum Carrier {
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
    /// A spline shell, sampled: exact algebra is not available for a cubic.
    Polygon(Vec<Vec2>),
}

impl Carrier {
    /// Strictly inside, no margin: a point right at the boundary is a contact.
    fn holds(&self, p: Vec2) -> bool {
        match *self {
            Carrier::Circle { c, r } => (p[0] - c[0]).hypot(p[1] - c[1]) < r,
            Carrier::Ellipse { c, a, b, theta } => conic_residual(c, a, b, theta, p) < 0.0,
            Carrier::Polygon(ref pts) => point_in_polygon(p, pts),
        }
    }

    /// Inside or on: the closure of the shell's interior. A face bounded BY a
    /// shell (an arc of it is one of the face's sides) is inside that shell,
    /// which is what makes the bore's pieces holes and leaves the ring -- whose
    /// boundary reaches far outside the bore -- material.
    ///
    /// The "on" side carries the point-recompute allowance
    /// (`tolerance::on_carrier_tol`): an arc endpoint is rebuilt from its split
    /// parameter and lands a few ulp of the comparison's largest coordinate off
    /// the carrier, so a closure decided exactly would flip a face whose side IS
    /// the shell. The allowance is not MERGE-sized on purpose: this is a closure
    /// question about one recomputed point, not an identity question between two
    /// curves (see the constant's derivation).
    fn holds_or_on(&self, p: Vec2) -> bool {
        match *self {
            Carrier::Circle { c, r } => {
                let magnitude = p[0]
                    .abs()
                    .max(p[1].abs())
                    .max(c[0].abs())
                    .max(c[1].abs())
                    .max(r);
                (p[0] - c[0]).hypot(p[1] - c[1]) <= r + on_carrier_tol(magnitude)
            }
            Carrier::Ellipse { c, a, b, theta } => {
                let magnitude = p[0]
                    .abs()
                    .max(p[1].abs())
                    .max(c[0].abs())
                    .max(c[1].abs())
                    .max(a.abs())
                    .max(b.abs());
                conic_gap(c, a, b, theta, p) <= on_carrier_tol(magnitude)
            }
            Carrier::Polygon(ref pts) => point_in_polygon(p, pts) || near_polygon(p, pts),
        }
    }

    /// Sample points of the shell, used to ask whether a nested shell lies
    /// entirely inside this one.
    fn samples(&self) -> Vec<Vec2> {
        match *self {
            Carrier::Circle { c, r } => {
                // A polygon is enough for a nested shell's sample points: it
                // is inscribed, so it under-reports by the sagitta, and the
                // nesting question only cares that a whole shell is inside.
                (0..SPLINE_CHAIN_SAMPLES)
                    .map(|k| {
                        let t = 2.0 * std::f64::consts::PI * k as f64 / SPLINE_CHAIN_SAMPLES as f64;
                        [c[0] + r * t.cos(), c[1] + r * t.sin()]
                    })
                    .collect()
            }
            Carrier::Ellipse { c, a, b, theta } => {
                let cr = radians(theta).cos();
                let sr = radians(theta).sin();
                (0..SPLINE_CHAIN_SAMPLES)
                    .map(|k| {
                        let t = 2.0 * std::f64::consts::PI * k as f64 / SPLINE_CHAIN_SAMPLES as f64;
                        let ax = a * t.cos();
                        let ay = b * t.sin();
                        [c[0] + ax * cr - ay * sr, c[1] + ax * sr + ay * cr]
                    })
                    .collect()
            }
            Carrier::Polygon(ref pts) => pts.clone(),
        }
    }
}

/// The conic residual `F(p)` of an ellipse: negative inside, zero on it.
fn conic_residual(c: Vec2, a: f64, b: f64, theta: f64, p: Vec2) -> f64 {
    let cr = radians(theta).cos();
    let sr = radians(theta).sin();
    let dx = p[0] - c[0];
    let dy = p[1] - c[1];
    let xl = dx * cr + dy * sr;
    let yl = -dx * sr + dy * cr;
    // The same degenerate-semi-axis floor the conic residual uses elsewhere.
    xl * xl / (a * a).max(MIN_SEMI_AXIS_SQ) + yl * yl / (b * b).max(MIN_SEMI_AXIS_SQ) - 1.0
}

/// First-order (world) signed gap of a point from an ellipse: negative
/// inside, positive outside, in the residual-over-gradient form the area
/// builder uses everywhere else. `0.0` at the centre, where the gradient
/// vanishes and "inside" is the only answer.
fn conic_gap(c: Vec2, a: f64, b: f64, theta: f64, p: Vec2) -> f64 {
    let f = conic_residual(c, a, b, theta, p);
    let cr = radians(theta).cos();
    let sr = radians(theta).sin();
    let dx = p[0] - c[0];
    let dy = p[1] - c[1];
    let xl = dx * cr + dy * sr;
    let yl = -dx * sr + dy * cr;
    let gx = 2.0 * xl / (a * a).max(MIN_SEMI_AXIS_SQ);
    let gy = 2.0 * yl / (b * b).max(MIN_SEMI_AXIS_SQ);
    let m = gx.hypot(gy);
    if m > 0.0 {
        f / m
    } else {
        f
    }
}

/// True when `p` is within `tol` of a closed polygon's boundary. A spline
/// shell's samples lie on its curve, so a point read against them is on the
/// shell within the polygon's own sagitta.
fn near_polygon(p: Vec2, pts: &[Vec2]) -> bool {
    point_polygon_dist(p, pts) <= polygon_sagitta(pts, SPLINE_CHAIN_SAMPLES)
}

/// One closed carrier: its region test, its sample points, its own loop, and
/// its nesting depth.
struct Chain {
    carrier: Carrier,
    /// The shell's own loop, one wire: the nesting pass subtracts THIS from a
    /// face that covers the shell, not the shell's traced pieces (pieces that
    /// share an arc make touching hole wires, which a face builder cannot
    /// take).
    loop_edges: Vec<BoundaryEdge>,
    /// One plus the depth of the deepest chain that strictly contains this one
    /// (zero for a chain nothing contains). `region_state` reads it.
    depth: usize,
    /// True when the half-edge graph emits a piece of this shell: the
    /// arrangement cut it, so its interior is a traced face and the even/odd
    /// alternation decides it. An UNcut shell keeps the sketch model's
    /// standalone loop: its interior is its own face (the unsliced washer's
    /// bore is still an area), and so is every traced face inside it.
    subdivided: bool,
}

/// The loop one closed entity bounds, in the same edge vocabulary the
/// standalone surfaces use. `None` for the kinds that never close on their own
/// (lines, arcs, open splines) and for a degenerate ellipse, which the
/// standalone pass also refuses.
fn chain_loop(
    id: &str,
    e: &TopoEntity,
    splits: &HashMap<String, Vec<Split>>,
) -> Option<Vec<BoundaryEdge>> {
    match *e {
        TopoEntity::Circle { center, radius, .. } => {
            if radius <= MERGE {
                return None;
            }
            Some(super::trace::circle_arcs(center[0], center[1], radius, id))
        }
        TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } => {
            if a.abs() < MERGE || b.abs() < MERGE {
                return None;
            }
            Some(vec![BoundaryEdge {
                geom: EdgeGeom::Ellipse {
                    center: [center[0], center[1]],
                    a,
                    b,
                    theta: theta.unwrap_or(0.0),
                },
                id: Some(id.to_string()),
                start_vertex: None,
                end_vertex: None,
            }])
        }
        TopoEntity::Spline {
            start, c1, c2, end, ..
        } => spline_loop(id, start, c1, c2, end, splits),
        TopoEntity::Line { .. } | TopoEntity::Arc { .. } => None,
    }
}

/// The loop a closed spline bounds, or `None` for a spline whose start and
/// end are distinct vertices (an open curve closes only together with other
/// edges).
///
/// A closed spline cannot cross itself: with the ends coincident the curve is
/// a nonnegative combination of its two control legs (`B(t) = w1*C1 + w2*C2`
/// with `w1 = 3t(1-t)^2`, `w2 = 3t^2(1-t)`), and equal values at two distinct
/// parameters force the legs to be parallel, which is a retrace rather than a
/// transversal crossing. The near-closure of a spline whose ends sit a
/// sub-merge gap apart is the same point to the merge and is rejected by
/// `bezier_self_crossing` for that reason, so there is nothing to exclude
/// here.
fn spline_loop(
    id: &str,
    start: Vec2,
    c1: Vec2,
    c2: Vec2,
    end: Vec2,
    splits: &HashMap<String, Vec<Split>>,
) -> Option<Vec<BoundaryEdge>> {
    let spl = splits.get(id)?;
    // The seed pass pushes the two endpoint splits first, in order; a merged
    // start/end pair is one vertex id, an open spline's are two.
    let (v0, v1) = (spl.first()?.1.clone(), spl.get(1)?.1.clone());
    if v0 != v1 {
        return None;
    }
    Some(vec![BoundaryEdge {
        geom: EdgeGeom::Spline { start, c1, c2, end },
        id: Some(id.to_string()),
        start_vertex: Some(v0),
        end_vertex: Some(v1),
    }])
}

/// The region test of one closed entity, with its own loop. `None` for the
/// kinds that never close on their own (lines, arcs, open splines) and for a
/// degenerate ellipse, which the standalone pass also refuses to build a face
/// from.
fn chain_carrier(
    id: &str,
    e: &TopoEntity,
    splits: &HashMap<String, Vec<Split>>,
) -> Option<(Carrier, Vec<BoundaryEdge>)> {
    let loop_edges = chain_loop(id, e, splits)?;
    let carrier = match *e {
        TopoEntity::Circle { center, radius, .. } => Carrier::Circle {
            c: center,
            r: radius,
        },
        TopoEntity::Ellipse {
            center,
            a,
            b,
            theta,
            ..
        } => Carrier::Ellipse {
            c: center,
            a,
            b,
            theta: theta.unwrap_or(0.0),
        },
        TopoEntity::Spline { .. } => Carrier::Polygon(loop_pts(&loop_edges, SPLINE_CHAIN_SAMPLES)),
        TopoEntity::Line { .. } | TopoEntity::Arc { .. } => return None,
    };
    Some((carrier, loop_edges))
}

/// The closed carriers of one classified sketch, with their nesting depths.
/// `subdivided_ids` are the entity ids the half-edge graph emitted pieces of.
fn chains_of(
    circles: &[(String, TopoEntity)],
    ellipses: &[(String, TopoEntity)],
    splines: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
    subdivided_ids: &HashSet<&str>,
) -> Vec<Chain> {
    let mut chains: Vec<Chain> = Vec::new();
    for (id, e) in circles.iter().chain(ellipses).chain(splines) {
        let Some((carrier, loop_edges)) = chain_carrier(id, e, splits) else {
            continue;
        };
        chains.push(Chain {
            carrier,
            loop_edges,
            subdivided: subdivided_ids.contains(id.as_str()),
            depth: 0,
        });
    }

    // Nesting depth over the strict-containment relation, relaxed to a
    // fixpoint: a chain inside a chain inside a chain ends at depth two. The
    // relation is a DAG (containment is a strict partial order), so the
    // relaxation settles in at most `chains.len()` rounds.
    for _ in 0..chains.len() {
        let mut changed = false;
        for i in 0..chains.len() {
            let mut deepest = 0;
            for j in 0..chains.len() {
                if i != j && chain_inside(&chains[i], &chains[j]) {
                    deepest = deepest.max(chains[j].depth + 1);
                }
            }
            if deepest > chains[i].depth {
                chains[i].depth = deepest;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    chains
}

/// True when chain `inner` lies strictly inside `outer`: every sample point of
/// the inner shell held by the outer one. `holds` is strict, so a shell that
/// touches its container (an internal tangency) or crosses it keeps some
/// point unheld and never nests: only whole-region enclosure alternates the
/// fill.
fn chain_inside(inner: &Chain, outer: &Chain) -> bool {
    inner
        .carrier
        .samples()
        .iter()
        .all(|&p| outer.carrier.holds(p))
}

/// The fill decision for one face: `(level, innermost_subdivided)` where level
/// is one plus the depth of the deepest chain whose closure holds the face's
/// whole boundary (zero when no chain does). Reading the BOUNDARY rather than
/// an interior probe keeps the answer exact for concave faces, whose centroid
/// can sit in a notch outside them.
fn face_state(boundary: &[BoundaryEdge], chains: &[Chain]) -> (usize, bool) {
    let pts = loop_pts(boundary, FACE_CHAIN_SAMPLES);
    let holds = |c: &Chain| pts.iter().all(|&p| c.carrier.holds_or_on(p));
    let mut level = 0;
    for c in chains {
        if c.depth + 1 > level && holds(c) {
            level = c.depth + 1;
        }
    }
    // The cut flag ORs over every shell at the region's own level: two shells
    // whose interiors overlap are equally innermost, and a region that is a
    // traced face of EITHER is a traced face. Deciding by iteration order
    // would make the answer depend on the entity order.
    let subdivided = chains
        .iter()
        .any(|c| c.depth + 1 == level && c.subdivided && holds(c));
    (level, subdivided)
}

/// The shell a face is a hole of: the innermost chain holding it, when the rule
/// reads the face as a hole (an even level at or above two, the arrangement
/// having subdivided the shell at that level). An untouched shell keeps the
/// standalone model, and so does everything nested inside it.
fn hole_owner(boundary: &[BoundaryEdge], chains: &[Chain]) -> Option<usize> {
    let (level, subdivided) = face_state(boundary, chains);
    if !(subdivided && level >= 2 && level % 2 == 0) {
        return None;
    }
    let pts = loop_pts(boundary, FACE_CHAIN_SAMPLES);
    let holds = |c: &Chain| pts.iter().all(|&p| c.carrier.holds_or_on(p));
    // Two shells at the same level can hold one region (their interiors
    // overlap). The owner decides WHICH loop the covering face subtracts, so
    // it must not be the iteration order: the smallest carrier wins, and two
    // shells of equal area that both hold the region are the same loop anyway.
    let mut owner: Option<usize> = None;
    for (i, c) in chains.iter().enumerate() {
        if c.depth + 1 != level || !c.subdivided || !holds(c) {
            continue;
        }
        if owner.is_none_or(|o| carrier_area(&c.carrier) < carrier_area(&chains[o].carrier)) {
            owner = Some(i);
        }
    }
    owner
}

/// The enclosed area of a carrier, for the deterministic owner above.
fn carrier_area(carrier: &Carrier) -> f64 {
    match *carrier {
        Carrier::Circle { r, .. } => std::f64::consts::PI * r * r,
        Carrier::Ellipse { a, b, .. } => std::f64::consts::PI * a.abs() * b.abs(),
        Carrier::Polygon(ref pts) => {
            let n = pts.len();
            let mut acc = 0.0;
            for i in 0..n {
                let j = (i + 1) % n;
                acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
            }
            (acc / 2.0).abs()
        }
    }
}

/// One shell whose interior the rule refused to fill: the loop a covering face
/// subtracts, plus the traced faces the refusal dropped.
pub(super) struct HoleShell {
    /// The traced pieces of its interior: the wires the islands subtract, and
    /// the faces the oracle counts and checks.
    pub regions: Vec<SurfaceOut>,
}

/// Split the traced faces into the ones the even/odd rule fills and the ones
/// it reads as holes. A hole face is not emitted as a surface; it is returned
/// grouped under the shell that owns it, so the nesting pass can subtract the
/// shell from whatever material face covers its region, and so the oracle can
/// count the pieces in the planar subdivision's Euler identity and check that
/// their cells stay empty.
pub(super) fn split_hole_faces(
    faces: Vec<SurfaceOut>,
    he_eid: &[String],
    circles: &[(String, TopoEntity)],
    ellipses: &[(String, TopoEntity)],
    splines: &[(String, TopoEntity)],
    splits: &HashMap<String, Vec<Split>>,
) -> (Vec<SurfaceOut>, Vec<HoleShell>, Vec<Vec<BoundaryEdge>>) {
    let subdivided_ids: HashSet<&str> = he_eid.iter().map(|s| s.as_str()).collect();
    let chains = chains_of(circles, ellipses, splines, splits, &subdivided_ids);
    let mut material: Vec<SurfaceOut> = Vec::with_capacity(faces.len());
    // Indexed by chain, so the pieces of one shell come back together.
    let mut shells: Vec<HoleShell> = chains
        .iter()
        .map(|_| HoleShell {
            regions: Vec::new(),
        })
        .collect();
    for face in faces {
        match hole_owner(&face.boundary, &chains) {
            Some(owner) => shells[owner].regions.push(face),
            None => material.push(face),
        }
    }
    shells.retain(|s| !s.regions.is_empty());
    // The faces that may subtract a shell are the STANDALONE islands: an uncut
    // chain's own loop, whose region is the whole disk. A traced face's region
    // is a different component of the same subdivision, so it never holds a
    // hole region's region; only a degenerate loop can look like it does, and
    // subtracting there would cut a region the face never owned.
    let island_loops: Vec<Vec<BoundaryEdge>> = chains
        .iter()
        .filter(|c| !c.subdivided)
        .map(|c| c.loop_edges.clone())
        .collect();
    (material, shells, island_loops)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle_entity(r: f64) -> TopoEntity {
        TopoEntity::Circle {
            construction: false,
            center: [0.0, 0.0],
            radius: r,
        }
    }

    /// One traced face as the splitter sees it: a square-ish loop, big enough
    /// that the face-existence floor never matters.
    fn square_face(x0: f64, y0: f64, side: f64) -> SurfaceOut {
        let p = [
            [x0, y0],
            [x0 + side, y0],
            [x0 + side, y0 + side],
            [x0, y0 + side],
        ];
        let boundary = (0..4)
            .map(|i| BoundaryEdge {
                geom: EdgeGeom::Line {
                    start: p[i],
                    end: p[(i + 1) % 4],
                },
                id: Some("l".into()),
                start_vertex: Some(format!("_v{i}")),
                end_vertex: Some(format!("_v{}", (i + 1) % 4)),
            })
            .collect();
        SurfaceOut {
            boundary,
            face_entity_ids: vec!["l".into()],
            holes: vec![],
        }
    }

    fn chain_at(depth: usize, r: f64) -> Chain {
        Chain {
            carrier: Carrier::Circle { c: [0.0, 0.0], r },
            loop_edges: vec![],
            subdivided: true,
            depth,
        }
    }

    /// A tiny square face centred on a point, for the boundary-read rule.
    fn face_at(p: Vec2) -> SurfaceOut {
        square_face(p[0] - 0.05, p[1] - 0.05, 0.1)
    }

    #[test]
    fn face_level_alternates_along_a_nesting_line() {
        let chains = [chain_at(0, 2.0), chain_at(1, 1.0), chain_at(2, 0.5)];
        let level_at = |p: Vec2| face_state(&face_at(p).boundary, &chains).0;
        assert_eq!(level_at([3.0, 0.0]), 0, "outside everything");
        assert_eq!(level_at([1.5, 0.0]), 1, "inside the shell");
        assert!(
            hole_owner(&face_at([0.75, 0.0]).boundary, &chains).is_some(),
            "inside the nested shell (a hole)"
        );
        assert_eq!(
            level_at([0.25, 0.0]),
            3,
            "inside the island (material again)"
        );
        assert!(
            hole_owner(&face_at([0.25, 0.0]).boundary, &chains).is_none(),
            "an island in a hole is material"
        );
        // The same nesting with an UNcut innermost shell stays material: the
        // sketch model's standalone island (the unsliced washer's bore).
        let uncut = [
            chain_at(0, 2.0),
            Chain {
                subdivided: false,
                ..chain_at(1, 1.0)
            },
        ];
        assert!(hole_owner(&face_at([0.5, 0.0]).boundary, &uncut).is_none());
    }

    #[test]
    fn a_face_no_shell_encloses_is_material() {
        // The curvilinear triangle between three tangent circles: no shell
        // encloses it, so the even/odd rule has no opinion.
        let chains = [chain_at(0, 2.0)];
        assert_eq!(
            face_state(&face_at([3.0, 3.0]).boundary, &chains),
            (0, false)
        );
        assert!(hole_owner(&face_at([3.0, 3.0]).boundary, &chains).is_none());
    }

    #[test]
    fn a_face_bounded_by_a_shell_is_inside_it() {
        // A half-disk bounded by an arc of the inner circle and a chord: its
        // boundary lies in the inner shell's closure, so it is inside it (a
        // hole), while the ring -- bounded by the outer arc too -- is not.
        let chains = [chain_at(0, 2.0), chain_at(1, 1.0)];
        let bore_half = SurfaceOut {
            boundary: vec![
                BoundaryEdge {
                    geom: EdgeGeom::Line {
                        start: [-1.0, 0.0],
                        end: [1.0, 0.0],
                    },
                    id: Some("chord".into()),
                    start_vertex: Some("_a".into()),
                    end_vertex: Some("_b".into()),
                },
                BoundaryEdge {
                    geom: EdgeGeom::Line {
                        start: [1.0, 0.0],
                        end: [-1.0, 0.0],
                    },
                    id: Some("chord".into()),
                    start_vertex: Some("_b".into()),
                    end_vertex: Some("_a".into()),
                },
            ],
            face_entity_ids: vec!["chord".into()],
            holes: vec![],
        };
        // A degenerate flat "face" still reads its boundary: entirely inside
        // the inner shell, so the level is two.
        assert_eq!(face_state(&bore_half.boundary, &chains).0, 2);
        // A face sitting between the circles (on the outer shell's side) is
        // outside the inner shell: level one.
        let ring = face_at([1.5, 0.0]);
        assert_eq!(face_state(&ring.boundary, &chains).0, 1);
    }

    #[test]
    fn crossing_and_touching_chains_do_not_nest() {
        // A lens inside a venn: both circles are roots, so a point inside both
        // stays at level one. A chain crossing another keeps sample points on
        // both sides of it and never nests; same for one that merely touches.
        let a = chain_at(0, 2.0);
        let crossing = Chain {
            carrier: Carrier::Circle {
                c: [1.0, 0.0],
                r: 2.0,
            },
            loop_edges: vec![],
            subdivided: true,
            depth: 0,
        };
        assert!(!chain_inside(&crossing, &a), "a crossing pair never nests");
        assert_eq!(
            face_state(&face_at([0.5, 0.0]).boundary, &[a, crossing]).0,
            1
        );
        // An externally tangent pair: no sample of the small shell is held by
        // the big one.
        let a = chain_at(0, 2.0);
        let small = Chain {
            carrier: Carrier::Circle {
                c: [3.0, 0.0],
                r: 1.0,
            },
            loop_edges: vec![],
            subdivided: true,
            depth: 0,
        };
        assert!(!chain_inside(&small, &a));
    }

    #[test]
    fn a_sliced_washer_keeps_the_c_shapes_and_drops_the_bore_halves() {
        // The whole point of the rule: two concentric circles sliced by the
        // line x = 0 give two ring halves (material) and two bore halves
        // (holes), not four filled regions. The ring halves sit between the
        // circles, the bore halves inside the inner one.
        let circles = vec![
            ("outer".into(), circle_entity(2.0)),
            ("inner".into(), circle_entity(1.0)),
        ];
        let splits: HashMap<String, Vec<Split>> = HashMap::new();
        let faces = vec![
            square_face(1.0, -0.5, 0.4),  // ring half (between the circles)
            square_face(-1.4, -0.5, 0.4), // the other ring half
            square_face(0.2, -0.2, 0.4),  // a bore half (inside the inner circle)
            square_face(-0.6, -0.2, 0.4), // the other bore half
        ];
        let cut: Vec<String> = circles
            .iter()
            .map(|(id, _): &(String, TopoEntity)| id.clone())
            .collect();
        let (material, shells, _islands) =
            split_hole_faces(faces, &cut, &circles, &[], &[], &splits);
        assert_eq!(material.len(), 2, "the two ring halves are material");
        let regions: usize = shells.iter().map(|s| s.regions.len()).sum();
        assert_eq!(regions, 2, "the two bore halves are holes");
        assert_eq!(shells.len(), 1, "both pieces belong to the inner shell");
    }

    #[test]
    fn a_face_outside_every_shell_stays_material() {
        // The curvilinear triangle between three tangent circles: no shell
        // encloses it, so the even/odd rule has no opinion and the face stays
        // material, exactly as it did under "every bounded face is fillable".
        let circles = vec![("c".into(), circle_entity(2.0))];
        let splits: HashMap<String, Vec<Split>> = HashMap::new();
        let faces = vec![square_face(3.0, 3.0, 0.5)];
        let cut: Vec<String> = circles
            .iter()
            .map(|(id, _): &(String, TopoEntity)| id.clone())
            .collect();
        let (material, shells, _islands) =
            split_hole_faces(faces, &cut, &circles, &[], &[], &splits);
        assert_eq!(material.len(), 1);
        assert!(shells.is_empty());
    }

    #[test]
    fn an_island_inside_the_bore_stays_material() {
        // A boss inside the bore of a washer: the shell nested in material is
        // a hole, the bore region between the shells is that hole, and the
        // boss nested inside the bore is material again.
        let circles = vec![
            ("outer".into(), circle_entity(4.0)),
            ("inner".into(), circle_entity(2.0)),
            ("boss".into(), circle_entity(0.5)),
        ];
        let splits: HashMap<String, Vec<Split>> = HashMap::new();
        let faces = vec![
            square_face(2.5, -0.2, 0.4),  // ring: material
            square_face(0.6, -0.1, 0.2),  // bore, outside the boss: a hole
            square_face(-0.1, -0.1, 0.2), // the boss itself: material again
        ];
        let cut: Vec<String> = circles
            .iter()
            .map(|(id, _): &(String, TopoEntity)| id.clone())
            .collect();
        let (material, shells, _islands) =
            split_hole_faces(faces, &cut, &circles, &[], &[], &splits);
        assert_eq!(material.len(), 2, "ring + boss");
        let regions: usize = shells.iter().map(|s| s.regions.len()).sum();
        assert_eq!(regions, 1, "the bore region is the hole");
    }
}
