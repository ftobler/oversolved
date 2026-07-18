//! Byte-level mate solve entry point: the single function the WASM boundary and
//! any headless (Node/CLI) runner call.
//!
//! `solve_mate_bytes` is plain Rust with no wasm-bindgen dependency so native
//! `cargo test` exercises the exact same path the browser will. The thin
//! `#[wasm_bindgen]` wrapper lives in `wasm.rs` (compiled only for wasm32) and
//! delegates here.

use crate::codec::CodecError;
use crate::mate::{decode_mate_input, encode_mate_output};
use crate::mate_residuals::solve_mate;

/// Decode a flat `MateInput` buffer, solve the assembly, and encode the flat
/// `MateOutput` buffer. The mate solver uses the same LM driver as the sketch
/// solver (`solver_core::lm`) but operates on 3D rigid-body transforms (7
/// params per body).
///
/// Errors are limited to malformed input (a host bug, since the host built the
/// buffer); a valid buffer always produces a valid output, even when the
/// assembly is over/underconstrained (that is reported in the output's status,
/// not as an error).
pub fn solve_mate_bytes(input: &[u8]) -> Result<Vec<u8>, CodecError> {
    let inp = decode_mate_input(input)?;
    let out = solve_mate(&inp);
    Ok(encode_mate_output(&out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mate::{
        decode_mate_output, encode_mate_input, AnchorKind, Mate, MateGeometry, MateInput,
        MateKind, MateRef, RigidBody,
    };

    #[test]
    fn solve_mate_bytes_round_trips_spherical() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![Mate {
                kind: MateKind::Spherical,
                a: MateRef {
                    body_index: 0,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0],
                    },
                    anchor_kind: AnchorKind::Point,
                },
                b: MateRef {
                    body_index: 1,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0],
                    },
                    anchor_kind: AnchorKind::Point,
                },
                flip: false,
                offset: 0.0,
                ratio: 1.0,
                radius: 0.0,
                angle: 0.0,
            }],
        };
        let bytes = encode_mate_input(&input);
        let out_bytes = solve_mate_bytes(&bytes).expect("solve mate");
        let out = decode_mate_output(&out_bytes).expect("decode output");
        assert!(out.params_solved[7].abs() < 1e-2);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn solve_mate_bytes_rejects_bad_input() {
        assert!(solve_mate_bytes(&[0, 1, 2, 3]).is_err());
    }

    #[test]
    fn solve_mate_bytes_rejects_sketch_magic() {
        // The sketch input magic ("SKS1", sketch-solver/src/codec.rs MAGIC),
        // spelled out rather than imported: the crates are deliberately
        // independent, and this guard is about the byte value on the wire. If
        // the sketch crate ever changes its magic, the two formats stay
        // mutually unreadable either way -- that is the property under test.
        const SKETCH_MAGIC: u32 = 0x5347_4B53;
        let mut sketch_bytes = SKETCH_MAGIC.to_le_bytes().to_vec();
        sketch_bytes.extend_from_slice(&[0u8; 32]);  // plausible header padding
        assert!(solve_mate_bytes(&sketch_bytes).is_err());
    }
}
