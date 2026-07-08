//! Mate constraint solver types and flat typed-array codec for the WASM boundary.
//!
//! The mate solver reuses `solve_lm` (`lm.rs`) with 3D rigid-body residuals:
//! each rigid body carries 7 params (tx, ty, tz, qx, qy, qz, qw — translation +
//! quaternion rotation). Mates constrain the bodies' relative transforms by
//! comparing anchor geometry (point + axis) in world space.
//!
//! ## Input buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MATE_MAGIC ("MTS1")
//!   u32  n_bodies
//!   u32  n_params            // n_bodies * 7
//!   u32  n_mates
//!   u32  n_fixed_bodies      // informational count
//! bodies:         n_bodies x { body_index u32 (informational) }
//! params_initial: n_params x f32
//! fixed_mask:     ceil(n_bodies / 8) bytes (LSB-first, 1 = body is grounded)
//! mates:          n_mates x mate-record (see below)
//! ```
//!
//! ## Mate record (fixed length, 89 bytes)
//!
//! ```text
//!   u8   kind_code
//!   u32  body_a_index
//!   u32  body_b_index
//!   f32  point_a_x, point_a_y, point_a_z  // anchor point in body A local frame
//!   f32  axis_a_x, axis_a_y, axis_a_z     // anchor axis in body A local frame
//!   f32  point_b_x, point_b_y, point_b_z  // anchor point in body B local frame
//!   f32  axis_b_x, axis_b_y, axis_b_z     // anchor axis in body B local frame
//!   u8   flags                             // bit 0 = flip
//! ```
//!
//! ## Output buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MATE_MAGIC_OUT ("MTR1")
//!   u32  n_params
//!   u8   overall_status
//! params_solved: n_params x f32
//! diagnostics:    f64 residual_norm, u32 rank, u32 dof, u32 iters, f64 ms
//! ```

use crate::codec::{CodecError, Reader, Writer};

pub const MATE_MAGIC: u32 = 0x5331_544D; // "MTS1" in LE
pub const MATE_MAGIC_OUT: u32 = 0x5231_544D; // "MTR1" in LE

/// Mate kinds implemented in Stage 4a.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MateKind {
    Fixed,
    Spherical,
    Parallel,
}

impl MateKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => MateKind::Fixed,
            1 => MateKind::Spherical,
            2 => MateKind::Parallel,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            MateKind::Fixed => 0,
            MateKind::Spherical => 1,
            MateKind::Parallel => 2,
        }
    }
}

/// Pre-resolved anchor geometry for a mate reference.
/// point and axis are in the body's local coordinate frame.
#[derive(Debug, Clone)]
pub struct MateGeometry {
    pub point: [f64; 3],
    pub axis: [f64; 3],
}

/// A mate reference: which body + its anchor geometry in local frame.
#[derive(Debug, Clone)]
pub struct MateRef {
    pub body_index: u32,
    pub geometry: MateGeometry,
}

/// A single mate constraint between two bodies.
#[derive(Debug, Clone)]
pub struct Mate {
    pub kind: MateKind,
    pub a: MateRef,
    pub b: MateRef,
    pub flip: bool,
}

/// Description of a rigid body in the parameter vector.
/// Each body occupies 7 consecutive params (tx, ty, tz, qx, qy, qz, qw).
#[derive(Debug, Clone)]
pub struct RigidBody {
    pub param_offset: usize,
}

/// Input to the mate solver.
#[derive(Debug, Clone)]
pub struct MateInput {
    pub bodies: Vec<RigidBody>,
    /// Flat f32 params: n_bodies * 7 entries (tx, ty, tz, qx, qy, qz, qw).
    pub params_initial: Vec<f32>,
    /// Bitmask: 1 = body is grounded/fixed (its transform is pinned to x0).
    pub fixed_mask: Vec<u8>,
    pub mates: Vec<Mate>,
}

impl MateInput {
    pub fn is_fixed(&self, body_index: usize) -> bool {
        let byte = body_index / 8;
        let bit = body_index % 8;
        self.fixed_mask
            .get(byte)
            .map(|b| (b >> bit) & 1 == 1)
            .unwrap_or(false)
    }
}

impl MateInput {
    pub fn n_bodies(&self) -> usize {
        self.bodies.len()
    }

    pub fn n_params(&self) -> usize {
        self.params_initial.len()
    }

    pub fn n_mates(&self) -> usize {
        self.mates.len()
    }
}

/// Mate solver status, mirroring the sketch solver's Status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MateStatus {
    FullyConstrained,
    Underconstrained,
    Overconstrained,
}

impl MateStatus {
    pub fn to_u8(self) -> u8 {
        match self {
            MateStatus::FullyConstrained => 0,
            MateStatus::Underconstrained => 1,
            MateStatus::Overconstrained => 2,
        }
    }
}

/// Diagnostics from the mate solve.
#[derive(Debug, Clone, Default)]
pub struct MateDiagnostics {
    pub residual_norm: f64,
    pub rank: u32,
    pub dof: u32,
    pub iters: u32,
    pub ms: f64,
}

/// Output of the mate solver.
#[derive(Debug, Clone)]
pub struct MateOutput {
    pub params_solved: Vec<f32>,
    pub overall_status: u8,
    pub diagnostics: MateDiagnostics,
}

// ─── Codec ───

fn pinned_mask_bytes(n_bodies: usize) -> usize {
    n_bodies.div_ceil(8)
}

/// Decode a flat `MateInput` buffer.
pub fn decode_mate_input(buf: &[u8]) -> Result<MateInput, CodecError> {
    let mut r = Reader::new(buf);
    if r.u32()? != MATE_MAGIC {
        return Err(CodecError::BadMagic);
    }
    let n_bodies = r.u32()? as usize;
    let n_params = r.u32()? as usize;
    let n_mates = r.u32()? as usize;
    let _n_fixed_bodies = r.u32()?; // informational

    // Skip per-body index entries (informational).
    for _ in 0..n_bodies {
        r.u32()?;
    }

    let mut params_initial = Vec::with_capacity(n_params);
    for _ in 0..n_params {
        params_initial.push(r.f32()?);
    }

    let mask_len = pinned_mask_bytes(n_bodies);
    let fixed_mask = r.take(mask_len)?.to_vec();

    let mut mates = Vec::with_capacity(n_mates);
    for _ in 0..n_mates {
        let kind_byte = r.u8()?;
        let kind = MateKind::from_u8(kind_byte).ok_or_else(|| CodecError::BadKind(kind_byte))?;
        let body_a_index = r.u32()?;
        let body_b_index = r.u32()?;

        let px_a = r.f32()? as f64;
        let py_a = r.f32()? as f64;
        let pz_a = r.f32()? as f64;
        let ax_a = r.f32()? as f64;
        let ay_a = r.f32()? as f64;
        let az_a = r.f32()? as f64;

        let px_b = r.f32()? as f64;
        let py_b = r.f32()? as f64;
        let pz_b = r.f32()? as f64;
        let ax_b = r.f32()? as f64;
        let ay_b = r.f32()? as f64;
        let az_b = r.f32()? as f64;

        let flags = r.u8()?;
        let flip = (flags & 0b001) != 0;

        mates.push(Mate {
            kind,
            a: MateRef {
                body_index: body_a_index,
                geometry: MateGeometry {
                    point: [px_a, py_a, pz_a],
                    axis: [ax_a, ay_a, az_a],
                },
            },
            b: MateRef {
                body_index: body_b_index,
                geometry: MateGeometry {
                    point: [px_b, py_b, pz_b],
                    axis: [ax_b, ay_b, az_b],
                },
            },
            flip,
        });
    }

    let mut bodies = Vec::with_capacity(n_bodies);
    for i in 0..n_bodies {
        bodies.push(RigidBody {
            param_offset: i * 7,
        });
    }

    Ok(MateInput {
        bodies,
        params_initial,
        fixed_mask,
        mates,
    })
}

/// Encode a MateInput to bytes (test-only — production decode happens on WASM side).
#[cfg(test)]
pub(crate) fn encode_mate_input(input: &MateInput) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(MATE_MAGIC);
    w.u32(input.bodies.len() as u32);
    w.u32(input.params_initial.len() as u32);
    w.u32(input.mates.len() as u32);
    w.u32(0); // n_fixed_bodies placeholder

    for i in 0..input.bodies.len() as u32 {
        w.u32(i);
    }

    for &p in &input.params_initial {
        w.f32(p);
    }

    let mask_len = pinned_mask_bytes(input.bodies.len());
    for i in 0..mask_len {
        w.u8(input.fixed_mask.get(i).copied().unwrap_or(0));
    }

    for m in &input.mates {
        w.u8(m.kind.to_u8());
        w.u32(m.a.body_index);
        w.u32(m.b.body_index);

        w.f32(m.a.geometry.point[0] as f32);
        w.f32(m.a.geometry.point[1] as f32);
        w.f32(m.a.geometry.point[2] as f32);
        w.f32(m.a.geometry.axis[0] as f32);
        w.f32(m.a.geometry.axis[1] as f32);
        w.f32(m.a.geometry.axis[2] as f32);

        w.f32(m.b.geometry.point[0] as f32);
        w.f32(m.b.geometry.point[1] as f32);
        w.f32(m.b.geometry.point[2] as f32);
        w.f32(m.b.geometry.axis[0] as f32);
        w.f32(m.b.geometry.axis[1] as f32);
        w.f32(m.b.geometry.axis[2] as f32);

        let mut flags = 0u8;
        if m.flip {
            flags |= 0b001;
        }
        w.u8(flags);
    }
    w.into_bytes()
}

/// Encode a MateOutput to a flat byte buffer.
pub fn encode_mate_output(out: &MateOutput) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(MATE_MAGIC_OUT);
    w.u32(out.params_solved.len() as u32);
    w.u8(out.overall_status);
    for &p in &out.params_solved {
        w.f32(p);
    }
    w.f64(out.diagnostics.residual_norm);
    w.u32(out.diagnostics.rank);
    w.u32(out.diagnostics.dof);
    w.u32(out.diagnostics.iters);
    w.f64(out.diagnostics.ms);
    w.into_bytes()
}

/// Decode a flat MateOutput buffer.
pub fn decode_mate_output(buf: &[u8]) -> Result<MateOutput, CodecError> {
    let mut r = Reader::new(buf);
    if r.u32()? != MATE_MAGIC_OUT {
        return Err(CodecError::BadMagic);
    }
    let n_params = r.u32()? as usize;
    let overall_status = r.u8()?;
    let mut params_solved = Vec::with_capacity(n_params);
    for _ in 0..n_params {
        params_solved.push(r.f32()?);
    }
    let residual_norm = r.f64()?;
    let rank = r.u32()?;
    let dof = r.u32()?;
    let iters = r.u32()?;
    let ms = r.f64()?;
    Ok(MateOutput {
        params_solved,
        overall_status,
        diagnostics: MateDiagnostics {
            residual_norm,
            rank,
            dof,
            iters,
            ms,
        },
    })
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> MateInput {
        let params: Vec<f32> = vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity
            5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: translated +x
        ];
        let mate = Mate {
            kind: MateKind::Spherical,
            a: MateRef {
                body_index: 0,
                geometry: MateGeometry {
                    point: [0.0, 0.0, 0.0],
                    axis: [0.0, 0.0, 1.0],
                },
            },
            b: MateRef {
                body_index: 1,
                geometry: MateGeometry {
                    point: [0.0, 0.0, 0.0],
                    axis: [0.0, 0.0, 1.0],
                },
            },
            flip: false,
        };
        MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: params,
            fixed_mask: vec![0b0000_0001],
            mates: vec![mate],
        }
    }

    #[test]
    fn mate_input_round_trips() {
        let input = sample_input();
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
        assert!(decoded.is_fixed(0));
        assert!(!decoded.is_fixed(1));
        assert_eq!(encode_mate_input(&decoded), bytes);
    }

    #[test]
    fn mate_output_round_trips() {
        let out = MateOutput {
            params_solved: vec![0.0; 14],
            overall_status: MateStatus::FullyConstrained.to_u8(),
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
    }

    #[test]
    fn mate_input_bad_magic_rejected() {
        let mut bytes = encode_mate_input(&sample_input());
        bytes[0] ^= 0xff;
        assert!(matches!(decode_mate_input(&bytes), Err(CodecError::BadMagic)));
    }

    #[test]
    fn mate_output_bad_magic_rejected() {
        let out = MateOutput {
            params_solved: vec![0.0; 7],
            overall_status: 0,
            diagnostics: MateDiagnostics::default(),
        };
        let mut bytes = encode_mate_output(&out);
        bytes[0] ^= 0xff;
        assert!(matches!(decode_mate_output(&bytes), Err(CodecError::BadMagic)));
    }

    #[test]
    fn mate_input_bad_kind_rejected() {
        let mut bytes = encode_mate_input(&sample_input());
        bytes[85] = 0xff; // kind_code in first mate record
        assert!(matches!(decode_mate_input(&bytes), Err(CodecError::BadKind(_))));
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
    fn parallel_mate_with_flip_round_trips() {
        let input = MateInput {
            bodies: vec![RigidBody { param_offset: 0 }, RigidBody { param_offset: 7 }],
            params_initial: vec![0.0; 14],
            fixed_mask: vec![0],
            mates: vec![Mate {
                kind: MateKind::Parallel,
                a: MateRef {
                    body_index: 0,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0],
                    },
                },
                b: MateRef {
                    body_index: 1,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, -1.0],
                    },
                },
                flip: true,
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
        assert_eq!(MateKind::from_u8(3), None);
        assert_eq!(MateKind::Fixed.to_u8(), 0);
        assert_eq!(MateKind::Spherical.to_u8(), 1);
        assert_eq!(MateKind::Parallel.to_u8(), 2);
    }

    #[test]
    fn is_fixed_reads_mask() {
        let input = MateInput {
            bodies: vec![RigidBody { param_offset: 0 }],
            params_initial: vec![0.0; 7],
            fixed_mask: vec![0b0000_0101],
            mates: vec![],
        };
        assert!(input.is_fixed(0));
        assert!(!input.is_fixed(1));
        assert!(input.is_fixed(2));
        assert!(!input.is_fixed(3));
    }
}
