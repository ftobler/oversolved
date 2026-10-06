//! Shared fixtures and builders for the split mate residual tests.

use crate::mate::*;
use crate::mate_residuals::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn mate_ref(
    body_index: u32,
    px: f64,
    py: f64,
    pz: f64,
    ax: f64,
    ay: f64,
    az: f64,
    ak: AnchorKind,
) -> MateRef {
    MateRef {
        body_index,
        geometry: MateGeometry {
            point: [px, py, pz],
            axis: [ax, ay, az],
            // Every helper here names the +Z axis; this is its canonical
            // perp. A test that needs another frame overrides it directly.
            perp: [0.0, 1.0, 0.0],
        },
        anchor_kind: ak,
    }
}

/// Builds a mate from a SCALAR offset, the pre-vector authoring form: the
/// scalar is expanded to `offset * axis_a` in A's local frame. Every test
/// below that predates the vector widening still calls this, so they double
/// as the back-compat guarantee -- if the vector semantics ever stopped
/// collapsing onto the scalar ones, they would all move.
pub(super) fn mate(
    kind: MateKind,
    a: MateRef,
    b: MateRef,
    flip: bool,
    offset: f64,
    ratio: f64,
    radius: f64,
) -> Mate {
    mate_with_angle(kind, a, b, flip, offset, ratio, radius, 0.0)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn mate_with_angle(
    kind: MateKind,
    a: MateRef,
    b: MateRef,
    flip: bool,
    offset: f64,
    ratio: f64,
    radius: f64,
    angle: f64,
) -> Mate {
    let ax = a.geometry.axis;
    let offset = [offset * ax[0], offset * ax[1], offset * ax[2]];
    Mate {
        kind,
        a,
        b,
        flip,
        offset,
        ratio,
        radius,
        angle,
        weight: 1.0,
    }
}

/// Same as `mate_with_angle` but with the row scale a drag objective uses.
#[allow(clippy::too_many_arguments)]
pub(super) fn mate_weighted(
    kind: MateKind,
    a: MateRef,
    b: MateRef,
    flip: bool,
    offset: f64,
    ratio: f64,
    radius: f64,
    angle: f64,
    weight: f64,
) -> Mate {
    let mut m = mate_with_angle(kind, a, b, flip, offset, ratio, radius, angle);
    m.weight = weight;
    m
}

/// Builds a mate from a full offset VECTOR in A's local frame.
pub(super) fn mate_with_offset_vec(
    kind: MateKind,
    a: MateRef,
    b: MateRef,
    flip: bool,
    offset: [f64; 3],
    ratio: f64,
    radius: f64,
) -> Mate {
    Mate {
        kind,
        a,
        b,
        flip,
        offset,
        ratio,
        radius,
        angle: 0.0,
        weight: 1.0,
    }
}

/// (qz, qw) for a pure roll of `deg` degrees about world Z, qx = qy = 0.
pub(super) fn quat_roll_z(deg: f64) -> (f32, f32) {
    let half = (deg.to_radians() / 2.0).sin();
    let cos_half = (deg.to_radians() / 2.0).cos();
    (half as f32, cos_half as f32)
}

/// Two bodies: body 0 at origin (grounded), body 1 at (5, 0, 0).
/// One spherical mate at (0,0,0) should pull body 1 to body 0.
pub(super) fn two_body_input() -> MateInput {
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity, grounded
            5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: translated +x
        ],
        fixed_mask: vec![0b0000_0001], // body 0 is grounded
        mates: vec![mate(
            MateKind::Spherical,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
            false,
            0.0,
            1.0,
            0.0,
        )],
    }
}

/// A quaternion's rotated local Z axis, for checking alignment without
/// depending on how the solver happened to spell the rotation.
pub(super) fn rotated_z(qx: f64, qy: f64, qz: f64, qw: f64) -> [f64; 3] {
    rotate_vec(qx, qy, qz, qw, &[0.0, 0.0, 1.0])
}

pub(super) fn compare_jacobians(analytical: &DMatrix<f64>, fd: &DMatrix<f64>, tol: f64) {
    for r in 0..analytical.nrows() {
        for c in 0..analytical.ncols() {
            let a = analytical[(r, c)];
            let f = fd[(r, c)];
            let diff = (a - f).abs();
            let denom = f.abs().max(1e-12);
            assert!(
                diff < tol * denom.max(1.0) || diff < tol,
                "row={}, col={}, analytic={}, fd={}, diff={}",
                r,
                c,
                a,
                f,
                diff
            );
        }
    }
}

/// Three spherical mates between a grounded body and a free one pin all
/// six relative DOF. Their rotational constraint directions live in the
/// geometry-proportional Jacobian entries, which is what makes this the
/// sensitive fixture for rank-cutoff scaling: measured spectra were
/// sigma = {40, 28, 28, ...} at unit scale versus {2.3e-6, 2.0e-6,
/// 1.2e-6, ...} at 1e-7 and ~1e-8 values at 1e-9.
pub(super) fn three_spherical_weld_input(scale: f64) -> MateInput {
    let pt = |v: f64| v * scale;
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            (5.0 * scale) as f32,
            scale as f32,
            (2.0 * scale) as f32,
            0.0,
            0.0,
            0.0,
            1.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Spherical,
                mate_ref(0, pt(10.0), 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, pt(10.0), 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, pt(10.0), 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, pt(10.0), 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    }
}

/// CopyRotation pair with both bodies seeded at zero roll about Z.
pub(super) fn copy_rotation_input(ratio: f64, seed_a_deg: f64, seed_b_deg: f64) -> MateInput {
    let q = |deg: f64| {
        let half = deg.to_radians() / 2.0;
        (half.sin() as f32, half.cos() as f32)
    };
    let (qza, qwa) = q(seed_a_deg);
    let (qzb, qwb) = q(seed_b_deg);
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, qza, qwa, 0.0, 0.0, 0.0, 0.0, 0.0, qzb, qwb,
        ],
        // A grounded so the driven-pose tests below cannot be satisfied by
        // rotating the pair jointly; B must do the moving.
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::CopyRotation,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
            false,
            0.0,
            ratio,
            0.0,
        )],
    }
}
