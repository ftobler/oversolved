//! Sketch constraint solver crate.
//!
//! It comprises the flat typed-array I/O codec, the constraint residual
//! builders, the sketch area topology builder, and the rank / status /
//! per-entity-status / vertex-freedom analysis. The Levenberg-Marquardt driver
//! and the byte cursors it runs on are shared with the mate solver and live in
//! `solver-core`; the assembly mate solver itself is a separate crate
//! (`mate-solver`) compiled to its own wasm binary, so nothing here knows what
//! a mate is.
//!
//! Design invariants the implementation keeps:
//!   - No JS callbacks during a solve; no OCC.js access. The crate does not
//!     know what a brep is.
//!   - Projection is NOT modelled here. A projected entity is just an entity
//!     whose params are pinned (`pinned_mask` / `equality_pins`). Residual
//!     builders branch on geometric kind only (line/circle/arc/point), never on
//!     projected-ness.
//!   - `equality_pins` pin a param to an explicit target that is constraint
//!     payload, not x0 (which is what `pinned_mask` holds a param to).
//!   - `vertex_freedom` (per-entity null-space directions from the Jacobian
//!     SVD) is emitted as the seed for the frontend drag math, which does not
//!     consume it yet (see `solve::vertex_freedom`); the wire field stays so
//!     the layout does not churn.
//!   - `skip_status_pass` is the drag-mode escape hatch (no per-entity SVD).

pub mod api;
pub mod codec;
pub mod constraints;
/// The interpolating spline through N fit points (the `fit_spline` entity):
/// the solver, the area builder and the TS mirror all read this one algorithm.
pub(crate) mod fit_spline;
pub mod residuals;
pub mod solve;
#[cfg(test)]
pub mod test_util;
/// The resolution and the threshold ladder it feeds (see the module docs); the
/// two halves of the pipeline that consume it are `solve` and `topology`.
pub(crate) mod tolerance;
pub(crate) mod topology;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use constraints::{Axis, Constraint, ConstraintKind, PointSelector, Ref, RefRole};

/// Degrees->radians factor. Angle params are stored in degrees (the document's
/// arc-angle convention) and converted at use sites. The `radians`
/// helper keeps the multiply-then-divide grouping its call sites have always
/// used, so it is bit-identical to the conversions it replaces.
pub(crate) const DEG2RAD: f64 = std::f64::consts::PI / 180.0;

pub(crate) fn radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

/// Floor on the `semi-axis^2` an ellipse conic residual divides by.
///
/// A collapsed (or corrupt) semi-axis turns `u*u / (a*a)` into infinity or NaN,
/// and a single NaN row poisons the entire solve: every LM step from there on
/// is NaN and the sketch silently stops converging with no error anywhere.
/// Flooring the denominator keeps the row finite and very large, which pushes
/// the ellipse back out of the degeneracy instead. A NaN semi-axis floors too:
/// `f64::max` ignores the NaN operand (IEEE 754 maxNum semantics) and returns
/// the floor, so the row stays finite. Only a finite tiny axis and a NaN axis
/// reach the floor; an infinite axis squares to infinity and divides to zero.
pub(crate) const MIN_SEMI_AXIS_SQ: f64 = 1e-12;

/// Geometric entity kinds the solver understands: seven, the four primitives
/// (line, circle, arc, point) plus ellipse, the cubic Bezier spline, and the
/// interpolating fit spline. Projection is a pin-mask concern, not a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Line,
    Circle,
    Arc,
    Point,
    Ellipse,
    Spline,
    FitSpline,
}

impl Kind {
    /// Number of scalar params in the flat array for the fixed-size kinds.
    /// `fit_spline` is variable (`2 N + 2 h`), so its count rides the entity
    /// record instead; every call site reads `Entity::param_count`.
    /// Ellipse is `[cx, cy, a, b, theta]` where `a >= b >= 0` are the semi-major
    /// and semi-minor radii and `theta` is the major-axis rotation (degrees, to
    /// match the arc-angle convention; the residuals convert to radians).
    /// Spline is a cubic Bezier `[x1, y1, x2, y2, x3, y3, x4, y4]`: P1/P4 are the
    /// on-curve endpoints, P2/P3 the off-curve control points.
    pub fn fixed_param_count(self) -> Option<usize> {
        Some(match self {
            Kind::Line => 4,
            Kind::Circle => 3,
            Kind::Arc => 5,
            Kind::Point => 2,
            Kind::Ellipse => 5,
            Kind::Spline => 8,
            Kind::FitSpline => return None,
        })
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Kind::Line,
            1 => Kind::Circle,
            2 => Kind::Arc,
            3 => Kind::Point,
            4 => Kind::Ellipse,
            5 => Kind::Spline,
            6 => Kind::FitSpline,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Kind::Line => 0,
            Kind::Circle => 1,
            Kind::Arc => 2,
            Kind::Point => 3,
            Kind::Ellipse => 4,
            Kind::Spline => 5,
            Kind::FitSpline => 6,
        }
    }
}

/// One sketch entity: its kind, the offset into the flat param buffer, the
/// number of params it owns, and the per-kind flag bits (`fit_spline`'s end
/// handles). (The contract's `id_offset` into a separate id buffer is a TS-side
/// concern; the crate works in entity *indices* and never sees string ids.)
#[derive(Debug, Clone)]
pub struct Entity {
    pub kind: Kind,
    pub param_offset: usize,
    /// For a fixed-size kind this must equal `kind.fixed_param_count()`; the
    /// codec rejects a mismatch. `fit_spline` carries its own `2 N + 2 h`.
    pub param_count: usize,
    /// Kind-specific bits: `fit_spline` uses bit 0 for a start handle and bit 1
    /// for an end handle. Zero for every other kind.
    pub flags: u8,
}

impl Entity {
    /// A fixed-size entity with the canonical param count and no flags.
    pub fn new(kind: Kind, param_offset: usize) -> Self {
        Entity {
            kind,
            param_offset,
            param_count: kind.fixed_param_count().unwrap_or(0),
            flags: 0,
        }
    }
}

/// Pin a single param to an explicit target value (constraint payload), as
/// distinct from the `pinned_mask` "does not move from x0" semantics.
#[derive(Debug, Clone, Copy)]
pub struct EqualityPin {
    pub param_index: u32,
    pub target: f64,
}

/// Solve-time options. `drag_mode` + `skip_status_pass` drive the 60 Hz path.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    pub drag_mode: bool,
    pub drag_anchor_id: u32,
    pub skip_status_pass: bool,
}

/// Built from flat typed arrays handed across the WASM boundary (see `codec`).
#[derive(Debug, Clone, Default)]
pub struct Input {
    pub entities: Vec<Entity>,
    pub params_initial: Vec<f64>,
    /// One bit per param (LSB-first within each byte); 1 = pinned to its
    /// `params_initial` value.
    pub pinned_mask: Vec<u8>,
    pub equality_pins: Vec<EqualityPin>,
    pub constraints: Vec<Constraint>,
    pub options: Options,
}

impl Input {
    /// True when param `i` is pinned to its initial value by `pinned_mask`.
    pub fn is_pinned(&self, i: usize) -> bool {
        let byte = i / 8;
        let bit = i % 8;
        self.pinned_mask
            .get(byte)
            .map(|b| (b >> bit) & 1 == 1)
            .unwrap_or(false)
    }

    /// True when entity `index` exists AND its whole param block lies inside
    /// `params_initial`. Every read of an entity's params is unchecked slicing,
    /// so a stale index (or a `param_offset` from an older param layout) would
    /// panic the Worker; callers use this to drop the reference instead, the way
    /// a constraint with a missing role is dropped.
    pub fn entity_params_in_range(&self, index: usize) -> bool {
        match self.entities.get(index) {
            Some(e) => e
                .param_offset
                .checked_add(e.param_count)
                .is_some_and(|end| end <= self.params_initial.len()),
            None => false,
        }
    }
}

/// Per-entity and overall constraint status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    FullyConstrained,
    Underconstrained,
    Overconstrained,
}

impl Status {
    pub fn to_u8(self) -> u8 {
        match self {
            Status::FullyConstrained => 0,
            Status::Underconstrained => 1,
            Status::Overconstrained => 2,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Diagnostics {
    pub residual_norm: f64,
    pub rank: u32,
    pub dof: u32,
    pub iters: u32,
    pub ms: f64,
}

/// Bit values of `Output::constraint_flags`. One byte per input constraint, in
/// the order `Input::constraints` was sent, so the frontend can map a flag back
/// to the constraint id it authored.
///
/// A redundant constraint is a measurement, not a driver: every row of its
/// Jacobian already lies in the span of the earlier constraints', so removing
/// it changes nothing about the solution set. Blame lands on the LATER
/// constraint, matching "the constraint I just added".
pub const CONSTRAINT_FLAG_REDUNDANT: u8 = 1 << 0;

#[derive(Debug, Clone, Default)]
pub struct Output {
    pub params_solved: Vec<f64>,
    /// Per-entity status code (`Status::to_u8`); empty on the drag fast path and
    /// when `skip_status_pass` is set, since both skip the per-entity SVD.
    pub entity_status: Vec<u8>,
    pub overall_status: u8,
    /// Per-entity null-space directions for drag (Jacobian SVD), flattened as
    /// `[entity_count][dir_x, dir_y, ...]`. Empty on the drag fast path and
    /// when `skip_status_pass` is set.
    pub vertex_freedom: Vec<f64>,
    /// Per-constraint verdict bits (`CONSTRAINT_FLAG_*`), index-aligned with
    /// `Input::constraints` (dropped constraints included, flagged 0). Empty on
    /// the drag fast path: the walk is for cold solves, the drag budget is not.
    pub constraint_flags: Vec<u8>,
    /// Per-constraint miss as a fraction of the sketch scale, index-aligned with
    /// `Input::constraints` and with `constraint_flags` (the wire carries one
    /// count for both). One value per constraint: the largest single-row Newton
    /// step its rows imply (see `solve::constraint_miss`). All zeros on a
    /// satisfied solve; empty on the drag fast path.
    ///
    /// f64, not the f32 a diagnostic could afford: the wire's single scalar
    /// width is an invariant the repo greps for (no f32 on either codec), and
    /// the extra bytes are bounded by the constraint count.
    pub constraint_miss: Vec<f64>,
    pub diagnostics: Diagnostics,
}

/// Solve a sketch. See `solve::solve_sketch` for the orchestration.
pub fn solve_sketch(input: &Input) -> Output {
    solve::solve_sketch(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_counts_match_the_wire_entity_sizes() {
        assert_eq!(Kind::Line.fixed_param_count(), Some(4));
        assert_eq!(Kind::Circle.fixed_param_count(), Some(3));
        assert_eq!(Kind::Arc.fixed_param_count(), Some(5));
        assert_eq!(Kind::Point.fixed_param_count(), Some(2));
        assert_eq!(Kind::Ellipse.fixed_param_count(), Some(5));
        assert_eq!(Kind::Spline.fixed_param_count(), Some(8));
        assert_eq!(Kind::FitSpline.fixed_param_count(), None);
    }

    #[test]
    fn ellipse_kind_code_round_trips() {
        assert_eq!(Kind::from_u8(4), Some(Kind::Ellipse));
        assert_eq!(Kind::Ellipse.to_u8(), 4);
    }

    #[test]
    fn spline_kind_code_round_trips() {
        assert_eq!(Kind::from_u8(5), Some(Kind::Spline));
        assert_eq!(Kind::Spline.to_u8(), 5);
    }

    #[test]
    fn pinned_mask_reads_lsb_first() {
        let input = Input {
            pinned_mask: vec![0b0000_0101],
            ..Default::default()
        };
        assert!(input.is_pinned(0));
        assert!(!input.is_pinned(1));
        assert!(input.is_pinned(2));
        assert!(!input.is_pinned(8)); // out of range -> false
    }

    #[test]
    fn status_codes_match_the_wire() {
        assert_eq!(Status::FullyConstrained.to_u8(), 0);
        assert_eq!(Status::Underconstrained.to_u8(), 1);
        assert_eq!(Status::Overconstrained.to_u8(), 2);
    }

    #[test]
    fn all_kind_codes_round_trip() {
        let kinds = [
            Kind::Line,
            Kind::Circle,
            Kind::Arc,
            Kind::Point,
            Kind::Ellipse,
            Kind::Spline,
            Kind::FitSpline,
        ];
        for (code, kind) in kinds.iter().enumerate() {
            assert_eq!(kind.to_u8() as usize, code);
            assert_eq!(Kind::from_u8(code as u8), Some(*kind));
        }
        // Anything past the defined range is rejected.
        assert_eq!(Kind::from_u8(7), None);
        assert_eq!(Kind::from_u8(u8::MAX), None);
    }
}
