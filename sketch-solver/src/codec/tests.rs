use super::*;

fn sample_input() -> Input {
    let entities = vec![Entity::new(Kind::Line, 0), Entity::new(Kind::Circle, 4)];
    let constraints = vec![
        Constraint {
            kind_code: crate::ConstraintKind::Horizontal.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            )],
            ..Default::default()
        },
        Constraint {
            kind_code: crate::ConstraintKind::Length.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            )],
            value: Some(10.0),
            ..Default::default()
        },
        Constraint {
            kind_code: crate::ConstraintKind::Coincident.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Start,
                    },
                ),
                (RefRole::B, Ref::External { x: 1.5, y: -2.0 }),
            ],
            ..Default::default()
        },
        Constraint {
            kind_code: crate::ConstraintKind::Midpoint.to_u8(),
            refs: vec![(
                RefRole::Point,
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Center,
                },
            )],
            axis: Some(Axis::X),
            ..Default::default()
        },
    ];
    Input {
        entities,
        params_initial: vec![0.0, 0.0, 10.0, 0.0, 3.0, 4.0, 2.5],
        params_reference: Vec::new(),
        pinned_mask: vec![0b0000_0011],
        equality_pins: vec![EqualityPin {
            param_index: 6,
            target: 2.5,
        }],
        constraints,
        seed_quantum: 1e-6,
        options: Options {
            drag_mode: true,
            drag_anchor_id: 1,
            skip_status_pass: false,
        },
    }
}

#[test]
fn input_round_trips() {
    let input = sample_input();
    let bytes = encode_input(&input);
    let decoded = decode_input(&bytes).expect("decode");

    assert_eq!(decoded.entities.len(), input.entities.len());
    assert_eq!(decoded.params_initial, input.params_initial);
    assert_eq!(decoded.pinned_mask, input.pinned_mask);
    assert_eq!(decoded.equality_pins.len(), 1);
    assert_eq!(decoded.equality_pins[0].param_index, 6);
    assert_eq!(decoded.constraints.len(), 4);
    assert!(decoded.options.drag_mode);
    assert_eq!(decoded.options.drag_anchor_id, 1);
    // Bit-exact, not merely close: the grid value is forwarded verbatim.
    assert_eq!(decoded.seed_quantum.to_bits(), input.seed_quantum.to_bits());

    // Re-encoding the decode is byte-identical: the layout is canonical.
    assert_eq!(encode_input(&decoded), bytes);
}

#[test]
fn f64_scalars_round_trip_bit_exact() {
    // The values the f32 wire could not carry: 1234.567 (rounds to
    // 1234.567017 in f32) and 1e6 (no sub-integer resolution at all in
    // f32). Every float field class is exercised and compared by bit
    // pattern, so -0.0 cannot pass as +0.0 and no silent narrowing hides.
    let values = [25.4, 1234.567, 1e-9, -0.0, 1e6];
    let input = Input {
        entities: vec![Entity::new(Kind::Point, 0)],
        params_initial: values.to_vec(),
        params_reference: Vec::new(),
        pinned_mask: vec![0],
        equality_pins: vec![EqualityPin {
            param_index: 0,
            target: 1234.567,
        }],
        constraints: vec![
            Constraint {
                kind_code: crate::ConstraintKind::Length.to_u8(),
                refs: Vec::new(),
                value: Some(25.4),
                xy: Some((1e-9, -0.0)),
                sign: Some(1e6),
                ..Default::default()
            },
            Constraint {
                kind_code: crate::ConstraintKind::Coincident.to_u8(),
                refs: vec![(
                    RefRole::A,
                    Ref::External {
                        x: 1234.567,
                        y: 1e6,
                    },
                )],
                ..Default::default()
            },
        ],
        seed_quantum: 1234.567,
        options: Options::default(),
    };
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(decoded.seed_quantum.to_bits(), 1234.567_f64.to_bits());
    for (got, want) in decoded.params_initial.iter().zip(&input.params_initial) {
        assert_eq!(got.to_bits(), want.to_bits(), "{got} != {want}");
    }
    assert_eq!(
        decoded.equality_pins[0].target.to_bits(),
        1234.567_f64.to_bits()
    );
    let c = &decoded.constraints[0];
    assert_eq!(c.value.unwrap().to_bits(), 25.4f64.to_bits());
    assert_eq!(c.xy.unwrap().0.to_bits(), 1e-9f64.to_bits());
    assert_eq!(c.xy.unwrap().1.to_bits(), (-0.0f64).to_bits());
    assert_eq!(c.sign.unwrap().to_bits(), 1e6f64.to_bits());
    match &decoded.constraints[1].refs[0].1 {
        Ref::External { x, y } => {
            assert_eq!(x.to_bits(), 1234.567f64.to_bits());
            assert_eq!(y.to_bits(), 1e6f64.to_bits());
        }
        other => panic!("expected external ref, got {other:?}"),
    }
}

#[test]
fn output_floats_round_trip_bit_exact() {
    let out = Output {
        params_solved: vec![25.4, 1234.567, 1e-9, -0.0, 1e6],
        entity_status: Vec::new(),
        overall_status: 0,
        vertex_freedom: vec![-0.0, 1e6],
        constraint_flags: vec![crate::CONSTRAINT_FLAG_REDUNDANT, 0, 1],
        // Diagnostic fractions: 1.5 and 0.25 are exactly representable, and
        // -0.0 pins that the encoder does not normalise the sign away (the
        // comparison below is bit-exact, since f64 equality cannot tell
        // -0.0 from 0.0).
        constraint_miss: vec![1.5, 0.25, -0.0],
        entity_moved: vec![0b0000_0010],
        diagnostics: Diagnostics::default(),
    };
    let decoded = decode_output(&encode_output(&out)).unwrap();
    for (got, want) in decoded.params_solved.iter().zip(&out.params_solved) {
        assert_eq!(got.to_bits(), want.to_bits());
    }
    for (got, want) in decoded.vertex_freedom.iter().zip(&out.vertex_freedom) {
        assert_eq!(got.to_bits(), want.to_bits());
    }
    assert_eq!(decoded.constraint_flags, out.constraint_flags);
    // Bit-exact like the params above: assert_eq! on f64 reads -0.0 as
    // equal to 0.0 and could not pin the sign.
    for (got, want) in decoded.constraint_miss.iter().zip(&out.constraint_miss) {
        assert_eq!(got.to_bits(), want.to_bits());
    }
    assert_eq!(decoded.entity_moved, out.entity_moved);
}

#[test]
fn constraint_refs_and_scalars_round_trip() {
    let decoded = decode_input(&encode_input(&sample_input())).unwrap();
    let length = &decoded.constraints[1];
    assert_eq!(length.value, Some(10.0));
    let coincident = &decoded.constraints[2];
    assert_eq!(
        coincident.ref_for(RefRole::A),
        Some(Ref::Entity {
            index: 0,
            point: PointSelector::Start
        })
    );
    assert_eq!(
        coincident.ref_for(RefRole::B),
        Some(Ref::External { x: 1.5, y: -2.0 })
    );
    let midpoint = &decoded.constraints[3];
    assert_eq!(midpoint.axis, Some(Axis::X));
}

#[test]
fn sign_selector_round_trips() {
    // A directional dimension carries an orientation sign alongside its
    // value; both must survive the codec, and the has_sign flag bit must be
    // independent of has_value.
    let input = Input {
        entities: vec![Entity::new(Kind::Point, 0)],
        params_initial: vec![0.0, 0.0],
        params_reference: Vec::new(),
        pinned_mask: vec![0],
        equality_pins: Vec::new(),
        constraints: vec![
            Constraint {
                kind_code: crate::ConstraintKind::PointDistanceX.to_u8(),
                refs: vec![(
                    RefRole::A,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Xy,
                    },
                )],
                value: Some(7.5),
                sign: Some(-1.0),
                ..Default::default()
            },
            // A sign without a value (defensive: the flags are orthogonal).
            Constraint {
                kind_code: crate::ConstraintKind::Angle.to_u8(),
                sign: Some(1.0),
                ..Default::default()
            },
        ],
        seed_quantum: 0.0,
        options: Options::default(),
    };
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(decoded.constraints[0].value, Some(7.5));
    assert_eq!(decoded.constraints[0].sign, Some(-1.0));
    assert_eq!(decoded.constraints[1].value, None);
    assert_eq!(decoded.constraints[1].sign, Some(1.0));
    // Byte-identical re-encode: the new field is part of the canonical layout.
    assert_eq!(encode_input(&decoded), encode_input(&input));
}

#[test]
fn output_round_trips() {
    let out = Output {
        params_solved: vec![1.0, 2.0, 3.0],
        entity_status: vec![0, 1],
        overall_status: crate::Status::Underconstrained.to_u8(),
        vertex_freedom: vec![0.0, 1.0, 1.0, 0.0],
        constraint_flags: vec![crate::CONSTRAINT_FLAG_REDUNDANT, 0],
        constraint_miss: vec![0.0, 0.375],
        entity_moved: vec![0b0000_0001],
        diagnostics: Diagnostics {
            residual_norm: 1.25e-9,
            rank: 5,
            dof: 1,
            iters: 7,
            ms: 0.42,
        },
    };
    let decoded = decode_output(&encode_output(&out)).unwrap();
    assert_eq!(decoded.params_solved, out.params_solved);
    assert_eq!(decoded.entity_status, out.entity_status);
    assert_eq!(decoded.vertex_freedom, out.vertex_freedom);
    assert_eq!(decoded.constraint_flags, out.constraint_flags);
    assert_eq!(decoded.constraint_miss, out.constraint_miss);
    assert_eq!(decoded.entity_moved, out.entity_moved);
    assert_eq!(decoded.diagnostics.rank, 5);
    assert_eq!(decoded.diagnostics.iters, 7);
    assert!((decoded.diagnostics.residual_norm - 1.25e-9).abs() < 1e-18);
}

#[test]
fn ellipse_entity_round_trips() {
    let input = Input {
        entities: vec![Entity::new(Kind::Ellipse, 0)],
        params_initial: vec![1.0, 2.0, 4.0, 2.0, 30.0],
        params_reference: Vec::new(),
        pinned_mask: vec![0],
        equality_pins: Vec::new(),
        constraints: Vec::new(),
        seed_quantum: 0.0,
        options: Options::default(),
    };
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(decoded.entities.len(), 1);
    assert_eq!(decoded.entities[0].kind, Kind::Ellipse);
    assert_eq!(decoded.params_initial, input.params_initial);
    // Re-encoding the decode is byte-identical: kind code 4 round-trips.
    assert_eq!(encode_input(&decoded), encode_input(&input));
}

#[test]
fn spline_entity_round_trips() {
    let input = Input {
        entities: vec![Entity::new(Kind::Spline, 0)],
        params_initial: vec![0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 4.0, 0.0],
        params_reference: Vec::new(),
        pinned_mask: vec![0],
        equality_pins: Vec::new(),
        constraints: Vec::new(),
        seed_quantum: 0.0,
        options: Options::default(),
    };
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(decoded.entities.len(), 1);
    assert_eq!(decoded.entities[0].kind, Kind::Spline);
    assert_eq!(decoded.params_initial, input.params_initial);
    // Re-encoding the decode is byte-identical: kind code 5 round-trips.
    assert_eq!(encode_input(&decoded), encode_input(&input));
}

#[test]
fn entity_index_past_the_entity_table_decodes_verbatim() {
    // The wire layer is structural: an index no entity backs is a perfectly
    // well-formed record, so decode must accept it and hand it on unchanged.
    // Nothing in the byte stream can catch this class of staleness, which is
    // why `Problem::new` is the one that drops the constraint.
    let mut input = one_entity_input();
    input.params_initial = vec![0.0, 0.0, 1.0, 0.0];
    input.pinned_mask = vec![0];
    input.constraints = vec![Constraint {
        kind_code: crate::ConstraintKind::Horizontal.to_u8(),
        refs: vec![(
            RefRole::Target,
            Ref::Entity {
                index: 4,
                point: PointSelector::Absent,
            },
        )],
        ..Default::default()
    }];
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(decoded.entities.len(), 1);
    assert_eq!(
        decoded.constraints[0].ref_for(RefRole::Target),
        Some(Ref::Entity {
            index: 4,
            point: PointSelector::Absent
        })
    );
    assert!(!decoded.entity_params_in_range(4));
    assert!(decoded.entity_params_in_range(0));
}

#[test]
fn entity_param_offset_past_the_param_buffer_decodes_verbatim() {
    // The other half of the same class: the index resolves, but the entity's
    // param block does not fit the buffer the header describes.
    let mut input = one_entity_input();
    input.entities = vec![Entity::new(Kind::Line, 2)];
    input.params_initial = vec![0.0, 0.0, 1.0];
    input.pinned_mask = vec![0];
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(decoded.entities[0].param_offset, 2);
    assert!(!decoded.entity_params_in_range(0));
}

#[test]
fn bad_magic_rejected() {
    let mut bytes = encode_input(&sample_input());
    bytes[0] ^= 0xff;
    assert!(matches!(decode_input(&bytes), Err(CodecError::BadMagic)));
}

// The magic is the only version handshake on this wire (see its docs), so
// a buffer stamped with a superseded revision must be refused outright:
// accepting it would decode shifted constraint records as garbage instead
// of surfacing the stale js/wasm pairing.
#[test]
fn rev1_input_magic_rejected() {
    let mut bytes = encode_input(&sample_input());
    bytes[..4].copy_from_slice(&MAGIC_REV1.to_le_bytes());
    assert!(matches!(decode_input(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn rev2_input_magic_rejected() {
    // Rev 2 is the f32 layout: the float widths moved, so a rev 2 payload
    // fed to the rev 3 decoder must fail at the magic, never decode
    // shifted values.
    let mut bytes = encode_input(&sample_input());
    bytes[..4].copy_from_slice(&MAGIC_REV2.to_le_bytes());
    assert!(matches!(decode_input(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn rev5_input_magic_rejected() {
    // Same layout, older meaning: that solver never set the dropped verdict
    // bit, so accepting it would hide exactly the constraint this revision
    // exists to report.
    let mut bytes = encode_input(&sample_input());
    bytes[..4].copy_from_slice(&MAGIC_SKG5.to_le_bytes());
    assert!(matches!(decode_input(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn current_input_magic_accepted() {
    let bytes = encode_input(&sample_input());
    assert_eq!(&bytes[..4], &MAGIC.to_le_bytes());
    assert!(decode_input(&bytes).is_ok());
}

#[test]
fn rev1_output_magic_rejected() {
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: Vec::new(),
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[..4].copy_from_slice(&MAGIC_OUT_REV1.to_le_bytes());
    assert!(matches!(decode_output(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn rev2_output_magic_rejected() {
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: Vec::new(),
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[..4].copy_from_slice(&MAGIC_OUT_REV2.to_le_bytes());
    assert!(matches!(decode_output(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn rev3_output_magic_rejected() {
    // Rev 3's output header carried no per-constraint verdict count, so a
    // rev 3 payload fed to this decoder must fail at the magic rather than
    // read the diagnostics fields four bytes early.
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: Vec::new(),
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[..4].copy_from_slice(&MAGIC_OUT_REV3.to_le_bytes());
    assert!(matches!(decode_output(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn rev4_output_magic_is_rejected() {
    // The rev 4 output put the diagnostics straight after the constraint miss
    // block; this decoder reads the `entity_moved` bytes from that first
    // diagnostic f64. The magic must refuse it instead.
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: vec![0],
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[..4].copy_from_slice(&MAGIC_OUT_SKR4.to_le_bytes());
    assert!(matches!(decode_output(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn rev5_output_magic_is_rejected() {
    // Same byte layout as rev 5, but its constraint flags never carry the
    // dropped bit; the magic is the only handshake that can tell the host so.
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: vec![0],
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[..4].copy_from_slice(&MAGIC_OUT_SKR5.to_le_bytes());
    assert!(matches!(decode_output(&bytes), Err(CodecError::BadMagic)));
}

// The fixed-size input header (see module docs): magic, four counts, two
// u8 flags, the drag anchor, the storage quantum and the reference count. The
// first entity or constraint record starts right after it, which is what the
// corruption offsets below rely on.
const HEADER_LEN: usize = 38;

fn one_entity_input() -> Input {
    Input {
        entities: vec![Entity::new(Kind::Line, 0)],
        params_initial: Vec::new(),
        params_reference: Vec::new(),
        pinned_mask: Vec::new(),
        equality_pins: Vec::new(),
        constraints: Vec::new(),
        seed_quantum: 0.0,
        options: Options::default(),
    }
}

fn one_entity_ref_constraint_input() -> Input {
    Input {
        entities: Vec::new(),
        params_initial: Vec::new(),
        params_reference: Vec::new(),
        pinned_mask: Vec::new(),
        equality_pins: Vec::new(),
        constraints: vec![Constraint {
            kind_code: 0,
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            )],
            ..Default::default()
        }],
        seed_quantum: 0.0,
        options: Options::default(),
    }
}

#[test]
fn empty_buffer_is_unexpected_eof() {
    // Not even the magic u32 can be read.
    assert!(matches!(decode_input(&[]), Err(CodecError::UnexpectedEof)));
    assert!(matches!(decode_output(&[]), Err(CodecError::UnexpectedEof)));
}

#[test]
fn truncated_input_is_unexpected_eof() {
    let bytes = encode_input(&sample_input());
    // Dropping the final byte leaves the last constraint record short.
    let truncated = &bytes[..bytes.len() - 1];
    assert!(matches!(
        decode_input(truncated),
        Err(CodecError::UnexpectedEof)
    ));
}

#[test]
fn corrupt_header_counts_stay_eof_instead_of_reserving_the_heap() {
    // Each count in the header set to u32::MAX in turn, over a buffer that
    // holds one entity and nothing else. Decoding must fail on the first
    // short read: pre-allocating straight from the count would reserve
    // gigabytes and abort the process outright on wasm32's 32-bit heap,
    // which the Worker cannot report or recover from.
    for count_offset in [4usize, 8, 12, 16] {
        let mut bytes = encode_input(&one_entity_input());
        bytes[count_offset..count_offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(
            matches!(decode_input(&bytes), Err(CodecError::UnexpectedEof)),
            "corrupt count at byte {count_offset}"
        );
    }
}

#[test]
fn bad_entity_kind_rejected() {
    let mut bytes = encode_input(&one_entity_input());
    assert!(decode_input(&bytes).is_ok());
    // First entity record begins with its u8 kind code.
    bytes[HEADER_LEN] = 0xff;
    assert!(matches!(decode_input(&bytes), Err(CodecError::BadKind(_))));
}

#[test]
fn bad_ref_role_rejected() {
    let mut bytes = encode_input(&one_entity_ref_constraint_input());
    assert!(decode_input(&bytes).is_ok());
    // Constraint layout: kind_code, n_refs, then per ref [role, ref_type, ...].
    bytes[HEADER_LEN + 2] = 0xff;
    assert!(matches!(
        decode_input(&bytes),
        Err(CodecError::BadRefRole(_))
    ));
}

#[test]
fn bad_ref_type_rejected() {
    let mut bytes = encode_input(&one_entity_ref_constraint_input());
    assert!(decode_input(&bytes).is_ok());
    // ref_type sits right after the role byte; only 0 and 1 are defined.
    bytes[HEADER_LEN + 3] = 0xff;
    assert!(matches!(
        decode_input(&bytes),
        Err(CodecError::BadRefType(0xff))
    ));
}

#[test]
fn bad_point_selector_rejected() {
    let mut bytes = encode_input(&one_entity_ref_constraint_input());
    assert!(decode_input(&bytes).is_ok());
    // For an entity ref the point selector follows role and ref_type.
    bytes[HEADER_LEN + 4] = 0xff;
    assert!(matches!(
        decode_input(&bytes),
        Err(CodecError::BadPointSelector(_))
    ));
}

#[test]
fn bad_axis_rejected() {
    let input = Input {
        entities: Vec::new(),
        params_initial: Vec::new(),
        params_reference: Vec::new(),
        pinned_mask: Vec::new(),
        equality_pins: Vec::new(),
        constraints: vec![Constraint {
            kind_code: 0,
            axis: Some(Axis::X),
            ..Default::default()
        }],
        seed_quantum: 0.0,
        options: Options::default(),
    };
    let mut bytes = encode_input(&input);
    assert!(decode_input(&bytes).is_ok());
    // With no refs the record is kind_code, n_refs(0), flags(has_axis), axis.
    bytes[HEADER_LEN + 3] = 0xff;
    assert!(matches!(decode_input(&bytes), Err(CodecError::BadAxis(_))));
}

// Each float field class on the input wire is gated individually: one NaN
// row reaching the residuals silently poisons a whole solve into a wrong
// status, so there is no "harmless" slot for a non-finite to hide in.
fn assert_nonfinite_rejected(field: &str, apply: impl Fn(&mut Input, f64)) {
    for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut input = sample_input();
        apply(&mut input, v);
        assert!(
            matches!(
                decode_input(&encode_input(&input)),
                Err(CodecError::NonFinite)
            ),
            "{field} accepted {v}"
        );
    }
}

#[test]
fn nonfinite_param_coordinate_rejected() {
    assert_nonfinite_rejected("param", |input, v| input.params_initial[0] = v);
}

#[test]
fn nonfinite_equality_pin_target_rejected() {
    assert_nonfinite_rejected("pin target", |input, v| input.equality_pins[0].target = v);
}

#[test]
fn nonfinite_constraint_scalar_value_rejected() {
    // The Length constraint is the canonical scalar value carrier.
    assert_nonfinite_rejected("value", |input, v| {
        input.constraints[1].value = Some(v);
    });
}

#[test]
fn nonfinite_constraint_xy_field_rejected() {
    assert_nonfinite_rejected("xy.x", |input, v| {
        input.constraints[0].xy = Some((v, 0.5));
    });
    assert_nonfinite_rejected("xy.y", |input, v| {
        input.constraints[0].xy = Some((0.5, v));
    });
}

#[test]
fn nonfinite_sign_field_rejected() {
    // Value dropped alongside so the sign branch is exercised through its
    // own flag bit, independent of has_value.
    assert_nonfinite_rejected("sign", |input, v| {
        input.constraints[1].value = None;
        input.constraints[1].sign = Some(v);
    });
}

#[test]
fn nonfinite_external_coord_rejected() {
    assert_nonfinite_rejected("external x", |input, v| {
        let (_, rf) = &mut input.constraints[2].refs[1];
        match rf {
            Ref::External { x, .. } => *x = v,
            _ => panic!("expected the external ref"),
        }
    });
    assert_nonfinite_rejected("external y", |input, v| {
        let (_, rf) = &mut input.constraints[2].refs[1];
        match rf {
            Ref::External { y, .. } => *y = v,
            _ => panic!("expected the external ref"),
        }
    });
}

#[test]
fn nonfinite_seed_quantum_rejected() {
    // A NaN quantum makes every `< tol` comparison false, which would read as
    // "every entity moved"; Infinity reads as "nothing moved". Neither is a
    // report the host asked for, so the wire refuses it like every other float.
    assert_nonfinite_rejected("seed_quantum", |input, v| input.seed_quantum = v);
}

#[test]
fn output_bad_magic_rejected() {
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: Vec::new(),
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[0] ^= 0xff;
    assert!(matches!(decode_output(&bytes), Err(CodecError::BadMagic)));
}

#[test]
fn truncated_output_is_unexpected_eof() {
    let out = Output {
        params_solved: vec![1.0, 2.0],
        entity_status: vec![0, 1],
        overall_status: 0,
        vertex_freedom: vec![1.0],
        constraint_flags: vec![1, 0],
        constraint_miss: vec![0.5, 0.25],
        entity_moved: vec![0b0000_0011],
        diagnostics: Diagnostics::default(),
    };
    let bytes = encode_output(&out);
    // Cut into the trailing f64 diagnostics so a take(8) runs off the end.
    let truncated = &bytes[..bytes.len() - 1];
    assert!(matches!(
        decode_output(truncated),
        Err(CodecError::UnexpectedEof)
    ));
    // Cutting into the miss block fails on the f64 read instead: drop the
    // trailing diagnostics (28 bytes) plus the last byte of the miss.
    let miss_cut = &bytes[..bytes.len() - 28 - 1];
    assert!(matches!(
        decode_output(miss_cut),
        Err(CodecError::UnexpectedEof)
    ));
}

/// One fit_spline entity with `points` fit points and the given flag bits,
/// plus the params its record implies.
fn fit_input(points: usize, flags: u8) -> Input {
    let handles = (flags & 1 != 0) as usize + (flags & 2 != 0) as usize;
    let mut params: Vec<f64> = (0..points).flat_map(|i| [i as f64, i as f64]).collect();
    params.extend(std::iter::repeat_n(9.0, 2 * handles));
    Input {
        entities: vec![Entity {
            kind: Kind::FitSpline,
            param_offset: 0,
            param_count: 2 * points + 2 * handles,
            flags,
        }],
        params_initial: params,
        params_reference: Vec::new(),
        ..Default::default()
    }
}

/// Patch the first entity record's flags and count bytes (the header is
/// `HEADER_LEN` bytes and the record is `kind, flags, offset, count`).
fn patch_entity_record(bytes: &mut [u8], flags: u8, count: u32) {
    bytes[HEADER_LEN + 1] = flags;
    bytes[HEADER_LEN + 6..HEADER_LEN + 10].copy_from_slice(&count.to_le_bytes());
}

#[test]
fn a_fit_spline_round_trips_with_its_count_and_flags() {
    for (points, flags) in [(2, 0), (3, 1), (5, 2), (64, 3)] {
        let input = fit_input(points, flags);
        let decoded = decode_input(&encode_input(&input)).expect("decode");
        let entity = &decoded.entities[0];
        assert_eq!(entity.kind, Kind::FitSpline);
        assert_eq!(entity.param_count, input.entities[0].param_count);
        assert_eq!(entity.flags, flags);
        assert_eq!(decoded.params_initial, input.params_initial);
    }
}

#[test]
fn the_decoder_rejects_a_fixed_kind_with_the_wrong_count() {
    let input = Input {
        entities: vec![Entity::new(Kind::Line, 0)],
        params_initial: vec![0.0; 4],
        params_reference: Vec::new(),
        ..Default::default()
    };
    let mut bytes = encode_input(&input);
    patch_entity_record(&mut bytes, 0, 6);
    assert_eq!(
        decode_input(&bytes).unwrap_err(),
        CodecError::BadParamCount(0, 6)
    );
}

#[test]
fn the_decoder_rejects_a_malformed_fit_spline() {
    // An odd count, one point, sixty-five points and an unknown flag bit.
    for (flags, count) in [(0u8, 7u32), (0, 2), (0, 130), (0b100, 6)] {
        let input = fit_input(3, 0);
        let mut bytes = encode_input(&input);
        patch_entity_record(&mut bytes, flags, count);
        assert!(
            matches!(decode_input(&bytes), Err(CodecError::BadFitLayout(..))),
            "flags {flags} count {count} decoded"
        );
    }
    // A fixed kind cannot carry flags either.
    let input = Input {
        entities: vec![Entity::new(Kind::Line, 0)],
        params_initial: vec![0.0; 4],
        params_reference: Vec::new(),
        ..Default::default()
    };
    let mut bytes = encode_input(&input);
    patch_entity_record(&mut bytes, 1, 4);
    assert_eq!(decode_input(&bytes).unwrap_err(), CodecError::BadFlags(1));
}

#[test]
fn a_fit_point_selector_round_trips_on_the_constraint_wire() {
    let input = Input {
        entities: vec![Entity {
            kind: Kind::FitSpline,
            param_offset: 0,
            param_count: 6,
            flags: 0,
        }],
        params_initial: vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0],
        params_reference: Vec::new(),
        constraints: vec![Constraint {
            kind_code: crate::ConstraintKind::Coincident.to_u8(),
            refs: vec![(
                RefRole::A,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Fit(1),
                },
            )],
            ..Default::default()
        }],
        ..Default::default()
    };
    let decoded = decode_input(&encode_input(&input)).expect("decode");
    assert_eq!(
        decoded.constraints[0].refs[0].1,
        Ref::Entity {
            index: 0,
            point: PointSelector::Fit(1),
        }
    );
}

#[test]
fn a_stale_rev_4_input_magic_is_rejected() {
    let input = fit_input(2, 0);
    let mut bytes = encode_input(&input);
    bytes[0..4].copy_from_slice(&MAGIC_REV4.to_le_bytes());
    assert_eq!(decode_input(&bytes).unwrap_err(), CodecError::BadMagic);
}

#[test]
fn a_stale_skg4_input_magic_is_rejected() {
    // The previous magic's buffer has no `seed_quantum`: decoding it as this
    // layout would read the first param's bytes as the quantum and shift every
    // later offset by eight. The magic is the only handshake, so it must refuse.
    let input = fit_input(2, 0);
    let mut bytes = encode_input(&input);
    bytes[0..4].copy_from_slice(&MAGIC_SKG4.to_le_bytes());
    assert_eq!(decode_input(&bytes).unwrap_err(), CodecError::BadMagic);
}

#[test]
fn a_group_constraint_round_trips_and_carries_the_reference() {
    // Kind 19 plus the optional reference block: both are new on this wire, and
    // the reference must survive bit-exact so a drag holds the authored shape.
    let input = Input {
        entities: vec![Entity::new(Kind::Line, 0), Entity::new(Kind::Circle, 4)],
        params_initial: vec![0.0, 0.0, 10.0, 0.0, 3.0, 4.0, 2.5],
        params_reference: vec![1.0, 1.0, 11.0, 1.0, 4.0, 5.0, 2.5],
        pinned_mask: vec![0],
        equality_pins: Vec::new(),
        constraints: vec![Constraint {
            kind_code: crate::ConstraintKind::Group.to_u8(),
            refs: vec![
                (
                    RefRole::Target,
                    Ref::Entity {
                        index: 1,
                        point: PointSelector::Absent,
                    },
                ),
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Start,
                    },
                ),
            ],
            ..Default::default()
        }],
        seed_quantum: 1e-6,
        options: Options::default(),
    };
    let bytes = encode_input(&input);
    let decoded = decode_input(&bytes).expect("decode");
    assert_eq!(
        decoded.constraints[0].kind(),
        Some(crate::ConstraintKind::Group)
    );
    assert_eq!(
        decoded.constraints[0].ref_for(RefRole::A),
        Some(Ref::Entity {
            index: 0,
            point: PointSelector::Start
        })
    );
    assert_eq!(decoded.params_reference, input.params_reference);
    assert_eq!(encode_input(&decoded), bytes);
}

#[test]
fn a_payload_without_a_group_or_reference_still_decodes() {
    // A buffer authored before the kind existed: no group constraint and no
    // reference block. The reference reads as empty, which the solver treats as
    // "hold params_initial", exactly the old behaviour.
    let decoded = decode_input(&encode_input(&sample_input())).expect("decode");
    assert!(decoded.params_reference.is_empty());
    assert!(decoded
        .constraints
        .iter()
        .all(|c| c.kind() != Some(crate::ConstraintKind::Group)));
}

#[test]
fn a_partial_reference_block_is_refused() {
    // A reference shorter than the params is a host bug: the group residual
    // would read another vector's length. The codec refuses it at the door.
    let input = Input {
        params_reference: vec![0.0, 0.0],
        ..one_entity_input()
    };
    assert_eq!(
        decode_input(&encode_input(&input)).unwrap_err(),
        CodecError::BadReferenceCount(2)
    );
}

#[test]
fn the_rev_6_input_magic_is_rejected() {
    // Rev 6 has no `n_reference` field: this decoder would read the first
    // entity record's bytes as it and shift the whole param block.
    let mut bytes = encode_input(&sample_input());
    bytes[0..4].copy_from_slice(&MAGIC_SKG6.to_le_bytes());
    assert_eq!(decode_input(&bytes).unwrap_err(), CodecError::BadMagic);
}

#[test]
fn the_rev_6_output_magic_is_rejected() {
    let out = Output {
        params_solved: vec![1.0],
        entity_status: vec![0],
        overall_status: 0,
        vertex_freedom: Vec::new(),
        constraint_flags: Vec::new(),
        constraint_miss: Vec::new(),
        entity_moved: Vec::new(),
        diagnostics: Diagnostics::default(),
    };
    let mut bytes = encode_output(&out);
    bytes[0..4].copy_from_slice(&MAGIC_OUT_SKR6.to_le_bytes());
    assert_eq!(decode_output(&bytes).unwrap_err(), CodecError::BadMagic);
}
