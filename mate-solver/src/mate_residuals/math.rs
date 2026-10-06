//! Shared quaternion, 3-vector and roll-angle helpers for the mate
//! residuals and Jacobian. Split out of `mate_residuals.rs`; the formulas
//! are unchanged. Visibility is `pub(super)` because the residual builders
//! and the Jacobian fillers live in sibling modules.

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
