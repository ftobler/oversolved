//! Shared quaternion, 3-vector and roll-angle helpers for the mate
//! residuals and Jacobian. Split out of `mate_residuals.rs`; the residual
//! formulas are unchanged, and the manifold helpers at the bottom are the
//! ones the rotation-increment state composes through. Visibility is
//! `pub(super)` because the residual builders and the Jacobian fillers live
//! in sibling modules.

// ─── Quaternion / transform helpers ───

/// Quaternion to 3x3 rotation matrix.
/// Layout: [r00, r01, r02, r10, r11, r12, r20, r21, r22].
pub(super) fn rot_matrix(qx: f64, qy: f64, qz: f64, qw: f64) -> [f64; 9] {
    let qx2 = qx * qx;
    let qy2 = qy * qy;
    let qz2 = qz * qz;
    [
        1.0 - 2.0 * (qy2 + qz2),
        2.0 * (qx * qy - qz * qw),
        2.0 * (qx * qz + qy * qw),
        2.0 * (qx * qy + qz * qw),
        1.0 - 2.0 * (qx2 + qz2),
        2.0 * (qy * qz - qx * qw),
        2.0 * (qx * qz - qy * qw),
        2.0 * (qy * qz + qx * qw),
        1.0 - 2.0 * (qx2 + qy2),
    ]
}

/// Rotate a 3-vector by a quaternion: R(q) * v.
pub(super) fn rotate_vec(qx: f64, qy: f64, qz: f64, qw: f64, v: &[f64; 3]) -> [f64; 3] {
    let r = rot_matrix(qx, qy, qz, qw);
    [
        r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
        r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
        r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
    ]
}

/// Transform a local point to world space: R(q) * p + t.
pub(super) fn world_point(x: &[f64], offset: usize, p: &[f64; 3]) -> [f64; 3] {
    let tx = x[offset];
    let ty = x[offset + 1];
    let tz = x[offset + 2];
    let qx = x[offset + 3];
    let qy = x[offset + 4];
    let qz = x[offset + 5];
    let qw = x[offset + 6];
    let r = rotate_vec(qx, qy, qz, qw, p);
    [r[0] + tx, r[1] + ty, r[2] + tz]
}

/// Transform a local direction to world space: R(q) * d (no translation).
pub(super) fn world_direction(x: &[f64], offset: usize, d: &[f64; 3]) -> [f64; 3] {
    let qx = x[offset + 3];
    let qy = x[offset + 4];
    let qz = x[offset + 5];
    let qw = x[offset + 6];
    rotate_vec(qx, qy, qz, qw, d)
}

/// Normalise a direction vector to unit length (or return identity if zero).
pub(super) fn normalise_axis(v: &[f64; 3]) -> [f64; 3] {
    let n2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if n2 < 1e-20 {
        return [0.0, 0.0, 1.0];
    }
    let inv = 1.0 / n2.sqrt();
    [v[0] * inv, v[1] * inv, v[2] * inv]
}

// ─── Manifold rotation state (rotation vector increments over a unit reference) ───

/// Quaternion product `a * b` (apply `b` first, then `a`), (x, y, z, w) layout.
pub(super) fn quat_mul(a: &[f64; 4], b: &[f64; 4]) -> [f64; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

/// Unit quaternion closest to `q`. A zero (or degenerate) quaternion reads as
/// the identity rather than NaN: the seed comes from a host buffer the codec
/// gates for finiteness, not for norm, so a zero quaternion is legal input.
pub(super) fn quat_normalize(q: &[f64; 4]) -> [f64; 4] {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if !(n.is_finite() && n > 0.0) {
        return [0.0, 0.0, 0.0, 1.0];
    }
    let inv = 1.0 / n;
    [q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv]
}

/// Unit quaternion of the rotation vector `w` (axis times angle), the
/// `exp(w)` the manifold state composes onto its reference. The small-angle
/// branch keeps `exp(0)` exactly the identity, so a body at its seed composes
/// back to the reference quaternion itself instead of a rounded copy of it.
pub(super) fn quat_exp(w: &[f64; 3]) -> [f64; 4] {
    let theta2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
    if theta2 < 1e-16 {
        // sin(t/2)/t and cos(t/2) to second order; exact enough that the two
        // branches agree to well below one ulp at the switch point.
        let s = 0.5 - theta2 / 48.0;
        return [w[0] * s, w[1] * s, w[2] * s, 1.0 - theta2 / 8.0];
    }
    let theta = theta2.sqrt();
    let s = (0.5 * theta).sin() / theta;
    [w[0] * s, w[1] * s, w[2] * s, (0.5 * theta).cos()]
}

/// `d(exp(w) * q_ref)/dw`, the 4x3 chain the manifold Jacobian applies to the
/// existing per-kind quaternion derivatives (row per quaternion component,
/// column per rotation-vector component).
///
/// With `p = exp(w)` and `q = p * q_ref`, the chain factorises as
/// `dq/dw = (dq/dp) * (dp/dw)`: the left factor is the constant
/// `[[qw*I - [q_vec]_x], [-q_vec]]` of `q_ref` (and `q_ref` itself for the
/// scalar half), the right factor the derivative of the rotation-vector
/// exponential. It is exact at EVERY `w`, which is what lets the LM state keep
/// `w` relative to the seed instead of folding every accepted step back into
/// a reference: no re-linearisation point is ever stale.
pub(super) fn dexp_drot(q_ref: &[f64; 4], w: &[f64; 3]) -> [[f64; 3]; 4] {
    let (rx, ry, rz, rw) = (q_ref[0], q_ref[1], q_ref[2], q_ref[3]);
    let theta2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];

    // d(exp(w))/dw split into its vector and scalar halves:
    //   d p_vec / d w = f(w) I + (f'(t)/t) * w w^T   with f(t) = sin(t/2)/t
    //   d p_w   / d w = -(sin(t/2) / (2t)) * w^T
    // The small-angle branch uses the same series `quat_exp` does, so both
    // halves stay continuous (and exact for w = 0) across the switch point.
    let (f, fp_over_t, sin_half_over_2t): (f64, f64, f64) = if theta2 < 1e-16 {
        (
            0.5 - theta2 / 48.0,
            -1.0 / 24.0 + theta2 / 960.0,
            -0.25 + theta2 / 96.0,
        )
    } else {
        let theta = theta2.sqrt();
        let half = 0.5 * theta;
        let (s, c) = (half.sin(), half.cos());
        (
            s / theta,
            (0.5 * c * theta - s) / (theta * theta * theta),
            -s / (2.0 * theta),
        )
    };
    let mut dp_dv = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            dp_dv[i][j] = if i == j { f } else { 0.0 } + fp_over_t * w[i] * w[j];
        }
    }
    let dp_dw: [f64; 3] = [
        sin_half_over_2t * w[0],
        sin_half_over_2t * w[1],
        sin_half_over_2t * w[2],
    ];

    // Left factor of the chain, dq/dp: its vector rows are rw*I - [q_vec]_x
    // and its scalar row -q_vec^T (from q = p * q_ref, differentiating the
    // vector half), plus [q_vec; rw] for the scalar half of p.
    let skew = [[0.0, -rz, ry], [rz, 0.0, -rx], [-ry, rx, 0.0]];
    let q_vec = [rx, ry, rz];
    let mut out = [[0.0; 3]; 4];
    for i in 0..3 {
        for c in 0..3 {
            let mut acc = q_vec[i] * dp_dw[c];
            for k in 0..3 {
                let left = if i == k { rw } else { 0.0 } - skew[i][k];
                acc += left * dp_dv[k][c];
            }
            out[i][c] = acc;
        }
    }
    for c in 0..3 {
        let mut acc = rw * dp_dw[c];
        for k in 0..3 {
            acc += -q_vec[k] * dp_dv[k][c];
        }
        out[3][c] = acc;
    }
    out
}

// ─── Derivatives of rotation with respect to quaternion components ───

/// Compute ∂(R(q)*v)/∂q_i. Returns array of 4 triplets (one per qi), each a 3-vector.
pub(super) fn drot_vec_dq(qx: f64, qy: f64, qz: f64, qw: f64, v: &[f64; 3]) -> [[f64; 3]; 4] {
    let vx = v[0];
    let vy = v[1];
    let vz = v[2];
    // ∂R/∂qx * v
    let dqx = [
        0.0 * vx + 2.0 * qy * vy + 2.0 * qz * vz,
        2.0 * qy * vx + (-4.0 * qx) * vy + (-2.0 * qw) * vz,
        2.0 * qz * vx + 2.0 * qw * vy + (-4.0 * qx) * vz,
    ];
    // ∂R/∂qy * v
    let dqy = [
        (-4.0 * qy) * vx + 2.0 * qx * vy + 2.0 * qw * vz,
        2.0 * qx * vx + 0.0 * vy + 2.0 * qz * vz,
        (-2.0 * qw) * vx + 2.0 * qz * vy + (-4.0 * qy) * vz,
    ];
    // ∂R/∂qz * v
    let dqz = [
        (-4.0 * qz) * vx + (-2.0 * qw) * vy + 2.0 * qx * vz,
        2.0 * qw * vx + (-4.0 * qz) * vy + 2.0 * qy * vz,
        2.0 * qx * vx + 2.0 * qy * vy + 0.0 * vz,
    ];
    // ∂R/∂qw * v
    let dqw = [
        0.0 * vx + (-2.0 * qz) * vy + 2.0 * qy * vz,
        2.0 * qz * vx + 0.0 * vy + (-2.0 * qx) * vz,
        (-2.0 * qy) * vx + 2.0 * qx * vy + 0.0 * vz,
    ];
    [dqx, dqy, dqz, dqw]
}

/// Cross product of two 3-vectors.
pub(super) fn cross3(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Compute the signed twist (roll) angle of quaternion q around world axis w.
/// Returns 2 * atan2(dot(q_vec, w), q_w), in radians.
pub(super) fn twist_angle(qx: f64, qy: f64, qz: f64, qw: f64, w: &[f64; 3]) -> f64 {
    let proj = qx * w[0] + qy * w[1] + qz * w[2];
    2.0 * proj.atan2(qw)
}

/// The axis-alignment sign an authored `flip` selects: parallel (+1) or
/// anti-parallel (-1). Authored data, never derived from the seed pose.
pub(super) fn axis_sign(flip: bool) -> f64 {
    if flip {
        -1.0
    } else {
        1.0
    }
}

/// Wrap an angle difference into (-pi, pi].
pub(super) fn wrap_to_pi(v: f64) -> f64 {
    use std::f64::consts::PI;
    let d = (v + PI).rem_euclid(2.0 * PI) - PI;
    // rem_euclid maps an exact +pi input to -pi; keep the closed end at +pi so
    // an authored 180 deg target is representable without a sign surprise.
    if d == -PI {
        PI
    } else {
        d
    }
}

/// Gradient of twist_angle w.r.t. quaternion components.
/// ∂(2 * atan2(a, b))/∂a = 2*b/(a²+b²), ∂/∂b = -2*a/(a²+b²)
/// where a = dot(q_vec, w), b = q_w.
/// Returns [∂f/∂qx, ∂f/∂qy, ∂f/∂qz, ∂f/∂qw].
pub(super) fn twist_gradient(qx: f64, qy: f64, qz: f64, qw: f64, w: &[f64; 3]) -> [f64; 4] {
    let a = qx * w[0] + qy * w[1] + qz * w[2];
    let denom = a * a + qw * qw;
    if denom < 1e-20 {
        return [0.0; 4];
    }
    let dua = 2.0 * qw / denom;
    let dub = -2.0 * a / denom;
    [dua * w[0], dua * w[1], dua * w[2], dub]
}
