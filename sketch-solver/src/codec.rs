//! Flat typed-array codec for the WASM boundary.
//!
//! Locks the byte layout the TS builder will produce. Everything is
//! little-endian (WASM linear memory and JS `DataView` with `littleEndian=true`
//! agree). Phase 1.0 decodes into owned `Vec`s via explicit reads; a zero-copy
//! `Float32Array` view over linear memory is a later optimization and does not
//! change the layout below.
//!
//! ## Input buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MAGIC ("SKS1")
//!   u32  n_entities
//!   u32  n_params            // f32 count of params_initial
//!   u32  n_constraints
//!   u32  n_equality_pins
//!   u8   drag_mode (0/1)
//!   u8   skip_status_pass (0/1)
//!   u32  drag_anchor_id
//! entities:       n_entities x { u8 kind, u32 param_offset }
//! params_initial: n_params x f32
//! pinned_mask:    ceil(n_params / 8) bytes (LSB-first within each byte)
//! equality_pins:  n_equality_pins x { u32 param_index, f32 target }
//! constraints:    n_constraints x constraint-record (see below)
//! ```
//!
//! ## Constraint record (variable length, self-describing)
//!
//! ```text
//!   u8  kind_code
//!   u8  n_refs
//!   n_refs x reference:
//!     u8  role
//!     u8  ref_type            // 0 = entity, 1 = external_xy
//!     entity (ref_type 0):  u8 point_selector, u32 entity_index
//!     external (ref_type 1): f32 x, f32 y
//!   u8  scalar_flags          // bit0 has_value, bit1 has_xy, bit2 has_axis
//!   has_value: f32 value
//!   has_xy:    f32 x, f32 y
//!   has_axis:  u8 axis
//! ```
//!
//! ## Output buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MAGIC_OUT ("SKR1")
//!   u32  n_params
//!   u32  n_entities_status   // 0 when skip_status_pass
//!   u32  vertex_freedom_len  // f32 count
//!   u8   overall_status
//! params_solved:  n_params x f32
//! entity_status:  n_entities_status x u8
//! vertex_freedom: vertex_freedom_len x f32
//! diagnostics:    f64 residual_norm, u32 rank, u32 dof, u32 iters, f64 ms
//! ```

use crate::constraints::{Axis, Constraint, PointSelector, Ref, RefRole};
use crate::{Diagnostics, Entity, EqualityPin, Input, Kind, Options, Output};

pub const MAGIC: u32 = 0x5347_4B53; // "SKGS"-ish marker, stable wire value
pub const MAGIC_OUT: u32 = 0x5347_4B52;

#[derive(Debug, PartialEq, Eq)]
pub enum CodecError {
    UnexpectedEof,
    BadMagic,
    BadKind(u8),
    BadConstraintKind(u8),
    BadRefRole(u8),
    BadPointSelector(u8),
    BadAxis(u8),
    BadRefType(u8),
}

/// Cursor over a byte slice with little-endian primitive reads.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        let end = self.pos.checked_add(n).ok_or(CodecError::UnexpectedEof)?;
        if end > self.buf.len() {
            return Err(CodecError::UnexpectedEof);
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, CodecError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f32(&mut self) -> Result<f32, CodecError> {
        let b = self.take(4)?;
        Ok(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Growable little-endian byte writer.
#[derive(Default)]
struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
}

fn pinned_mask_bytes(n_params: usize) -> usize {
    n_params.div_ceil(8)
}

// ─── Input ───

pub fn decode_input(buf: &[u8]) -> Result<Input, CodecError> {
    let mut r = Reader::new(buf);
    if r.u32()? != MAGIC {
        return Err(CodecError::BadMagic);
    }
    let n_entities = r.u32()? as usize;
    let n_params = r.u32()? as usize;
    let n_constraints = r.u32()? as usize;
    let n_equality_pins = r.u32()? as usize;
    let drag_mode = r.u8()? != 0;
    let skip_status_pass = r.u8()? != 0;
    let drag_anchor_id = r.u32()?;

    let mut entities = Vec::with_capacity(n_entities);
    for _ in 0..n_entities {
        let kind = Kind::from_u8(r.u8()?).ok_or(CodecError::BadKind(0))?;
        let param_offset = r.u32()? as usize;
        entities.push(Entity { kind, param_offset });
    }

    let mut params_initial = Vec::with_capacity(n_params);
    for _ in 0..n_params {
        params_initial.push(r.f32()?);
    }

    let mask_len = pinned_mask_bytes(n_params);
    let pinned_mask = r.take(mask_len)?.to_vec();

    let mut equality_pins = Vec::with_capacity(n_equality_pins);
    for _ in 0..n_equality_pins {
        let param_index = r.u32()?;
        let target = r.f32()?;
        equality_pins.push(EqualityPin {
            param_index,
            target,
        });
    }

    let mut constraints = Vec::with_capacity(n_constraints);
    for _ in 0..n_constraints {
        constraints.push(decode_constraint(&mut r)?);
    }

    Ok(Input {
        entities,
        params_initial,
        pinned_mask,
        equality_pins,
        constraints,
        options: Options {
            drag_mode,
            drag_anchor_id,
            skip_status_pass,
        },
    })
}

fn decode_constraint(r: &mut Reader) -> Result<Constraint, CodecError> {
    let kind_code = r.u8()?;
    let n_refs = r.u8()? as usize;
    let mut refs = Vec::with_capacity(n_refs);
    for _ in 0..n_refs {
        let role = RefRole::from_u8(r.u8()?).ok_or(CodecError::BadRefRole(0))?;
        let ref_type = r.u8()?;
        let rf = match ref_type {
            0 => {
                let point = PointSelector::from_u8(r.u8()?)
                    .ok_or(CodecError::BadPointSelector(0))?;
                let index = r.u32()?;
                Ref::Entity { index, point }
            }
            1 => {
                let x = r.f32()? as f64;
                let y = r.f32()? as f64;
                Ref::External { x, y }
            }
            other => return Err(CodecError::BadRefType(other)),
        };
        refs.push((role, rf));
    }
    let flags = r.u8()?;
    let value = if flags & 0b001 != 0 {
        Some(r.f32()? as f64)
    } else {
        None
    };
    let xy = if flags & 0b010 != 0 {
        let x = r.f32()? as f64;
        let y = r.f32()? as f64;
        Some((x, y))
    } else {
        None
    };
    let axis = if flags & 0b100 != 0 {
        Some(Axis::from_u8(r.u8()?).ok_or(CodecError::BadAxis(0))?)
    } else {
        None
    };
    Ok(Constraint {
        kind_code,
        refs,
        value,
        xy,
        axis,
    })
}

pub fn encode_input(input: &Input) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(MAGIC);
    w.u32(input.entities.len() as u32);
    w.u32(input.params_initial.len() as u32);
    w.u32(input.constraints.len() as u32);
    w.u32(input.equality_pins.len() as u32);
    w.u8(input.options.drag_mode as u8);
    w.u8(input.options.skip_status_pass as u8);
    w.u32(input.options.drag_anchor_id);

    for e in &input.entities {
        w.u8(e.kind.to_u8());
        w.u32(e.param_offset as u32);
    }
    for &p in &input.params_initial {
        w.f32(p);
    }
    // Pad the mask to the canonical length so decode round-trips exactly.
    let mask_len = pinned_mask_bytes(input.params_initial.len());
    for i in 0..mask_len {
        w.u8(input.pinned_mask.get(i).copied().unwrap_or(0));
    }
    for pin in &input.equality_pins {
        w.u32(pin.param_index);
        w.f32(pin.target);
    }
    for c in &input.constraints {
        encode_constraint(&mut w, c);
    }
    w.buf
}

fn encode_constraint(w: &mut Writer, c: &Constraint) {
    w.u8(c.kind_code);
    w.u8(c.refs.len() as u8);
    for (role, rf) in &c.refs {
        w.u8(role.to_u8());
        match rf {
            Ref::Entity { index, point } => {
                w.u8(0);
                w.u8(point.to_u8());
                w.u32(*index);
            }
            Ref::External { x, y } => {
                w.u8(1);
                w.f32(*x as f32);
                w.f32(*y as f32);
            }
        }
    }
    let mut flags = 0u8;
    if c.value.is_some() {
        flags |= 0b001;
    }
    if c.xy.is_some() {
        flags |= 0b010;
    }
    if c.axis.is_some() {
        flags |= 0b100;
    }
    w.u8(flags);
    if let Some(v) = c.value {
        w.f32(v as f32);
    }
    if let Some((x, y)) = c.xy {
        w.f32(x as f32);
        w.f32(y as f32);
    }
    if let Some(a) = c.axis {
        w.u8(a.to_u8());
    }
}

// ─── Output ───

pub fn encode_output(out: &Output) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(MAGIC_OUT);
    w.u32(out.params_solved.len() as u32);
    w.u32(out.entity_status.len() as u32);
    w.u32(out.vertex_freedom.len() as u32);
    w.u8(out.overall_status);
    for &p in &out.params_solved {
        w.f32(p);
    }
    for &s in &out.entity_status {
        w.u8(s);
    }
    for &v in &out.vertex_freedom {
        w.f32(v);
    }
    w.f64(out.diagnostics.residual_norm);
    w.u32(out.diagnostics.rank);
    w.u32(out.diagnostics.dof);
    w.u32(out.diagnostics.iters);
    w.f64(out.diagnostics.ms);
    w.buf
}

pub fn decode_output(buf: &[u8]) -> Result<Output, CodecError> {
    let mut r = Reader::new(buf);
    if r.u32()? != MAGIC_OUT {
        return Err(CodecError::BadMagic);
    }
    let n_params = r.u32()? as usize;
    let n_status = r.u32()? as usize;
    let vf_len = r.u32()? as usize;
    let overall_status = r.u8()?;
    let mut params_solved = Vec::with_capacity(n_params);
    for _ in 0..n_params {
        params_solved.push(r.f32()?);
    }
    let mut entity_status = Vec::with_capacity(n_status);
    for _ in 0..n_status {
        entity_status.push(r.u8()?);
    }
    let mut vertex_freedom = Vec::with_capacity(vf_len);
    for _ in 0..vf_len {
        vertex_freedom.push(r.f32()?);
    }
    let residual_norm = {
        let b = r.take(8)?;
        f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
    };
    let rank = r.u32()?;
    let dof = r.u32()?;
    let iters = r.u32()?;
    let ms = {
        let b = r.take(8)?;
        f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
    };
    Ok(Output {
        params_solved,
        entity_status,
        overall_status,
        vertex_freedom,
        diagnostics: Diagnostics {
            residual_norm,
            rank,
            dof,
            iters,
            ms,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> Input {
        let entities = vec![
            Entity {
                kind: Kind::Line,
                param_offset: 0,
            },
            Entity {
                kind: Kind::Circle,
                param_offset: 4,
            },
        ];
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
            pinned_mask: vec![0b0000_0011],
            equality_pins: vec![EqualityPin {
                param_index: 6,
                target: 2.5,
            }],
            constraints,
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

        // Re-encoding the decode is byte-identical: the layout is canonical.
        assert_eq!(encode_input(&decoded), bytes);
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
    fn output_round_trips() {
        let out = Output {
            params_solved: vec![1.0, 2.0, 3.0],
            entity_status: vec![0, 1],
            overall_status: crate::Status::Underconstrained.to_u8(),
            vertex_freedom: vec![0.0, 1.0, 1.0, 0.0],
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
        assert_eq!(decoded.diagnostics.rank, 5);
        assert_eq!(decoded.diagnostics.iters, 7);
        assert!((decoded.diagnostics.residual_norm - 1.25e-9).abs() < 1e-18);
    }

    #[test]
    fn bad_magic_rejected() {
        let mut bytes = encode_input(&sample_input());
        bytes[0] ^= 0xff;
        assert!(matches!(decode_input(&bytes), Err(CodecError::BadMagic)));
    }
}
