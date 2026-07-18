//! Assembly mate solver crate.
//!
//! Split out of `sketch-solver` so the anchor solver Worker
//! (`kernel/worker/anchorSolverWorker.ts`) loads only this binary, and so the
//! mate wire format can version independently of the sketch one. The numerics
//! it shares with the sketch solver (the Levenberg-Marquardt driver, the sparse
//! Jacobian row, the byte cursors) live in `solver-core`; nothing sketch-shaped
//! is reachable from here.
//!
//! Design invariants carried over from the WASM kernel migration:
//!   - No JS callbacks during a solve; no OCC.js access. The crate does not
//!     know what a brep is.
//!   - Bodies are 7-param rigid transforms (translation + quaternion); mates
//!     constrain relative transforms by comparing anchor geometry in world
//!     space. See `mate.rs` for the buffer layout.

pub mod api;
pub mod codec;
pub mod mate;
pub mod mate_residuals;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use mate::{
    AnchorKind, Mate, MateDiagnostics, MateGeometry, MateInput, MateKind, MateOutput, MateRef,
    MateStatus, RigidBody,
};

pub use mate_residuals::solve_mate;
