//! wasm-bindgen boundary. Compiled only for `wasm32`; native builds use
//! `api::solve_bytes` directly. Kept deliberately thin: the contract, codec,
//! and numerics all live in plain-Rust modules so native `cargo test` exercises
//! the same code the browser runs.

use wasm_bindgen::prelude::*;

/// Solve a sketch from a flat `Input` buffer, returning a flat `Output` buffer.
///
/// The host (the builder Worker) owns both buffers and times the call; see
/// `codec` for the byte layout. A malformed input buffer surfaces as a thrown
/// JS error (a host bug); a well-formed buffer always returns an output, with
/// over/underconstrained reported inside it.
#[wasm_bindgen]
pub fn solve_sketch_bytes(input: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::api::solve_bytes(input).map_err(|e| JsError::new(&format!("decode error: {e:?}")))
}
