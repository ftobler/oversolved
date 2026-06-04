//! Sketch constraint solver crate (WASM kernel migration, phase 1).
//!
//! SKELETON ONLY. This file pins the input/output contract from
//! `feature/wasm-kernel-migration.md` ("Crate boundary" and "Projections")
//! and a stub `solve_sketch` so the toolchain (native + wasm32) builds green
//! before any numerics land. There is no solver here yet.
//!
//! Design invariants the real implementation must keep (from the plan):
//!   - No JS callbacks during a solve; no OCC.js access. The crate does not
//!     know what a brep is.
//!   - Projection is NOT modelled here. A projected entity is just an entity
//!     whose params are bit-set in `pinned_mask`. Residual builders branch on
//!     geometric kind only (line/circle/arc/point), never on projected-ness.
//!   - `equality_pins` carries `_residual_fixed` mode 3 (pin a param to an
//!     explicit user (x, y) target that is constraint payload, not x0).
//!   - `vertex_freedom` (per-entity null-space directions from the Jacobian
//!     SVD) must be emitted; the frontend drag math consumes it.
//!   - `skip_status_pass` is the drag-mode escape hatch (no per-entity SVD).

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
}

/// One sketch entity: its kind plus offsets into the flat id/param buffers.
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

/// Built from flat typed arrays handed across the WASM boundary. Phase 1 adds a
/// zero-copy decoder; the skeleton keeps owned Vecs for clarity.
#[derive(Debug, Clone, Default)]
pub struct Input {
    pub entities: Vec<Entity>,
    pub params_initial: Vec<f32>,
    /// One bit per param; 1 = pinned to its `params_initial` value.
    pub pinned_mask: Vec<u8>,
    pub equality_pins: Vec<EqualityPin>,
    pub options: Options,
    // Constraints are deliberately omitted from the skeleton: their flat
    // encoding (one arm per kind) lands with the residual builders in phase 1.
}

/// Per-entity and overall constraint status (mirrors the Python solver strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    FullyConstrained,
    Underconstrained,
    Overconstrained,
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
    /// Per-entity; empty when `options.skip_status_pass`.
    pub entity_status: Vec<u8>,
    pub overall_status: u8,
    /// Per-entity null-space directions for drag (Jacobian SVD). Empty in stub.
    pub vertex_freedom: Vec<f32>,
    pub diagnostics: Diagnostics,
}

/// STUB. Echoes `params_initial` into `params_solved` so the pipeline is
/// exercisable end to end. Phase 1 replaces this body with the LM driver.
pub fn solve_sketch(input: &Input) -> Output {
    Output {
        params_solved: input.params_initial.clone(),
        entity_status: Vec::new(),
        overall_status: Status::Underconstrained as u8,
        vertex_freedom: Vec::new(),
        diagnostics: Diagnostics::default(),
    }
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
    fn stub_solve_is_identity_on_params() {
        let input = Input {
            entities: vec![Entity { kind: Kind::Line, param_offset: 0 }],
            params_initial: vec![0.0, 0.0, 1.0, 0.0],
            pinned_mask: vec![0],
            equality_pins: Vec::new(),
            options: Options::default(),
        };
        let out = solve_sketch(&input);
        assert_eq!(out.params_solved, input.params_initial);
    }
}
