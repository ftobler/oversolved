//! Sketch-solve orchestration: run the LM driver, then derive rank, overall
//! status, per-entity status, and per-entity vertex freedom.
//!
//! Ported from `_run_solver` / `_entity_status` in `oversolved/kernel/solver.py`.
//! The crate handles solving only; query/projection resolution and writing
//! solved params back into the doc stay in the TS builder (the plan's "what
//! stays scalar TS" boundary).

use crate::constraints::{ConstraintKind, Ref, RefRole};
use crate::lm::solve_lm;
use crate::residuals::Problem;
use crate::{Diagnostics, Input, Output, Status};
use nalgebra::{DMatrix, SymmetricEigen};

/// Singular values above this count toward the rank (mirrors `RANK_TOL`).
const RANK_TOL: f64 = 1e-6;
/// Sum of squared residuals above this means the system is unsatisfiable
/// (mirrors `LOSS_THRESHOLD`).
const LOSS_THRESHOLD: f64 = 1e-4;

pub fn solve_sketch(input: &Input) -> Output {
    let problem = Problem::new(input);
    let x0: Vec<f64> = problem.x0.clone();
    let n = x0.len();

    let f = |x: &[f64]| problem.residuals(x);
    let result = solve_lm(&x0, &f);

    let jac = result.jacobian;
    let final_loss = result.residual_norm * result.residual_norm;
    let rank = matrix_rank(&jac, RANK_TOL);

    let n_pinned = count_pinned_dof(input);
    let rigid_body_dof = 3usize.saturating_sub(n_pinned);
    let free_target = n.saturating_sub(rigid_body_dof);

    let status = if final_loss > LOSS_THRESHOLD {
        Status::Overconstrained
    } else if rank < free_target {
        Status::Underconstrained
    } else {
        Status::FullyConstrained
    };

    let params_solved: Vec<f32> = result.x.iter().map(|&v| v as f32).collect();

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

/// Total parameters pinned, for the rigid-body-DOF bookkeeping. Mirrors
/// `n_fixed_pinned` in `_run_solver`, extended to the crate's first-class
/// `pinned_mask` and `equality_pins` (each removes one DOF).
fn count_pinned_dof(input: &Input) -> usize {
    let mut n = 0usize;
    for c in &input.constraints {
        if c.kind() != Some(ConstraintKind::Fixed) {
            continue;
        }
        match c.ref_for(RefRole::Target) {
            Some(Ref::Entity { index, point }) => {
                if point.is_present() || c.xy.is_some() {
                    n += 2;
                } else {
                    n += input.entities[index as usize].kind.param_count();
                }
            }
            _ => n += 2,
        }
    }
    n += input.pinned_mask_bit_count(input.params_initial.len());
    n += input.equality_pins.len();
    n
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
        .map(|e| {
            let size = e.kind.param_count();
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
    use crate::constraints::{Constraint, ConstraintKind, PointSelector};
    use crate::{Entity, EqualityPin, Kind, Options, Status};

    fn line(off: usize) -> Entity {
        Entity {
            kind: Kind::Line,
            param_offset: off,
        }
    }

    fn point(off: usize) -> Entity {
        Entity {
            kind: Kind::Point,
            param_offset: off,
        }
    }

    fn c_target(kind: ConstraintKind, index: u32, point: PointSelector) -> Constraint {
        Constraint {
            kind_code: kind.to_u8(),
            refs: vec![(RefRole::Target, Ref::Entity { index, point })],
            ..Default::default()
        }
    }

    fn input(entities: Vec<Entity>, params: Vec<f32>, constraints: Vec<Constraint>) -> Input {
        Input {
            entities,
            params_initial: params,
            pinned_mask: Vec::new(),
            equality_pins: Vec::new(),
            constraints,
            options: Options::default(),
        }
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
        assert!(p[0].abs() < 1e-4 && p[1].abs() < 1e-4, "start {:?}", &p[0..2]);
        // horizontal -> end.y == 0, length 10 -> end.x ~ 10 (from the +x seed)
        assert!((p[2] - 10.0).abs() < 1e-3, "end.x {}", p[2]);
        assert!(p[3].abs() < 1e-3, "end.y {}", p[3]);
        assert!(out.diagnostics.residual_norm < 1e-5);
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
        assert!((out.params_solved[0] - 5.0).abs() < 1e-4, "x {}", out.params_solved[0]);
        assert!((out.params_solved[1] - (-4.0)).abs() < 1e-4, "y {}", out.params_solved[1]);
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
}
