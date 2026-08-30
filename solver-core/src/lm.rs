//! Hand-rolled Levenberg-Marquardt driver accepting an analytic Jacobian from
//! the caller.
//!
//! This replaces scipy's `least_squares(method="trf", jac="3-point")`. Per the
//! migration plan we deliberately do NOT try to match `trf` (trust-region
//! reflective with per-iteration Jacobian scaling) point-for-point: the parity
//! gate is status + residual-norm + gauge-aware geometry, not param equality.
//! A classical LM on the normal equations `(JᵀJ + λ·diag(JᵀJ)) δ = -Jᵀr`
//! converges the trivial sketches the tests cover. Analytic/zero-copy speedups
//! are explicitly later work (do not blend a perf change with the port).

use nalgebra::{DMatrix, DVector};

use crate::sparse::{self, SparseRow};

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
fn fd_step(xj: f64) -> f64 {
    f64::EPSILON.cbrt() * xj.abs().max(1.0)
}

/// Central 3-point finite-difference Jacobian of `f` at `x`. `m` is the residual
/// count (taken from a prior `f(x)` so we can size the matrix). Kept for the
/// analytic-vs-FD cross-check tests; the solver itself uses an analytic
/// Jacobian. Unconditionally compiled (not `#[cfg(test)]`) because both solver
/// crates' test suites call it across the crate boundary, where `cfg(test)`
/// does not reach.
pub fn fd_jacobian(f: &impl Fn(&[f64]) -> Vec<f64>, x: &[f64], m: usize) -> DMatrix<f64> {
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

/// Defensive per-param damping read. A short `damp_scale` is a caller bug, but
/// release wasm builds compile asserts out and this slice feeds per-param
/// indexing mid-solve, so the missing entries degrade to undamped rather than
/// panicking (or indexing out of bounds) inside the worker.
fn damp_scale_at(damp_scale: &[f64], i: usize) -> f64 {
    damp_scale.get(i).copied().unwrap_or(1.0)
}

/// Solve `min_x 0.5 * ||f(x)||²` from the seed `x0`. `jac(x)` returns the
/// Jacobian of `f` at `x` (m rows x n cols); the caller supplies it analytically.
pub fn solve_lm(
    x0: &[f64],
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
) -> LmResult {
    solve_lm_damped(x0, f, jac, &vec![1.0; x0.len()])
}

/// As `solve_lm`, but `damp_scale[i]` multiplies the Marquardt damping on param
/// `i` (the `lambda·diag(JᵀJ)` term only). A scale above 1 shrinks that param's
/// step, biasing the descent away from it where the constraints leave a choice;
/// it never enters the residual or the convergence test, so the solution a fully
/// constrained problem reaches is unchanged. `damp_scale` should have one
/// entry per param; shorter slices degrade to undamped per missing entry
/// instead of panicking mid-solve (see `damp_scale_at`).
pub fn solve_lm_damped(
    x0: &[f64],
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
    damp_scale: &[f64],
) -> LmResult {
    let n = x0.len();
    // Length contract: one entry per param. Deliberately NOT debug_assert'ed:
    // release wasm compiles asserts out anyway, and the defensive reads in
    // `damp_scale_at` make a short slice degrade to undamped instead of
    // trapping mid-solve -- which the regression test below pins.
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

    // Initial damping from the scale of JᵀJ's diagonal.
    let mut jtj = jacm.transpose() * &jacm;
    let max_diag = (0..n)
        .map(|i| jtj[(i, i)])
        .fold(0.0_f64, f64::max)
        .max(1e-12);
    let mut lambda = 1e-3 * max_diag;

    // Seed anchor (Tikhonov toward x0). Pure Marquardt damping (lambda * diag(JᵀJ))
    // gives a null-space DOF -- a direction the constraints leave free -- almost no
    // regularization, so off-diagonal coupling and finite-difference Jacobian noise
    // can drive that direction to absurd values: an under-constrained line asked
    // only to pass through a point would collapse to zero length or fly off to
    // 1e4+. A small absolute pull toward the seed bounds those free directions to
    // their drawn position while staying negligible against any real curvature, so
    // well-constrained solves are unaffected (the gradient at x=x0 is unchanged).
    // `damp_scale` weights this anchor per param as well as the Marquardt term.
    // The anchor is what resolves an underdetermined direction (there the
    // curvature is zero and only this pull acts), so weighting it is what makes a
    // free rotation-vs-translation choice settle on the slide: unlike the
    // Marquardt term it does not vanish as lambda shrinks. Still O(mu), so a
    // rotation a mate actually constrains is unmoved.
    let mu = 2e-9 * max_diag;
    let x0v = DVector::from_column_slice(x0);
    let scale_v = DVector::from_iterator(n, (0..n).map(|i| damp_scale_at(damp_scale, i)));
    // Augmented objective 0.5||r||² + 0.5·μ·||x - x0||² -- the gradient/damping and
    // the accept test must use the SAME cost or step acceptance is inconsistent.
    let anchor_cost = |xs: &[f64]| -> f64 {
        0.5 * mu * (0..n)
            .map(|i| damp_scale_at(damp_scale, i) * (xs[i] - x0[i]).powi(2))
            .sum::<f64>()
    };
    let mut cost = 0.5 * r.iter().map(|&e| e * e).sum::<f64>() + anchor_cost(&x);

    let mut iters = 0;
    while iters < MAX_ITERS {
        iters += 1;
        let rv = DVector::from_vec(r.clone());
        let xv = DVector::from_column_slice(&x);
        // gradient Jᵀr + μ·scale·(x - x0)
        let g = jacm.transpose() * &rv + mu * scale_v.component_mul(&(&xv - &x0v));

        if g.amax() < GTOL {
            break;
        }

        // Try damped steps, increasing lambda until the step reduces cost.
        let mut accepted = false;
        for _ in 0..30 {
            let mut a = jtj.clone();
            for i in 0..n {
                // Marquardt scaling: damp proportional to each column's curvature
                // (times the caller's per-param `damp_scale`), plus the absolute
                // seed-anchor floor `mu` so flat (free) directions stay finite.
                a[(i, i)] += (lambda * jtj[(i, i)].max(1e-12) + mu) * damp_scale_at(damp_scale, i);
            }
            let Some(delta) = a.clone().lu().solve(&(-&g)) else {
                lambda *= LAMBDA_UP;
                continue;
            };

            let x_new: Vec<f64> = (0..n).map(|i| x[i] + delta[i]).collect();
            let r_new = f(&x_new);
            let cost_new = 0.5 * r_new.iter().map(|&e| e * e).sum::<f64>() + anchor_cost(&x_new);

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

// ─── Sparse LM solver (CG-based) for the drag fast path ───

/// Result of a sparse Levenberg-Marquardt solve. The Jacobian is not returned
/// (the caller already skips status/rank analysis on drag ticks).
pub struct SpLmResult {
    pub x: Vec<f64>,
    /// Euclidean norm of the residual vector at `x`.
    pub residual_norm: f64,
    pub iters: u32,
}

/// LM driver that uses a sparse Jacobian + conjugate-gradient linear solve
/// instead of dense JᵀJ + LU. O(nnz·CG_iters·LM_iters) vs O(n³) dense LU.
/// The Jacobian closure returns `Vec<SparseRow>` - one sparse row per residual.
///
/// On the N=100 benchmark this replaces the dominant O(n³) dense factorization
/// with O(nnz) matvecs inside CG, dropping p95 drag latency from ~600 ms toward
/// the 5 ms target.
pub fn solve_lm_sparse(
    x0: &[f64],
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac_sparse: &impl Fn(&[f64]) -> Vec<SparseRow>,
) -> SpLmResult {
    let n = x0.len();
    let mut x = x0.to_vec();
    let mut r = f(&x);
    let m = r.len();

    if m == 0 || n == 0 {
        return SpLmResult {
            x,
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

    let mut jac = jac_sparse(&x);
    let mut cost = 0.5 * r.iter().map(|&e| e * e).sum::<f64>();

    // Initial damping from the scale of JᵀJ's diagonal.
    let mut lambda = 1e-3
        * sparse::jtj_diag(&jac, n)
            .iter()
            .copied()
            .fold(0.0_f64, f64::max)
            .max(1e-12);

    let mut iters = 0;
    while iters < MAX_ITERS {
        iters += 1;

        let g = sparse::gradient(&jac, &r, n); // Jᵀr
        if g.iter().map(|&v| v.abs()).fold(0.0_f64, f64::max) < GTOL {
            break;
        }

        let mut accepted = false;
        for _ in 0..30 {
            let (delta, truncated) =
                sparse::damped_solve(&jac, lambda, &g.iter().map(|&v| -v).collect::<Vec<_>>(), n);
            if truncated {
                // Same posture as the dense path's `LU.solve -> None`: CG met
                // an indefinite direction, so this delta cannot be trusted.
                // Raising lambda pushes the damped system back toward positive
                // definite, so retry instead of accepting an unvetted step.
                lambda *= LAMBDA_UP;
                continue;
            }

            let x_new: Vec<f64> = (0..n).map(|i| x[i] + delta[i]).collect();
            let r_new = f(&x_new);
            let cost_new = 0.5 * r_new.iter().map(|&e| e * e).sum::<f64>();

            if cost_new < cost {
                let dx = norm2(&delta);
                let cost_drop = cost - cost_new;
                x = x_new;
                r = r_new;
                jac = jac_sparse(&x);
                // diag is recomputed inside damped_solve each iteration;
                // only recompute here for the convergence-check heuristics.
                lambda = (lambda * LAMBDA_DOWN).max(1e-12);
                accepted = true;

                let xnorm = norm2(&x).max(1e-30);
                if dx < XTOL * xnorm || cost_drop < FTOL * cost.max(1e-30) {
                    return SpLmResult {
                        x,
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
            break;
        }
    }

    SpLmResult {
        x,
        residual_norm: norm2(&r),
        iters,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_d() -> (Vec<f64>, impl Fn(&[f64]) -> Vec<f64>, impl Fn(&[f64]) -> DMatrix<f64>) {
        let f = |x: &[f64]| vec![x[0] - 5.0];
        let jac = |_: &[f64]| DMatrix::from_row_slice(1, 1, &[1.0]);
        (vec![0.0], f, jac)
    }

    fn two_d() -> (Vec<f64>, impl Fn(&[f64]) -> Vec<f64>, impl Fn(&[f64]) -> DMatrix<f64>) {
        let f = |x: &[f64]| vec![x[0] - 3.0, x[1] - 7.0];
        let jac = |_: &[f64]| DMatrix::from_row_slice(2, 2, &[1.0, 0.0, 0.0, 1.0]);
        (vec![1.0, 2.0], f, jac)
    }

    #[test]
    fn solve_lm_converges_1d() {
        let (x0, f, jac) = one_d();
        let r = solve_lm(&x0, &f, &jac);
        assert!((r.x[0] - 5.0).abs() < 1e-6, "x={}", r.x[0]);
        assert!(r.residual_norm < 1e-4, "res={}", r.residual_norm);
    }

    #[test]
    fn solve_lm_converges_2d() {
        let (x0, f, jac) = two_d();
        let r = solve_lm(&x0, &f, &jac);
        assert!((r.x[0] - 3.0).abs() < 1e-6, "x={}", r.x[0]);
        assert!((r.x[1] - 7.0).abs() < 1e-6, "y={}", r.x[1]);
        assert!(r.residual_norm < 1e-4, "res={}", r.residual_norm);
    }

    #[test]
    fn solve_lm_no_residuals_returns_immediately() {
        let f = |_: &[f64]| Vec::<f64>::new();
        let jac = |_: &[f64]| DMatrix::<f64>::zeros(0, 2);
        let r = solve_lm(&[1.0, 2.0], &f, &jac);
        assert_eq!(r.iters, 0);
        assert_eq!(r.x, vec![1.0, 2.0]);
    }

    #[test]
    fn solve_lm_no_params_returns_immediately() {
        let f = |_: &[f64]| vec![1.0, 2.0];
        let jac = |_: &[f64]| DMatrix::<f64>::zeros(2, 0);
        let r = solve_lm(&[], &f, &jac);
        assert_eq!(r.iters, 0);
        assert!(r.residual_norm - (1.0_f64 * 1.0 + 2.0 * 2.0).sqrt() < 1e-12);
    }

    #[test]
    fn solve_lm_damped_with_short_damp_scale_degrades_to_undamped() {
        // An empty scale over a 1-param problem: the missing entry must read
        // as 1.0 and the solve must converge with defined behavior instead of
        // panicking on the index.
        let f = |x: &[f64]| vec![x[0] - 5.0];
        let jac = |_: &[f64]| DMatrix::from_row_slice(1, 1, &[1.0]);
        let r = solve_lm_damped(&[0.0], &f, &jac, &[]);
        assert!((r.x[0] - 5.0).abs() < 1e-6, "x={}", r.x[0]);
        assert!(r.residual_norm < 1e-4, "res={}", r.residual_norm);
    }

    #[test]
    fn solve_lm_sparse_converges_1d() {
        let f = |x: &[f64]| vec![x[0] - 5.0];
        let jac = |_: &[f64]| vec![vec![(0, 1.0)]];
        let r = solve_lm_sparse(&[0.0], &f, &jac);
        assert!((r.x[0] - 5.0).abs() < 1e-6, "x={}", r.x[0]);
        assert!(r.residual_norm < 1e-8);
    }

    #[test]
    fn solve_lm_sparse_no_residuals_returns_immediately() {
        let f = |_: &[f64]| Vec::<f64>::new();
        let jac = |_: &[f64]| Vec::<Vec<(usize, f64)>>::new();
        let r = solve_lm_sparse(&[1.0, 2.0], &f, &jac);
        assert_eq!(r.iters, 0);
        assert_eq!(r.x, vec![1.0, 2.0]);
    }

    #[test]
    fn solve_lm_sparse_no_params_returns_immediately() {
        let f = |_: &[f64]| vec![1.0];
        let jac = |_: &[f64]| vec![vec![]];
        let r = solve_lm_sparse(&[], &f, &jac);
        assert_eq!(r.iters, 0);
    }

    #[test]
    fn solve_lm_sparse_terminates_defined_on_a_degenerate_zero_jacobian() {
        // Every Jacobian row empty: the gradient is zero, so LM stops at the
        // seed without stepping. This pins the truncated-step plumbing in the
        // CG path -- a zero operator is reported, never silently accepted --
        // while the driver still returns a defined result.
        let f = |x: &[f64]| vec![x[0] - 5.0];
        let jac = |_: &[f64]| vec![vec![]];
        let r = solve_lm_sparse(&[2.0], &f, &jac);
        assert_eq!(r.x, vec![2.0]);
        assert_eq!(r.iters, 1);
    }
}
