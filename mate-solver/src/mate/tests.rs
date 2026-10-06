//! Wire-codec and geometry tests for the mate types. Moved out of
//! `mate.rs` unchanged aside from the indentation and the fixture path.

use super::*;

/// The shared wire fixture (tests/fixtures/mate_wire.txt), read by both the
/// Rust and TS wire tests so a stride or magic change cannot pass without a
/// matching edit in one visible place. Values may be decimal or `0x` hex.
fn fixture_u64(key: &str) -> u64 {
    let text = include_str!("../../../tests/fixtures/mate_wire.txt");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if k.trim() != key {
            continue;
        }
        let v = v.trim();
        return if let Some(hex) = v.strip_prefix("0x") {
            u64::from_str_radix(hex, 16).expect("hex fixture value")
        } else {
            v.parse().expect("decimal fixture value")
        };
    }
    panic!("tests/fixtures/mate_wire.txt has no key `{key}`");
}

fn mate_geom(ax: f64, ay: f64, az: f64) -> MateGeometry {
    MateGeometry {
        point: [0.0, 0.0, 0.0],
        axis: [ax, ay, az],
        // The canonical perp of +Z, the axis every helper here uses.
        perp: [0.0, 1.0, 0.0],
    }
}

fn sample_input() -> MateInput {
    let params: Vec<f32> = vec![
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity
        5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: translated +x
    ];
    let mate = Mate {
        kind: MateKind::Spherical,
        a: MateRef {
            body_index: 0,
            geometry: mate_geom(0.0, 0.0, 1.0),
            anchor_kind: AnchorKind::Point,
        },
        b: MateRef {
            body_index: 1,
            geometry: mate_geom(0.0, 0.0, 1.0),
            anchor_kind: AnchorKind::Point,
        },
        flip: false,
        offset: [0.0; 3],
        ratio: 1.0,
        radius: 0.0,
        angle: 0.0,
        weight: 1.0,
    };
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: params,
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate],
    }
}

#[test]
fn mate_input_round_trips() {
    // A distinct B perp, not the shared +Z default: a transposition of
    // perp_a/perp_b in the encoder would read back as identical otherwise.
    let mut input = sample_input();
    input.mates[0].b.geometry.perp = [1.0, 0.0, 0.0];
    let bytes = encode_mate_input(&input);
    let decoded = decode_mate_input(&bytes).expect("decode");
    assert_eq!(decoded.bodies.len(), 2);
    assert_eq!(decoded.params_initial.len(), 14);
    assert_eq!(decoded.mates.len(), 1);
    assert_eq!(decoded.params_initial[7], 5.0);
    assert_eq!(decoded.mates[0].kind, MateKind::Spherical);
    assert_eq!(decoded.mates[0].a.body_index, 0);
    assert_eq!(decoded.mates[0].b.body_index, 1);
    assert!(!decoded.mates[0].flip);
    assert_eq!(decoded.mates[0].a.geometry.perp, [0.0, 1.0, 0.0]);
    assert_eq!(decoded.mates[0].b.geometry.perp, [1.0, 0.0, 0.0]);
    assert!(decoded.is_fixed(0));
    assert!(!decoded.is_fixed(1));
    assert_eq!(encode_mate_input(&decoded), bytes);
}

#[test]
fn body_index_past_the_body_table_decodes_verbatim() {
    // Referential validity is not a wire property: a mate naming body 9 in a
    // two-body assembly is a well-formed 112-byte record, so decode keeps it
    // and `MateProblem::new` is what drops it.
    let mut input = sample_input();
    input.mates[0].b.body_index = 9;
    let decoded = decode_mate_input(&encode_mate_input(&input)).expect("decode");
    assert_eq!(decoded.bodies.len(), 2);
    assert_eq!(decoded.mates[0].b.body_index, 9);
}

#[test]
fn mate_output_round_trips() {
    let out = MateOutput {
        params_solved: vec![0.0; 14],
        overall_status: MateStatus::FullyConstrained.to_u8(),
        mate_residuals: vec![1.5e-7, 2.0e-6],
        diagnostics: MateDiagnostics {
            residual_norm: 1e-9,
            rank: 13,
            dof: 1,
            iters: 5,
            ms: 0.1,
        },
    };
    let decoded = decode_mate_output(&encode_mate_output(&out)).expect("decode");
    assert_eq!(decoded.diagnostics.rank, 13);
    assert_eq!(decoded.diagnostics.iters, 5);
    assert_eq!(decoded.mate_residuals, vec![1.5e-7, 2.0e-6]);
}

#[test]
fn mate_input_bad_magic_rejected() {
    let mut bytes = encode_mate_input(&sample_input());
    bytes[0] ^= 0xff;
    assert!(matches!(
        decode_mate_input(&bytes),
        Err(CodecError::BadMagic)
    ));
}

#[test]
fn mate_output_bad_magic_rejected() {
    let out = MateOutput {
        params_solved: vec![0.0; 7],
        overall_status: 0,
        mate_residuals: vec![],
        diagnostics: MateDiagnostics::default(),
    };
    let mut bytes = encode_mate_output(&out);
    bytes[0] ^= 0xff;
    assert!(matches!(
        decode_mate_output(&bytes),
        Err(CodecError::BadMagic)
    ));
}

#[test]
fn mate_input_bad_kind_rejected() {
    let mut bytes = encode_mate_input(&sample_input());
    // In the 112-byte record, kind_code is at offset:
    // header(20) + bodies(8) + params_initial(56) + fixed_mask(1) = 85
    // + kind_code is first byte of mate record
    bytes[85] = 0xff; // kind_code in first mate record
    assert!(matches!(
        decode_mate_input(&bytes),
        Err(CodecError::BadKind(_))
    ));
}

// A buffer built to the pre-offset-vector 104-byte stride (a scalar offset
// f32 where the current record carries a 3-component vector, 8 bytes
// shorter) must fail loudly rather than silently reading ratio/radius/angle
// out of the shifted positions -- there is only one mate here, so the
// missing bytes run the reader off the end of the buffer. The encoder and
// the TS side move in lockstep or not at all.
#[test]
fn mate_input_old_104_byte_stride_rejected() {
    let bytes = encode_mate_input(&sample_input());
    let truncated = &bytes[..bytes.len() - 8];
    assert!(matches!(
        decode_mate_input(truncated),
        Err(CodecError::UnexpectedEof)
    ));
}

// The other overrun direction: bytes beyond the declared layout are
// surplus, not corruption. The reader consumes exactly the declared counts
// and never demands EOF (the cursor has no is-empty check), so padding
// after the last mate record decodes to the identical input.
#[test]
fn mate_input_trailing_bytes_beyond_the_declared_layout_are_ignored() {
    let mut longer = encode_mate_input(&sample_input());
    longer.extend_from_slice(&[0xABu8; 16]);
    let decoded = decode_mate_input(&longer).expect("trailing bytes are surplus");
    assert_eq!(decoded.mates.len(), 1);
    assert_eq!(decoded.params_initial, sample_input().params_initial);
    assert_eq!(decoded.mates[0].kind, sample_input().mates[0].kind);
}

#[test]
fn mate_input_param_count_must_match_body_count() {
    // n_bodies sits right after the magic. Claiming three bodies over a
    // two-body param buffer is exactly the header corruption that would let
    // a per-body loop read past the end of params_initial.
    let mut bytes = encode_mate_input(&sample_input());
    bytes[4..8].copy_from_slice(&3u32.to_le_bytes());
    assert!(matches!(
        decode_mate_input(&bytes),
        Err(CodecError::ParamCountMismatch)
    ));
}

#[test]
fn mate_input_body_count_that_wraps_seven_is_rejected_not_panic() {
    // 613_566_757 * 7 = 4_294_967_299, which wraps to 3 in u32 arithmetic:
    // the crafted pair would have passed the old unchecked multiply on
    // wasm32 (and panicked on it in debug). The check must be overflow
    // proof in both profiles; the header-only buffer is enough because the
    // count gate fires before any body or param read.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&MATE_MAGIC.to_le_bytes());
    bytes.extend_from_slice(&613_566_757u32.to_le_bytes()); // n_bodies
    bytes.extend_from_slice(&3u32.to_le_bytes()); // n_params: wraps onto it
    bytes.extend_from_slice(&0u32.to_le_bytes()); // n_mates
    bytes.extend_from_slice(&0u32.to_le_bytes()); // n_fixed_bodies
    assert!(matches!(
        decode_mate_input(&bytes),
        Err(CodecError::ParamCountMismatch)
    ));
}

#[test]
fn mate_input_truncated_is_eof() {
    let bytes = encode_mate_input(&sample_input());
    assert!(matches!(
        decode_mate_input(&bytes[..bytes.len() - 1]),
        Err(CodecError::UnexpectedEof)
    ));
}

#[test]
fn corrupt_mate_count_stays_eof_instead_of_reserving_the_heap() {
    // n_mates sits at byte 12. A corrupt count must fail on the first short
    // record read rather than pre-allocating a mate array of that size,
    // which aborts the process on wasm32 instead of returning an error.
    let mut bytes = encode_mate_input(&sample_input());
    bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(
        decode_mate_input(&bytes),
        Err(CodecError::UnexpectedEof)
    ));
}

#[test]
fn parallel_mate_with_flip_round_trips() {
    let input = MateInput {
        bodies: vec![RigidBody, RigidBody],
        params_initial: vec![0.0; 14],
        fixed_mask: vec![0],
        mates: vec![Mate {
            kind: MateKind::Parallel,
            a: MateRef {
                body_index: 0,
                geometry: mate_geom(0.0, 0.0, 1.0),
                anchor_kind: AnchorKind::Plane,
            },
            b: MateRef {
                body_index: 1,
                geometry: mate_geom(0.0, 0.0, -1.0),
                anchor_kind: AnchorKind::Plane,
            },
            flip: true,
            offset: [0.0; 3],
            ratio: 1.0,
            radius: 0.0,
            angle: 0.0,
            weight: 1.0,
        }],
    };
    let decoded = decode_mate_input(&encode_mate_input(&input)).expect("decode");
    assert_eq!(decoded.mates[0].kind, MateKind::Parallel);
    assert!(decoded.mates[0].flip);
}

#[test]
fn kind_codes_round_trip() {
    assert_eq!(MateKind::from_u8(0), Some(MateKind::Fixed));
    assert_eq!(MateKind::from_u8(1), Some(MateKind::Spherical));
    assert_eq!(MateKind::from_u8(2), Some(MateKind::Parallel));
    assert_eq!(MateKind::from_u8(3), Some(MateKind::Sliding));
    assert_eq!(MateKind::from_u8(4), Some(MateKind::Rotating));
    assert_eq!(MateKind::from_u8(5), Some(MateKind::SlidingRotating));
    assert_eq!(MateKind::from_u8(6), Some(MateKind::Tangential));
    assert_eq!(MateKind::from_u8(7), Some(MateKind::CopyRotation));
    assert_eq!(MateKind::from_u8(8), Some(MateKind::ParallelPlaneDistance));
    assert_eq!(MateKind::from_u8(9), None);
    assert_eq!(MateKind::Fixed.to_u8(), 0);
    assert_eq!(MateKind::ParallelPlaneDistance.to_u8(), 8);
}

#[test]
fn offset_ratio_radius_round_trip() {
    let input = MateInput {
        bodies: vec![RigidBody, RigidBody],
        params_initial: vec![0.0; 14],
        fixed_mask: vec![0],
        mates: vec![Mate {
            kind: MateKind::Tangential,
            a: MateRef {
                body_index: 0,
                geometry: mate_geom(0.0, 0.0, 1.0),
                anchor_kind: AnchorKind::Plane,
            },
            b: MateRef {
                body_index: 1,
                geometry: mate_geom(0.0, 1.0, 0.0),
                anchor_kind: AnchorKind::Cylinder,
            },
            flip: false,
            offset: [1.5, -2.5, 4.25],
            ratio: 2.0,
            radius: 3.0,
            angle: 0.7,
            weight: 1.0,
        }],
    };
    let decoded = decode_mate_input(&encode_mate_input(&input)).expect("decode");
    let m = &decoded.mates[0];
    // All three offset components survive, and ratio/radius/angle read back
    // from their shifted positions rather than out of the offset tail.
    assert!((m.offset[0] - 1.5).abs() < 1e-4);
    assert!((m.offset[1] - (-2.5)).abs() < 1e-4);
    assert!((m.offset[2] - 4.25).abs() < 1e-4);
    assert!((m.ratio - 2.0).abs() < 1e-4);
    assert!((m.radius - 3.0).abs() < 1e-4);
    assert!((m.angle - 0.7).abs() < 1e-4);
    // The perps ride after angle and survive the round trip.
    assert_eq!(m.a.geometry.perp, [0.0, 1.0, 0.0]);
    assert_eq!(m.b.geometry.perp, [0.0, 1.0, 0.0]);
}

/// The record stride the TS encoder must match byte for byte. A silent
/// disagreement here does not fail: it makes the solver read ratio out of
/// the offset's tail and mis-solve, which is why the stride is pinned
/// against the shared fixture rather than a bare literal.
#[test]
fn mate_record_is_112_bytes() {
    let one = encode_mate_input(&sample_input()).len();
    let mut two_mates = sample_input();
    let extra = two_mates.mates[0].clone();
    two_mates.mates.push(extra);
    let stride = encode_mate_input(&two_mates).len() - one;
    assert_eq!(stride as u64, fixture_u64("record_bytes"));
    assert_eq!(stride, 112);
}

// A record built to the pre-weight 108-byte stride must fail loudly instead
// of silently reading the missing weight back as surplus. With one mate the
// missing four bytes run the reader off the end of the buffer.
#[test]
fn mate_input_short_weight_record_rejected() {
    let bytes = encode_mate_input(&sample_input());
    let truncated = &bytes[..bytes.len() - 4];
    assert!(matches!(
        decode_mate_input(truncated),
        Err(CodecError::UnexpectedEof)
    ));
}

#[test]
fn mate_weight_round_trips() {
    let mut input = sample_input();
    input.mates[0].weight = 1e-4;
    let decoded = decode_mate_input(&encode_mate_input(&input)).expect("decode");
    assert_eq!(decoded.mates[0].weight, 1e-4_f32 as f64);
}

/// The Rust half of the cross-language wire lock: the constants and stride
/// must equal tests/fixtures/mate_wire.txt, which the TS byte-size test
/// reads too. The fixture puts the magic-bump rule in front of the editor.
#[test]
fn mate_wire_fixture_matches_the_constants() {
    assert_eq!(fixture_u64("rev"), 3);
    assert_eq!(MATE_MAGIC as u64, fixture_u64("magic"));
    assert_eq!(MATE_MAGIC_OUT as u64, fixture_u64("magic_out"));
}

// A stale decoder can meet a fresh encoder (the WASM is served from a fixed,
// unhashed URL). The prior rev's magic (MTS2) must be rejected, not decoded
// with the new weight field running off the old record.
#[test]
fn stale_magic_is_rejected() {
    let mut bytes = encode_mate_input(&sample_input());
    bytes[0..4].copy_from_slice(&0x3253_544Du32.to_le_bytes());
    assert!(matches!(
        decode_mate_input(&bytes),
        Err(CodecError::BadMagic)
    ));
}

/// The axial reduction Tangential and ParallelPlaneDistance read. A scalar
/// offset `s` was authored as `s * axis_a`, and this must give back exactly
/// `s` -- that identity is the whole back-compat guarantee for those kinds.
#[test]
fn axial_offset_recovers_the_scalar_form() {
    let axis = [0.0, 0.6, 0.8]; // unit, deliberately not a cardinal direction
    let mut m = sample_input().mates.pop().unwrap();
    m.a.geometry.axis = axis;
    m.offset = [7.0 * axis[0], 7.0 * axis[1], 7.0 * axis[2]];
    assert!((m.axial_offset() - 7.0).abs() < 1e-12);

    // A purely perpendicular offset has no axial component at all.
    m.offset = [1.0, 0.0, 0.0];
    assert!(m.axial_offset().abs() < 1e-12);

    // A degenerate axis yields 0, never NaN.
    m.a.geometry.axis = [0.0, 0.0, 0.0];
    m.offset = [1.0, 2.0, 3.0];
    assert_eq!(m.axial_offset(), 0.0);
}

#[test]
fn anchor_kinds_round_trip() {
    for code in 0..=7u8 {
        let kind = AnchorKind::from_u8(code).unwrap();
        assert_eq!(kind.to_u8(), code);
    }
    assert_eq!(AnchorKind::from_u8(8), None);
}

#[test]
fn is_fixed_reads_mask() {
    let input = MateInput {
        bodies: vec![RigidBody],
        params_initial: vec![0.0; 7],
        fixed_mask: vec![0b0000_0101],
        mates: vec![],
    };
    assert!(input.is_fixed(0));
    assert!(!input.is_fixed(1));
    assert!(input.is_fixed(2));
    assert!(!input.is_fixed(3));
}

#[test]
fn all_mate_kinds_decode() {
    // Iterating ALL, not a hardcoded range: a variant missing from from_u8
    // fails here instead of falling outside the loop. Codes must be unique
    // and contiguous from 0, which `code == enumerate` proves in one check.
    for (code, &kind) in MateKind::ALL.iter().enumerate() {
        assert_eq!(
            kind.to_u8() as usize,
            code,
            "kind codes are contiguous from 0"
        );
        assert_eq!(MateKind::from_u8(kind.to_u8()), Some(kind));
    }
    assert_eq!(MateKind::from_u8(MateKind::ALL.len() as u8), None);
}

// Each float field class on the input wire is gated individually: one NaN
// row reaching the residuals poisons the Jacobian, and nalgebra's SVD (the
// rank pass) never converges on NaN -- it hangs the serialized worker for
// good -- so there is no "harmless" slot for a non-finite to hide in.
fn assert_nonfinite_rejected(field: &str, apply: impl Fn(&mut MateInput, f32)) {
    for v in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut input = sample_input();
        apply(&mut input, v);
        assert!(
            matches!(
                decode_mate_input(&encode_mate_input(&input)),
                Err(CodecError::NonFinite)
            ),
            "{field} accepted {v}"
        );
    }
}

#[test]
fn nonfinite_param_seed_rejected() {
    assert_nonfinite_rejected("params_initial", |input, v| input.params_initial[0] = v);
}

#[test]
fn nonfinite_anchor_point_rejected() {
    for comp in 0..3 {
        assert_nonfinite_rejected("point_a", move |input, v| {
            input.mates[0].a.geometry.point[comp] = v as f64;
        });
        assert_nonfinite_rejected("point_b", move |input, v| {
            input.mates[0].b.geometry.point[comp] = v as f64;
        });
    }
}

#[test]
fn nonfinite_anchor_axis_rejected() {
    for comp in 0..3 {
        assert_nonfinite_rejected("axis_a", move |input, v| {
            input.mates[0].a.geometry.axis[comp] = v as f64;
        });
        assert_nonfinite_rejected("axis_b", move |input, v| {
            input.mates[0].b.geometry.axis[comp] = v as f64;
        });
    }
}

#[test]
fn nonfinite_offset_component_rejected() {
    // The offset is a full 3-vector on the wire; every component gates.
    assert_nonfinite_rejected("offset.x", |input, v| input.mates[0].offset[0] = v as f64);
    assert_nonfinite_rejected("offset.y", |input, v| input.mates[0].offset[1] = v as f64);
    assert_nonfinite_rejected("offset.z", |input, v| input.mates[0].offset[2] = v as f64);
}

#[test]
fn nonfinite_ratio_radius_angle_rejected() {
    assert_nonfinite_rejected("ratio", |input, v| input.mates[0].ratio = v as f64);
    assert_nonfinite_rejected("radius", |input, v| input.mates[0].radius = v as f64);
    assert_nonfinite_rejected("angle", |input, v| input.mates[0].angle = v as f64);
}
