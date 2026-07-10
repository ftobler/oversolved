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
//! ## Mate record (fixed length, 76 bytes)
//!
//! ```text
//!   u8   kind_code
//!   u32  body_a_index
//!   u32  body_b_index
//!   u8   anchor_kind_a       // AnchorKind to_u8
//!   u8   anchor_kind_b
//!   f32  point_a_x, point_a_y, point_a_z  // anchor point in body A local frame
//!   f32  axis_a_x, axis_a_y, axis_a_z     // anchor axis in body A local frame
//!   f32  point_b_x, point_b_y, point_b_z  // anchor point in body B local frame
//!   f32  axis_b_x, axis_b_y, axis_b_z     // anchor axis in body B local frame
//!   u8   flags               // bit 0 = flip
//!   f32  offset              // linear offset along axis (Fixed / ParallelPlaneDistance / Sliding / Tangential)
//!   f32  ratio               // for CopyRotation (gear-like ratio)
//!   f32  radius              // for Tangential (mate-side radius fallback)
//!   f32  angle               // radians, for Fixed's seed-relative roll (TS encodes degrees -> radians)
//! ```
//!
//! There is no version field on this record and nothing persists it: the buffer
//! is built and consumed within a single solve, main thread to WASM, so widening
//! it needs no migration and no dual-read. Contrast the part-bundle format next
//! door, which *is* persisted and does need one.
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

/// All mate kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MateKind {
    Fixed,
    Spherical,
    Parallel,
    Sliding,
    Rotating,
    SlidingRotating,
    Tangential,
    CopyRotation,
    ParallelPlaneDistance,
}

impl MateKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => MateKind::Fixed,
            1 => MateKind::Spherical,
            2 => MateKind::Parallel,
            3 => MateKind::Sliding,
            4 => MateKind::Rotating,
            5 => MateKind::SlidingRotating,
            6 => MateKind::Tangential,
            7 => MateKind::CopyRotation,
            8 => MateKind::ParallelPlaneDistance,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            MateKind::Fixed => 0,
            MateKind::Spherical => 1,
            MateKind::Parallel => 2,
            MateKind::Sliding => 3,
            MateKind::Rotating => 4,
            MateKind::SlidingRotating => 5,
            MateKind::Tangential => 6,
            MateKind::CopyRotation => 7,
            MateKind::ParallelPlaneDistance => 8,
        }
    }
}

/// Anchor surface kinds used by the Tangential mate to select the
/// correct signed-distance formula (plane-plane, plane-cylinder,
/// cylinder-cylinder).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorKind {
    Plane = 0,
    Cylinder = 1,
    Sphere = 2,
    Cone = 3,
    Line = 4,
    Circle = 5,
    Point = 6,
}

impl AnchorKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => AnchorKind::Plane,
            1 => AnchorKind::Cylinder,
            2 => AnchorKind::Sphere,
            3 => AnchorKind::Cone,
            4 => AnchorKind::Line,
            5 => AnchorKind::Circle,
            6 => AnchorKind::Point,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        self as u8
    }
}

/// Pre-resolved anchor geometry for a mate reference.
/// point and axis are in the body's local coordinate frame.
#[derive(Debug, Clone)]
pub struct MateGeometry {
    pub point: [f64; 3],
    pub axis: [f64; 3],
}

/// A mate reference: which body + its anchor geometry in local frame
/// + the anchor's surface kind (used by Tangential formula selection).
#[derive(Debug, Clone)]
pub struct MateRef {
    pub body_index: u32,
    pub geometry: MateGeometry,
    pub anchor_kind: AnchorKind,
}

/// A single mate constraint between two bodies.
#[derive(Debug, Clone)]
pub struct Mate {
    pub kind: MateKind,
    pub a: MateRef,
    pub b: MateRef,
    pub flip: bool,
    /// Linear offset along the shared axis. Used by Fixed, Sliding,
    /// Tangential (plane-plane signed distance), and ParallelPlaneDistance.
    pub offset: f64,
    /// Gear-like ratio for CopyRotation: `roll_b = ratio * roll_a`.
    pub ratio: f64,
    /// Mate-side radius for Tangential when the geometry itself does
    /// not carry one (e.g. a tangent point on a plane to a virtual cylinder).
    pub radius: f64,
    /// Fixed's seed-relative roll target, in radians. Read only by `Fixed`; see
    /// the seed-relative roll residual in `mate_residuals.rs`.
    pub angle: f64,
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
        let kind = MateKind::from_u8(kind_byte).ok_or(CodecError::BadKind(kind_byte))?;
        let body_a_index = r.u32()?;
        let body_b_index = r.u32()?;

        let ak_a = r.u8()?;
        let anchor_kind_a = AnchorKind::from_u8(ak_a)
            .ok_or(CodecError::BadKind(ak_a))?;
        let ak_b = r.u8()?;
        let anchor_kind_b = AnchorKind::from_u8(ak_b)
            .ok_or(CodecError::BadKind(ak_b))?;

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

        let offset = r.f32()? as f64;
        let ratio = r.f32()? as f64;
        let radius = r.f32()? as f64;
        let angle = r.f32()? as f64;

        mates.push(Mate {
            kind,
            a: MateRef {
                body_index: body_a_index,
                geometry: MateGeometry {
                    point: [px_a, py_a, pz_a],
                    axis: [ax_a, ay_a, az_a],
                },
                anchor_kind: anchor_kind_a,
            },
            b: MateRef {
                body_index: body_b_index,
                geometry: MateGeometry {
                    point: [px_b, py_b, pz_b],
                    axis: [ax_b, ay_b, az_b],
                },
                anchor_kind: anchor_kind_b,
            },
            flip,
            offset,
            ratio,
            radius,
            angle,
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

        w.u8(m.a.anchor_kind.to_u8());
        w.u8(m.b.anchor_kind.to_u8());

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

        w.f32(m.offset as f32);
        w.f32(m.ratio as f32);
        w.f32(m.radius as f32);
        w.f32(m.angle as f32);
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

    fn mate_geom(ax: f64, ay: f64, az: f64) -> MateGeometry {
        MateGeometry {
            point: [0.0, 0.0, 0.0],
            axis: [ax as f64, ay as f64, az as f64],
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
            offset: 0.0,
            ratio: 1.0,
            radius: 0.0,
            angle: 0.0,
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
        // In the 76-byte record, kind_code is at offset:
        // header(20) + bodies(8) + params_initial(56) + fixed_mask(1) = 85
        // + kind_code is first byte of mate record
        bytes[85] = 0xff; // kind_code in first mate record
        assert!(matches!(decode_mate_input(&bytes), Err(CodecError::BadKind(_))));
    }

    // A buffer built to the pre-widen 72-byte stride (missing the trailing angle
    // f32) must fail loudly rather than silently reading the next record's
    // kind_code as an angle -- there is only one mate here, so the missing bytes
    // run the reader off the end of the buffer.
    #[test]
    fn mate_input_old_72_byte_stride_rejected() {
        let bytes = encode_mate_input(&sample_input());
        let truncated = &bytes[..bytes.len() - 4];
        assert!(matches!(decode_mate_input(truncated), Err(CodecError::UnexpectedEof)));
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
                    geometry: mate_geom(0.0, 0.0, 1.0),
                    anchor_kind: AnchorKind::Plane,
                },
                b: MateRef {
                    body_index: 1,
                    geometry: mate_geom(0.0, 0.0, -1.0),
                    anchor_kind: AnchorKind::Plane,
                },
                flip: true,
                offset: 0.0,
                ratio: 1.0,
                radius: 0.0,
                angle: 0.0,
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
            bodies: vec![RigidBody { param_offset: 0 }, RigidBody { param_offset: 7 }],
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
                offset: 1.5,
                ratio: 2.0,
                radius: 3.0,
                angle: 0.7,
            }],
        };
        let decoded = decode_mate_input(&encode_mate_input(&input)).expect("decode");
        let m = &decoded.mates[0];
        assert!((m.offset - 1.5).abs() < 1e-4);
        assert!((m.ratio - 2.0).abs() < 1e-4);
        assert!((m.radius - 3.0).abs() < 1e-4);
        assert!((m.angle - 0.7).abs() < 1e-4);
    }

    #[test]
    fn anchor_kinds_round_trip() {
        for code in 0..=6u8 {
            let kind = AnchorKind::from_u8(code).unwrap();
            assert_eq!(kind.to_u8(), code);
        }
        assert_eq!(AnchorKind::from_u8(7), None);
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

    #[test]
    fn all_mate_kinds_decode() {
        for code in 0..=8u8 {
            let kind = MateKind::from_u8(code).unwrap();
            assert_eq!(kind.to_u8(), code);
        }
    }
}
