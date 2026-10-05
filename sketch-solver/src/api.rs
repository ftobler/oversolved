//! Byte-level solve entry point: the single function the WASM boundary and any
//! headless (Node/CLI) runner call.
//!
//! `solve_bytes` is plain Rust with no wasm-bindgen dependency so native
//! `cargo test` exercises the exact same path the browser will. The thin
//! `#[wasm_bindgen]` wrapper lives in `wasm.rs` (compiled only for wasm32) and
//! delegates here.

use crate::codec::{decode_input, encode_output, CodecError};
use crate::solve::solve_sketch;
use crate::topology::codec::{
    decode_input as decode_topology_input, encode_output as encode_topology_output,
    TopologyCodecError,
};
use crate::topology::detect_topology;

/// Decode a flat `Input` buffer, solve, and encode the flat `Output` buffer.
///
/// Errors are limited to malformed input (a host bug, since the host built the
/// buffer); a valid buffer always produces a valid output, even when the sketch
/// itself is over/underconstrained (that is reported in the output's status,
/// not as an error).
pub fn solve_bytes(input: &[u8]) -> Result<Vec<u8>, CodecError> {
    let inp = decode_input(input)?;
    let out = solve_sketch(&inp);
    Ok(encode_output(&out))
}

/// Decode an ordered `richGeom` payload, run the sketch area builder (topology),
/// and encode the structural `TopologyOut` as JSON for the TS decorator.
///
/// This is the topology twin of `solve_bytes`: plain Rust (no wasm-bindgen) so
/// native `cargo test` exercises the exact path the browser runs. Kept separate
/// from the solve so the two stay independently testable.
pub fn detect_topology_bytes(input: &[u8]) -> Result<Vec<u8>, TopologyCodecError> {
    let geometry = decode_topology_input(input)?;
    let out = detect_topology(&geometry);
    encode_topology_output(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_output, encode_input};
    use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
    use crate::{Entity, Input, Kind, Options, Status};

    #[test]
    fn solve_bytes_round_trips_a_fixed_horizontal_length_line() {
        let fixed_start = Constraint {
            kind_code: ConstraintKind::Fixed.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Start,
                },
            )],
            xy: Some((0.0, 0.0)),
            ..Default::default()
        };
        let horizontal = Constraint {
            kind_code: ConstraintKind::Horizontal.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            )],
            ..Default::default()
        };
        let length = Constraint {
            kind_code: ConstraintKind::Length.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            )],
            value: Some(10.0),
            ..Default::default()
        };

        let input = Input {
            entities: vec![Entity {
                kind: Kind::Line,
                param_offset: 0,
            }],
            params_initial: vec![0.2, -0.1, 9.5, 0.8],
            pinned_mask: Vec::new(),
            equality_pins: Vec::new(),
            constraints: vec![fixed_start, horizontal, length],
            options: Options::default(),
        };

        let out_bytes = solve_bytes(&encode_input(&input)).expect("solve");
        let out = decode_output(&out_bytes).expect("decode output");

        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        assert_eq!(out.params_solved.len(), 4);
        assert!((out.params_solved[2] - 10.0).abs() < 1e-3);
        assert!(out.params_solved[3].abs() < 1e-3);
    }

    #[test]
    fn solve_bytes_survives_a_stale_entity_index_on_the_wire() {
        // The full byte path over a buffer that decodes cleanly but references
        // an entity that is not there: the Worker must answer with a normal
        // output instead of trapping, since it cannot ask the host to re-send.
        let stale = Constraint {
            kind_code: ConstraintKind::Length.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 9,
                    point: PointSelector::Absent,
                },
            )],
            value: Some(10.0),
            ..Default::default()
        };
        let horizontal = Constraint {
            kind_code: ConstraintKind::Horizontal.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            )],
            ..Default::default()
        };
        let input = Input {
            entities: vec![Entity {
                kind: Kind::Line,
                param_offset: 0,
            }],
            params_initial: vec![0.0, 0.0, 9.5, 0.8],
            pinned_mask: Vec::new(),
            equality_pins: Vec::new(),
            constraints: vec![stale, horizontal],
            options: Options::default(),
        };

        let out = decode_output(&solve_bytes(&encode_input(&input)).expect("solve"))
            .expect("decode output");
        assert_eq!(out.params_solved.len(), 4);
        // The surviving horizontal constraint still did its work.
        assert!((out.params_solved[1] - out.params_solved[3]).abs() < 1e-3);
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    }

    #[test]
    fn solve_bytes_rejects_garbage() {
        assert!(solve_bytes(&[0, 1, 2, 3]).is_err());
    }

    // detect_topology_bytes is the topology twin of solve_bytes and the exact
    // entry the WASM/Node boundary calls. The codec module tests decode/encode
    // in isolation; these exercise the full byte-in/byte-out wiring once.
    #[test]
    fn detect_topology_bytes_round_trips_a_square() {
        let input = serde_json::json!([
            ["a", {"start": [0.0, 0.0], "end": [2.0, 0.0]}],
            ["b", {"start": [2.0, 0.0], "end": [2.0, 2.0]}],
            ["c", {"start": [2.0, 2.0], "end": [0.0, 2.0]}],
            ["d", {"start": [0.0, 2.0], "end": [0.0, 0.0]}],
        ]);
        let bytes = serde_json::to_vec(&input).expect("encode input");

        let out_bytes = detect_topology_bytes(&bytes).expect("detect topology");
        let v: serde_json::Value = serde_json::from_slice(&out_bytes).expect("decode output");

        assert_eq!(v["surfaces"].as_array().unwrap().len(), 1);
        assert_eq!(v["edges"].as_array().unwrap().len(), 4);
        assert_eq!(v["edges"][0]["kind"], serde_json::json!("line"));
    }

    #[test]
    fn detect_topology_bytes_rejects_garbage() {
        assert!(detect_topology_bytes(&[0, 1, 2, 3]).is_err());
    }
}
