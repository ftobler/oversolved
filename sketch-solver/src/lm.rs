//! Hand-rolled Levenberg-Marquardt driver with a 3-point finite-difference
//! Jacobian.
//!
//! This replaces scipy's `least_squares(method="trf", jac="3-point")`. Per the
//! migration plan we deliberately do NOT try to match `trf` (trust-region
//! reflective with per-iteration Jacobian scaling) point-for-point: the parity
//! gate is status + residual-norm + gauge-aware geometry, not param equality.
//! A classical LM on the normal equations `(JᵀJ + λ·diag(JᵀJ)) δ = -Jᵀr`
//! converges the trivial sketches the tests cover. Analytic/zero-copy speedups
//! are explicitly later work (do not blend a perf change with the port).

use nalgebra::{DMatrix, DVector};

pub struct LmResult {
    pub x: Vec<f64>,
    /// Jacobian at the returned `x` (m rows = residuals, n cols = params).
    pub jacobian: DMatrix<f64>,
    /// Euclidean norm of the residual vector at `x`.
    pub residual_norm: f64,
    pub iters: u32,
}

/// Relative step for the central finite-difference Jacobian. `cbrt(eps)` is the
/// usual optimum for a 3-point stencil (truncation vs round-off balance).
#[cfg(test)]
fn fd_step(xj: f64) -> f64 {
    f64::EPSILON.cbrt() * xj.abs().max(1.0)
}

/// Central 3-point finite-difference Jacobian of `f` at `x`. `m` is the residual
/// count (taken from a prior `f(x)` so we can size the matrix). Kept for the
/// analytic-vs-FD cross-check tests; the solver now uses an analytic Jacobian.
#[cfg(test)]
pub(crate) fn fd_jacobian(f: &impl Fn(&[f64]) -> Vec<f64>, x: &[f64], m: usize) -> DMatrix<f64> {
    let n = x.len();
    let mut j = DMatrix::<f64>::zeros(m, n);
    if m == 0 {
        return j;
    }
    let mut xp = x.to_vec();
    for col in 0..n {
        let h = fd_step(x[col]);
        xp[col] = x[col] + h;
        let f_plus = f(&xp);
        xp[col] = x[col] - h;
        let f_minus = f(&xp);
        xp[col] = x[col];
        let inv = 1.0 / (2.0 * h);
        for row in 0..m {
            j[(row, col)] = (f_plus[row] - f_minus[row]) * inv;
        }
    }
    j
}

fn norm2(v: &[f64]) -> f64 {
    v.iter().map(|&e| e * e).sum::<f64>().sqrt()
}

/// Solve `min_x 0.5 * ||f(x)||²` from the seed `x0`. `jac(x)` returns the
/// Jacobian of `f` at `x` (m rows x n cols); the caller supplies it analytically.
pub fn solve_lm(
    x0: &[f64],
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
) -> LmResult {
    let n = x0.len();
    let mut x = x0.to_vec();
    let mut r = f(&x);
    let m = r.len();

    // Degenerate problem: no residuals. Nothing to solve; report a 0xn Jacobian.
    if m == 0 || n == 0 {
        return LmResult {
            x,
            jacobian: DMatrix::zeros(m, n),
            residual_norm: norm2(&r),
            iters: 0,
        };
    }

    const MAX_ITERS: u32 = 200;
    const GTOL: f64 = 1e-10;
    const XTOL: f64 = 1e-12;
    const FTOL: f64 = 1e-12;
    const LAMBDA_UP: f64 = 3.0;
    const LAMBDA_DOWN: f64 = 0.4;

    let mut jacm = jac(&x);
    let mut cost = 0.5 * r.iter().map(|&e| e * e).sum::<f64>();

    // Initial damping from the scale of JᵀJ's diagonal.
    let mut jtj = jacm.transpose() * &jacm;
    let mut lambda = 1e-3
        * (0..n)
            .map(|i| jtj[(i, i)])
            .fold(0.0_f64, f64::max)
            .max(1e-12);

    let mut iters = 0;
    while iters < MAX_ITERS {
        iters += 1;
        let rv = DVector::from_vec(r.clone());
        let g = jacm.transpose() * &rv; // gradient Jᵀr

        if g.amax() < GTOL {
            break;
        }

        // Try damped steps, increasing lambda until the step reduces cost.
        let mut accepted = false;
        for _ in 0..30 {
            let mut a = jtj.clone();
            for i in 0..n {
                // Marquardt scaling: damp proportional to each column's curvature.
                a[(i, i)] += lambda * jtj[(i, i)].max(1e-12);
            }
            let Some(delta) = a.clone().lu().solve(&(-&g)) else {
                lambda *= LAMBDA_UP;
                continue;
            };

            let x_new: Vec<f64> = (0..n).map(|i| x[i] + delta[i]).collect();
            let r_new = f(&x_new);
            let cost_new = 0.5 * r_new.iter().map(|&e| e * e).sum::<f64>();

            if cost_new < cost {
                let dx = norm2(delta.as_slice());
                let cost_drop = cost - cost_new;
                x = x_new;
                r = r_new;
                jacm = jac(&x);
                jtj = jacm.transpose() * &jacm;
                lambda = (lambda * LAMBDA_DOWN).max(1e-12);
                accepted = true;

                // Convergence on tiny step or tiny relative cost reduction.
                let xnorm = norm2(&x).max(1e-30);
                if dx < XTOL * xnorm || cost_drop < FTOL * cost.max(1e-30) {
                    return LmResult {
                        x,
                        jacobian: jacm,
                        residual_norm: norm2(&r),
                        iters,
                    };
                }
                cost = cost_new;
                break;
            }
            lambda *= LAMBDA_UP;
            if lambda > 1e12 {
                break;
            }
        }

        if !accepted {
            // No downhill step found; treat as converged at a local min.
            break;
        }
    }

    LmResult {
        x,
        jacobian: jacm,
        residual_norm: norm2(&r),
        iters,
    }
}
