//! Sketch-solve orchestration: run the LM driver, then derive rank, overall
//! status, per-entity status, and per-entity vertex freedom.
//!
//! The crate handles solving only; query/projection resolution and writing
//! solved params back into the doc stay in the TS builder (the "what stays
//! scalar TS" boundary).

use crate::residuals::Problem;
use crate::{Diagnostics, Input, Output, Status};
use nalgebra::{DMatrix, SymmetricEigen};
use solver_core::lm::{solve_lm, solve_lm_sparse, solve_lm_sparse_anchored};

/// Singular values above this count toward the rank.
const RANK_TOL: f64 = 1e-6;
/// Sum of squared residuals above this means the system is unsatisfiable.
const LOSS_THRESHOLD: f64 = 1e-4;
/// Drag re-solve regularization. A linear
/// penalty `w*(x - x0)` per param biases the constraint null-space toward the
/// pre-drag state so free DOF do not drift; weights are small vs hard
/// constraints (weight 1) so real constraints always dominate.
const REG_WEIGHT_BASE: f64 = 1e-3;
const REG_WEIGHT_DRAG: f64 = 5e-2;

fn to_f32(x: &[f64]) -> Vec<f32> {
    x.iter().map(|&v| v as f32).collect()
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
        let final_loss = clean.residual_norm * clean.residual_norm;

        // Drag only operates when there are free DOF; we assume underconstrained
        // without calling the expensive matrix_rank SVD.
        // A non-finite norm is an unsatisfiable/malformed solve, not a clean
        // underconstrained one: report it as Overconstrained so NaN never reads
        // as success.
        let status = if !clean.residual_norm.is_finite() || final_loss > LOSS_THRESHOLD {
            Status::Overconstrained
        } else {
            Status::Underconstrained
        };

        // Second pass: the driver-owned seed anchor pulls free DOF toward the
        // pre-drag state (the old caller-side augmented-Jacobian refine, now a
        // shared driver mechanism). The driver anchors toward its seed, so seed
        // from the pre-drag x0: that is the cursor/pre-drag gauge reference, and
        // the anchored solve starts from it with the constraint residual
        // pulling onto the manifold. Both passes get the full iteration budget,
        // as the old plain-then-refine pair did.
        let x_final = if status == Status::Underconstrained {
            let weights = drag_reg_weights(input, n);
            // `refine_drag_sparse` appended `w*(x-x0)` residual rows; their
            // Hessian contribution is `w²`, the absolute anchor weight.
            let anchor: Vec<f64> = weights.iter().map(|w| w * w).collect();
            solve_lm_sparse_anchored(&x0, &f, &jac_sp, &anchor).x
        } else {
            clean.x
        };

        let params_solved = to_f32(&x_final);

        return Output {
            params_solved,
            entity_status: Vec::new(),
            overall_status: status.to_u8(),
            vertex_freedom: Vec::new(),
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
    let final_loss = result.residual_norm * result.residual_norm;
    let rank = matrix_rank(&jac, RANK_TOL);

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
    // fall through to FullyConstrained.
    let status = if !result.residual_norm.is_finite() || final_loss > LOSS_THRESHOLD {
        Status::Overconstrained
    } else if rank < n {
        Status::Underconstrained
    } else {
        Status::FullyConstrained
    };

    // `result.x` is not read again, so move it instead of cloning.
    let x_final = result.x;

    let params_solved = to_f32(&x_final);

    let (entity_status, vertex_freedom) = if input.options.skip_status_pass {
        (Vec::new(), Vec::new())
    } else {
        let es = entity_status(input, &jac, rank, status);
        let vf = vertex_freedom(input, &jac);
        (es, vf)
    };

    Output {
        params_solved,
        entity_status,
        overall_status: status.to_u8(),
        vertex_freedom,
        diagnostics: Diagnostics {
            residual_norm: result.residual_norm,
            rank: rank as u32,
            dof: n.saturating_sub(rank) as u32,
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
/// the driver's absolute anchor weights (the old augmented rows' Hessian was
/// `w²`).
fn drag_reg_weights(input: &Input, n: usize) -> Vec<f64> {
    let mut weights = vec![REG_WEIGHT_BASE; n];
    let anchor = input.options.drag_anchor_id as usize;
    if let Some(e) = input.entities.get(anchor) {
        // A stale anchor whose block runs past the buffer (or whose offset
        // arithmetic would overflow on 32-bit targets) gets only the base
        // pull, matching the out-of-range handling everywhere else.
        if let Some(end) = e
            .param_offset
            .checked_add(e.kind.param_count())
            .filter(|&end| end <= n)
        {
            for w in &mut weights[e.param_offset..end] {
                *w = REG_WEIGHT_DRAG;
            }
        }
    }
    weights
}

/// Rank of `j` = count of singular values strictly above `tol` (matches
/// `np.linalg.matrix_rank(J, tol=RANK_TOL)`).
fn matrix_rank(j: &DMatrix<f64>, tol: f64) -> usize {
    if j.nrows() == 0 || j.ncols() == 0 {
        return 0;
    }
    let sv = j.clone().svd(false, false).singular_values;
    sv.iter().filter(|&&s| s > tol).count()
}

/// Per-entity status via the column-pinning rank bump from `_entity_status`:
/// pin all of an entity's params (append identity rows) and see whether the
/// rank rises. If it does, that entity had free DOF -> underconstrained.
fn entity_status(input: &Input, jac: &DMatrix<f64>, rank: usize, overall: Status) -> Vec<u8> {
    match overall {
        Status::Overconstrained => {
            return vec![Status::Overconstrained.to_u8(); input.entities.len()]
        }
        Status::FullyConstrained => {
            return vec![Status::FullyConstrained.to_u8(); input.entities.len()]
        }
        Status::Underconstrained => {}
    }

    let n = input.params_initial.len();
    let m = jac.nrows();
    input
        .entities
        .iter()
        .enumerate()
        .map(|(ei, e)| {
            let size = e.kind.param_count();
            // A stale entity whose block runs past the param buffer has no
            // columns to pin; call it unconstrained rather than indexing out of
            // bounds (its constraints were dropped in `Problem::new` anyway).
            // The shared range check is checked arithmetic, so a verbatim
            // offset near u32::MAX cannot wrap past the guard on wasm32 and
            // index far out of bounds below.
            if !input.entity_params_in_range(ei) {
                return Status::Underconstrained.to_u8();
            }
            let mut aug = DMatrix::<f64>::zeros(m + size, n);
            aug.view_mut((0, 0), (m, n)).copy_from(jac);
            for k in 0..size {
                aug[(m + k, e.param_offset + k)] = 1.0;
            }
            let new_rank = matrix_rank(&aug, RANK_TOL);
            if new_rank > rank {
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
fn vertex_freedom(input: &Input, jac: &DMatrix<f64>) -> Vec<f32> {
    let n = input.params_initial.len();
    let mut out = vec![0.0f32; input.entities.len() * 2];
    if n == 0 || jac.nrows() == 0 {
        return out;
    }

    let jtj = jac.transpose() * jac;
    let eig = SymmetricEigen::new(jtj);

    // The freest direction is the eigenvector with the smallest eigenvalue,
    // provided it is in the null space (eigenvalue <= RANK_TOL^2).
    let tol2 = RANK_TOL * RANK_TOL;
    let mut best: Option<usize> = None;
    for i in 0..eig.eigenvalues.len() {
        let ev = eig.eigenvalues[i];
        if ev <= tol2 {
            match best {
                Some(b) if eig.eigenvalues[b] <= ev => {}
                _ => best = Some(i),
            }
        }
    }

    let Some(col) = best else {
        return out; // fully constrained: no free direction
    };
    let v = eig.eigenvectors.column(col);
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
            out[ei * 2] = (dx / mag) as f32;
            out[ei * 2 + 1] = (dy / mag) as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
    use crate::test_util::*;
    use crate::{EqualityPin, Kind, Options, Status};

    #[test]
    fn stale_entity_ref_solves_instead_of_panicking() {
        // The whole status pass runs over an input carrying a constraint on a
        // non-existent entity: the solve completes and simply ignores it.
        let inp = input(
            vec![line(0)],
            vec![0.0, 0.0, 10.0, 1.0],
            vec![c_target(
                ConstraintKind::Horizontal,
                7,
                PointSelector::Absent,
            )],
        );
        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        assert_eq!(out.entity_status.len(), 1);
    }

    #[test]
    fn entity_whose_param_block_overruns_the_buffer_solves() {
        // Second entity claims params 4..8 of a 4-param buffer. Both the
        // per-entity pinning pass and the vertex-freedom pass must skip it.
        let inp = input(vec![line(0), line(4)], vec![0.0, 0.0, 10.0, 1.0], vec![]);
        let out = solve_sketch(&inp);
        assert_eq!(out.entity_status.len(), 2);
        assert_eq!(out.entity_status[1], Status::Underconstrained.to_u8());
        assert_eq!(out.vertex_freedom.len(), 4);
    }

    #[test]
    fn entity_with_overflowing_param_offset_takes_the_out_of_range_path() {
        // The codec decodes a stale param_offset verbatim, so one far past
        // the param buffer can arrive. usize::MAX scale makes `offset + size`
        // overflow on every target width, so the guard path here is a real
        // regression detector on 64-bit native CI too, not just wasm32.
        let inp = input(
            vec![line(0), ent(Kind::Line, usize::MAX)],
            vec![0.0, 0.0, 10.0, 1.0],
            vec![c_target(
                ConstraintKind::Horizontal,
                0,
                PointSelector::Absent,
            )],
        );
        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        assert_eq!(out.entity_status.len(), 2);
        // Same absent status a neighboring past-the-buffer entity reports.
        assert_eq!(out.entity_status[1], Status::Underconstrained.to_u8());
        assert_eq!(out.vertex_freedom.len(), 4);
        assert_eq!(&out.vertex_freedom[2..], &[0.0, 0.0]);
    }

    #[test]
    fn vertex_freedom_skips_entity_whose_offset_wraps_the_bounds_check() {
        // Line 0 carries the free DOF so a null-space column exists; the
        // stale-offset line (usize::MAX scale, overflowing on every width)
        // must not wrap `off + 1` into a passing bounds check and slice the
        // eigenvector far out of range.
        let inp = input(
            vec![line(0), ent(Kind::Line, usize::MAX)],
            vec![0.0, 0.0, 10.0, 1.0],
            vec![c_target(
                ConstraintKind::Horizontal,
                0,
                PointSelector::Absent,
            )],
        );
        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        // Freedom pair emitted for the real line, (0, 0) left for the stale one.
        assert_eq!(out.vertex_freedom.len(), 4);
        assert_eq!(&out.vertex_freedom[2..], &[0.0, 0.0]);
    }

    #[test]
    fn drag_anchor_with_overflowing_offset_leaves_base_weights() {
        // A verbatim stale anchor offset must not wrap through
        // `offset + count` and bump arbitrary weights; it just gets no firmer
        // pull, like any other out-of-range anchor block.
        let inp = Input {
            options: Options {
                drag_anchor_id: 1,
                ..Default::default()
            },
            ..input(
                vec![line(0), ent(Kind::Line, usize::MAX)],
                vec![0.0; 4],
                vec![],
            )
        };
        let w = drag_reg_weights(&inp, 4);
        assert_eq!(w, vec![REG_WEIGHT_BASE; 4]);
    }

    #[test]
    fn free_line_is_underconstrained() {
        let inp = input(vec![line(0)], vec![0.0, 0.0, 10.0, 1.0], vec![]);
        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        assert_eq!(out.entity_status, vec![Status::Underconstrained.to_u8()]);
    }

    #[test]
    fn fixed_horizontal_length_line_converges_and_is_fully_constrained() {
        // Start fixed at (0,0); horizontal; length 10. Seeded slightly off.
        let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
        fixed_start.xy = Some((0.0, 0.0));
        let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
        length.value = Some(10.0);
        let horizontal = c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent);

        let inp = input(
            vec![line(0)],
            vec![0.2, -0.1, 9.5, 0.8],
            vec![fixed_start, horizontal, length],
        );
        let out = solve_sketch(&inp);

        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        let p = &out.params_solved;
        // start pinned at origin
        assert!(
            p[0].abs() < 1e-4 && p[1].abs() < 1e-4,
            "start {:?}",
            &p[0..2]
        );
        // horizontal -> end.y == 0, length 10 -> end.x ~ 10 (from the +x seed)
        assert!((p[2] - 10.0).abs() < 1e-3, "end.x {}", p[2]);
        assert!(p[3].abs() < 1e-3, "end.y {}", p[3]);
        assert!(out.diagnostics.residual_norm < 1e-5);
    }

    #[test]
    fn line_pinned_at_origin_with_length_but_no_orientation_is_underconstrained() {
        // Regression: start pinned at the origin and length fixed, but the line
        // is still free to rotate about that pinned point. That rotation is a
        // real, removable DOF (a horizontal/angle constraint would take it), so
        // the sketch is NOT fully constrained. The old rigid-body-DOF allowance
        // wrongly forgave this one DOF and reported FullyConstrained.
        let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
        fixed_start.xy = Some((0.0, 0.0));
        let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
        length.value = Some(10.0);

        let inp = input(
            vec![line(0)],
            vec![0.0, 0.0, 9.0, 1.0],
            vec![fixed_start, length],
        );
        let out = solve_sketch(&inp);

        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        assert_eq!(out.entity_status, vec![Status::Underconstrained.to_u8()]);
        // One free DOF remains (the rotation): rank 3 of 4 params.
        assert_eq!(out.diagnostics.dof, 1);
    }

    #[test]
    fn pinned_mask_holds_point_and_reports_fully_constrained() {
        let mut inp = input(vec![point(0)], vec![2.0, 3.0], vec![]);
        inp.pinned_mask = vec![0b11]; // pin both params to initial
        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        assert!((out.params_solved[0] - 2.0).abs() < 1e-5);
        assert!((out.params_solved[1] - 3.0).abs() < 1e-5);
    }

    #[test]
    fn equality_pins_move_point_to_target() {
        let mut inp = input(vec![point(0)], vec![0.0, 0.0], vec![]);
        inp.equality_pins = vec![
            EqualityPin {
                param_index: 0,
                target: 5.0,
            },
            EqualityPin {
                param_index: 1,
                target: -4.0,
            },
        ];
        let out = solve_sketch(&inp);
        assert!(
            (out.params_solved[0] - 5.0).abs() < 1e-4,
            "x {}",
            out.params_solved[0]
        );
        assert!(
            (out.params_solved[1] - (-4.0)).abs() < 1e-4,
            "y {}",
            out.params_solved[1]
        );
        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    }

    #[test]
    fn skip_status_pass_omits_status_and_freedom() {
        let inp = Input {
            options: Options {
                skip_status_pass: true,
                ..Default::default()
            },
            ..input(vec![line(0)], vec![0.0, 0.0, 10.0, 1.0], vec![])
        };
        let out = solve_sketch(&inp);
        assert!(out.entity_status.is_empty());
        assert!(out.vertex_freedom.is_empty());
    }

    #[test]
    fn coincident_endpoints_form_solvable_triangle_corner() {
        // Two lines; end of line A coincident with start of line B; both pinned
        // at their far ends. Exercises coincident point-point through the solver.
        let mut fix_a = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
        fix_a.xy = Some((0.0, 0.0));
        let mut fix_b = c_target(ConstraintKind::Fixed, 1, PointSelector::End);
        fix_b.xy = Some((10.0, 0.0));
        let coincident = Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::End,
                    },
                ),
                (
                    RefRole::B,
                    Ref::Entity {
                        index: 1,
                        point: PointSelector::Start,
                    },
                ),
            ],
            ..Default::default()
        };
        let inp = input(
            vec![line(0), line(4)],
            vec![0.0, 0.0, 4.0, 5.0, 4.2, 4.8, 10.0, 0.0],
            vec![fix_a, fix_b, coincident],
        );
        let out = solve_sketch(&inp);
        // line A end == line B start after solve
        let p = &out.params_solved;
        assert!((p[2] - p[4]).abs() < 1e-4, "x meet {} vs {}", p[2], p[4]);
        assert!((p[3] - p[5]).abs() < 1e-4, "y meet {} vs {}", p[3], p[5]);
        assert!(out.diagnostics.residual_norm < 1e-4);
    }

    #[test]
    fn point_on_fixed_ellipse_is_fully_constrained() {
        // Ellipse [0,0,4,2,0] pinned whole; a point pinned in x at 3 and forced
        // onto the ellipse by a point-on-ellipse coincident. The point's y is the
        // only free DOF and the conic determines it -> fully constrained, and the
        // point lands on the curve at y = sqrt(b^2 (1 - x^2/a^2)) = sqrt(1.75).
        let fix_ellipse = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
        let on_ellipse = Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 1,
                        point: PointSelector::Xy,
                    },
                ),
                (
                    RefRole::B,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Absent,
                    },
                ),
            ],
            ..Default::default()
        };
        let mut inp = input(
            vec![ellipse(0), point(5)],
            vec![0.0, 0.0, 4.0, 2.0, 0.0, 3.0, 1.0],
            vec![fix_ellipse, on_ellipse],
        );
        inp.equality_pins = vec![EqualityPin {
            param_index: 5,
            target: 3.0,
        }];

        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        let p = &out.params_solved;
        assert!((p[5] - 3.0).abs() < 1e-4, "x pinned: {}", p[5]);
        assert!(
            (p[6] - 1.75_f32.sqrt()).abs() < 1e-3,
            "y on ellipse: {}",
            p[6]
        );
        assert!(out.diagnostics.residual_norm < 1e-4);
    }

    #[test]
    fn point_on_rotated_ellipse_lands_on_the_curve() {
        // Ellipse [0,0,4,2,90] (major axis along +y after the 90deg rotation),
        // pinned whole. A point pinned in x at 1 and forced onto the ellipse: the
        // solved y must satisfy the conic in the rotated frame. With theta=90 the
        // frame swaps axes, so the conic is x^2/b^2 + y^2/a^2 = 1 -> at x=1,
        // y = a*sqrt(1 - x^2/b^2) = 4*sqrt(1 - 1/4) = 4*sqrt(3)/2 = 2*sqrt(3).
        let fix_ellipse = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
        let on_ellipse = Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 1,
                        point: PointSelector::Xy,
                    },
                ),
                (
                    RefRole::B,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Absent,
                    },
                ),
            ],
            ..Default::default()
        };
        let mut inp = input(
            vec![ellipse(0), point(5)],
            vec![0.0, 0.0, 4.0, 2.0, 90.0, 1.0, 1.0],
            vec![fix_ellipse, on_ellipse],
        );
        inp.equality_pins = vec![EqualityPin {
            param_index: 5,
            target: 1.0,
        }];

        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        let p = &out.params_solved;
        assert!((p[5] - 1.0).abs() < 1e-4, "x pinned: {}", p[5]);
        assert!(
            (p[6] - 2.0 * 3.0_f32.sqrt()).abs() < 1e-3,
            "y on rotated ellipse: {}",
            p[6]
        );
        assert!(out.diagnostics.residual_norm < 1e-4);
    }

    #[test]
    fn point_on_fixed_spline_lands_on_the_curve() {
        // Symmetric arch Bezier P1(0,0) P2(0,3) P3(3,3) P4(3,0), pinned whole.
        // Its apex is B(0.5)=(1.5,2.25) with a horizontal tangent. A point pinned
        // in x at 1.5 and forced onto the spline has y as the only free DOF; the
        // perpendicular-distance residual drives it to the apex -> fully
        // constrained, y = 2.25.
        let fix_spline = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
        let on_spline = Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 1,
                        point: PointSelector::Xy,
                    },
                ),
                (
                    RefRole::B,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Absent,
                    },
                ),
            ],
            ..Default::default()
        };
        let mut inp = input(
            vec![spline(0), point(8)],
            vec![0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0, 1.5, 1.0],
            vec![fix_spline, on_spline],
        );
        inp.equality_pins = vec![EqualityPin {
            param_index: 8,
            target: 1.5,
        }];

        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        let p = &out.params_solved;
        assert!((p[8] - 1.5).abs() < 1e-4, "x pinned: {}", p[8]);
        assert!((p[9] - 2.25).abs() < 1e-3, "y on spline apex: {}", p[9]);
        assert!(out.diagnostics.residual_norm < 1e-4);
    }

    #[test]
    fn point_distance_to_axis_endpoints_dimensions_major_and_minor_radius() {
        // Center + theta pinned; point_distance(center, Major)=5 pins a, and
        // point_distance(center, Minor)=3 pins b. Fully constrained, and the
        // solved ellipse has a=5, b=3.
        let pd_major = Constraint {
            kind_code: ConstraintKind::PointDistance.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Center,
                    },
                ),
                (
                    RefRole::B,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Major,
                    },
                ),
            ],
            value: Some(5.0),
            ..Default::default()
        };
        let pd_minor = Constraint {
            kind_code: ConstraintKind::PointDistance.to_u8(),
            refs: vec![
                (
                    RefRole::A,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Center,
                    },
                ),
                (
                    RefRole::B,
                    Ref::Entity {
                        index: 0,
                        point: PointSelector::Minor,
                    },
                ),
            ],
            value: Some(3.0),
            ..Default::default()
        };
        let mut inp = input(
            vec![ellipse(0)],
            vec![0.0, 0.0, 1.0, 1.0, 0.0],
            vec![pd_major, pd_minor],
        );
        inp.pinned_mask = vec![0b0001_0011]; // pin cx(0), cy(1), theta(4)

        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
        let p = &out.params_solved;
        assert!((p[2] - 5.0).abs() < 1e-3, "major radius a: {}", p[2]);
        assert!((p[3] - 3.0).abs() < 1e-3, "minor radius b: {}", p[3]);
        assert!(out.diagnostics.residual_norm < 1e-4);
    }

    #[test]
    fn drag_reg_weights_bump_only_the_anchor_entity() {
        // line (off 0, 4 params) + point (off 4, 2 params); anchor = the point.
        let inp = Input {
            options: Options {
                drag_anchor_id: 1,
                ..Default::default()
            },
            ..input(vec![line(0), point(4)], vec![0.0; 6], vec![])
        };
        let w = drag_reg_weights(&inp, 6);
        assert_eq!(&w[0..4], &[REG_WEIGHT_BASE; 4]); // line stays at base
        assert_eq!(&w[4..6], &[REG_WEIGHT_DRAG; 2]); // point (anchor) bumped
    }

    #[test]
    fn drag_preserves_status_rank_and_feasibility() {
        // p1 fixed at origin (seeded off), p2 free. Underconstrained either way.
        // Dragging must not change the geometry - only re-place free DOF toward
        // seed. The sparse drag fast path skips SVD/rank, so entity_status
        // and rank diagnostics are not compared against the cold path.
        let mut fix_p1 = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
        fix_p1.xy = Some((0.0, 0.0));
        let make = |drag: bool| Input {
            options: Options {
                drag_mode: drag,
                drag_anchor_id: 1,
                ..Default::default()
            },
            ..input(
                vec![point(0), point(2)],
                vec![1.0, 1.0, 3.0, 4.0],
                vec![fix_p1.clone()],
            )
        };

        let plain = solve_sketch(&make(false));
        let dragged = solve_sketch(&make(true));

        // Drag path classifies as underconstrained without the SVD (always true
        // when loss is low, which it is for a feasible underconstrained sketch).
        assert_eq!(dragged.overall_status, Status::Underconstrained.to_u8());
        assert_eq!(plain.overall_status, Status::Underconstrained.to_u8());

        // Both solves are feasible and place the fixed point at the origin.
        assert!(dragged.diagnostics.residual_norm < 1e-4);
        assert!(dragged.params_solved[0].abs() < 1e-3 && dragged.params_solved[1].abs() < 1e-3);
        // The free, undragged-by-constraints point stays near its seed under reg.
        assert!((dragged.params_solved[2] - 3.0).abs() < 1e-2);
        assert!((dragged.params_solved[3] - 4.0).abs() < 1e-2);
    }

    /// One line asked for two different lengths: no placement satisfies both,
    /// so the cold path must reach the unsatisfiable branch.
    fn contradictory_lengths(drag: bool) -> Input {
        let mut short = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
        short.value = Some(10.0);
        let mut long = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
        long.value = Some(20.0);
        Input {
            options: Options {
                drag_mode: drag,
                ..Default::default()
            },
            ..input(vec![line(0)], vec![0.0, 0.0, 10.0, 0.0], vec![short, long])
        }
    }

    #[test]
    fn contradictory_lengths_are_overconstrained_on_the_cold_path() {
        let out = solve_sketch(&contradictory_lengths(false));
        assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
        // The per-entity pass mirrors the overall status for every entity.
        assert_eq!(out.entity_status, vec![Status::Overconstrained.to_u8()]);
        assert!(out.diagnostics.residual_norm > 1e-2);
    }

    #[test]
    fn contradictory_lengths_are_overconstrained_on_the_drag_path() {
        let out = solve_sketch(&contradictory_lengths(true));
        assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
        // The drag fast path skips the per-entity SVD; the status is its output.
        assert!(out.entity_status.is_empty());
        assert!(out.diagnostics.residual_norm > 1e-2);
    }

    /// A non-finite param poisons the length residual; the LM driver refuses to
    /// step and reports a NaN norm, which the solve layer must classify as
    /// Overconstrained rather than let NaN fall through to a success status.
    fn non_finite_length(drag: bool) -> Input {
        let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
        length.value = Some(10.0);
        Input {
            options: Options {
                drag_mode: drag,
                ..Default::default()
            },
            ..input(vec![line(0)], vec![0.0, 0.0, f32::NAN, 0.0], vec![length])
        }
    }

    #[test]
    fn non_finite_residual_is_overconstrained_on_the_cold_path() {
        let out = solve_sketch(&non_finite_length(false));
        assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
        assert_eq!(out.entity_status, vec![Status::Overconstrained.to_u8()]);
        assert!(!out.diagnostics.residual_norm.is_finite());
    }

    #[test]
    fn non_finite_residual_is_overconstrained_on_the_drag_path() {
        let out = solve_sketch(&non_finite_length(true));
        assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
        assert!(out.entity_status.is_empty());
        assert!(!out.diagnostics.residual_norm.is_finite());
    }

    #[test]
    fn dragged_point_far_off_a_line_is_not_overconstrained() {
        // A point coincident with a fixed horizontal line, seeded 100 units off
        // it and dragged there. The anchored compromise sits ~0.25 off the line,
        // so its raw constraint residual exceeds LOSS_THRESHOLD; the status must
        // still come from the constraint system (satisfiable), exactly as the
        // old first unanchored solve classified it. Otherwise the caller drops
        // the frame and the point freezes instead of sliding.
        let fixed_line = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
        let on_line = Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: ab(e_ref(1, PointSelector::Xy), e_ref(0, PointSelector::Absent)),
            ..Default::default()
        };
        let inp = Input {
            options: Options {
                drag_mode: true,
                drag_anchor_id: 1,
                ..Default::default()
            },
            ..input(
                vec![line(0), point(4)],
                vec![0.0, 0.0, 10.0, 0.0, 5.0, 100.0],
                vec![fixed_line, on_line],
            )
        };

        let out = solve_sketch(&inp);
        assert_eq!(
            out.overall_status,
            Status::Underconstrained.to_u8(),
            "a satisfiable far drag must not read as overconstrained"
        );
        // The anchor still pulls the point toward the cursor: y is off the line
        // (the anchored compromise) but far below the cursor's y = 100.
        let y = out.params_solved[5];
        assert!(y.abs() > 1e-3, "anchor had no effect: y={y}");
        assert!(y.abs() < 1.0, "point did not settle near the line: y={y}");
    }

    #[test]
    fn drag_on_manifold_seed_is_a_no_op() {
        // Underconstrained, seeded already satisfying all constraints: the seed
        // anchor must leave the geometry put (it pulls toward x0, already there).
        let inp = Input {
            options: Options {
                drag_mode: true,
                drag_anchor_id: 0,
                ..Default::default()
            },
            ..input(vec![line(0)], vec![1.0, 2.0, 5.0, 2.0], vec![])
        };
        let out = solve_sketch(&inp);
        assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
        let p = &out.params_solved;
        for (got, want) in p.iter().zip([1.0, 2.0, 5.0, 2.0]) {
            assert!(
                (got - want).abs() < 1e-4,
                "drag moved a satisfied DOF: {p:?}"
            );
        }
    }
}
