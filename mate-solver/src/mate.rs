//! Mate constraint solver types and flat typed-array codec for the WASM boundary.
//!
//! The mate solver reuses `solve_lm` (`solver_core::lm`) with 3D rigid-body residuals:
//! each rigid body carries 7 params (tx, ty, tz, qx, qy, qz, qw - translation +
//! quaternion rotation). Mates constrain the bodies' relative transforms by
//! comparing anchor geometry (point + axis) in world space.
//!
//! ## Input buffer layout
//!
//! ```text
//! header:
//!   u32  magic = MATE_MAGIC ("MTS2")
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
//! ## Mate record (fixed length, 108 bytes)
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
//!   f32  offset_x, offset_y, offset_z  // offset vector in body A's LOCAL frame
//!   f32  ratio               // for CopyRotation (gear-like ratio)
//!   f32  radius              // for Tangential (mate-side radius fallback)
//!   f32  angle               // radians, Fixed/Sliding's absolute roll target (TS encodes degrees -> radians)
//!   f32  perp_a_x, perp_a_y, perp_a_z  // canonical in-plane frame of A's LOCAL axis
//!   f32  perp_b_x, perp_b_y, perp_b_z  // canonical in-plane frame of B's LOCAL axis
//! ```
//!
//! There is no per-record version field: the header magic is the version
//! handshake. Any change to this record's shape, field meaning or stride MUST
//! bump `MATE_MAGIC` in the same commit on both sides (this file and
//! frontend/src/kernel/solveAssembly.ts). The buffer is built and consumed
//! within one solve, but the WASM decoder is fetched from a fixed, unhashed URL
//! and can be a stale cache, so the magic is what makes a width mismatch fail
//! loud instead of being silently dropped. The strides below are additionally
//! pinned against tests/fixtures/mate_wire.txt.
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

use crate::codec::{finite, CodecError, Reader, Writer};

pub const MATE_MAGIC: u32 = 0x3253_544D; // "MTS2" in LE
pub const MATE_MAGIC_OUT: u32 = 0x5231_544D; // tag "MTR1"; its LE bytes read "MT1R"

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
    /// Every variant, in wire-code order. `all_mate_kinds_decode` iterates this
    /// instead of a hand-typed `0..=8`, so a variant missing from `from_u8`
    /// fails the round trip rather than falling outside a hardcoded range.
    pub const ALL: [MateKind; 9] = [
        MateKind::Fixed,
        MateKind::Spherical,
        MateKind::Parallel,
        MateKind::Sliding,
        MateKind::Rotating,
        MateKind::SlidingRotating,
        MateKind::Tangential,
        MateKind::CopyRotation,
        MateKind::ParallelPlaneDistance,
    ];

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
/// cylinder-cylinder). Only Plane, Cylinder and Cone have dedicated
/// formulas; every pair containing a Sphere, Line, Circle, Point or
/// Torus lands in `tangential_residual`'s point-to-point fallback
/// (see the caveat there: it is geometrically right only for centre
/// anchors and reports no error otherwise), which replaces the
/// TS-side `?? 0` coercion this enum was introduced for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorKind {
    Plane = 0,
    Cylinder = 1,
    Sphere = 2,
    Cone = 3,
    Line = 4,
    Circle = 5,
    Point = 6,
    Torus = 7,
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
            7 => AnchorKind::Torus,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        self as u8
    }
}

/// Pre-resolved anchor geometry for a mate reference.
/// point and axis are in the body's local coordinate frame. `perp` is the
/// canonical in-plane reference direction of `axis` (the editor's canonicalPerp,
/// utils/mateOrientation.ts), carried on the wire so the roll residual measures
/// against the frame the authored `angle` was captured with.
#[derive(Debug, Clone)]
pub struct MateGeometry {
    pub point: [f64; 3],
    pub axis: [f64; 3],
    pub perp: [f64; 3],
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
    /// Offset vector expressed in body A's LOCAL frame, so it rotates with A:
    /// the world offset is `R_a * offset`. Read by Fixed (all three components,
    /// as a full 3D translation), and by Tangential and ParallelPlaneDistance
    /// through `axial_offset` (those residuals are a single signed distance).
    /// The pre-vector scalar form is a special case of this one: a scalar `s`
    /// is `s * axis_a` in A's local frame, and `R_a * (s * axis_a) = s * a_w`
    /// is exactly what the scalar residual used to subtract.
    pub offset: [f64; 3],
    /// Gear-like ratio for CopyRotation: `roll_b = ratio * roll_a`.
    pub ratio: f64,
    /// Mate-side radius for Tangential when the geometry itself does
    /// not carry one (e.g. a tangent point on a plane to a virtual cylinder).
    pub radius: f64,
    /// Fixed's seed-relative roll target, in radians. Read only by `Fixed`; see
    /// the seed-relative roll residual in `mate_residuals.rs`.
    pub angle: f64,
}

impl Mate {
    /// The offset's signed length along A's anchor axis.
    ///
    /// Residuals that are a single distance measured along that axis
    /// (Tangential's clearance, ParallelPlaneDistance's plane separation) read
    /// only this component: the perpendicular part of the offset points along
    /// DOF those mates deliberately leave free, so it has nowhere to act. A
    /// rotation preserves dot products, so measuring the local offset against
    /// the local axis is the same as measuring `R_a * offset` against `a_w` --
    /// which is why this stays a pose-independent constant and the Jacobians of
    /// those two kinds are unchanged by the widening.
    ///
    /// A degenerate (zero) axis yields 0 rather than NaN, matching the
    /// fail-safe posture of `normalise_axis` in `mate_residuals.rs`.
    pub fn axial_offset(&self) -> f64 {
        let a = &self.a.geometry.axis;
        let n2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
        if n2 < 1e-20 {
            return 0.0;
        }
        (self.offset[0] * a[0] + self.offset[1] * a[1] + self.offset[2] * a[2]) / n2.sqrt()
    }
}

/// Description of a rigid body in the parameter vector.
/// Each body occupies 7 consecutive params (tx, ty, tz, qx, qy, qz, qw); the
/// body's block starts at `index * 7`, which every reader derives directly, so
/// the struct carries no offset field of its own.
#[derive(Debug, Clone)]
pub struct RigidBody {}

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

    // The layout fixes 7 params per body and every residual reads a body's block
    // as `body_index * 7`, so a header whose two counts disagree describes a
    // buffer nothing downstream can index safely. Reject it here rather than
    // running off the end of `params_initial` mid-solve. `checked_mul` because
    // the counts come off the wire: on wasm32 an unchecked `n_bodies * 7`
    // wraps, and a crafted pair like (613_566_757, 3) wraps back onto a match
    // that would sail through this gate.
    if n_bodies.checked_mul(7) != Some(n_params) {
        return Err(CodecError::ParamCountMismatch);
    }

    // Skip per-body index entries (informational).
    for _ in 0..n_bodies {
        r.u32()?;
    }

    // Header counts are untrusted; see `Reader::capacity_for`. A mate record is
    // a fixed 108 bytes, a param a single f32.
    let mut params_initial = Vec::with_capacity(r.capacity_for(n_params, 4));
    for _ in 0..n_params {
        params_initial.push(finite(r.f32()?)?);
    }

    let mask_len = pinned_mask_bytes(n_bodies);
    let fixed_mask = r.take(mask_len)?.to_vec();

    let mut mates = Vec::with_capacity(r.capacity_for(n_mates, 108));
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

        let px_a = finite(r.f32()?)? as f64;
        let py_a = finite(r.f32()?)? as f64;
        let pz_a = finite(r.f32()?)? as f64;
        let ax_a = finite(r.f32()?)? as f64;
        let ay_a = finite(r.f32()?)? as f64;
        let az_a = finite(r.f32()?)? as f64;

        let px_b = finite(r.f32()?)? as f64;
        let py_b = finite(r.f32()?)? as f64;
        let pz_b = finite(r.f32()?)? as f64;
        let ax_b = finite(r.f32()?)? as f64;
        let ay_b = finite(r.f32()?)? as f64;
        let az_b = finite(r.f32()?)? as f64;

        let flags = r.u8()?;
        let flip = (flags & 0b001) != 0;

        let offset = [
            finite(r.f32()?)? as f64,
            finite(r.f32()?)? as f64,
            finite(r.f32()?)? as f64,
        ];
        let ratio = finite(r.f32()?)? as f64;
        let radius = finite(r.f32()?)? as f64;
        let angle = finite(r.f32()?)? as f64;

        let perp_a = [
            finite(r.f32()?)? as f64,
            finite(r.f32()?)? as f64,
            finite(r.f32()?)? as f64,
        ];
        let perp_b = [
            finite(r.f32()?)? as f64,
            finite(r.f32()?)? as f64,
            finite(r.f32()?)? as f64,
        ];

        mates.push(Mate {
            kind,
            a: MateRef {
                body_index: body_a_index,
                geometry: MateGeometry {
                    point: [px_a, py_a, pz_a],
                    axis: [ax_a, ay_a, az_a],
                    perp: perp_a,
                },
                anchor_kind: anchor_kind_a,
            },
            b: MateRef {
                body_index: body_b_index,
                geometry: MateGeometry {
                    point: [px_b, py_b, pz_b],
                    axis: [ax_b, ay_b, az_b],
                    perp: perp_b,
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

    // `n_bodies` needs no cap of its own: the param-count check above ties it to
    // `n_params`, whose f32s have already been read out of the buffer.
    let bodies = vec![RigidBody {}; n_bodies];

    Ok(MateInput {
        bodies,
        params_initial,
        fixed_mask,
        mates,
    })
}

/// Encode a MateInput to bytes (test-only - production decode happens on WASM side).
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

        w.f32(m.offset[0] as f32);
        w.f32(m.offset[1] as f32);
        w.f32(m.offset[2] as f32);
        w.f32(m.ratio as f32);
        w.f32(m.radius as f32);
        w.f32(m.angle as f32);

        w.f32(m.a.geometry.perp[0] as f32);
        w.f32(m.a.geometry.perp[1] as f32);
        w.f32(m.a.geometry.perp[2] as f32);
        w.f32(m.b.geometry.perp[0] as f32);
        w.f32(m.b.geometry.perp[1] as f32);
        w.f32(m.b.geometry.perp[2] as f32);
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
    let mut params_solved = Vec::with_capacity(r.capacity_for(n_params, 4));
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

    /// The shared wire fixture (tests/fixtures/mate_wire.txt), read by both the
    /// Rust and TS wire tests so a stride or magic change cannot pass without a
    /// matching edit in one visible place. Values may be decimal or `0x` hex.
    fn fixture_u64(key: &str) -> u64 {
        let text = include_str!("../../tests/fixtures/mate_wire.txt");
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
            axis: [ax as f64, ay as f64, az as f64],
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
        };
        MateInput {
            bodies: (0..2).map(|_| RigidBody {}).collect(),
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
        // two-body assembly is a well-formed 108-byte record, so decode keeps it
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
        // In the 108-byte record, kind_code is at offset:
        // header(20) + bodies(8) + params_initial(56) + fixed_mask(1) = 85
        // + kind_code is first byte of mate record
        bytes[85] = 0xff; // kind_code in first mate record
        assert!(matches!(decode_mate_input(&bytes), Err(CodecError::BadKind(_))));
    }

    // A buffer built to the pre-widen 76-byte stride (scalar offset, before it
    // became a 3-component vector) must fail loudly rather than silently reading
    // ratio/radius/angle out of the shifted positions -- there is only one mate
    // here, so the missing bytes run the reader off the end of the buffer. The
    // encoder and the TS side move in lockstep or not at all.
    #[test]
    fn mate_input_old_76_byte_stride_rejected() {
        let bytes = encode_mate_input(&sample_input());
        let truncated = &bytes[..bytes.len() - 8];
        assert!(matches!(decode_mate_input(truncated), Err(CodecError::UnexpectedEof)));
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
            bodies: vec![RigidBody {}, RigidBody {}],
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
            bodies: vec![RigidBody {}, RigidBody {}],
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
    fn mate_record_is_108_bytes() {
        let one = encode_mate_input(&sample_input()).len();
        let mut two_mates = sample_input();
        let extra = two_mates.mates[0].clone();
        two_mates.mates.push(extra);
        let stride = encode_mate_input(&two_mates).len() - one;
        assert_eq!(stride as u64, fixture_u64("record_bytes"));
        assert_eq!(stride, 108);
    }

    /// The Rust half of the cross-language wire lock: the constants and stride
    /// must equal tests/fixtures/mate_wire.txt, which the TS byte-size test
    /// reads too. The fixture puts the magic-bump rule in front of the editor.
    #[test]
    fn mate_wire_fixture_matches_the_constants() {
        assert_eq!(fixture_u64("rev"), 2);
        assert_eq!(MATE_MAGIC as u64, fixture_u64("magic"));
        assert_eq!(MATE_MAGIC_OUT as u64, fixture_u64("magic_out"));
    }

    // A stale decoder can meet a fresh encoder (the WASM is served from a fixed,
    // unhashed URL). The old rev's magic must be rejected, not silently decoded
    // with the new fields dropped.
    #[test]
    fn stale_magic_is_rejected() {
        let mut bytes = encode_mate_input(&sample_input());
        bytes[0..4].copy_from_slice(&0x5331_544Du32.to_le_bytes());
        assert!(matches!(decode_mate_input(&bytes), Err(CodecError::BadMagic)));
    }

    /// The axial reduction Tangential and ParallelPlaneDistance read. A scalar
    /// offset `s` was authored as `s * axis_a`, and this must give back exactly
    /// `s` -- that identity is the whole back-compat guarantee for those kinds.
    #[test]
    fn axial_offset_recovers_the_scalar_form() {
        let axis = [0.0, 0.6, 0.8];  // unit, deliberately not a cardinal direction
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
            bodies: vec![RigidBody {}],
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
            assert_eq!(kind.to_u8() as usize, code, "kind codes are contiguous from 0");
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
}
