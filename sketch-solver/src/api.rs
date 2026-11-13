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
    decode_payload as decode_topology_payload, encode_output as encode_topology_output,
    TopologyCodecError,
};
use crate::topology::detect_topology;

/// Human text for a panic payload, for the boundary error.
#[cfg(panic = "unwind")]
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

/// Run a boundary call, turning a panic into a named error where the build can
/// unwind.
///
/// `wasm32-unknown-unknown` is compiled with `panic = "abort"` (the target's
/// default and the only supported strategy on stable), so this is a
/// pass-through on the shipping target: there is no unwinding to catch, and a
/// panic still traps the module. The crate's part of that contract is therefore
/// input validation plus never panicking on a reachable path (see the topology
/// chain walk and the degenerate-radius gate in `solve`). The guard is real for
/// native/headless builds and any future unwind-enabled target, where it turns
/// a panic into the same plain error a malformed buffer produces, so a sketch
/// reads as a red feature instead of a kernel fault.
fn catch_panic<T>(what: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    #[cfg(panic = "unwind")]
    {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(result) => result,
            Err(payload) => Err(format!("{what} panicked: {}", panic_message(payload))),
        }
    }
    #[cfg(not(panic = "unwind"))]
    {
        // No unwinding exists to catch; keep the parameter meaningful so the
        // abort build compiles without an unused-variable warning.
        let _ = what;
        f()
    }
}

/// [`solve_bytes`] with the boundary guard above wrapping it.
pub fn solve_bytes_guarded(input: &[u8]) -> Result<Vec<u8>, String> {
    catch_panic("sketch solve", || {
        solve_bytes(input).map_err(|e| format!("decode error: {e:?}"))
    })
}

/// [`detect_topology_bytes`] with the boundary guard above wrapping it.
pub fn detect_topology_bytes_guarded(input: &[u8]) -> Result<Vec<u8>, String> {
    catch_panic("sketch topology", || {
        detect_topology_bytes(input).map_err(|e| format!("topology codec error: {e}"))
    })
}

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
    let decoded = decode_topology_payload(input)?;
    let out = detect_topology(&decoded.entities, &decoded.contacts);
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
            entities: vec![Entity::new(Kind::Line, 0)],
            params_initial: vec![0.2, -0.1, 9.5, 0.8],
            params_reference: Vec::new(),
            pinned_mask: Vec::new(),
            equality_pins: Vec::new(),
            constraints: vec![fixed_start, horizontal, length],
            seed_quantum: 0.0,
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
            entities: vec![Entity::new(Kind::Line, 0)],
            params_initial: vec![0.0, 0.0, 9.5, 0.8],
            params_reference: Vec::new(),
            pinned_mask: Vec::new(),
            equality_pins: Vec::new(),
            constraints: vec![stale, horizontal],
            seed_quantum: 0.0,
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

    #[test]
    fn the_guarded_boundary_reports_a_decode_failure_as_a_plain_error() {
        // The wasm wrappers call the guarded forms. A malformed buffer must
        // produce the same named error they throw, not a trap (or a panic).
        let err = solve_bytes_guarded(&[0, 1, 2, 3]).expect_err("garbage must be refused");
        assert!(err.contains("decode error"), "{err}");
        let err =
            detect_topology_bytes_guarded(&[0, 1, 2, 3]).expect_err("garbage must be refused");
        assert!(err.contains("topology codec error"), "{err}");
    }

    #[cfg(panic = "unwind")]
    #[test]
    fn the_guarded_boundary_turns_a_panic_into_a_plain_error() {
        // Only a build that unwinds can catch. The native test gate runs with
        // the default unwind strategy, so this pins the guard the wasm target
        // cannot provide (see `catch_panic`).
        let err = catch_panic::<()>("probe", || panic!("boom")).expect_err("panic must be caught");
        assert!(err.contains("probe panicked"), "{err}");
        assert!(err.contains("boom"), "{err}");
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
