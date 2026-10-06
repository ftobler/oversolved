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
//!   u32  magic = MATE_MAGIC ("MTS3")
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
//! ## Mate record (fixed length, 112 bytes)
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
//!   f32  weight              // row scale on this mate's residuals/Jacobian (1 for real mates, small for the drag objective)
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
//!   u32  magic = MATE_MAGIC_OUT ("MTR2")
//!   u32  n_params
//!   u8   overall_status
//! params_solved: n_params x f32
//! mate_residuals: u32 n_mates, then n_mates x f64 (L2 norm of each mate's
//!                 weighted residual block, in input mate order)
//! diagnostics:    f64 residual_norm, u32 rank, u32 dof, u32 iters, f64 ms
//! ```

use crate::codec::{finite, CodecError, Reader, Writer};

// The mate wire format is independent of the sketch format (whose magic is
// plain `MAGIC` in sketch-solver/src/codec.rs): the two crates version their
// buffers separately and never read each other's bytes, so the naming
// asymmetry is deliberate and not a rename target.
pub const MATE_MAGIC: u32 = 0x3353_544D; // "MTS3" in LE
pub const MATE_MAGIC_OUT: u32 = 0x3252_544D; // "MTR2" in LE

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
///
/// `Cone` has no formula of its own: every cone arm reuses the cylinder
/// axis-distance formula with the single `Mate.radius`. A cone's radius varies
/// along its axis, so the solve is exact only where the cone's radius equals
/// that value. Modelling it properly needs a per-side radius (and a wire
/// format bump); until then this is a documented approximation, not an error.
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
    /// Row scale `s` on this mate's residual block and Jacobian rows, so its
    /// least-squares contribution is `s^2 * r^2`. Real mates author 1; the live
    /// drag objective authors a small value so it follows the cursor where the
    /// constraints leave a direction free and yields where they do not.
    pub weight: f64,
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
pub struct RigidBody;

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
    /// L2 norm of each solved mate's weighted residual block, in input mate
    /// order. Carried on the wire so the host can mark a mate whose rigid
    /// constraint did not hold without re-deriving the Rust residual formula.
    pub mate_residuals: Vec<f64>,
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
    // a fixed 112 bytes, a param a single f32.
    let mut params_initial = Vec::with_capacity(r.capacity_for(n_params, 4));
    for _ in 0..n_params {
        params_initial.push(finite(r.f32()?)?);
    }

    let mask_len = pinned_mask_bytes(n_bodies);
    let fixed_mask = r.take(mask_len)?.to_vec();

    let mut mates = Vec::with_capacity(r.capacity_for(n_mates, 112));
    for _ in 0..n_mates {
        let kind_byte = r.u8()?;
        let kind = MateKind::from_u8(kind_byte).ok_or(CodecError::BadKind(kind_byte))?;
        let body_a_index = r.u32()?;
        let body_b_index = r.u32()?;

        let ak_a = r.u8()?;
        let anchor_kind_a = AnchorKind::from_u8(ak_a).ok_or(CodecError::BadKind(ak_a))?;
        let ak_b = r.u8()?;
        let anchor_kind_b = AnchorKind::from_u8(ak_b).ok_or(CodecError::BadKind(ak_b))?;

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

        let weight = finite(r.f32()?)? as f64;

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
            weight,
        });
    }

    // `n_bodies` needs no cap of its own: the param-count check above ties it to
    // `n_params`, whose f32s have already been read out of the buffer.
    let bodies = vec![RigidBody; n_bodies];

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

        w.f32(m.weight as f32);
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
    w.u32(out.mate_residuals.len() as u32);
    for &r in &out.mate_residuals {
        w.f64(r);
    }
    w.f64(out.diagnostics.residual_norm);
    w.u32(out.diagnostics.rank);
    w.u32(out.diagnostics.dof);
    w.u32(out.diagnostics.iters);
    w.f64(out.diagnostics.ms);
    w.into_bytes()
}

/// Decode a flat MateOutput buffer. Only in-crate tests read the output back
/// through Rust (the host decodes it on the TS side), so it mirrors
/// `encode_mate_input`'s test-only visibility.
#[cfg(test)]
pub(crate) fn decode_mate_output(buf: &[u8]) -> Result<MateOutput, CodecError> {
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
    let n_mates = r.u32()? as usize;
    let mut mate_residuals = Vec::with_capacity(r.capacity_for(n_mates, 8));
    for _ in 0..n_mates {
        mate_residuals.push(r.f64()?);
    }
    let residual_norm = r.f64()?;
    let rank = r.u32()?;
    let dof = r.u32()?;
    let iters = r.u32()?;
    let ms = r.f64()?;
    Ok(MateOutput {
        params_solved,
        overall_status,
        mate_residuals,
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
mod tests;
