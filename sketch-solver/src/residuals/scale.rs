//! Length scales that put every residual row in the same unit.
//!
//! Rows used to mix units: lengths, raw cross and dot products of direction
//! vectors (length squared), angles in radians and the dimensionless ellipse
//! conic. Their relative weights then depended on the sketch's size, and a
//! satisfiable 20-line chain solved at scale 0.01 but read Overconstrained at
//! scale 1 and 100. Every angular row is now an angle times a length, so all
//! rows measure a displacement.
//!
//! The lengths come from the seed `x0`, not the current iterate: a factor that
//! moved with the geometry would reward the solver for shrinking a line to
//! shrink its angular row.

use super::{Problem, P2};
use crate::constraints::{Constraint, Ref};
use crate::fit_spline::split_params;
use crate::{Input, Kind};

/// Floor on a seed length, relative to the sketch scale, so a line drawn with
/// zero length still gives its angular rows a usable weight.
const MIN_LEN_REL: f64 = 1e-6;

/// Characteristic length of a sketch: the diagonal of the bounding box of its
/// seed geometry (every entity's defining points, padded by radii and
/// semi-axes) and of the external points its constraints name. `1.0` for an
/// empty or fully collapsed sketch, which has no length of its own.
pub(super) fn geometry_scale(input: &Input, x0: &[f64], constraints: &[&Constraint]) -> f64 {
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    let mut grow = |p: [f64; 2], pad: f64| {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k] - pad);
            hi[k] = hi[k].max(p[k] + pad);
        }
    };
    for (i, e) in input.entities.iter().enumerate() {
        if !input.entity_params_in_range(i) {
            continue;
        }
        let ep = &x0[e.param_offset..e.param_offset + e.param_count];
        match e.kind {
            Kind::Line => {
                grow([ep[0], ep[1]], 0.0);
                grow([ep[2], ep[3]], 0.0);
            }
            Kind::Circle | Kind::Arc => grow([ep[0], ep[1]], ep[2].abs()),
            Kind::Point => grow([ep[0], ep[1]], 0.0),
            Kind::Ellipse => grow([ep[0], ep[1]], ep[2].abs().max(ep[3].abs())),
            Kind::Spline => {
                for k in 0..4 {
                    grow([ep[2 * k], ep[2 * k + 1]], 0.0);
                }
            }
            Kind::FitSpline => {
                // Every fit point and both optional handles are defining
                // points; the curve lies inside their hull.
                for pair in ep.chunks_exact(2) {
                    grow([pair[0], pair[1]], 0.0);
                }
            }
        }
    }
    for c in constraints {
        for (_, r) in &c.refs {
            if let Ref::External { x, y } = r {
                grow([*x, *y], 0.0);
            }
        }
    }
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2)).sqrt();
    if diag.is_finite() && diag > 0.0 {
        diag
    } else {
        1.0
    }
}

impl Problem<'_> {
    /// The sketch's characteristic length (see `geometry_scale`).
    pub fn scale(&self) -> f64 {
        self.scale
    }

    /// Seed length of a line, floored relative to the sketch scale.
    pub(super) fn line_len0(&self, index: u32) -> f64 {
        let ep = self.params(&self.x0, index);
        let len = ((ep[2] - ep[0]).powi(2) + (ep[3] - ep[1]).powi(2)).sqrt();
        len.max(MIN_LEN_REL * self.scale)
    }

    /// Weight of an angular row between two lines: the geometric mean of their
    /// seed lengths, so the row reads roughly how far the angle error moves
    /// the line ends.
    pub(super) fn line_pair_len0(&self, a: u32, b: u32) -> f64 {
        (self.line_len0(a) * self.line_len0(b)).sqrt()
    }

    /// Seed length of a fit spline: its fit-point polyline, which is the curve's
    /// own scale (the chain lies inside the hull of the points and handles).
    pub(super) fn fit_len0(&self, index: u32) -> f64 {
        let Some(layout) = self.fit_layout(index) else {
            return MIN_LEN_REL * self.scale;
        };
        let (points, _, _) = split_params(self.params(&self.x0, index), layout);
        let mut len = 0.0;
        for i in 1..points.len() {
            len += (points[i][0] - points[i - 1][0]).hypot(points[i][1] - points[i - 1][1]);
        }
        len.max(MIN_LEN_REL * self.scale)
    }

    /// `|da| * |db|` for normalizing a cross or dot product of two direction
    /// vectors into a sine or cosine, floored so a collapsed line cannot
    /// divide by zero. The flag is false when the floor applied, i.e. the
    /// result no longer depends on the vectors.
    pub(super) fn norm_product(&self, da: P2, db: P2) -> (f64, bool) {
        let floor = (MIN_LEN_REL * self.scale).powi(2);
        let na = (da[0] * da[0] + da[1] * da[1]).sqrt();
        let nb = (db[0] * db[0] + db[1] * db[1]).sqrt();
        let prod = na * nb;
        (prod.max(floor), prod > floor)
    }

    /// `|d|` for normalizing one direction vector, floored like
    /// `norm_product`.
    pub(super) fn dir_norm(&self, d: P2) -> f64 {
        (d[0] * d[0] + d[1] * d[1])
            .sqrt()
            .max(MIN_LEN_REL * self.scale)
    }
}
