//! wasm-bindgen boundary. Compiled only for `wasm32`; native builds use
//! `api::solve_mate_bytes` directly. Kept deliberately thin: the contract,
//! codec, and numerics all live in plain-Rust modules so native `cargo test`
//! exercises the same code the browser runs.

use wasm_bindgen::prelude::*;

/// Solve an assembly from a flat `MateInput` buffer, returning a flat
/// `MateOutput` buffer. See `mate` for the byte layout.
///
/// The host (the anchor solver Worker) owns both buffers and times the call. A
/// malformed input buffer surfaces as a thrown JS error (a host bug); a
/// well-formed buffer always returns an output, with over/underconstrained
/// reported inside it.
#[wasm_bindgen]
pub fn solve_mate_bytes(input: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::api::solve_mate_bytes(input).map_err(|e| JsError::new(&format!("mate decode error: {e:?}")))
}

/// Live-drag variant of `solve_mate_bytes`: same solved pose, but skips the
/// dense rank/dof SVD so a per-frame drag tick does not pay for diagnostics it
/// discards. See `api::solve_mate_bytes_live`.
#[wasm_bindgen]
pub fn solve_mate_bytes_live(input: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::api::solve_mate_bytes_live(input).map_err(|e| JsError::new(&format!("mate decode error: {e:?}")))
}
