//! Flat typed-array codec for the WASM boundary.
//!
//! Locks the byte layout the TS builder will produce. Everything is
//! little-endian (WASM linear memory and JS `DataView` with `littleEndian=true`
//! agree). Phase 1.0 decodes into owned `Vec`s via explicit reads; a zero-copy
//! `Float64Array` view over linear memory is a later optimization and does not
//! change the layout below.
//!
//! Every scalar on the wire is f64. Rev 2 carried f32 and quantized the params
//! at ~6e-8 relative, which is 1e-5 to 1e-4 mm on typical part sizes, far above
//! OCCT's confusion tolerance.
//!
//! ## Input buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MAGIC ("SKG5", little-endian on the wire)
//!   u32  n_entities
//!   u32  n_params            // f64 count of params_initial
//!   u32  n_constraints
//!   u32  n_equality_pins
//!   u8   drag_mode (0/1)
//!   u8   skip_status_pass (0/1)
//!   u32  drag_anchor_id
//!   f64  seed_quantum        // host storage grid in doc units; 0 disables the moved report
//! entities:       n_entities x { u8 kind, u8 flags, u32 param_offset, u32 param_count }
//! params_initial: n_params x f64
//! pinned_mask:    ceil(n_params / 8) bytes (LSB-first within each byte)
//! equality_pins:  n_equality_pins x { u32 param_index, f64 target }
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
//!     external (ref_type 1): f64 x, f64 y
//!   u8  scalar_flags          // bit0 has_value, bit1 has_xy, bit2 has_axis, bit3 has_sign
//!   has_value: f64 value
//!   has_xy:    f64 x, f64 y
//!   has_axis:  u8 axis
//!   has_sign:  f64 sign       // orientation selector for directional dims (+1/-1)
//! ```
//!
//! ## Output buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MAGIC_OUT ("SKR5", little-endian on the wire)
//!   u32  n_params
//!   u32  n_entities_status   // 0 on the drag fast path or when skip_status_pass
//!   u32  vertex_freedom_len  // f64 count; also 0 on the drag fast path
//!   u32  n_constraints_status // per-constraint verdict count; 0 on the drag fast path
//!   u32  n_entity_moved      // byte count of entity_moved; 0 on the drag fast path
//!   u8   overall_status
//! params_solved:  n_params x f64
//! entity_status:  n_entities_status x u8
//! vertex_freedom: vertex_freedom_len x f64
//! constraint_flags: n_constraints_status x u8
//! constraint_miss:  n_constraints_status x f64
//! entity_moved:   n_entity_moved bytes (one bit per entity, LSB-first)
//! diagnostics:    f64 residual_norm, u32 rank, u32 dof, u32 iters, f64 ms
//! ```
//!
//! The `SKG5` input adds the header's `seed_quantum` and the `SKR5` output adds
//! the `entity_moved` bitmask, so the write-back asks the solver which entities
//! it moved instead of applying a float envelope of its own. Before that,
//! `SKG4` made the entity record variable-size: the `fit_spline` kind carries
//! `2 N + 2 h` params, so the record grew a flags byte and a param count. Rev 3
//! switched every scalar from f32 to f64; the layout had already evolved once
//! (the has_sign flag bit + trailing sign f32 per constraint record, commit
//! 9f81d31f) without moving these values, so a stale js/wasm pairing decoded
//! shifted offsets instead of failing loudly. The magic IS the version handshake
//! for a buffer that is built and consumed within one process: bump BOTH sides
//! of the boundary (this file and frontend/src/wasm-kernel/codec.ts) on any
//! layout change. Invalidating old cached payloads is acceptable and safe
//! post-wave-1: bundle-cache reads of stale buffers degrade to cold rebuilds.
pub const MAGIC: u32 = 0x3547_4B53; // "SKG5" in LE memory order
pub const MAGIC_OUT: u32 = 0x3552_4B53; // "SKR5" in LE memory order

/// The rev 1 and rev 2 values (and rev 3, whose output lacked the
/// per-constraint verdicts). Kept only so tests can assert a stale pairing
/// (either the f32 layout or an older field set) is rejected rather than
/// silently misdecoded.
#[cfg(test)]
pub const MAGIC_REV1: u32 = 0x5347_4B53;
#[cfg(test)]
pub const MAGIC_OUT_REV1: u32 = 0x5347_4B52;
#[cfg(test)]
pub const MAGIC_REV2: u32 = 0x3247_4B53;
#[cfg(test)]
pub const MAGIC_OUT_REV2: u32 = 0x3252_4B53;
#[cfg(test)]
pub const MAGIC_OUT_REV3: u32 = 0x3352_4B53;
/// The input magic the rev 3 and rev 4 builders wrote (`0x3347_4B53`, "SKG3").
#[cfg(test)]
pub const MAGIC_REV4: u32 = 0x3347_4B53;
/// The "SKG4" input magic, whose variable-size entity record is unchanged. A
/// buffer stamped with it is refused because it has no `seed_quantum`: the
/// solver would decode the first param's bytes as one.
#[cfg(test)]
pub const MAGIC_SKG4: u32 = 0x3447_4B53;
/// The "SKR4" output magic, refused because its diagnostics start eight bytes
/// earlier than the `entity_moved`-carrying layout's.
#[cfg(test)]
pub const MAGIC_OUT_SKR4: u32 = 0x3452_4B53;

use solver_core::bytes::{Eof, Reader, Writer};

use crate::constraints::{Axis, Constraint, PointSelector, Ref, RefRole};
use crate::{Diagnostics, Entity, EqualityPin, Input, Kind, Options, Output};

#[derive(Debug, PartialEq, Eq)]
pub enum CodecError {
    UnexpectedEof,
    BadMagic,
    BadKind(u8),
    BadRefRole(u8),
    BadPointSelector(u8),
    BadAxis(u8),
    BadRefType(u8),
    NonFinite,
    /// A fixed-size kind arrived with a param count that is not its own.
    BadParamCount(u8, u32),
    /// A flag byte carried a bit the kind does not define.
    BadFlags(u8),
    /// A `fit_spline` record whose count is not `2 N + 2 h` with `2 <= N <= 64`.
    BadFitLayout(u32, u8),
}

/// Lets `r.u32()?` inside a `Result<_, CodecError>` function convert the
/// cursor's only failure mode without an explicit map_err at every call site.
impl From<Eof> for CodecError {
    fn from(_: Eof) -> Self {
        CodecError::UnexpectedEof
    }
}

fn pinned_mask_bytes(n_params: usize) -> usize {
    n_params.div_ceil(8)
}

// ─── Input ───

/// Gate against non-finite floats on the wire.
///
/// A NaN or Inf that reaches the residual builders poisons the cost from
/// iteration 1, so LM returns the seed unchanged and the solve reports the
/// sketch Fully/Underconstrained with no error anywhere. The JSON topology
/// path already rejects non-finite literals via serde; the byte path has no
/// such gate, so every decoded float is checked here instead.
fn finite(v: f64) -> Result<f64, CodecError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(CodecError::NonFinite)
    }
}

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
    let seed_quantum = finite(r.f64()?)?;

    // Record widths for the pre-allocation caps below: entity = kind + flags +
    // offset + count, param = f64, pin = index + target, constraint = kind +
    // n_refs + flags at its shortest. See `Reader::capacity_for` for why the
    // counts are capped.
    let mut entities = Vec::with_capacity(r.capacity_for(n_entities, 10));
    for _ in 0..n_entities {
        let kind_byte = r.u8()?;
        let kind = Kind::from_u8(kind_byte).ok_or(CodecError::BadKind(kind_byte))?;
        let flags = r.u8()?;
        let param_offset = r.u32()? as usize;
        let param_count = r.u32()? as usize;
        match kind.fixed_param_count() {
            Some(fixed) => {
                if flags != 0 {
                    return Err(CodecError::BadFlags(flags));
                }
                if param_count != fixed {
                    return Err(CodecError::BadParamCount(kind_byte, param_count as u32));
                }
            }
            None => {
                // The one variable-size kind. Its layout owns the count and the
                // flag bits; an unknown bit or a count that is not
                // `2 N + 2 h` with `2 <= N <= 64` is refused here, at the one
                // door, so no residual builder ever indexes a bad block.
                crate::fit_spline::ParamLayout::from_wire(param_count, flags)
                    .map_err(|_| CodecError::BadFitLayout(param_count as u32, flags))?;
            }
        }
        entities.push(Entity {
            kind,
            param_offset,
            param_count,
            flags,
        });
    }

    let mut params_initial = Vec::with_capacity(r.capacity_for(n_params, 8));
    for _ in 0..n_params {
        params_initial.push(finite(r.f64()?)?);
    }

    let mask_len = pinned_mask_bytes(n_params);
    let pinned_mask = r.take(mask_len)?.to_vec();

    let mut equality_pins = Vec::with_capacity(r.capacity_for(n_equality_pins, 12));
    for _ in 0..n_equality_pins {
        let param_index = r.u32()?;
        let target = finite(r.f64()?)?;
        equality_pins.push(EqualityPin {
            param_index,
            target,
        });
    }

    let mut constraints = Vec::with_capacity(r.capacity_for(n_constraints, 3));
    for _ in 0..n_constraints {
        constraints.push(decode_constraint(&mut r)?);
    }

    Ok(Input {
        entities,
        params_initial,
        pinned_mask,
        equality_pins,
        constraints,
        seed_quantum,
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
        let role_byte = r.u8()?;
        let role = RefRole::from_u8(role_byte).ok_or(CodecError::BadRefRole(role_byte))?;
        let ref_type = r.u8()?;
        let rf = match ref_type {
            0 => {
                let point_byte = r.u8()?;
                let point = PointSelector::from_u8(point_byte)
                    .ok_or(CodecError::BadPointSelector(point_byte))?;
                let index = r.u32()?;
                Ref::Entity { index, point }
            }
            1 => {
                let x = finite(r.f64()?)?;
                let y = finite(r.f64()?)?;
                Ref::External { x, y }
            }
            other => return Err(CodecError::BadRefType(other)),
        };
        refs.push((role, rf));
    }
    let flags = r.u8()?;
    let value = if flags & 0b001 != 0 {
        Some(finite(r.f64()?)?)
    } else {
        None
    };
    let xy = if flags & 0b010 != 0 {
        let x = finite(r.f64()?)?;
        let y = finite(r.f64()?)?;
        Some((x, y))
    } else {
        None
    };
    let axis = if flags & 0b100 != 0 {
        let axis_byte = r.u8()?;
        Some(Axis::from_u8(axis_byte).ok_or(CodecError::BadAxis(axis_byte))?)
    } else {
        None
    };
    let sign = if flags & 0b1000 != 0 {
        Some(finite(r.f64()?)?)
    } else {
        None
    };
    Ok(Constraint {
        kind_code,
        refs,
        value,
        xy,
        axis,
        sign,
    })
}

#[cfg(test)]
pub(crate) fn encode_input(input: &Input) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(MAGIC);
    w.u32(input.entities.len() as u32);
    w.u32(input.params_initial.len() as u32);
    w.u32(input.constraints.len() as u32);
    w.u32(input.equality_pins.len() as u32);
    w.u8(input.options.drag_mode as u8);
    w.u8(input.options.skip_status_pass as u8);
    w.u32(input.options.drag_anchor_id);
    w.f64(input.seed_quantum);

    for e in &input.entities {
        w.u8(e.kind.to_u8());
        w.u8(e.flags);
        w.u32(e.param_offset as u32);
        w.u32(e.param_count as u32);
    }
    for &p in &input.params_initial {
        w.f64(p);
    }
    // Pad the mask to the canonical length so decode round-trips exactly.
    let mask_len = pinned_mask_bytes(input.params_initial.len());
    for i in 0..mask_len {
        w.u8(input.pinned_mask.get(i).copied().unwrap_or(0));
    }
    for pin in &input.equality_pins {
        w.u32(pin.param_index);
        w.f64(pin.target);
    }
    for c in &input.constraints {
        encode_constraint(&mut w, c);
    }
    w.into_bytes()
}

#[cfg(test)]
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
                w.f64(*x);
                w.f64(*y);
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
    if c.sign.is_some() {
        flags |= 0b1000;
    }
    w.u8(flags);
    if let Some(v) = c.value {
        w.f64(v);
    }
    if let Some((x, y)) = c.xy {
        w.f64(x);
        w.f64(y);
    }
    if let Some(a) = c.axis {
        w.u8(a.to_u8());
    }
    if let Some(s) = c.sign {
        w.f64(s);
    }
}

// ─── Output ───

pub fn encode_output(out: &Output) -> Vec<u8> {
    // One header count drives both per-constraint arrays: the verdicts are
    // index-aligned by contract, and a mismatch would silently shift them.
    debug_assert_eq!(out.constraint_flags.len(), out.constraint_miss.len());
    let mut w = Writer::default();
    w.u32(MAGIC_OUT);
    w.u32(out.params_solved.len() as u32);
    w.u32(out.entity_status.len() as u32);
    w.u32(out.vertex_freedom.len() as u32);
    w.u32(out.constraint_flags.len() as u32);
    w.u32(out.entity_moved.len() as u32);
    w.u8(out.overall_status);
    for &p in &out.params_solved {
        w.f64(p);
    }
    for &s in &out.entity_status {
        w.u8(s);
    }
    for &v in &out.vertex_freedom {
        w.f64(v);
    }
    for &f in &out.constraint_flags {
        w.u8(f);
    }
    for &m in &out.constraint_miss {
        w.f64(m);
    }
    for &b in &out.entity_moved {
        w.u8(b);
    }
    w.f64(out.diagnostics.residual_norm);
    w.u32(out.diagnostics.rank);
    w.u32(out.diagnostics.dof);
    w.u32(out.diagnostics.iters);
    w.f64(out.diagnostics.ms);
    w.into_bytes()
}

pub fn decode_output(buf: &[u8]) -> Result<Output, CodecError> {
    let mut r = Reader::new(buf);
    if r.u32()? != MAGIC_OUT {
        return Err(CodecError::BadMagic);
    }
    let n_params = r.u32()? as usize;
    let n_status = r.u32()? as usize;
    let vf_len = r.u32()? as usize;
    let n_constraint_status = r.u32()? as usize;
    let n_moved = r.u32()? as usize;
    let overall_status = r.u8()?;
    let mut params_solved = Vec::with_capacity(r.capacity_for(n_params, 8));
    for _ in 0..n_params {
        params_solved.push(r.f64()?);
    }
    let mut entity_status = Vec::with_capacity(r.capacity_for(n_status, 1));
    for _ in 0..n_status {
        entity_status.push(r.u8()?);
    }
    let mut vertex_freedom = Vec::with_capacity(r.capacity_for(vf_len, 8));
    for _ in 0..vf_len {
        vertex_freedom.push(r.f64()?);
    }
    let mut constraint_flags = Vec::with_capacity(r.capacity_for(n_constraint_status, 1));
    for _ in 0..n_constraint_status {
        constraint_flags.push(r.u8()?);
    }
    let mut constraint_miss = Vec::with_capacity(r.capacity_for(n_constraint_status, 8));
    for _ in 0..n_constraint_status {
        constraint_miss.push(r.f64()?);
    }
    let entity_moved = r.take(n_moved)?.to_vec();
    let residual_norm = r.f64()?;
    let rank = r.u32()?;
    let dof = r.u32()?;
    let iters = r.u32()?;
    let ms = r.f64()?;
    Ok(Output {
        params_solved,
        entity_status,
        overall_status,
        vertex_freedom,
        constraint_flags,
        constraint_miss,
        entity_moved,
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
mod tests;
