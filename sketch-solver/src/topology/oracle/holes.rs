//! The oracle's own even/odd hole derivation: the fill rule the builder
//! applies to its traced faces, re-derived from the raw input curves alone.
//!
//! A closed carrier (a circle, a full ellipse, a spline whose ends coincide
//! within the merge) is a shell; a shell strictly inside another alternates
//! the fill of its interior (outer shell's interior material, a nested
//! shell's interior a hole, material again inside that). Two shells that meet
//! are fused and never nest. The coverage check reads `region_level` per grid
//! cell to decide whether the cell is expected to sit in a face.
//!
//! Containment is decided on the shells' own sample points against a strict
//! region test, so a shell that crosses or merely touches another is never
//! contained in it and the two never nest. Both sides of the split (this
//! derivation and the builder's `dcel::holes`) are geometric in the same way,
//! which is what keeps their answers identical on the same input.

use super::geometry::{point_in_polygon, sample_curve};
use super::Curve;
use crate::radians;
use crate::topology::profile_loops::{EdgeGeom, Vec2};
use crate::topology::TOL_TOPOLOGY_MERGE as MERGE;
use crate::MIN_SEMI_AXIS_SQ;

/// Uniform samples per turn for a shell's polygon. The containment question
/// is whole-region (a shell is inside another or not), so this only has to be
/// fine enough that a nested shell's samples land on the right side; the
/// exact circle and ellipse tests carry the points themselves.
const SHELL_SAMPLES: usize = 256;

/// One shell's region test.
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
    /// A closed spline, sampled to the coverage chord tolerance.
    Polygon(Vec<Vec2>),
}

impl Carrier {
    /// Strictly inside, no margin: at the boundary the shells meet, and a
    /// fused pair never nests (see `chain_inside`).
    fn holds(&self, p: Vec2) -> bool {
        match *self {
            Carrier::Circle { c, r } => (p[0] - c[0]).hypot(p[1] - c[1]) < r,
            Carrier::Ellipse { c, a, b, theta } => {
                let cr = radians(theta).cos();
                let sr = radians(theta).sin();
                let dx = p[0] - c[0];
                let dy = p[1] - c[1];
                let xl = dx * cr + dy * sr;
                let yl = -dx * sr + dy * cr;
                xl * xl / (a * a).max(MIN_SEMI_AXIS_SQ) + yl * yl / (b * b).max(MIN_SEMI_AXIS_SQ)
                    < 1.0
            }
            Carrier::Polygon(ref pts) => point_in_polygon(p, pts),
        }
    }
}

/// One shell: its region test, its polygon (for the fused test and for its
/// own sample points), its bbox, its nesting depth, and whether the
/// arrangement actually subdivided it.
pub(crate) struct Chain {
    carrier: Carrier,
    poly: Vec<Vec2>,
    bbox: [f64; 4],
    depth: usize,
    /// True when some edge of the builder's split graph walks this shell: the
    /// shell was cut by other geometry, so its interior is a traced face and
    /// the even/odd alternation decides it. An UNcut shell keeps the sketch
    /// model's standalone loop: its interior is its own face (the unsliced
    /// washer's bore is still an area).
    subdivided: bool,
}

fn closed_carrier(c: &Curve, chord_tol: f64) -> Option<Carrier> {
    match *c {
        Curve::Circle { c, r } if r > MERGE => Some(Carrier::Circle { c, r }),
        Curve::Ellipse { c, a, b, theta } if a.abs() >= MERGE && b.abs() >= MERGE => {
            Some(Carrier::Ellipse { c, a, b, theta })
        }
        Curve::Spline { p0, p3, .. } if (p0[0] - p3[0]).hypot(p0[1] - p3[1]) <= MERGE => {
            // A figure-eight bounds no single region, so it neither nests nor
            // is nested: the same exclusion the builder applies.
            let s = sample_curve(c, chord_tol);
            let poly = s.pts;
            if poly.len() < 3 {
                return None;
            }
            Some(Carrier::Polygon(poly))
        }
        _ => None,
    }
}

fn shell_polygon(carrier: &Carrier) -> Vec<Vec2> {
    match *carrier {
        Carrier::Circle { c, r } => (0..SHELL_SAMPLES)
            .map(|k| {
                let t = 2.0 * std::f64::consts::PI * k as f64 / SHELL_SAMPLES as f64;
                [c[0] + r * t.cos(), c[1] + r * t.sin()]
            })
            .collect(),
        Carrier::Ellipse { c, a, b, theta } => {
            let cr = radians(theta).cos();
            let sr = radians(theta).sin();
            (0..SHELL_SAMPLES)
                .map(|k| {
                    let t = 2.0 * std::f64::consts::PI * k as f64 / SHELL_SAMPLES as f64;
                    let ax = a * t.cos();
                    let ay = b * t.sin();
                    [c[0] + ax * cr - ay * sr, c[1] + ax * sr + ay * cr]
                })
                .collect()
        }
        Carrier::Polygon(ref pts) => pts.clone(),
    }
}

fn bbox_of_poly(poly: &[Vec2]) -> [f64; 4] {
    let mut b = [poly[0][0], poly[0][1], poly[0][0], poly[0][1]];
    for p in poly {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b
}

/// The shells of one input, with their nesting depths. `subdivided` marks the
/// shells some edge of the built graph walks.
pub(crate) fn chains_of(
    curves: &[(String, Curve)],
    chord_tol: f64,
    edges: &[crate::topology::dcel::EdgeOut],
) -> Vec<Chain> {
    let mut chains: Vec<Chain> = Vec::new();
    for (id, c) in curves {
        let Some(carrier) = closed_carrier(c, chord_tol) else {
            continue;
        };
        let poly = shell_polygon(&carrier);
        let bbox = bbox_of_poly(&poly);
        let subdivided = edges.iter().any(|e| &e.entity_id == id);
        chains.push(Chain {
            carrier,
            poly,
            bbox,
            depth: 0,
            subdivided,
        });
    }
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

/// True when shell `inner` lies strictly inside shell `outer`: every sample
/// point of the inner shell held by the outer one. `holds` is strict, so a
/// shell that touches its container (an internal tangency) or crosses it keeps
/// some point unheld and never nests: only whole-region enclosure alternates
/// the fill.
fn chain_inside(inner: &Chain, outer: &Chain) -> bool {
    if inner.bbox[0] > outer.bbox[2]
        || inner.bbox[2] < outer.bbox[0]
        || inner.bbox[1] > outer.bbox[3]
        || inner.bbox[3] < outer.bbox[1]
    {
        return false;
    }
    inner.poly.iter().all(|&p| outer.carrier.holds(p))
}

/// The fill level of the region around `p`: one plus the depth of the deepest
/// shell containing the point, or zero when no shell contains it.
pub(crate) fn region_level(p: Vec2, chains: &[Chain]) -> usize {
    let mut level = 0;
    for c in chains {
        if c.depth < level {
            continue;
        }
        if p[0] < c.bbox[0] || p[0] > c.bbox[2] || p[1] < c.bbox[1] || p[1] > c.bbox[3] {
            continue;
        }
        if c.carrier.holds(p) {
            level = c.depth + 1;
        }
    }
    level
}

/// Whether the cell at `p` must stay out of every face. True when the deepest
/// shell containing the point is an even level at or above two AND that shell
/// was subdivided by the arrangement: an uncut shell keeps the sketch model's
/// standalone loop, where its interior is its own selectable area.
pub(crate) fn hole_expected(p: Vec2, chains: &[Chain]) -> bool {
    let holds = |c: &Chain| {
        p[0] >= c.bbox[0]
            && p[0] <= c.bbox[2]
            && p[1] >= c.bbox[1]
            && p[1] <= c.bbox[3]
            && c.carrier.holds(p)
    };
    let mut level = 0;
    for c in chains {
        if c.depth + 1 > level && holds(c) {
            level = c.depth + 1;
        }
    }
    if !is_hole_level(level) {
        return false;
    }
    // ORed over the shells at the region's own level, exactly as the builder's
    // `face_state` decides it: overlapping shells are equally innermost.
    chains
        .iter()
        .any(|c| c.depth + 1 == level && c.subdivided && holds(c))
}

/// True when an even level means a non-fillable hole.
pub(crate) fn is_hole_level(level: usize) -> bool {
    level >= 2 && level % 2 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circ(c: Vec2, r: f64) -> Curve {
        Curve::Circle { c, r }
    }

    fn chains(curves: &[Curve]) -> Vec<Chain> {
        let list: Vec<(String, Curve)> = curves
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("e{i}"), c.clone()))
            .collect();
        // Every shell counts as subdivided here: the level rule is what these
        // tests pin, and the unsliced exemption is exercised end to end.
        let edges: Vec<crate::topology::dcel::EdgeOut> = list
            .iter()
            .enumerate()
            .map(|(i, (id, _))| crate::topology::dcel::EdgeOut {
                entity_id: id.clone(),
                edge_index: i,
                edge_type: "edge",
                geom: EdgeGeom::Line {
                    start: [0.0, 0.0],
                    end: [1.0, 0.0],
                },
            })
            .collect();
        chains_of(&list, 1e-6, &edges)
    }

    #[test]
    fn nested_circles_alternate_the_fill_level() {
        let cs = chains(&[
            circ([0.0, 0.0], 3.0),
            circ([0.0, 0.0], 2.0),
            circ([0.0, 0.0], 1.0),
        ]);
        assert_eq!(region_level([5.0, 0.0], &cs), 0);
        assert_eq!(region_level([2.5, 0.0], &cs), 1);
        assert!(is_hole_level(region_level([1.5, 0.0], &cs)));
        assert_eq!(region_level([0.5, 0.0], &cs), 3);
    }

    #[test]
    fn crossing_circles_do_not_nest() {
        let cs = chains(&[circ([0.0, 0.0], 2.0), circ([1.0, 0.0], 2.0)]);
        assert_eq!(
            region_level([0.5, 0.0], &cs),
            1,
            "a point in both crossing shells stays at the first level"
        );
    }

    #[test]
    fn an_open_spline_is_not_a_shell() {
        // Only a spline whose ends coincide bounds a region on its own.
        let open = Curve::Spline {
            p0: [0.0, 0.0],
            c1: [4.0, 0.0],
            c2: [4.0, 4.0],
            p3: [1.0, 0.0],
        };
        assert!(chains(&[open]).is_empty());
    }

    #[test]
    fn a_closed_spline_inside_another_is_a_hole_boundary() {
        // The polygon path of the derivation: a small teardrop inside a big
        // one is at level two, and a point between them at level one.
        let big = Curve::Spline {
            p0: [0.0, 0.0],
            c1: [4.0, 0.0],
            c2: [4.0, 4.0],
            p3: [0.0, 0.0],
        };
        let small = Curve::Spline {
            p0: [1.5, 0.6],
            c1: [2.0, 0.6],
            c2: [2.0, 0.9],
            p3: [1.5, 0.6],
        };
        let cs = chains(&[big, small]);
        assert_eq!(cs.len(), 2, "both closed splines are shells");
        assert_eq!(region_level([1.0, 0.3], &cs), 1, "inside the big loop only");
        assert!(
            is_hole_level(region_level([1.75, 0.65], &cs)),
            "inside the small loop, which is inside the big one"
        );
    }
}
