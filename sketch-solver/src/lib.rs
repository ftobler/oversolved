//! Sketch constraint solver crate (WASM kernel migration, phase 1).
//!
//! Phase 1.0 vertical slice: the flat typed-array I/O codec, the constraint
//! residual builders ported from `solver_residuals.py`, a hand-rolled
//! Levenberg-Marquardt driver with a 3-point finite-difference Jacobian, and the
//! rank / status / per-entity-status / vertex-freedom analysis ported from
//! `solver.py`. It is correct on the trivial sketches the unit tests cover; it is
//! deliberately *not* optimized (no analytic Jacobian, no zero-copy decode, no
//! drag fast-path) and is not yet wired across the wasm-bindgen boundary.
//!
//! Design invariants the implementation keeps (from `feature/wasm-kernel-migration.md`):
//!   - No JS callbacks during a solve; no OCC.js access. The crate does not
//!     know what a brep is.
//!   - Projection is NOT modelled here. A projected entity is just an entity
//!     whose params are pinned (`pinned_mask` / `equality_pins`). Residual
//!     builders branch on geometric kind only (line/circle/arc/point), never on
//!     projected-ness.
//!   - `equality_pins` carries `_residual_fixed` mode 3 (pin a param to an
//!     explicit user (x, y) target that is constraint payload, not x0).
//!   - `vertex_freedom` (per-entity null-space directions from the Jacobian
//!     SVD) is emitted; the frontend drag math consumes it.
//!   - `skip_status_pass` is the drag-mode escape hatch (no per-entity SVD).

pub mod api;
pub mod codec;
pub mod constraints;
pub mod lm;
pub mod residuals;
pub mod solve;
pub mod sparse;
#[cfg(test)]
pub mod test_util;
pub mod topology;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use constraints::{Axis, Constraint, ConstraintKind, PointSelector, Ref, RefRole};

/// Geometric entity kinds the solver understands. Post kind-collapse (phase
/// 0.5) there are exactly four; projection is a pin-mask concern, not a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Line,
    Circle,
    Arc,
    Point,
    Ellipse,
    Spline,
}

impl Kind {
    /// Number of scalar params in the flat array (mirrors backend ENTITY_SIZES).
    /// Ellipse is `[cx, cy, a, b, theta]` where `a >= b >= 0` are the semi-major
    /// and semi-minor radii and `theta` is the major-axis rotation (degrees, to
    /// match the arc-angle convention; the residuals convert to radians).
    /// Spline is a cubic Bezier `[x1, y1, x2, y2, x3, y3, x4, y4]`: P1/P4 are the
    /// on-curve endpoints, P2/P3 the off-curve control points.
    pub fn param_count(self) -> usize {
        match self {
            Kind::Line => 4,
            Kind::Circle => 3,
            Kind::Arc => 5,
            Kind::Point => 2,
            Kind::Ellipse => 5,
            Kind::Spline => 8,
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Kind::Line,
            1 => Kind::Circle,
            2 => Kind::Arc,
            3 => Kind::Point,
            4 => Kind::Ellipse,
            5 => Kind::Spline,
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
        }
    }
}

/// One sketch entity: its kind plus the offset into the flat param buffer.
/// (The contract's `id_offset` into a separate id buffer is a TS-side concern;
/// the crate works in entity *indices* and never sees string ids.)
#[derive(Debug, Clone)]
pub struct Entity {
    pub kind: Kind,
    pub param_offset: usize,
}

/// Pin a single param to an explicit target value (constraint payload), as
/// distinct from the `pinned_mask` "does not move from x0" semantics.
#[derive(Debug, Clone, Copy)]
pub struct EqualityPin {
    pub param_index: u32,
    pub target: f32,
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
    pub params_initial: Vec<f32>,
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

    /// Count of params pinned by `pinned_mask` over `[0, n_params)`. Bits beyond
    /// the param range are ignored so a slack-padded mask byte never over-counts.
    pub fn pinned_mask_bit_count(&self, n_params: usize) -> usize {
        (0..n_params).filter(|&i| self.is_pinned(i)).count()
    }
}

/// Per-entity and overall constraint status (mirrors the Python solver strings).
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

#[derive(Debug, Clone, Default)]
pub struct Output {
    pub params_solved: Vec<f32>,
    /// Per-entity status code (`Status::to_u8`); empty when `skip_status_pass`.
    pub entity_status: Vec<u8>,
    pub overall_status: u8,
    /// Per-entity null-space directions for drag (Jacobian SVD), flattened as
    /// `[entity_count][dir_x, dir_y, ...]`. Empty when `skip_status_pass`.
    pub vertex_freedom: Vec<f32>,
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
    fn param_counts_match_backend_entity_sizes() {
        assert_eq!(Kind::Line.param_count(), 4);
        assert_eq!(Kind::Circle.param_count(), 3);
        assert_eq!(Kind::Arc.param_count(), 5);
        assert_eq!(Kind::Point.param_count(), 2);
        assert_eq!(Kind::Ellipse.param_count(), 5);
        assert_eq!(Kind::Spline.param_count(), 8);
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
    fn pinned_mask_bit_count_counts_set_bits_in_range() {
        let input = Input {
            pinned_mask: vec![0b0000_0101],
            ..Default::default()
        };
        // bits 0 and 2 set within the first three params.
        assert_eq!(input.pinned_mask_bit_count(3), 2);
    }

    #[test]
    fn pinned_mask_bit_count_ignores_bits_beyond_n_params() {
        // A slack-padded byte: bits 0, 5, 6, 7 are set but only the first two
        // params exist. The doc contract says the high bits must not be counted.
        let input = Input {
            pinned_mask: vec![0b1110_0001],
            ..Default::default()
        };
        assert_eq!(input.pinned_mask_bit_count(2), 1);
    }

    #[test]
    fn pinned_mask_bit_count_spans_multiple_bytes() {
        // bit 0 in byte 0, bit 1 (param 9) in byte 1 -> two pinned params.
        let input = Input {
            pinned_mask: vec![0b0000_0001, 0b0000_0010],
            ..Default::default()
        };
        assert_eq!(input.pinned_mask_bit_count(10), 2);
        // Narrowing n_params past the second byte's bit drops it again.
        assert_eq!(input.pinned_mask_bit_count(9), 1);
    }

    #[test]
    fn pinned_mask_bit_count_zero_params_is_zero() {
        let input = Input {
            pinned_mask: vec![0b1111_1111],
            ..Default::default()
        };
        assert_eq!(input.pinned_mask_bit_count(0), 0);
    }

    #[test]
    fn status_codes_match_backend() {
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
        ];
        for (code, kind) in kinds.iter().enumerate() {
            assert_eq!(kind.to_u8() as usize, code);
            assert_eq!(Kind::from_u8(code as u8), Some(*kind));
        }
        // Anything past the defined range is rejected.
        assert_eq!(Kind::from_u8(6), None);
        assert_eq!(Kind::from_u8(u8::MAX), None);
    }
}
