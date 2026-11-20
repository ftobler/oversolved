//! The dense LM driver behind `solve_lm_damped_retract` and
//! `solve_lm_anchor_projected`: an anchored phase, an optional manifold phase
//! that walks the solution set to the anchor's minimiser, and a proximal
//! polish. The phase loop is shared, so each phase is one call of
//! `run_phase` with its own anchor target and budget.

use nalgebra::{DMatrix, DVector};

use super::{
    damp_scale_at, norm2, LmResult, LmStop, FTOL, GTOL, LAMBDA_DOWN, LAMBDA_MAX, LAMBDA_UP,
    MAX_ITERS, MAX_RETRIES, POLISH_ITERS, XTOL,
};

/// Outer steps of the manifold phase. Each is one tangent step plus a short
/// restoration; on the measured plate-and-bar fixture a 56 degree spin
/// closes in a handful, so the cap only bounds a curved solution set the
/// tangent keeps overshooting.
const MANIFOLD_STEPS: u32 = 12;
/// Gauss-Newton steps that restore one tangent trial onto the solution set.
/// The trial starts within the tangent's second-order error of it, where
/// Gauss-Newton converges quadratically.
const RESTORE_ITERS: u32 = 8;
/// Halvings of a tangent step whose restored landing did not lower the cost.
const MANIFOLD_BACKTRACKS: u32 = 6;
/// Tangent steps shorter than this, relative to the state's size, are never
/// halved: the curvature error a halving cures is second order in the step,
/// so below it a refused step is the cost's rounding and the phase is done.
const BACKTRACK_MIN: f64 = 1e-6;
/// The manifold phase stops once a tangent step moves the state less than
/// this, relative to the state's size: past it the anchor's remaining pull is
/// below anything a solved pose reports.
const MANIFOLD_XTOL: f64 = 1e-9;
/// The tangent step's regulariser, relative to the anchor weight `mu`. In the
/// Jacobian's null space the step is `-(x - x0)` whatever its size, but a
/// weakly constrained direction of curvature `s` is also pulled by
/// `eps / s` of its offset, which the restoration then pushes back: at `mu`
/// itself that tug (1e-6 of a plate contact's tilt) outlasted the stop test.
/// It must stay above the null space's rounding noise (`eps_mach * max_diag`,
/// about `5e-8 * mu`), which 1e-3 clears by four orders.
const TANGENT_EPS_REL: f64 = 1e-3;
/// The anchored phase hands over to the manifold phase once its residual cost
/// has fallen this far below the seed's and under the anchor's own cost: from
/// there the remaining descent is the anchor creeping along the solution set,
/// which the manifold phase does in a few steps instead of a few hundred.
const HANDOVER_REL: f64 = 1e-6;

/// The driver's moving parts, carried from phase to phase.
#[derive(Clone)]
struct State {
    x: Vec<f64>,
    r: Vec<f64>,
    jacm: DMatrix<f64>,
    jtj: DMatrix<f64>,
    lambda: f64,
}

impl State {
    fn residual_cost(&self) -> f64 {
        0.5 * self.r.iter().map(|&e| e * e).sum::<f64>()
    }
}

/// The per-solve constants every phase prices its cost with.
struct Ctx<'a> {
    n: usize,
    damp_scale: &'a [f64],
    mu: f64,
    lambda0: f64,
}

impl Ctx<'_> {
    /// `0.5 * mu * sum(scale_i * (x_i - target_i)^2)`: the seed anchor's
    /// price, the same term the gradient and the damped diagonal carry.
    fn anchor_cost(&self, xs: &[f64], target: &[f64]) -> f64 {
        0.5 * self.mu
            * (0..self.n)
                .map(|i| damp_scale_at(self.damp_scale, i) * (xs[i] - target[i]).powi(2))
                .sum::<f64>()
    }
}

/// Where a phase's anchor pulls: a fixed point (the seed), or the iterate
/// itself, re-centred after every accepted step (the proximal polish).
enum Target<'a> {
    Fixed(&'a [f64]),
    Proximal,
}

/// One LM phase over `st`, at most `budget` iterations. `handover` (anchored
/// phases only) is the residual cost under which the phase stops as soon as
/// the anchor's cost exceeds it, see `HANDOVER_REL`.
#[allow(clippy::too_many_arguments)]
fn run_phase(
    ctx: &Ctx,
    st: &mut State,
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
    target_kind: Target,
    budget: u32,
    handover: Option<f64>,
    retract: &mut dyn FnMut(&mut [f64]),
    iters: &mut u32,
) -> LmStop {
    let n = ctx.n;
    let proximal = matches!(target_kind, Target::Proximal);
    let mut target = match target_kind {
        Target::Fixed(t) => t.to_vec(),
        Target::Proximal => st.x.clone(),
    };
    let scale_v = DVector::from_iterator(n, (0..n).map(|i| damp_scale_at(ctx.damp_scale, i)));
    // A phase that ended on the lambda ceiling would hand the next one a
    // frozen damped system, so each phase starts no stiffer than the seed.
    st.lambda = st.lambda.min(ctx.lambda0);
    let mut cost = st.residual_cost() + ctx.anchor_cost(&st.x, &target);
    let mut phase_iters = 0;
    while phase_iters < budget {
        phase_iters += 1;
        *iters += 1;
        let rv = DVector::from_vec(st.r.clone());
        let xv = DVector::from_column_slice(&st.x);
        let target_v = DVector::from_column_slice(&target);
        // gradient Jᵀr + μ·scale·(x - target)
        let g = st.jacm.transpose() * &rv + ctx.mu * scale_v.component_mul(&(&xv - &target_v));

        // A non-finite gradient means the curvature/probe has gone bad; stop
        // here rather than let the comparison below step on NaN.
        if g.iter().any(|&v| !v.is_finite()) {
            return LmStop::GradientNonFinite;
        }
        if g.amax() < GTOL {
            return LmStop::Gradient;
        }

        // Try damped steps, increasing lambda until the step reduces cost.
        let mut accepted = false;
        let mut stop: Option<LmStop> = None;
        for _ in 0..MAX_RETRIES {
            let mut a = st.jtj.clone();
            for i in 0..n {
                // Marquardt scaling: damp proportional to each column's
                // curvature (times the caller's per-param `damp_scale`), plus
                // the absolute seed-anchor floor `mu` so flat (free)
                // directions stay finite.
                a[(i, i)] += (st.lambda * st.jtj[(i, i)].max(1e-12) + ctx.mu)
                    * damp_scale_at(ctx.damp_scale, i);
            }
            let Some(delta) = a.lu().solve(&(-&g)) else {
                st.lambda *= LAMBDA_UP;
                continue;
            };

            let x_new: Vec<f64> = (0..n).map(|i| st.x[i] + delta[i]).collect();
            let r_new = f(&x_new);
            let cost_new =
                0.5 * r_new.iter().map(|&e| e * e).sum::<f64>() + ctx.anchor_cost(&x_new, &target);

            if cost_new < cost {
                let dx = norm2(delta.as_slice());
                let cost_drop = cost - cost_new;
                st.x = x_new;
                // The retraction runs before anything reads `x` again, so
                // the Jacobian below and the anchor target after it both
                // see the folded state with its redundant coordinates back
                // at their reference.
                retract(&mut st.x);
                st.r = r_new;
                st.jacm = jac(&st.x);
                st.jtj = st.jacm.transpose() * &st.jacm;
                st.lambda = (st.lambda * LAMBDA_DOWN).max(1e-12);
                accepted = true;

                // Convergence on tiny step or tiny relative cost reduction.
                let xnorm = norm2(&st.x).max(1e-30);
                if dx < XTOL * xnorm {
                    stop = Some(LmStop::Step);
                } else if cost_drop < FTOL * cost.max(1e-30) {
                    stop = Some(LmStop::Cost);
                }
                // Re-read the cost at the retracted point rather than
                // reusing `cost_new`: the fold zeroed whatever coordinates
                // it folded, and the anchor priced those on the trial
                // vector. For a retract that changed nothing this
                // recomputes `cost_new` exactly.
                let residual = st.residual_cost();
                let anchor = ctx.anchor_cost(&st.x, &target);
                cost = residual + anchor;
                if proximal {
                    // The anchor follows the iterate, so its cost drops to 0.
                    target.clone_from(&st.x);
                    cost = residual;
                } else if stop.is_none()
                    && handover.is_some_and(|h| residual < h && residual < anchor)
                {
                    stop = Some(LmStop::Handover);
                }
                break;
            }
            st.lambda *= LAMBDA_UP;
            if st.lambda > LAMBDA_MAX {
                break;
            }
        }

        // No downhill step found means a local min of this phase's cost.
        if let Some(stop) = stop {
            return stop;
        }
        if !accepted {
            return LmStop::NoDescent;
        }
    }
    LmStop::Budget
}

/// Re-evaluate the residual and Jacobian at `st.x`.
fn refresh(st: &mut State, f: &impl Fn(&[f64]) -> Vec<f64>, jac: &impl Fn(&[f64]) -> DMatrix<f64>) {
    st.r = f(&st.x);
    st.jacm = jac(&st.x);
    st.jtj = st.jacm.transpose() * &st.jacm;
}

/// One Gauss-Newton step in the anchor's metric: solves
/// `(JᵀJ + eps·A) δ = -(Jᵀr + eps·A·d)` with `A = diag(damp_scale)`. With
/// `d = x - x0` it is the tangent step: the Jacobian's null space moves all
/// the way back to the seed (`δ = -d` there, whatever `eps`), the constrained
/// directions take the Gauss-Newton correction of `r`. With no `d` it is the
/// restoration step: the A-shortest move that closes the linearised residual,
/// so it leaves the free directions where the tangent put them. `None` on a
/// singular or non-finite solve.
fn anchor_metric_step(ctx: &Ctx, st: &State, d: Option<&DVector<f64>>) -> Option<DVector<f64>> {
    let n = ctx.n;
    let eps = ctx.mu * TANGENT_EPS_REL;
    let rv = DVector::from_column_slice(&st.r);
    let mut g = st.jacm.transpose() * &rv;
    if let Some(d) = d {
        for i in 0..n {
            g[i] += eps * damp_scale_at(ctx.damp_scale, i) * d[i];
        }
    }
    let mut a = st.jtj.clone();
    for i in 0..n {
        a[(i, i)] += eps * damp_scale_at(ctx.damp_scale, i);
    }
    let delta = a.lu().solve(&(-&g))?;
    delta.iter().all(|v| v.is_finite()).then_some(delta)
}

/// Restore a tangent trial onto the solution set: anchor-metric Gauss-Newton
/// steps until its residual cost is down to `target`. False when the
/// restoration stalled or went non-finite before getting there.
fn restore(
    ctx: &Ctx,
    trial: &mut State,
    target: f64,
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
    iters: &mut u32,
) -> bool {
    for _ in 0..RESTORE_ITERS {
        let residual = trial.residual_cost();
        if residual <= target {
            return true;
        }
        let Some(delta) = anchor_metric_step(ctx, trial, None) else {
            return false;
        };
        *iters += 1;
        let before = trial.clone();
        for (xi, di) in trial.x.iter_mut().zip(delta.iter()) {
            *xi += di;
        }
        refresh(trial, f, jac);
        if !trial.r.iter().all(|v| v.is_finite()) || trial.residual_cost() >= residual {
            *trial = before;
            return false;
        }
    }
    trial.residual_cost() <= target
}

/// The manifold phase: minimise the seed anchor ON the solution set rather
/// than along whatever path the anchored phase took to reach it.
///
/// Why it exists: the anchor is a penalty orders of magnitude weaker than any
/// constraint's curvature, so once the anchored phase stands on the solution
/// set, a step that pulls a free direction back toward the seed is a straight
/// line in parameter space that leaves the (curved) set by second order. That
/// residual increase outweighs the anchor's drop, the accept test refuses all
/// but tiny steps, and the free direction creeps at `mu / (lambda diag)` per
/// iteration: a plane contact's spin sat 56 degrees off its seed after 200.
///
/// Each outer step takes the anchor-metric tangent step, restores the trial
/// onto the solution set in the same metric, and only then prices it, so the
/// anchor's tiny cost compares two feasible points instead of losing to the
/// tangent's curvature error. Tangent and restoration sharing the anchor's
/// metric is what makes the walk converge fast: a restoration in any other
/// metric (the proximal LM's Marquardt one was measured) drags the free
/// directions back by a fixed fraction of each step. A trial that did not
/// lower the cost is halved.
///
/// It runs only while the residual is below the anchor's own cost, which is
/// what standing on the solution set means here: a conflict has no solution
/// set to walk, and a point still at its seed has nothing to walk back.
///
/// Trials evaluate with no retraction: a refused trial must leave the
/// caller's reference state untouched. The accepted landing is retracted once.
///
/// Returns whether any tangent step was accepted, and the stop of the
/// leading restoration, which is a complete polish when nothing moved after it.
fn manifold_phase(
    ctx: &Ctx,
    st: &mut State,
    x0: &[f64],
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
    retract: &mut dyn FnMut(&mut [f64]),
    iters: &mut u32,
) -> (bool, LmStop) {
    let n = ctx.n;
    let mut moved = false;
    // Stand on the solution set first, so the first tangent is the set's own.
    let lead_stop = run_phase(
        ctx,
        st,
        f,
        jac,
        Target::Proximal,
        POLISH_ITERS,
        None,
        retract,
        iters,
    );
    for _ in 0..MANIFOLD_STEPS {
        let residual = st.residual_cost();
        let anchor = ctx.anchor_cost(&st.x, x0);
        if residual >= anchor {
            break;
        }
        let cost = residual + anchor;
        let d = DVector::from_iterator(n, (0..n).map(|i| st.x[i] - x0[i]));
        *iters += 1;
        let Some(delta) = anchor_metric_step(ctx, st, Some(&d)) else {
            break;
        };
        let xnorm = norm2(&st.x).max(1.0);
        let dnorm = norm2(delta.as_slice());
        if dnorm < MANIFOLD_XTOL * xnorm {
            break;
        }
        // The anchor's cost is far above the restored residual, so the cost
        // test alone would trade feasibility for a rounding-level anchor
        // gain: a trial must restore at least as feasible as the current
        // point, to rounding. Two roundings bound that: the cost's own, and
        // the residual's, which is a few ulp of `|J| |x|` per row. Without
        // the second, a current point polished to its floor would refuse
        // every trial whose own floor happened to land a little higher.
        let jnorm = st.jtj.diagonal().amax().sqrt();
        let row_noise = 16.0 * f64::EPSILON * jnorm * xnorm;
        let noise_floor = 0.5 * st.r.len() as f64 * row_noise * row_noise;
        let target = residual.max(f64::EPSILON * cost).max(noise_floor);
        // A small tangent that the restored cost refuses is rounding, not
        // curvature: halving it only spends restorations on noise.
        let backtracks = if dnorm < BACKTRACK_MIN * xnorm {
            0
        } else {
            MANIFOLD_BACKTRACKS
        };
        let mut step = 1.0;
        let mut landed: Option<State> = None;
        for _ in 0..=backtracks {
            let mut trial = st.clone();
            for i in 0..n {
                trial.x[i] += step * delta[i];
            }
            refresh(&mut trial, f, jac);
            if trial.r.iter().all(|v| v.is_finite())
                && restore(ctx, &mut trial, target, f, jac, iters)
                && trial.residual_cost() + ctx.anchor_cost(&trial.x, x0) < cost
            {
                landed = Some(trial);
                break;
            }
            step *= 0.5;
        }
        let Some(mut next) = landed else {
            break;
        };
        let before = next.x.clone();
        retract(&mut next.x);
        if next.x != before {
            refresh(&mut next, f, jac);
        }
        *st = next;
        moved = true;
    }
    (moved, lead_stop)
}

/// The dense driver. `project` runs the manifold phase between the anchored
/// phase and the polish; without it the arithmetic is the two-phase driver's.
pub(super) fn solve(
    x0: &[f64],
    f: &impl Fn(&[f64]) -> Vec<f64>,
    jac: &impl Fn(&[f64]) -> DMatrix<f64>,
    damp_scale: &[f64],
    retract: &mut dyn FnMut(&mut [f64]),
    project: bool,
) -> LmResult {
    let n = x0.len();
    // Length contract: one entry per param. Deliberately NOT debug_assert'ed:
    // release wasm compiles asserts out anyway, and the defensive reads in
    // `damp_scale_at` make a short slice degrade to undamped instead of
    // trapping mid-solve -- which the regression test pins.
    let x = x0.to_vec();
    let r = f(&x);
    let m = r.len();

    // Degenerate problem: no residuals. Nothing to solve; report a 0xn Jacobian.
    if m == 0 || n == 0 {
        return LmResult {
            x,
            jacobian: DMatrix::zeros(m, n),
            residual_norm: norm2(&r),
            jacobian_finite: true,
            iters: 0,
            stop: LmStop::Degenerate,
            stop_phase: 0,
        };
    }

    // Non-finite contract: a NaN/Inf residual would poison every subsequent
    // cost comparison, so the driver refuses to step and returns the seed
    // unchanged. The caller sees a non-finite `residual_norm` and can report
    // the malformed problem instead of a silent "converged" seed. The returned
    // matrix is a placeholder, so the finite flag is false whatever it holds.
    if r.iter().any(|&v| !v.is_finite()) {
        return LmResult {
            x,
            jacobian: DMatrix::zeros(m, n),
            residual_norm: norm2(&r),
            jacobian_finite: false,
            iters: 0,
            stop: LmStop::NonFinite,
            stop_phase: 0,
        };
    }

    let jacm = jac(&x);
    // Initial damping from the scale of JᵀJ's diagonal.
    let jtj = jacm.transpose() * &jacm;
    let max_diag = (0..n)
        .map(|i| jtj[(i, i)])
        .fold(0.0_f64, f64::max)
        .max(1e-12);
    let lambda0 = 1e-3 * max_diag;

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
    //
    // The anchor is a penalty, so it also moves the minimizer: a converged
    // anchored solve leaves `|r| ~ mu * |x - x0|` in every constrained
    // direction, which a fixed r=2000 arc with a coincident line endpoint
    // showed as a 5e-3 gap reported as satisfied. So the first phase only
    // picks WHERE on the solution set to land, and a polish phase then
    // re-anchors at the current iterate after every accepted step (a proximal
    // point iteration). The anchor still damps each step's free directions
    // (dropping it outright let a vertical line through a point slide off to
    // 1e4 along its own valley), but it never pulls toward a fixed spot, so it
    // cannot leave a residual behind; re-anchoring once at the landing point
    // still left 3e-6 of that 5e-3 gap.
    let ctx = Ctx {
        n,
        damp_scale,
        mu: 2e-9 * max_diag,
        lambda0,
    };
    let mut st = State {
        x,
        r,
        jacm,
        jtj,
        lambda: lambda0,
    };
    let mut iters = 0;
    let handover = project.then(|| HANDOVER_REL * st.residual_cost());
    let anchored_stop = run_phase(
        &ctx,
        &mut st,
        f,
        jac,
        Target::Fixed(x0),
        MAX_ITERS,
        handover,
        retract,
        &mut iters,
    );
    let mut polish = true;
    let mut stop = anchored_stop;
    if project {
        let anchored_iters = iters;
        let (moved, lead_stop) = manifold_phase(&ctx, &mut st, x0, f, jac, retract, &mut iters);
        if !moved && anchored_stop == LmStop::Handover {
            // The handover bet that the manifold phase would carry the free
            // directions home; it took no step, so the anchored phase gets
            // the rest of its budget back and lands where the plain driver
            // would have, never short of it.
            run_phase(
                &ctx,
                &mut st,
                f,
                jac,
                Target::Fixed(x0),
                MAX_ITERS.saturating_sub(anchored_iters),
                None,
                retract,
                &mut iters,
            );
        } else if !moved {
            // Nothing moved after the leading restoration, which ran with the
            // polish's own target and budget: it was the polish.
            polish = false;
            stop = lead_stop;
        }
    }
    // The polish is phase 1 and ends every solve. After the manifold phase it
    // only finishes the last trial's restoration, whose budget is short; the
    // proximal anchor damps the free directions, so it keeps the landing.
    if polish {
        stop = run_phase(
            &ctx,
            &mut st,
            f,
            jac,
            Target::Proximal,
            POLISH_ITERS,
            None,
            retract,
            &mut iters,
        );
    }

    // The gate both SVD call sites read before decomposing: a non-finite
    // entry here would spin nalgebra's SVD forever (see the field's doc).
    let jacobian_finite = st.jacm.iter().all(|v| v.is_finite()) && norm2(&st.r).is_finite();
    LmResult {
        residual_norm: norm2(&st.r),
        x: st.x,
        jacobian: st.jacm,
        jacobian_finite,
        iters,
        stop,
        stop_phase: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{solve_lm_anchor_projected, solve_lm_damped};
    use nalgebra::DMatrix;

    // Non-capturing closures coerce to fn pointers; naming the pair keeps
    // clippy's complexity lint quiet (the same shape as `lm`'s own tests).
    type ResidualFn = fn(&[f64]) -> Vec<f64>;
    type JacobianFn = fn(&[f64]) -> DMatrix<f64>;

    /// The unit circle as the solution set, its angle the free direction,
    /// under an anchor 400 times stiffer in y than in x: the anchor's
    /// minimiser is not the radial projection of the seed, so a driver that
    /// lands where its descent stops does not find it by accident.
    fn circle() -> (ResidualFn, JacobianFn) {
        let f = |x: &[f64]| vec![10.0 * (x[0] * x[0] + x[1] * x[1] - 1.0)];
        let jac = |x: &[f64]| DMatrix::from_row_slice(1, 2, &[20.0 * x[0], 20.0 * x[1]]);
        (f, jac)
    }

    /// The minimiser of `(x - sx)^2 + k (y - sy)^2` on the unit circle, by a
    /// grid over the angle refined with Newton on its derivative.
    fn circle_minimiser(sx: f64, sy: f64, k: f64) -> [f64; 2] {
        let g = |t: f64| (t.cos() - sx).powi(2) + k * (t.sin() - sy).powi(2);
        let dg = |t: f64| -2.0 * (t.cos() - sx) * t.sin() + 2.0 * k * (t.sin() - sy) * t.cos();
        let mut t = (0..3600)
            .map(|i| i as f64 * std::f64::consts::TAU / 3600.0)
            .min_by(|a, b| g(*a).total_cmp(&g(*b)))
            .unwrap();
        for _ in 0..50 {
            let h = 1e-6;
            let ddg = (dg(t + h) - dg(t - h)) / (2.0 * h);
            t -= dg(t) / ddg;
        }
        [t.cos(), t.sin()]
    }

    #[test]
    fn projected_driver_lands_at_the_anchor_minimiser_on_a_curved_set() {
        let (f, jac) = circle();
        let seed = [3.0, 0.5];
        let scale = [1.0, 400.0];
        let mut noop = |_: &mut [f64]| {};
        let out = solve_lm_anchor_projected(&seed, &f, &jac, &scale, &mut noop);
        let want = circle_minimiser(seed[0], seed[1], scale[1]);
        assert!(out.residual_norm < 1e-10, "residual {}", out.residual_norm);
        for i in 0..2 {
            assert!(
                (out.x[i] - want[i]).abs() < 1e-7,
                "x[{i}] = {} vs the anchor minimiser {}",
                out.x[i],
                want[i]
            );
        }
    }

    /// The bug's shape in two params, at the mate fixture's proportions: a
    /// slide `a` and a swing `b` (damped 500 times stiffer) on the set
    /// `a = L (1 - cos b)`, a 250 lever. Seeded with the slide 30 off the
    /// set, the anchor's minimiser has the lever swung out to `b = 0.48` so
    /// the slide gives back part of its 30: a free direction reached only
    /// along a curved set, by the anchor alone. With one row the plain driver
    /// gets there as well (the mate fixture's coupled rows are what stalled
    /// it, see `ppd_free_spin_lands_where_the_seed_anchor_holds_it`); this
    /// pins the projected driver's own guarantee.
    const LEVER: f64 = 250.0;

    fn lever() -> (ResidualFn, JacobianFn) {
        let f = |x: &[f64]| vec![x[0] - LEVER * (1.0 - x[1].cos())];
        let jac = |x: &[f64]| DMatrix::from_row_slice(1, 2, &[1.0, -LEVER * x[1].sin()]);
        (f, jac)
    }

    /// The anchor's minimiser on the lever's set, over `b` by Newton on the
    /// derivative of `(L (1 - cos b) - a0)^2 + k (b - b0)^2`.
    fn lever_minimiser(a0: f64, b0: f64, k: f64) -> [f64; 2] {
        let g = |b: f64| (LEVER * (1.0 - b.cos()) - a0).powi(2) + k * (b - b0).powi(2);
        let mut b = (0..2000)
            .map(|i| i as f64 * 2e-3)
            .min_by(|p, q| g(*p).total_cmp(&g(*q)))
            .unwrap();
        for _ in 0..50 {
            let h = 1e-5;
            let d1 = (g(b + h) - g(b - h)) / (2.0 * h);
            let d2 = (g(b + h) - 2.0 * g(b) + g(b - h)) / (h * h);
            b -= d1 / d2;
        }
        [LEVER * (1.0 - b.cos()), b]
    }

    #[test]
    fn projected_driver_carries_a_free_lever_to_the_anchor_minimiser() {
        let (f, jac) = lever();
        let seed = [30.0, 0.1];
        let scale = [1.0, 500.0];
        let want = lever_minimiser(seed[0], seed[1], scale[1]);
        // The minimiser must sit well along the set from the seed's swing,
        // or the test would pass on a driver that never moves `b`.
        assert!(want[1] > 0.3, "minimiser at b = {}", want[1]);
        let mut noop = |_: &mut [f64]| {};
        let out = solve_lm_anchor_projected(&seed, &f, &jac, &scale, &mut noop);
        assert!(out.residual_norm < 1e-10, "residual {}", out.residual_norm);
        for i in 0..2 {
            assert!(
                (out.x[i] - want[i]).abs() < 1e-6,
                "x[{i}] = {} vs the anchor minimiser {}",
                out.x[i],
                want[i]
            );
        }
    }

    #[test]
    fn projected_driver_leaves_a_conflict_to_the_plain_driver() {
        // No point satisfies both rows, so there is no solution set to walk:
        // the manifold phase must not run, and the landing is the plain one.
        let f = |x: &[f64]| vec![x[0] - 1.0, x[0] - 2.0, x[1] - 3.0];
        let jac = |_: &[f64]| DMatrix::from_row_slice(3, 2, &[1.0, 0.0, 1.0, 0.0, 0.0, 1.0]);
        let mut noop = |_: &mut [f64]| {};
        let plain = solve_lm_damped(&[0.0, 0.0], &f, &jac, &[1.0, 1.0]);
        let projected = solve_lm_anchor_projected(&[0.0, 0.0], &f, &jac, &[1.0, 1.0], &mut noop);
        // Bit-identical, count included: the conflict never hands over, the
        // manifold phase's leading restoration is the plain driver's polish,
        // and with nothing moved after it no second polish runs.
        assert_eq!(plain.x, projected.x);
        assert_eq!(plain.iters, projected.iters);
    }

    #[test]
    fn projected_driver_matches_the_plain_one_when_nothing_is_free() {
        // A fully constrained problem has a one-point solution set: the
        // manifold phase has nowhere to go, so it must not move the answer.
        let f = |x: &[f64]| vec![x[0] * x[0] - 2.0, x[1] - x[0]];
        let jac = |x: &[f64]| DMatrix::from_row_slice(2, 2, &[2.0 * x[0], 0.0, -1.0, 1.0]);
        let mut noop = |_: &mut [f64]| {};
        let plain = solve_lm_damped(&[3.0, 1.0], &f, &jac, &[1.0, 1.0]);
        let projected = solve_lm_anchor_projected(&[3.0, 1.0], &f, &jac, &[1.0, 1.0], &mut noop);
        let root = 2f64.sqrt();
        for out in [&plain, &projected] {
            assert!((out.x[0] - root).abs() < 1e-10, "x = {:?}", out.x);
            assert!((out.x[1] - root).abs() < 1e-10, "x = {:?}", out.x);
        }
    }

    #[test]
    fn manifold_trials_keep_the_retraction_consistent() {
        // The retraction rewrites the caller's hidden reference, so it may
        // only ever see accepted states: retracting a trial the phase then
        // refused would move the reference under an iterate that did not
        // move, and the residual the driver reports would stop describing
        // its own `x`. A reference that folds every increment past a small
        // radius makes that mismatch show.
        use std::cell::Cell;
        let reference = Cell::new([0.0, 0.0]);
        let f = |x: &[f64]| {
            let p = reference.get();
            let (u, v) = (p[0] + x[0], p[1] + x[1]);
            vec![10.0 * (u * u + v * v - 1.0)]
        };
        let jac = |x: &[f64]| {
            let p = reference.get();
            DMatrix::from_row_slice(1, 2, &[20.0 * (p[0] + x[0]), 20.0 * (p[1] + x[1])])
        };
        let mut retract = |x: &mut [f64]| {
            if x[0].hypot(x[1]) > 0.05 {
                let p = reference.get();
                reference.set([p[0] + x[0], p[1] + x[1]]);
                x[0] = 0.0;
                x[1] = 0.0;
            }
        };
        let out = solve_lm_anchor_projected(&[3.0, 0.5], &f, &jac, &[1.0, 400.0], &mut retract);
        let recomputed = f(&out.x)[0].abs();
        assert!(
            (recomputed - out.residual_norm).abs() < 1e-12,
            "reported {} but the state reads {recomputed}",
            out.residual_norm
        );
        assert!(recomputed < 1e-10, "residual {recomputed}");
    }
}
