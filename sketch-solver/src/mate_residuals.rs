//! Mate residual builders and analytic Jacobian for the 3D rigid-body solver.
//!
//! Each rigid body carries 7 params: translation (tx, ty, tz) followed by a
//! unit quaternion (qx, qy, qz, qw). The solver reuses `solve_lm` (`lm.rs`) via
//! the closures `residuals(x)` and `jacobian(x, n)` built by `MateProblem`.
//!
//! Residuals per mate kind:
//! - Fixed:      point coincidence (3) + axis cross product (3)
//! - Spherical:  point coincidence (3)
//! - Parallel:   dot product of the two world-space axes minus ±1 (1)
//!
//! Global soft residuals:
//! - Quaternion unit-norm per body (1 residual each)
//! - Grounded-body pin per param (7 residuals each)

use nalgebra::DMatrix;

use crate::lm;
use crate::mate::{
    Mate, MateDiagnostics, MateInput, MateKind, MateOutput, MateStatus, RigidBody,
};

/// Pre-built problem: holds decodings from MateInput for fast residual/Jacobian eval.
pub struct MateProblem {
    /// Number of scalar params (n_bodies * 7).
    n: usize,
    /// Copy of the seed params widened to f64.
    x0: Vec<f64>,
    /// Mates with local geometry.
    mates: Vec<Mate>,
    /// Per-body param offsets.
    bodies: Vec<RigidBody>,
    /// Which bodies are grounded (grounded = not movable).
    grounded: Vec<bool>,
    /// Total residual count m.
    m: usize,
}

impl MateProblem {
    pub fn new(input: &MateInput) -> Self {
        let n_bodies = input.bodies.len();
        let n = n_bodies * 7;
        let grounded: Vec<bool> = (0..n_bodies).map(|i| input.is_fixed(i)).collect();

        let mut mate_residual_count = 0usize;
        for m in &input.mates {
            mate_residual_count += match m.kind {
                MateKind::Fixed => 6,
                MateKind::Spherical => 3,
                MateKind::Parallel => 1,
            };
        }

        let m = mate_residual_count + n_bodies + 7 * grounded.iter().filter(|&&g| g).count();
        let x0: Vec<f64> = input.params_initial.iter().map(|&p| p as f64).collect();

        MateProblem {
            n,
            x0,
            mates: input.mates.clone(),
            bodies: input.bodies.clone(),
            grounded,
            m,
        }
    }

    /// Build the residuals closure for `solve_lm`.
    pub fn residuals_fn(&self) -> impl Fn(&[f64]) -> Vec<f64> + '_ {
        |x: &[f64]| self.residuals(x)
    }

    /// Build the dense Jacobian closure for `solve_lm`.
    pub fn jacobian_fn(&self) -> impl Fn(&[f64]) -> DMatrix<f64> + '_ {
        |x: &[f64]| self.jacobian(x)
    }
}

// ─── Quaternion / transform helpers ───

/// Quaternion to 3x3 rotation matrix.
/// Layout: [r00, r01, r02, r10, r11, r12, r20, r21, r22].
fn rot_matrix(qx: f64, qy: f64, qz: f64, qw: f64) -> [f64; 9] {
    let qx2 = qx * qx;
    let qy2 = qy * qy;
    let qz2 = qz * qz;
    [
        1.0 - 2.0 * (qy2 + qz2), 2.0 * (qx * qy - qz * qw), 2.0 * (qx * qz + qy * qw),
        2.0 * (qx * qy + qz * qw), 1.0 - 2.0 * (qx2 + qz2), 2.0 * (qy * qz - qx * qw),
        2.0 * (qx * qz - qy * qw), 2.0 * (qy * qz + qx * qw), 1.0 - 2.0 * (qx2 + qy2),
    ]
}

/// Rotate a 3-vector by a quaternion: R(q) * v.
fn rotate_vec(qx: f64, qy: f64, qz: f64, qw: f64, v: &[f64; 3]) -> [f64; 3] {
    let r = rot_matrix(qx, qy, qz, qw);
    [
        r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
        r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
        r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
    ]
}

/// Transform a local point to world space: R(q) * p + t.
fn world_point(x: &[f64], offset: usize, p: &[f64; 3]) -> [f64; 3] {
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
fn world_direction(x: &[f64], offset: usize, d: &[f64; 3]) -> [f64; 3] {
    let qx = x[offset + 3];
    let qy = x[offset + 4];
    let qz = x[offset + 5];
    let qw = x[offset + 6];
    rotate_vec(qx, qy, qz, qw, d)
}

// ─── Derivatives of rotation with respect to quaternion components ───

/// Compute ∂(R(q)*v)/∂q_i. Returns array of 4 triplets (one per qi), each a 3-vector.
fn drot_vec_dq(qx: f64, qy: f64, qz: f64, qw: f64, v: &[f64; 3]) -> [[f64; 3]; 4] {
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

// ─── Residuals ───

impl MateProblem {
    fn get_quat(&self, x: &[f64], body_idx: usize) -> (f64, f64, f64, f64) {
        let off = body_idx * 7;
        (x[off + 3], x[off + 4], x[off + 5], x[off + 6])
    }

    /// Compute the full residual vector at x.
    fn residuals(&self, x: &[f64]) -> Vec<f64> {
        let mut r = Vec::with_capacity(self.m);

        // Mate residuals.
        for mate in &self.mates {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;

            match mate.kind {
                MateKind::Fixed => {
                    // Point coincidence: p_a_world - p_b_world.
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    r.push(pa[0] - pb[0]);
                    r.push(pa[1] - pb[1]);
                    r.push(pa[2] - pb[2]);
                    // Axis cross product: crosses_a = cross(axis_a_w, axis_b_w).
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let cx = a_w[1] * b_w[2] - a_w[2] * b_w[1];
                    let cy = a_w[2] * b_w[0] - a_w[0] * b_w[2];
                    let cz = a_w[0] * b_w[1] - a_w[1] * b_w[0];
                    r.push(cx);
                    r.push(cy);
                    r.push(cz);
                }
                MateKind::Spherical => {
                    // Point coincidence only.
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    r.push(pa[0] - pb[0]);
                    r.push(pa[1] - pb[1]);
                    r.push(pa[2] - pb[2]);
                }
                MateKind::Parallel => {
                    // Dot product of the two world-space axes minus sign.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let dot = a_w[0] * b_w[0] + a_w[1] * b_w[1] + a_w[2] * b_w[2];
                    let sign = if mate.flip { -1.0 } else { 1.0 };
                    r.push(dot - sign);
                }
            }
        }

        // Quaternion unit-norm soft residuals (one per body).
        for bi in 0..self.bodies.len() {
            let (qx, qy, qz, qw) = self.get_quat(x, bi);
            r.push(qx * qx + qy * qy + qz * qz + qw * qw - 1.0);
        }

        // Grounded-body pin residuals (pull each param to x0).
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] {
                let off = bi * 7;
                for j in 0..7 {
                    r.push(x[off + j] - self.x0[off + j]);
                }
            }
        }

        r
    }

    /// Build the full dense Jacobian (m × n) at x.
    fn jacobian(&self, x: &[f64]) -> DMatrix<f64> {
        let mut j = DMatrix::zeros(self.m, self.n);
        let mut row = 0usize;

        // Mate residuals.
        for mate in &self.mates {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;

            match mate.kind {
                MateKind::Fixed => {
                    // Point coincidence (3 rows).
                    self.fill_point_coincidence(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                    );
                    row += 3;
                    // Axis cross product (3 rows).
                    self.fill_axis_cross(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                    );
                    row += 3;
                }
                MateKind::Spherical => {
                    self.fill_point_coincidence(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.point,
                        &mate.b.geometry.point,
                    );
                    row += 3;
                }
                MateKind::Parallel => {
                    self.fill_axis_dot(
                        &mut j, row, off_a, off_b, x,
                        &mate.a.geometry.axis,
                        &mate.b.geometry.axis,
                    );
                    row += 1;
                }
            }
        }

        // Quaternion norm residuals (1 per body).
        for bi in 0..self.bodies.len() {
            let off = bi * 7;
            j[(row, off + 3)] = 2.0 * x[off + 3];
            j[(row, off + 4)] = 2.0 * x[off + 4];
            j[(row, off + 5)] = 2.0 * x[off + 5];
            j[(row, off + 6)] = 2.0 * x[off + 6];
            row += 1;
        }

        // Grounded-body pin residuals (7 per grounded body).
        for bi in 0..self.bodies.len() {
            if self.grounded[bi] {
                let off = bi * 7;
                for jj in 0..7 {
                    j[(row, off + jj)] = 1.0;
                    row += 1;
                }
            }
        }

        j
    }

    // ─── Jacobian fillers per residual kind ───

    /// Point coincidence: `p_a_world - p_b_world`.
    /// ∂r/∂t_a_i = +δ_ij, ∂r/∂q_a_i = +(∂R/∂q_i)*p_a,
    /// ∂r/∂t_b_i = -δ_ij, ∂r/∂q_b_i = -(∂R/∂q_i)*p_b.
    fn fill_point_coincidence(
        &self, j: &mut DMatrix<f64>, row0: usize,
        off_a: usize, off_b: usize, x: &[f64],
        pa: &[f64; 3], pb: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let dpa = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, pa);
        let dpb = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, pb);

        for comp in 0..3 {
            let r = row0 + comp;
            // Body A: +∂/∂t_a + +∂/∂q_a
            j[(r, off_a + comp)] = 1.0;
            j[(r, off_a + 3)] = dpa[0][comp];
            j[(r, off_a + 4)] = dpa[1][comp];
            j[(r, off_a + 5)] = dpa[2][comp];
            j[(r, off_a + 6)] = dpa[3][comp];
            // Body B: -∂/∂t_b + -∂/∂q_b
            j[(r, off_b + comp)] = -1.0;
            j[(r, off_b + 3)] = -dpb[0][comp];
            j[(r, off_b + 4)] = -dpb[1][comp];
            j[(r, off_b + 5)] = -dpb[2][comp];
            j[(r, off_b + 6)] = -dpb[3][comp];
        }
    }

    /// Axis cross product: `cross(a_w, b_w)` (3 residual components).
    /// ∂cross/∂q_a_i = cross(∂a_w/∂q_i, b_w)
    /// ∂cross/∂q_b_i = cross(a_w, ∂b_w/∂q_i)
    /// No translation dependence.
    fn fill_axis_cross(
        &self, j: &mut DMatrix<f64>, row0: usize,
        off_a: usize, off_b: usize, x: &[f64],
        axis_a: &[f64; 3], axis_b: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let a_w = rotate_vec(qa.0, qa.1, qa.2, qa.3, axis_a);
        let b_w = rotate_vec(qb.0, qb.1, qb.2, qb.3, axis_b);
        let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);
        let db = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, axis_b);

        // For each quaternion component i: cross(∂a/∂q_i, b_w).
        let da_cross_b: [[f64; 3]; 4] = [
            cross3(&da[0], &b_w),
            cross3(&da[1], &b_w),
            cross3(&da[2], &b_w),
            cross3(&da[3], &b_w),
        ];
        // For each quaternion component i: cross(a_w, ∂b/∂q_i).
        let a_cross_db: [[f64; 3]; 4] = [
            cross3(&a_w, &db[0]),
            cross3(&a_w, &db[1]),
            cross3(&a_w, &db[2]),
            cross3(&a_w, &db[3]),
        ];

        for comp in 0..3 {
            let r = row0 + comp;
            for qi in 0..4 {
                j[(r, off_a + 3 + qi)] = da_cross_b[qi][comp];
                j[(r, off_b + 3 + qi)] = a_cross_db[qi][comp];
            }
        }
    }

    /// Axis dot product: `dot(a_w, b_w) - sign` (1 residual).
    /// ∂r/∂q_a_i = dot(∂a_w/∂q_i, b_w)
    /// ∂r/∂q_b_i = dot(a_w, ∂b_w/∂q_i)
    /// No translation dependence.
    fn fill_axis_dot(
        &self, j: &mut DMatrix<f64>, row: usize,
        off_a: usize, off_b: usize, x: &[f64],
        axis_a: &[f64; 3], axis_b: &[f64; 3],
    ) {
        let qa = (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
        let qb = (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);
        let a_w = rotate_vec(qa.0, qa.1, qa.2, qa.3, axis_a);
        let b_w = rotate_vec(qb.0, qb.1, qb.2, qb.3, axis_b);
        let da = drot_vec_dq(qa.0, qa.1, qa.2, qa.3, axis_a);
        let db = drot_vec_dq(qb.0, qb.1, qb.2, qb.3, axis_b);

        for qi in 0..4 {
            j[(row, off_a + 3 + qi)] = da[qi][0] * b_w[0] + da[qi][1] * b_w[1] + da[qi][2] * b_w[2];
            j[(row, off_b + 3 + qi)] = a_w[0] * db[qi][0] + a_w[1] * db[qi][1] + a_w[2] * db[qi][2];
        }
    }
}

/// Cross product of two 3-vectors.
fn cross3(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

// ─── Solve entry point ───

/// Run the mate solver: build a Problem, call solve_lm, compute status, build output.
pub fn solve_mate(input: &MateInput) -> MateOutput {
    let problem = MateProblem::new(input);
    let n = problem.n;
    let m = problem.m;

    let start = std::time::Instant::now();

    let x0_f64: Vec<f64> = input.params_initial.iter().map(|&p| p as f64).collect();

    let residuals_fn = problem.residuals_fn();
    let jacobian_fn = problem.jacobian_fn();

    let lm_result = lm::solve_lm(&x0_f64, &residuals_fn, &jacobian_fn);

    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

    // Rank analysis via SVD.
    let dof = if m == 0 || n == 0 {
        0
    } else {
        let svd = lm_result.jacobian.svd(true, false);
        let tol = 1e-6;
        let rank = svd.singular_values.iter().filter(|&&s| s > tol).count();
        n.saturating_sub(rank as usize)
    };
    let rank = (n - dof) as u32;

    let status = if lm_result.residual_norm > 1e-4 {
        MateStatus::Overconstrained
    } else if dof > 0 {
        MateStatus::Underconstrained
    } else {
        MateStatus::FullyConstrained
    };

    let params_solved: Vec<f32> = lm_result.x.iter().map(|&v| v as f32).collect();

    MateOutput {
        params_solved,
        overall_status: status.to_u8(),
        diagnostics: MateDiagnostics {
            residual_norm: lm_result.residual_norm,
            rank,
            dof: dof as u32,
            iters: lm_result.iters,
            ms: elapsed_ms,
        },
    }
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mate::{MateGeometry, MateInput, MateKind, MateRef, RigidBody};

    /// Two bodies: body 0 at origin (grounded), body 1 at (5, 0, 0).
    /// One spherical mate at (0,0,0) should pull body 1 to body 0.
    fn two_body_input() -> MateInput {
        MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity, grounded
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 1: translated +x
            ],
            fixed_mask: vec![0b0000_0001], // body 0 is grounded
            mates: vec![Mate {
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
                        point: [0.0, 0.0, 0.0], // local point at body 1's origin
                        axis: [0.0, 0.0, 1.0],
                    },
                },
                flip: false,
            }],
        }
    }

    #[test]
    fn spherical_pulls_bodies_together() {
        let input = two_body_input();
        let out = solve_mate(&input);
        // Body 0 stays at origin (grounded). Body 1 should move close to body 0.
        // The spherical mate at body 1's local (0,0,0) must meet body 0's world (0,0,0).
        // So body 1's translation should become ~(0,0,0).
        assert!(out.params_solved[7].abs() < 1e-3, "tx should be ~0, got {}", out.params_solved[7]);
        assert!(out.params_solved[8].abs() < 1e-3, "ty should be ~0, got {}", out.params_solved[8]);
        assert!(out.params_solved[9].abs() < 1e-3, "tz should be ~0, got {}", out.params_solved[9]);
        // Body 0 should stay at identity.
        assert!(out.params_solved[0].abs() < 1e-3);
        assert!((out.params_solved[6] - 1.0).abs() < 1e-3, "qw should be ~1");
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn spherical_fully_constrained_with_three_mates() {
        // Two boxes, one fixed with 3 spherical mates = 9 residuals = 0 DOF.
        // Body 0 grounded, body 1 free.
        // Three distinct mating points fully pin body 1's position and orientation.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                5.0, 1.0, 2.0, 0.1, 0.2, 0.3, 0.927, // body 1: arbitrary seed
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![
                Mate {
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
                },
                Mate {
                    kind: MateKind::Spherical,
                    a: MateRef {
                        body_index: 0,
                        geometry: MateGeometry {
                            point: [10.0, 0.0, 0.0],
                            axis: [0.0, 0.0, 1.0],
                        },
                    },
                    b: MateRef {
                        body_index: 1,
                        geometry: MateGeometry {
                            point: [10.0, 0.0, 0.0],
                            axis: [0.0, 0.0, 1.0],
                        },
                    },
                    flip: false,
                },
                Mate {
                    kind: MateKind::Spherical,
                    a: MateRef {
                        body_index: 0,
                        geometry: MateGeometry {
                            point: [0.0, 10.0, 0.0],
                            axis: [0.0, 0.0, 1.0],
                        },
                    },
                    b: MateRef {
                        body_index: 1,
                        geometry: MateGeometry {
                            point: [0.0, 10.0, 0.0],
                            axis: [0.0, 0.0, 1.0],
                        },
                    },
                    flip: false,
                },
            ],
        };
        let out = solve_mate(&input);
        // Body 0 stays at identity.
        assert!((out.params_solved[6] - 1.0).abs() < 1e-3);
        // Body 1 should have moved to match the three mating points.
        // Translation should be near (0,0,0) since the first mate point at body 1's
        // local origin must coincide with body 0's world origin.
        assert!(out.params_solved[7].abs() < 5e-2, "tx={}", out.params_solved[7]);
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn parallel_aligns_axes_parallel() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity (Z axis)
                0.0, 0.0, 0.0, -0.707, 0.0, 0.0, 0.707, // body 1: 90° about X, so Z→Y
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![Mate {
                kind: MateKind::Parallel,
                a: MateRef {
                    body_index: 0,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0], // body 0: Z axis
                    },
                },
                b: MateRef {
                    body_index: 1,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0], // body 1: Z axis (rotates to Y in world at seed)
                    },
                },
                flip: false,
            }],
        };
        let out = solve_mate(&input);
        // Body 0 stays at identity. Body 1's Z axis should rotate to be parallel
        // to body 0's Z axis (the world Z). After the solve, the quaternion should
        // be back near identity since the parallel mate forces body 1's Z axis
        // to align with body 0's Z axis.
        let qw = out.params_solved[13];
        assert!((qw.abs() - 1.0).abs() < 1e-2, "qw should be ~±1, got {}", qw);
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn parallel_flip_aligns_axes_anti_parallel() {
        // Start with a slight perturbation (not identity) so the gradient
        // of the dot-product residual is non-zero. Parallel mate with flip
        // forces the two world-space axes to be anti-parallel.
        let angle = 0.3; // small rotation about X
        let half: f64 = angle / 2.0;
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0: identity
                0.0, 0.0, 0.0, half.sin() as f32, 0.0, 0.0, half.cos() as f32, // body 1: slight rotation about X
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![Mate {
                kind: MateKind::Parallel,
                a: MateRef {
                    body_index: 0,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0], // pos Z
                    },
                },
                b: MateRef {
                    body_index: 1,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0],
                        axis: [0.0, 0.0, 1.0], // pos Z in local, should end anti-parallel
                    },
                },
                flip: true, // anti-parallel
            }],
        };
        let out = solve_mate(&input);
        // Body 1 should rotate to make its Z axis anti-parallel to body 0's Z.
        // A 180° rotation about X, plus the seed perturbation.
        let qx = out.params_solved[10];
        let qy = out.params_solved[11];
        let qz = out.params_solved[12];
        // At least one of qx, qy should be significant (the rotation).
        let rot_mag = (qx as f64 * qx as f64 + qy as f64 * qy as f64).sqrt();
        assert!(rot_mag > 0.5, "should have significant rotation, q=({}, {}, {}, {})",
            qx, qy, qz, out.params_solved[13]);
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn fixed_mate_pins_all_dof() {
        // Body 0 grounded. Body 1's anchor at local offset = body 0's anchor at local offset.
        // Fixed mate should bring body 1 to exactly match body 0's world anchor position
        // and axis direction.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                3.0, 4.0, 5.0, 0.0, 0.707, 0.0, 0.707, // body 1: 90° about Y
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![Mate {
                kind: MateKind::Fixed,
                a: MateRef {
                    body_index: 0,
                    geometry: MateGeometry {
                        point: [2.0, 3.0, 4.0],
                        axis: [0.0, 0.0, 1.0],
                    },
                },
                b: MateRef {
                    body_index: 1,
                    geometry: MateGeometry {
                        point: [0.0, 0.0, 0.0], // body 1's local point
                        axis: [0.0, 0.0, 1.0],  // body 1's Z axis
                    },
                },
                flip: false,
            }],
        };
        let out = solve_mate(&input);
        // Body 1's world point (0,0,0) must equal body 0's world point (2,3,4).
        assert!((out.params_solved[7] - 2.0).abs() < 1e-2, "tx={}", out.params_solved[7]);
        assert!((out.params_solved[8] - 3.0).abs() < 1e-2, "ty={}", out.params_solved[8]);
        assert!((out.params_solved[9] - 4.0).abs() < 1e-2, "tz={}", out.params_solved[9]);
        // Axes should be aligned (body 1's Z axis parallel to body 0's Z axis).
        // The seed had body 1 at 90° about Y, so Z→X. The fixed mate should correct that.
        assert!(out.diagnostics.residual_norm < 1e-3);
    }

    #[test]
    fn underconstrained_assembly_status() {
        // Two ungrounded bodies with one spherical mate = 7+7 params - 3 constraints.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            fixed_mask: vec![0],
            mates: vec![Mate {
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
            }],
        };
        let out = solve_mate(&input);
        assert_eq!(out.overall_status, MateStatus::Underconstrained.to_u8());
        assert!(out.diagnostics.dof > 0);
    }

    #[test]
    fn no_mates_returns_unchanged() {
        let input = MateInput {
            bodies: vec![RigidBody { param_offset: 0 }],
            params_initial: vec![1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0],
            fixed_mask: vec![0b0000_0001], // grounded
            mates: vec![],
        };
        let out = solve_mate(&input);
        // Grounded body stays put.
        assert!((out.params_solved[0] - 1.0).abs() < 1e-4);
        assert!((out.params_solved[1] - 2.0).abs() < 1e-4);
        assert!((out.params_solved[2] - 3.0).abs() < 1e-4);
    }

    #[test]
    fn quaternion_stays_near_unit_in_mate_solve() {
        // Even with a non-unit starting quaternion, the quaternion-norm soft
        // residual + the mate geometry (this is a spherical mate) together keep
        // the quaternion close to unit. The solver balances the Tikhonov pull
        // against the constraint residuals and the norm soft residual.
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // body 0 grounded
                5.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.2, // body 1: non-unit quat
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![Mate {
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
            }],
        };
        let out = solve_mate(&input);
        // Body 1 should have moved to meet body 0, with its quaternion normalized.
        assert!(out.params_solved[7].abs() < 1e-2); // tx ≈ 0
        let qx = out.params_solved[10] as f64;
        let qy = out.params_solved[11] as f64;
        let qz = out.params_solved[12] as f64;
        let qw = out.params_solved[13] as f64;
        let norm = (qx * qx + qy * qy + qz * qz + qw * qw).sqrt();
        assert!((norm - 1.0).abs() < 1e-2, "norm={}", norm);
        assert!(out.diagnostics.residual_norm < 1e-2);
    }

    #[test]
    fn spherical_mate_accuracy_with_settled_body() {
        // Simple test: one spherical mate should converge to exact coincidence.
        let input = two_body_input();
        let out = solve_mate(&input);
        // The solved point at body 1's local (0,0,0) should equal body 0's world (0,0,0).
        let tx = out.params_solved[7] as f64;
        let ty = out.params_solved[8] as f64;
        let tz = out.params_solved[9] as f64;
        assert!(tx.abs() < 1e-4, "tx={}", tx);
        assert!(ty.abs() < 1e-4, "ty={}", ty);
        assert!(tz.abs() < 1e-4, "tz={}", tz);
    }

    // ─── Jacobian vs finite-difference cross-checks ───

    #[test]
    fn jacobian_vs_fd_spherical() {
        let input = two_body_input();
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_fixed() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                3.0, 4.0, 5.0, 0.1, 0.2, 0.3, f64::sqrt(1.0 - 0.01 - 0.04 - 0.09) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
            mates: vec![Mate {
                kind: MateKind::Fixed,
                a: MateRef {
                    body_index: 0,
                    geometry: MateGeometry {
                        point: [1.0, 2.0, 3.0],
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
            }],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    #[test]
    fn jacobian_vs_fd_parallel() {
        let input = MateInput {
            bodies: (0..2).map(|i| RigidBody { param_offset: i * 7 }).collect(),
            params_initial: vec![
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
                0.0, 0.0, 0.0, -0.5, 0.1, 0.2, f64::sqrt(1.0 - 0.25 - 0.01 - 0.04) as f32,
            ],
            fixed_mask: vec![0b0000_0001],
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
                        axis: [0.0, 0.0, 1.0],
                    },
                },
                flip: false,
            }],
        };
        let p = MateProblem::new(&input);
        let x: Vec<f64> = input.params_initial.iter().map(|&v| v as f64).collect();
        let j_analytic = p.jacobian(&x);
        let j_fd = lm::fd_jacobian(&|xx| p.residuals(xx), &x, p.m);
        compare_jacobians(&j_analytic, &j_fd, 1e-3);
    }

    fn compare_jacobians(analytical: &DMatrix<f64>, fd: &DMatrix<f64>, tol: f64) {
        for r in 0..analytical.nrows() {
            for c in 0..analytical.ncols() {
                let a = analytical[(r, c)];
                let f = fd[(r, c)];
                let diff = (a - f).abs();
                let denom = f.abs().max(1e-12);
                assert!(
                    diff < tol * denom.max(1.0) || diff < tol,
                    "row={}, col={}, analytic={}, fd={}, diff={}",
                    r, c, a, f, diff
                );
            }
        }
    }
}
