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

pub mod codec;
pub mod constraints;
pub mod lm;
pub mod residuals;
pub mod solve;

pub use constraints::{Axis, Constraint, ConstraintKind, PointSelector, Ref, RefRole};

/// Geometric entity kinds the solver understands. Post kind-collapse (phase
/// 0.5) there are exactly four; projection is a pin-mask concern, not a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Line,
    Circle,
    Arc,
    Point,
}

impl Kind {
    /// Number of scalar params in the flat array (mirrors backend ENTITY_SIZES).
    pub fn param_count(self) -> usize {
        match self {
            Kind::Line => 4,
            Kind::Circle => 3,
            Kind::Arc => 5,
            Kind::Point => 2,
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Kind::Line,
            1 => Kind::Circle,
            2 => Kind::Arc,
            3 => Kind::Point,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Kind::Line => 0,
            Kind::Circle => 1,
            Kind::Arc => 2,
            Kind::Point => 3,
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
}
