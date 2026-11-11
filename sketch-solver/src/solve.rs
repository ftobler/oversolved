//! Sketch-solve orchestration: run the LM driver, then derive rank, overall
//! status, per-entity status, and per-entity vertex freedom.
//!
//! The crate handles solving only; query/projection resolution and writing
//! solved params back into the doc stay in the TS builder (the "what stays
//! scalar TS" boundary).

use crate::residuals::Problem;
use crate::tolerance::{
    seed_keep_tol, verdict_tol, FREE_COMPONENT_TOL, RANK_TOL, REDUNDANT_ROW_REL,
};
use crate::{
    Diagnostics, Input, Output, Status, CONSTRAINT_FLAG_DROPPED, CONSTRAINT_FLAG_REDUNDANT,
};
use nalgebra::DMatrix;
use solver_core::lm::{
    solve_lm, solve_lm_sparse, solve_lm_sparse_anchored, solve_lm_sparse_proximal,
};

/// True when a solve's final residual reads as a satisfied system. The width
/// comes from the tolerance ladder (`tolerance::verdict_tol`: the measured
/// multiple of the sketch's resolution); a non-finite norm (malformed
/// residual, singular blow-up) never reads as satisfied.
fn satisfied(residual_norm: f64, scale: f64) -> bool {
    residual_norm.is_finite() && residual_norm <= verdict_tol(scale)
}
/// Drag re-solve regularization. A linear
/// penalty `w*(x - x0)` per param biases the constraint null-space toward the
/// pre-drag state so free DOF do not drift; weights are small vs hard
/// constraints (weight 1) so real constraints always dominate.
const REG_WEIGHT_BASE: f64 = 1e-3;
const REG_WEIGHT_DRAG: f64 = 5e-2;

/// The solve's overall verdict from its final residual, Jacobian health and
/// rank. A non-finite residual or Jacobian is a failure whatever the rank
/// reads: the rank pass is a placeholder zero then, so it cannot claim the
/// system is constrained.
fn overall_status(
    jacobian_finite: bool,
    residual_norm: f64,
    rank: usize,
    n: usize,
    scale: f64,
) -> Status {
    if !jacobian_finite || !satisfied(residual_norm, scale) {
        Status::Overconstrained
    } else if rank < n {
        Status::Underconstrained
    } else {
        Status::FullyConstrained
    }
}

pub fn solve_sketch(input: &Input) -> Output {
    let problem = Problem::new(input);
    let x0: Vec<f64> = problem.x0.clone();
    let n = x0.len();

    // Drag fast path: sparse CG solves, no SVD/rank analysis.
    if input.options.drag_mode {
        let f = |x: &[f64]| problem.residuals(x);
        let jac_sp = |x: &[f64]| problem.jacobian_sparse(x, n);

        // Satisfiability comes from the CONSTRAINT system alone. Solve it
        // unanchored first: an anchored solve pulls x off the manifold by
        // design, so a satisfiable drag far from a constraint would otherwise
        // read as Overconstrained and the caller would drop the frame, freezing
        // the point instead of sliding it.
        let clean = solve_lm_sparse(&x0, &f, &jac_sp);

        // Drag only operates when there are free DOF; we assume underconstrained
        // without calling the expensive matrix_rank SVD.
        // A non-finite norm or Jacobian is an unsatisfiable/malformed solve, not
        // a clean underconstrained one: report it as Overconstrained so NaN
        // never reads as success.
        let status = if satisfied(clean.residual_norm, problem.scale()) && clean.jacobian_finite {
            Status::Underconstrained
        } else {
            Status::Overconstrained
        };

        // Second pass: the driver-owned seed anchor pulls free DOF toward the
        // pre-drag state. The driver anchors toward its seed, so seed from the
        // pre-drag x0: that is the cursor/pre-drag gauge reference, and the
        // anchored solve starts from it with the constraint residual pulling
        // onto the manifold. Each pass gets the full iteration budget.
        let x_final = if status == Status::Underconstrained {
            let weights = drag_reg_weights(input, n);
            // A pull of `w * (x - x0)` per param has Hessian `w²`, the
            // driver's absolute anchor weight.
            let anchor: Vec<f64> = weights.iter().map(|w| w * w).collect();
            let anchored = solve_lm_sparse_anchored(&x0, &f, &jac_sp, &anchor).x;
            // The anchored result is a compromise that violates the
            // constraints in proportion to the cursor's distance from them (a
            // point dragged 100 off its line sat 0.25 off it). It already
            // picked the spot on the solution set nearest the cursor; a
            // proximal pass from there projects back onto it. Its anchor
            // follows the iterate, so it leaves no bias of its own while still
            // holding the free directions: unanchored, a vertical line through
            // the origin slid its dragged end off to ~1e4.
            solve_lm_sparse_proximal(&anchored, &f, &jac_sp, &anchor).x
        } else {
            clean.x
        };

        let params_solved = x_final;

        return Output {
            params_solved,
            entity_status: Vec::new(),
            overall_status: status.to_u8(),
            vertex_freedom: Vec::new(),
            // The drag fast path stays untouched: no per-constraint walk at
            // 60 Hz. The caller's count guard expects these empty.
            constraint_flags: Vec::new(),
            constraint_miss: Vec::new(),
            // A drag commit goes through a mutation, not the write-back, so it
            // reads no moved report; keep it empty like the other per-entity
            // arrays.
            entity_moved: Vec::new(),
            diagnostics: Diagnostics {
                residual_norm: clean.residual_norm,
                rank: 0,
                dof: 0,
                iters: clean.iters,
                ms: 0.0,
            },
        };
    }

    // Cold solve: dense LM, full status/rank analysis.
    let f = |x: &[f64]| problem.residuals(x);
    let jac = |x: &[f64]| problem.jacobian(x, n);
    let result = solve_lm(&x0, &f, &jac);

    let jac = result.jacobian;
    // One SVD serves the rank and, unless skipped, the whole status pass. A
    // non-finite Jacobian is never handed to it: the decomposition has no
    // answer for NaN (it can spin or panic), so it would wedge the worker.
    // That solve has no trustworthy rank either.
    let spectrum = if result.jacobian_finite {
        Spectrum::of(&jac, n, !input.options.skip_status_pass)
    } else {
        Spectrum::non_finite()
    };
    let rank = spectrum.rank;

    // Fully constrained means zero remaining DOF: the rank of the constraint
    // Jacobian reaches the parameter count. Every grounding constraint (fixed,
    // pinned_mask, equality pins, coincident-to-origin) already contributes its
    // own Jacobian rows, so the rank reflects them directly. We deliberately do
    // not forgive a "rigid-body" DOF allowance here: a point pinned to the
    // origin still leaves the geometry free to rotate about it, and that
    // rotation is a real, removable DOF (e.g. a horizontal/angle constraint),
    // not an unconstrainable gauge freedom.
    // A non-finite norm (malformed residual, singular blow-up) is not a
    // satisfiable sketch: classify it Overconstrained rather than let a NaN
    // fall through to FullyConstrained. A non-finite Jacobian is the same
    // verdict: the rank above is placeholder zero, so the solve cannot claim
    // to be constrained.
    let status = overall_status(
        result.jacobian_finite,
        result.residual_norm,
        rank,
        n,
        problem.scale(),
    );

    // `result.x` is not read again, so move it instead of cloning.
    let mut params_solved = result.x;
    // A solve may satisfy the (periodic) arc angle rows a whole turn away from
    // the authored spelling. That is the same geometry but a different branch
    // to the document's "CCW from a0 to a1" reading, so put it back.
    problem.rebase_arc_branches(&mut params_solved);

    // Per-constraint verdicts: a satisfied cold solve marks redundancy, an
    // unsatisfied one reports the per-constraint miss so the UI can localise
    // the conflict. Both are cold-path work with no SVD: the redundancy walk is
    // incremental Gram-Schmidt over the Jacobian rows (the per-constraint SVD
    // variant was measured at 5.9 s for 200 lines), the miss is a row-norm
    // ratio. `skip_status_pass` does not gate them: it skips the per-ENTITY
    // pass, which is a different cost class.
    let (mut constraint_flags, constraint_miss) = if status == Status::Overconstrained {
        (
            vec![0u8; input.constraints.len()],
            constraint_miss(
                &problem,
                &params_solved,
                &jac,
                problem.scale(),
                input.constraints.len(),
            ),
        )
    } else {
        (
            redundancy_flags(&problem, &params_solved, &jac, input.constraints.len()),
            vec![0f64; input.constraints.len()],
        )
    };
    mark_dropped_constraints(&problem, &mut constraint_flags);

    let (entity_status, vertex_freedom) = if input.options.skip_status_pass {
        (Vec::new(), Vec::new())
    } else {
        let es = entity_status(input, &spectrum, status);
        let vf = if jac.nrows() == 0 {
            vec![0.0; input.entities.len() * 2]
        } else {
            vertex_freedom(input, &spectrum)
        };
        (es, vf)
    };

    let entity_moved = entity_moved(input, &problem.x0, &params_solved);
    Output {
        params_solved,
        entity_status,
        overall_status: status.to_u8(),
        vertex_freedom,
        constraint_flags,
        constraint_miss,
        entity_moved,
        diagnostics: Diagnostics {
            residual_norm: result.residual_norm,
            rank: rank as u32,
            // A skipped spectrum leaves no usable rank: report dof 0, the same
            // reading the mate solver gives a poisoned Jacobian, rather than
            // `n`, which would tell the UI every param is free.
            dof: if result.jacobian_finite {
                n.saturating_sub(rank) as u32
            } else {
                0
            },
            iters: result.iters,
            // Wall-clock is measured by the JS host (it has performance.now());
            // the crate has no portable clock on wasm32-unknown-unknown.
            ms: 0.0,
        },
    }
}

/// Per-param drag regularization weights. Every
/// param gets `REG_WEIGHT_BASE`; the dragged (anchor) entity's params get the
/// firmer `REG_WEIGHT_DRAG`. The contract carries a single `drag_anchor_id`
/// (an entity index); an out-of-range id just leaves the base weights (still a
/// valid, gentle pull toward the pre-drag state). The caller squares these into
/// the driver's absolute anchor weights.
fn drag_reg_weights(input: &Input, n: usize) -> Vec<f64> {
    let mut weights = vec![REG_WEIGHT_BASE; n];
    let anchor = input.options.drag_anchor_id as usize;
    if let Some(e) = input.entities.get(anchor) {
        // A stale anchor whose block runs past the buffer (or whose offset
        // arithmetic would overflow on 32-bit targets) gets only the base
        // pull, matching the out-of-range handling everywhere else.
        if let Some(end) = e
            .param_offset
            .checked_add(e.param_count)
            .filter(|&end| end <= n)
        {
            for w in &mut weights[e.param_offset..end] {
                *w = REG_WEIGHT_DRAG;
            }
        }
    }
    weights
}

/// Flag every input constraint the `Problem` build did not keep.
///
/// The survivors filter is the crate's "drop, do not panic" contract: a stale
/// ref or an operand whose kind cannot supply the slots its builder reads would
/// index off the end, so the whole constraint is removed before any row exists.
/// A dropped constraint is a fact the host must report, not a silent absence,
/// so the wire says which input positions never reached the residual stack.
fn mark_dropped_constraints(problem: &Problem, flags: &mut [u8]) {
    let mut survived = vec![false; flags.len()];
    for &wire in problem.constraint_wire_indices() {
        if let Some(flag) = survived.get_mut(wire) {
            *flag = true;
        }
    }
    for (wire, kept) in survived.into_iter().enumerate() {
        if !kept {
            flags[wire] |= CONSTRAINT_FLAG_DROPPED;
        }
    }
}

/// Incremental rank walk over the constraint rows in authoring order.
///
/// Each constraint's rows are orthogonalised (modified Gram-Schmidt, with a
/// second pass so the basis stays accurate as it grows) against the span of
/// every earlier constraint's rows. A constraint whose rows all land in that
/// span is redundant; blame falls on the LATER constraint, which is the one the
/// user just authored. Rows are taken from the final Jacobian, so the walk sees
/// the same linear structure the verdict was computed from; the pin and
/// equality-pin rows are deliberately not part of the span, matching the plan's
/// "earlier constraints" reading (a projected entity's pins would otherwise
/// make every constraint on it redundant).
///
/// Once the basis spans the full parameter space every later row is dependent
/// by construction, so the walk stops accumulating there. One pass, no SVD:
/// O(m n^2) worst case, the alternative's 5.9 s for 200 lines is the stated
/// reason.
fn redundancy_flags(problem: &Problem, x: &[f64], jac: &DMatrix<f64>, n_wire: usize) -> Vec<u8> {
    let mut flags = vec![0u8; n_wire];
    let n = jac.ncols();
    if n == 0 {
        return flags;
    }
    let wire = problem.constraint_wire_indices();
    // Orthonormal basis of the span so far, one flat row per direction.
    let mut basis: Vec<Vec<f64>> = Vec::new();
    let mut rows: Vec<f64> = Vec::new();
    let mut row0 = 0usize;
    for (ci, c) in problem.constraints().iter().enumerate() {
        rows.clear();
        problem.residual_one(c, x, &mut rows);
        let mut adds_rank = false;
        for (r, _) in rows.iter().enumerate() {
            // The residual and Jacobian builders mirror row counts by contract;
            // a broken mirror must not trap the Worker, so a short Jacobian
            // stops the WHOLE walk and keeps the flags decided so far. If only
            // this row were skipped, `row0` would still advance past the end
            // and every later constraint would read a missing row as "adds no
            // rank", misflagging the rest of the set as redundant.
            if row0 + r >= jac.nrows() {
                return flags;
            }
            if basis.len() == n {
                break;
            }
            let mut v: Vec<f64> = jac.row(row0 + r).iter().copied().collect();
            let before = norm(&v);
            for _ in 0..2 {
                for b in &basis {
                    let d = dot(&v, b);
                    if d != 0.0 {
                        for (vi, bi) in v.iter_mut().zip(b.iter()) {
                            *vi -= d * bi;
                        }
                    }
                }
            }
            let after = norm(&v);
            if after > REDUNDANT_ROW_REL * before {
                for vi in v.iter_mut() {
                    *vi /= after;
                }
                basis.push(v);
                adds_rank = true;
            }
        }
        if !rows.is_empty() && !adds_rank {
            flags[wire[ci]] = CONSTRAINT_FLAG_REDUNDANT;
        }
        row0 += rows.len();
    }
    flags
}

/// Per-constraint miss at the final iterate, as a fraction of the sketch scale.
///
/// A row's raw residual mixes units across kinds (a parallel row is a cross
/// product, i.e. a squared length, while a distance row is a length), so
/// comparing raw magnitudes would always blame the squared-unit rows. Dividing
/// each row's residual by its Jacobian row norm turns it into the position-space
/// step that would zero that row alone, which IS comparable across kinds; the
/// largest such step over a constraint's rows is its miss, and dividing by the
/// sketch scale makes the value a unit-free fraction. The frontend reads these
/// to pick the culprits of an unsatisfied solve (top contributors covering 90%
/// of the total miss), so it needs exactly this: how far each constraint is
/// from being satisfiable in the units of the sketch.
fn constraint_miss(
    problem: &Problem,
    x: &[f64],
    jac: &DMatrix<f64>,
    scale: f64,
    n_wire: usize,
) -> Vec<f64> {
    let mut miss = vec![0f64; n_wire];
    let denom = if scale > 0.0 { scale } else { 1.0 };
    let wire = problem.constraint_wire_indices();
    let mut rows: Vec<f64> = Vec::new();
    let mut row0 = 0usize;
    for (ci, c) in problem.constraints().iter().enumerate() {
        rows.clear();
        problem.residual_one(c, x, &mut rows);
        let mut worst = 0f64;
        for (r, &res) in rows.iter().enumerate() {
            if row0 + r >= jac.nrows() {
                break;
            }
            let jn = jac.row(row0 + r).norm();
            if jn > 0.0 {
                worst = worst.max(res.abs() / jn);
            }
        }
        miss[wire[ci]] = worst / denom;
        row0 += rows.len();
    }
    miss
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn norm(v: &[f64]) -> f64 {
    dot(v, v).sqrt()
}

/// The singular structure of the final Jacobian: its rank and, on request, an
/// orthonormal basis of its null space (the directions the constraints leave
/// free), each with its singular value.
struct Spectrum {
    rank: usize,
    /// `n x k`, one null direction per column; empty unless requested.
    null: DMatrix<f64>,
    null_sv: Vec<f64>,
}

impl Spectrum {
    /// The spectrum of a Jacobian that cannot be decomposed. Nothing is
    /// computed: rank 0 and an empty null basis are the only readings that do
    /// not invent structure, and the caller's verdict is already failure.
    fn non_finite() -> Spectrum {
        Spectrum {
            rank: 0,
            null: DMatrix::zeros(0, 0),
            null_sv: Vec::new(),
        }
    }

    fn of(j: &DMatrix<f64>, n: usize, want_null: bool) -> Spectrum {
        if n == 0 {
            return Spectrum {
                rank: 0,
                null: DMatrix::zeros(0, 0),
                null_sv: Vec::new(),
            };
        }
        // The last line of defence: nalgebra's SVD has no answer for a NaN
        // entry (its convergence test never fires there, and 0.33 panics on the
        // NaN singular value), so a single non-finite entry either spins or
        // aborts the worker. Callers gate on `LmResult::jacobian_finite` as
        // well, but the matrix itself is checked here so no future caller can
        // reach the SVD with one.
        if !j.iter().all(|v| v.is_finite()) {
            return Spectrum::non_finite();
        }
        // A thin SVD of an m x n matrix only returns min(m, n) right vectors,
        // so with fewer rows than params part of the null space would be
        // missing. Zero rows change neither the rank nor the null space, so
        // pad up to square first.
        let padded;
        let j = if j.nrows() < n {
            let mut p = DMatrix::<f64>::zeros(n, n);
            p.view_mut((0, 0), (j.nrows(), n)).copy_from(j);
            padded = p;
            &padded
        } else {
            j
        };
        let svd = j.clone().svd(false, want_null);
        let sv = &svd.singular_values;
        // `RANK_TOL` is a numerical-rank floor on a dimensionless spectrum;
        // its own comment in `tolerance` says why it is absolute.
        let rank = sv.iter().filter(|&&s| s > RANK_TOL).count();
        let Some(v_t) = svd.v_t else {
            return Spectrum {
                rank,
                null: DMatrix::zeros(n, 0),
                null_sv: Vec::new(),
            };
        };
        let free: Vec<usize> = (0..sv.len()).filter(|&i| sv[i] <= RANK_TOL).collect();
        let mut null = DMatrix::<f64>::zeros(n, free.len());
        for (k, &i) in free.iter().enumerate() {
            null.set_column(k, &v_t.row(i).transpose());
        }
        Spectrum {
            rank,
            null,
            null_sv: free.iter().map(|&i| sv[i]).collect(),
        }
    }
}

/// Per-entity moved report: one bit per entity, LSB-first, set when the cold
/// solve moved that entity by at least half the host's storage quantum. The
/// frontend uses it to keep the document's authored `initial` arrays for
/// entities the solve did not actually move, without a float envelope of its
/// own (see `tolerance::seed_keep_tol` for why the width is absolute).
///
/// A zero (or negative, or non-finite) quantum disables the report: with no
/// storage grid to compare against, the conservative answer is that every
/// entity moved, so the caller installs the solved geometry exactly as it did
/// before this report existed. An entity whose block does not fit the param
/// buffer is also reported moved: no solved value backs it, so no keep is
/// sound. Only stale wire data reaches that branch; the codec and `Problem`
/// already drop it.
fn entity_moved(input: &Input, x0: &[f64], x: &[f64]) -> Vec<u8> {
    let n = input.entities.len();
    let mut mask = vec![0u8; n.div_ceil(8)];
    let tol = seed_keep_tol(input.seed_quantum);
    if tol.is_nan() || tol <= 0.0 {
        for (ei, _) in input.entities.iter().enumerate() {
            mask[ei / 8] |= 1 << (ei % 8);
        }
        return mask;
    }
    for (ei, e) in input.entities.iter().enumerate() {
        let end = e.param_offset.checked_add(e.param_count);
        let unmoved = end.is_some_and(|end| {
            end <= x0.len()
                && end <= x.len()
                && (e.param_offset..end).all(|i| (x[i] - x0[i]).abs() < tol)
        });
        if !unmoved {
            mask[ei / 8] |= 1 << (ei % 8);
        }
    }
    mask
}

/// Per-entity status. An entity is underconstrained exactly when one of its
/// params can move without disturbing the constraints, i.e. when the null
/// space has a component on its columns above `tolerance::FREE_COMPONENT_TOL`
/// (absolute: the basis is orthonormal). That is the same test as pinning the
/// entity (appending identity rows) and watching the rank rise, which is how
/// this used to run: one SVD per entity, 5.9 s for 200 lines against 0.2 s
/// for the solve itself.
fn entity_status(input: &Input, spectrum: &Spectrum, overall: Status) -> Vec<u8> {
    match overall {
        Status::Overconstrained => {
            return vec![Status::Overconstrained.to_u8(); input.entities.len()]
        }
        Status::FullyConstrained => {
            return vec![Status::FullyConstrained.to_u8(); input.entities.len()]
        }
        Status::Underconstrained => {}
    }

    let null = &spectrum.null;
    input
        .entities
        .iter()
        .enumerate()
        .map(|(ei, e)| {
            // A stale entity whose block runs past the param buffer has no
            // columns to read; call it unconstrained rather than indexing out
            // of bounds (its constraints were dropped in `Problem::new`
            // anyway). The shared range check is checked arithmetic, so a
            // verbatim offset near u32::MAX cannot wrap past the guard on
            // wasm32 and index far out of bounds below.
            if !input.entity_params_in_range(ei) {
                return Status::Underconstrained.to_u8();
            }
            let mut cols = e.param_offset..e.param_offset + e.param_count;
            let free = cols.any(|i| null.row(i).iter().any(|v| v.abs() > FREE_COMPONENT_TOL));
            if free {
                Status::Underconstrained.to_u8()
            } else {
                Status::FullyConstrained.to_u8()
            }
        })
        .collect()
}

/// Per-entity null-space direction (provisional, first-cut). For each entity we
/// report the `(dx, dy)` movement of its anchor point (the first two params:
/// line start / circle/arc center / point xy) under the freest null-space
/// direction of the Jacobian. A fully constrained entity reports `(0, 0)`.
///
/// This is the seed of what the frontend drag math (`dofProjection`, not yet
/// written) will consume to project a cursor delta onto allowed directions; the
/// exact reduction across multiple null directions is refined when drag is
/// wired (phase 5). Emitted as `entity_count` pairs flattened.
fn vertex_freedom(input: &Input, spectrum: &Spectrum) -> Vec<f64> {
    let mut out = vec![0.0f64; input.entities.len() * 2];

    // The freest direction is the null vector with the smallest singular
    // value. It comes out of the status pass's SVD; a separate JᵀJ eigen
    // solve used to cost another O(n³) for this output alone.
    let best = (0..spectrum.null_sv.len()).min_by(|&a, &b| {
        spectrum.null_sv[a]
            .partial_cmp(&spectrum.null_sv[b])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let Some(col) = best else {
        return out; // fully constrained: no free direction
    };
    let v = spectrum.null.column(col);
    for (ei, e) in input.entities.iter().enumerate() {
        let off = e.param_offset;
        // Same stale-entity guard as `entity_status`: no anchor params in the
        // buffer means no reportable freedom direction, so leave the (0, 0).
        // Checked add keeps a verbatim offset near u32::MAX from wrapping the
        // bounds check and slicing the eigenvector far out of range.
        if off.checked_add(2).is_none_or(|end| end > v.len()) {
            continue;
        }
        let dx = v[off];
        let dy = v[off + 1];
        let mag = (dx * dx + dy * dy).sqrt();
        if mag > 1e-9 {
            out[ei * 2] = dx / mag;
            out[ei * 2 + 1] = dy / mag;
        }
    }
    out
}

#[cfg(test)]
mod tests;
