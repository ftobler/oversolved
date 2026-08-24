//! Sparse Jacobian representation and conjugate-gradient linear solver.
//!
//! Each row of the Jacobian is a list of (column_index, value) pairs for
//! nonzero entries. This naturally matches the constraint structure: a
//! constraint touches at most 2 entities, each with 2-5 params, so row
//! occupancy is a handful of entries regardless of the total param count.
//!
//! CG solves the LM normal equations (JᵀJ + λ·diag)·δ = -Jᵀr without ever
//! forming the dense JᵀJ, using only sparse matvecs: J·v then Jᵀ·(J·v).

pub type SparseRow = Vec<(usize, f64)>;

/// v·v
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Diagonal of JᵀJ: d[i] = Σᵣ J[r,i]²
pub fn jtj_diag(jac: &[SparseRow], n: usize) -> Vec<f64> {
    let mut d = vec![0.0; n];
    for row in jac {
        for &(col, val) in row {
            d[col] += val * val;
        }
    }
    d
}

/// J·v: one output per row = Σⱼ J[r,j]·v[j]
fn sparse_matvec(jac: &[SparseRow], v: &[f64]) -> Vec<f64> {
    let m = jac.len();
    let mut out = vec![0.0; m];
    for (r, row) in jac.iter().enumerate() {
        let mut s = 0.0;
        for &(col, val) in row {
            s += val * v[col];
        }
        out[r] = s;
    }
    out
}

/// Jᵀ·v: one output per column = Σᵣ J[r,col]·v[r]
fn sparse_transpose_matvec(jac: &[SparseRow], v: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n];
    for (r, row) in jac.iter().enumerate() {
        let vr = v[r];
        for &(col, val) in row {
            out[col] += val * vr;
        }
    }
    out
}

/// (JᵀJ)·v computed as Jᵀ(J·v) — never forms the dense JᵀJ matrix.
#[cfg(test)]
fn jtj_matvec(jac: &[SparseRow], v: &[f64], n: usize) -> Vec<f64> {
    let jv = sparse_matvec(jac, v);
    sparse_transpose_matvec(jac, &jv, n)
}

/// Apply the damped system matrix A = JᵀJ + λ·diag to vector v in-place.
/// out = Jᵀ(J·v) + λ·diag ∘ v
fn apply_damped(
    jac: &[SparseRow],
    lambda: f64,
    diag: &[f64],
    v: &[f64],
    out: &mut [f64],
) {
    let jv = sparse_matvec(jac, v);
    let jtjv = sparse_transpose_matvec(jac, &jv, out.len());
    for i in 0..out.len() {
        out[i] = jtjv[i] + lambda * diag[i] * v[i];
    }
}

/// Conjugate-gradient solve for (JᵀJ + λ·diag)·δ = b.
/// Returns `(delta, truncated)`. Converges when `‖r‖ < tol` or `max_iters` is
/// reached. `truncated` marks an indefinite system (`p'Ap <= 0` mid-run): CG's
/// descent guarantee is void there, so the partial estimate may be meaningless
/// and reporting it lets the caller decide -- the LM driver treats it like its
/// dense-path LU failure and raises lambda for a retry.
fn cg_solve(
    jac: &[SparseRow],
    lambda: f64,
    diag: &[f64],
    b: &[f64],
    n: usize,
    max_iters: usize,
    tol: f64,
) -> (Vec<f64>, bool) {
    let mut x = vec![0.0; n];
    if n == 0 {
        return (x, false);
    }

    // r₀ = b - A·x₀ = b (since x₀ = 0)
    let mut r = b.to_vec();
    let mut p = r.clone();
    let mut rsold = dot(&r, &r);

    let mut ap = vec![0.0; n];
    let mut truncated = false;

    for _ in 0..max_iters {
        apply_damped(jac, lambda, diag, &p, &mut ap);

        let p_ap = dot(&p, &ap);
        if p_ap <= 0.0 {
            // A is not positive-definite — should not happen with λ>0 unless
            // numerical issues. Stop, and say so: silently returning the
            // current estimate would hand the caller a step nobody vetted.
            truncated = true;
            break;
        }

        let alpha = rsold / p_ap;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }

        let rsnew = dot(&r, &r);
        if rsnew.sqrt() < tol {
            break;
        }

        let beta = rsnew / rsold;
        for i in 0..n {
            p[i] = r[i] + beta * p[i];
        }
        rsold = rsnew;
    }

    (x, truncated)
}

/// Precompute the damping diagonal and solve (JᵀJ + λ·diag)·δ = b via CG.
/// Returns `(delta, truncated)`; see `cg_solve` for the truncation semantics.
pub fn damped_solve(
    jac: &[SparseRow],
    lambda: f64,
    b: &[f64],
    n: usize,
) -> (Vec<f64>, bool) {
    let diag = jtj_diag(jac, n);
    // For small systems, more CG iterations are affordable.
    let max_iters = n * 2;
    let tol = 1e-12;
    cg_solve(jac, lambda, &diag, b, n, max_iters, tol)
}

/// Build the gradient Jᵀr given the sparse Jacobian and residual vector.
pub fn gradient(jac: &[SparseRow], residuals: &[f64], n: usize) -> Vec<f64> {
    sparse_transpose_matvec(jac, residuals, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_jac() -> Vec<SparseRow> {
        // 2×3 Jacobian: [[1, 2, 0], [0, 3, 4]]
        vec![
            vec![(0, 1.0), (1, 2.0)],
            vec![(1, 3.0), (2, 4.0)],
        ]
    }

    #[test]
    fn matvec_matches_dense() {
        let jac = make_jac();
        let v = vec![1.0, 2.0, 3.0];
        // J·v = [1*1+2*2, 3*2+4*3] = [5, 18]
        let jv = sparse_matvec(&jac, &v);
        assert!((jv[0] - 5.0).abs() < 1e-12);
        assert!((jv[1] - 18.0).abs() < 1e-12);
    }

    #[test]
    fn transpose_matvec_matches_dense() {
        let jac = make_jac();
        let v = vec![1.0, 2.0];
        // Jᵀ·v = [1*1, 2*1+3*2, 4*2] = [1, 8, 8]
        let jtv = sparse_transpose_matvec(&jac, &v, 3);
        assert!((jtv[0] - 1.0).abs() < 1e-12);
        assert!((jtv[1] - 8.0).abs() < 1e-12);
        assert!((jtv[2] - 8.0).abs() < 1e-12);
    }

    #[test]
    fn jtj_matvec_matches_dense() {
        let jac = make_jac();
        // JᵀJ = [[1,0],[2,3],[0,4]]ᵀ · [[1,2,0],[0,3,4]]
        //      = [[1,2,0],[2,13,12],[0,12,16]]
        let v = vec![1.0, 2.0, 3.0];
        let jtjv = jtj_matvec(&jac, &v, 3);
        // JᵀJ·v = [1+4, 2+26+36, 24+48] = [5, 64, 72]
        assert!((jtjv[0] - 5.0).abs() < 1e-12);
        assert!((jtjv[1] - 64.0).abs() < 1e-12);
        assert!((jtjv[2] - 72.0).abs() < 1e-12);
    }

    #[test]
    fn cg_solves_trivial_system() {
        // J = [1, 0] (one row, two cols). JᵀJ = [[1,0],[0,0]].
        // With λ=0.1, diag = [1, 0]. A = [[1.1, 0], [0, 0]].
        // b = Jᵀr = [1, 0]·[3] = [3, 0].
        // Solve Aδ = b: δ = [3/1.1, 0] ≈ [2.727, 0]
        let jac = vec![vec![(0, 1.0)]];
        let r = vec![3.0]; // residual
        let b = sparse_transpose_matvec(&jac, &r, 2);
        let (delta, truncated) = damped_solve(&jac, 0.1, &b, 2);
        assert!(!truncated, "damped healthy system is not truncation");
        assert!((delta[0] - 3.0 / 1.1).abs() < 1e-6, "δ₀={}", delta[0]);
        assert!(delta[1].abs() < 1e-12, "δ₁={}", delta[1]);
    }

    #[test]
    fn cg_solves_well_conditioned() {
        // J = [[2,1],[1,2]], well-conditioned 2×2.
        // JᵀJ = [[5,4],[4,5]].
        // b = [-Jᵀr] with r = [1, 1], b = [-3, -3].
        // With λ=0: solve [[5,4],[4,5]] δ = [-3,-3] → δ = [-1/3, -1/3].
        let jac = vec![
            vec![(0, 2.0), (1, 1.0)],
            vec![(0, 1.0), (1, 2.0)],
        ];
        let b = vec![-3.0, -3.0];
        let (delta, truncated) = cg_solve(&jac, 0.0, &[5.0, 5.0], &b, 2, 20, 1e-14);
        assert!(!truncated);
        assert!((delta[0] + 1.0 / 3.0).abs() < 1e-6, "δ₀={}", delta[0]);
        assert!((delta[1] + 1.0 / 3.0).abs() < 1e-6, "δ₁={}", delta[1]);
    }

    #[test]
    fn damped_solve_empty_jac_returns_a_reported_truncated_zero_step() {
        // Zero rows: A is the zero operator, so the very first p'Ap reads 0 --
        // CG has no descent direction and must SAY SO instead of handing back
        // zeros dressed up as the solved system.
        let jac: Vec<SparseRow> = vec![];
        let b = vec![1.0, 2.0];
        let (delta, truncated) = damped_solve(&jac, 0.1, &b, 2);
        assert_eq!(delta, vec![0.0, 0.0]);
        assert!(truncated, "zero operator must be reported as truncated");
    }

    #[test]
    fn cg_solve_zero_columns_returns_empty() {
        // n=0: no variables, returns empty delta, nothing to truncate.
        let jac: Vec<SparseRow> = vec![vec![]];
        let (delta, truncated) = cg_solve(&jac, 0.1, &[], &[], 0, 10, 1e-12);
        assert!(delta.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn cg_solve_zero_jacobian_without_damping_hits_divergence_path() {
        // J = [[0, 0]]: diag = [0, 0], lambda=0 => A = zero matrix.
        // p_ap = dot(p, A·p) = 0, triggering the indefinite break in cg_solve,
        // now reported through the truncation flag instead of silently
        // returning the initial zeros.
        let jac = vec![vec![]];
        let b = vec![5.0, 5.0];
        let diag = vec![0.0, 0.0];
        let (delta, truncated) = cg_solve(&jac, 0.0, &diag, &b, 2, 10, 1e-12);
        assert_eq!(delta, vec![0.0, 0.0], "singular system returns zeros");
        assert!(truncated, "singular system must be reported");
    }

    #[test]
    fn damped_solve_singular_system_with_damping_succeeds() {
        // J = [[1, 1], [1, 1]]: rank-deficient (both rows identical).
        // JᵀJ = [[2, 2], [2, 2]], diag = [2, 2].
        // With λ=1: A = [[4, 2], [2, 4]] which is invertible.
        // b = Jᵀr = [1+1, 1+1] = [2, 2] with r = [1, 1].
        // Solve A·δ = b: δ = [1/3, 1/3].
        let jac = vec![
            vec![(0, 1.0), (1, 1.0)],
            vec![(0, 1.0), (1, 1.0)],
        ];
        let b = vec![2.0, 2.0];
        let (delta, truncated) = damped_solve(&jac, 1.0, &b, 2);
        assert!(!truncated, "damping restored positive-definiteness");
        assert!((delta[0] - 1.0 / 3.0).abs() < 1e-6, "δ₀={}", delta[0]);
        assert!((delta[1] - 1.0 / 3.0).abs() < 1e-6, "δ₁={}", delta[1]);
    }
}
