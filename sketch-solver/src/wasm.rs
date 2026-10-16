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

/// Run the area builder over an ordered `richGeom` payload and judge the result
/// with the invariant oracle, returning `[{class, reason, known, text}]`.
///
/// Behind the `fuzz` feature on purpose: the oracle is a test-time judge, so
/// the production WASM binary must not carry it, and only a node build made
/// with `-- --features fuzz` (what the repro test drives) exposes this export.
#[cfg(feature = "fuzz")]
#[wasm_bindgen]
pub fn check_topology_violations(input: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::topology::oracle::violations_json(input)
        .map_err(|e| JsError::new(&format!("oracle error: {e}")))
}

/// Run the sketch area builder (topology) from an ordered `richGeom` JSON
/// payload, returning the structural topology JSON the TS decorator consumes.
/// Separate from `solve_sketch_bytes`: topology and solve cross the boundary
/// independently. See `api::detect_topology_bytes`.
#[wasm_bindgen]
pub fn detect_topology_bytes(input: &[u8]) -> Result<Vec<u8>, JsError> {
    // "codec error", not "decode error": the topology encoder can also refuse
    // the output (non-finite computed coordinates), so this failure is not
    // necessarily about the buffer the host sent.
    crate::api::detect_topology_bytes(input)
        .map_err(|e| JsError::new(&format!("topology codec error: {e:?}")))
}
