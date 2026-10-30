//! Mate residual builders and analytic Jacobian for the 3D rigid-body solver.
//!
//! The wire keeps its 7 params per body: translation (tx, ty, tz) followed by
//! a unit quaternion (qx, qy, qz, qw). What LM optimises is smaller. Each FREE
//! body contributes 6 state entries -- translation (3) plus a rotation vector
//! `w` (3) about its seeded orientation -- and a grounded body contributes
//! none: its pose is a constant in the residuals, never a parameter.
//! `expand` composes each evaluation's pose as `q = exp(w) * q_ref` over the
//! per-body reference `q_ref` (the normalised seed), so the residuals below
//! always see a unit quaternion and `params_solved` reports unit quaternions
//! without any normalisation step. That is why a converged solve is converged
//! in the pose the host shows: there is no soft unit-norm residual left to
//! trade a point gap against, and no grounded pin row a least-squares optimum
//! can outvote. `dexp_drot` chains the existing quaternion derivatives through
//! `dq/dw` exactly, at whatever `w` the state holds, so the state stays
//! anchored to the seed rather than being folded step by step -- the seed
//! anchor then keeps meaning "stay oriented as you were placed"
//! (`ROT_DAMP_SCALE` records how the damping was re-measured). The one fold
//! is `retract`, driven through `lm::solve_lm_damped_retract`: past a
//! rotation-vector radius of 4 radians `exp` starts losing conditioning and at
//! a full turn it collapses outright, so a stray body is re-based onto its
//! reference there with the pose unchanged. The wire and the rank analysis
//! only ever meet a well-conditioned chart.
//!
//! Residuals per mate kind:
//! - Fixed:              point coincidence + offset vector in A's frame (3) + signed axis difference w/ flip (3) + absolute roll to authored angle (1)
//! - Spherical:          point coincidence (3)
//! - Parallel:           dot product of axes minus sign (1)
//! - Sliding:            signed axis difference w/ flip (3) + perp displacement cross (3) + absolute roll to authored angle (1)
//!   -- prismatic: slide is the only free DOF
//! - Rotating:           point coincidence (3) + signed axis difference w/ flip (3)
//! - SlidingRotating:    signed axis difference w/ flip (3) + perp displacement cross (3)
//!   -- cylindrical: slide + roll are free DOF
//! - Tangential:         signed-distance formula (1), surface-pair dependent
//! - CopyRotation:       roll_b - ratio * roll_a around seed-frame axes (1)
//! - ParallelPlaneDistance: dot(diff, normal) - offset (1) + axis-dot parallelism w/ flip (1)
//!
//! Orientation is authored data, never seed state: every orientation target
//! above comes off the wire (`flip`, `angle`), so a solve is a pure function of
//! the document and re-solving from its own output is a no-op. The one
//! exception is CopyRotation, whose whole point is linking FUTURE rotation, so
//! it alone keeps a seed-relative twist. The editor captures `flip`/`angle`
//! from the on-screen pose when the mate's references are picked, which is how
//! "hold what I placed" still works without the solver remembering anything:
//! deriving these from the seed instead made every solve inherit the last
//! solve's rounding error (baked into the doc on drag pointer-up) -- welded
//! parts drifted apart rotationally, an authored angle re-applied itself on
//! every reseed (a ratchet), and the weld side flipped when a drag swung the
//! axes past perpendicular.

use nalgebra::DMatrix;
use std::cell::RefCell;

use crate::mate::{
    AnchorKind, Mate, MateDiagnostics, MateInput, MateKind, MateOutput, MateStatus, RigidBody,
};
use solver_core::lm;

/// Pre-built problem: holds decodings from MateInput for fast residual/Jacobian eval.
pub struct MateProblem {
    /// The seed buffer's length (n_bodies * 7): the WIRE dimension. The
    /// dimension LM optimises is `n_red`; `n` sizes the 7-param pose buffer
    /// every residual indexes through `body_index * 7`.
    n: usize,
    /// Copy of the seed params widened to f64.
    x0: Vec<f64>,
    /// Mates with local geometry, after the stale/dropped filter.
    mates: Vec<Mate>,
    /// Mate count as it arrived on the wire, before the filter above. The
    /// per-mate residual wire reports one entry per INPUT mate so the host's
    /// positional fold cannot shift when a mate is dropped.
    input_mate_count: usize,
    /// For each surviving mate in `mates`, its index in the input list. Dropped
    /// mates hold their slot in the output (a sentinel) instead of closing the
    /// gap and mis-attributing every later residual.
    kept_input_indices: Vec<usize>,
    /// Per-body param offsets.
    bodies: Vec<RigidBody>,
    /// Total residual count m: the mate rows only. The two global row groups
    /// the pre-manifold solver appended (one unit-norm row per body, seven
    /// pin rows per grounded body) are gone; grounding and unit norm are now
    /// properties of the state, not residuals. `mate_residual_count` and the
    /// per-mate slicing are unaffected.
    m: usize,
    /// Reduced LM state dimension: 6 per free body (translation + rotation
    /// vector), 0 per grounded body. This is the `n` of every rank/dof
    /// and damping computation.
    n_red: usize,
    /// Per body, its first column in the reduced state, or `None` when the
    /// body is no solver parameter at all: grounded (its pose is a constant
    /// in the residuals) or its 7-param block is missing from the seed
    /// buffer (same drop-don't-panic posture as the stale-mate filter).
    body_col: Vec<Option<usize>>,
    /// Reference quaternion per body, unit by construction: the base the
    /// reduced state composes through as `exp(w) * q_ref`. It starts as the
    /// normalised seed, so `w = 0` reads "oriented as seeded" and the seed
    /// anchor keeps its meaning; `retract` re-bases it whenever `w` strays
    /// past `FOLD_W` (the pose is unchanged by that fold, only the chart is).
    /// `RefCell` because the residual and Jacobian closures borrow the
    /// problem immutably while the LM driver's retract hook re-bases through
    /// the same storage. Only free bodies are read; a body whose block is
    /// missing from the seed buffer keeps the identity placeholder and
    /// contributes no columns anyway.
    q_ref: RefCell<Vec<f64>>,
    /// Seed-frame world axes for CopyRotation (fixed at problem build time).
    /// `fill_copy_rotation` linearises about THESE, never the current
    /// quaternion's axis -- the current axis drifts as the body rotates away
    /// from its seed, and `jacobian_vs_fd_copy_rotation` only evaluates at the
    /// seed, which made a seed-vs-current mismatch invisible.
    seed_axes: Vec<Option<([f64; 3], [f64; 3])>>,
    /// `(twist_a(x0), twist_b(x0))`, measured about `seed_axes`. CopyRotation
    /// holds each body's twist relative to ITS OWN half of the pair
    /// (`twist_b - twist_b0 = ratio * (twist_a - twist_a0)`), so authoring a
    /// gear mate on two already-rotated bodies links their FUTURE rotation
    /// instead of snapping them together.
    seed_twist: Vec<(f64, f64)>,
    /// Canonical in-plane reference direction per side, for `Fixed`'s and
    /// `Sliding`'s absolute roll residual. Carried on the wire as
    /// `MateGeometry.perp` (the editor's canonicalPerp of each anchor's LOCAL
    /// axis, utils/mateOrientation.ts), so the frame is rigid to the part and
    /// the solver measures the exact direction the authored `angle` was captured
    /// against.
    roll_frames: Vec<Option<([f64; 3], [f64; 3])>>,
    /// Characteristic drawing length: the AABB diagonal over the seed body
    /// translations and the mate anchors' local points, floored at 1.0. See
    /// `geometry_scale`.
    scale: f64,
}

/// How much stiffer the LM step damps a free body's rotation vectors than its
/// translations. `reduced_damp_scale` divides both by the seed's largest
/// J^T J diagonal, so what this constant fixes is the RATIO between the two:
/// the slide-over-spin preference, and nothing about the drawing's size.
///
/// Why 500 -- the pre-manifold value, kept as a measured result rather than
/// inherited: what this weights is damping per unit of ANCHOR motion, and in
/// both parameterisations the rotation columns already carry the lever arm
/// squared (the quaternion derivative `drot_vec_dq` scales with the local
/// anchor length, `d r / d w` with the world lever), so the lever cancels and
/// only `damp_r / damp_t` survives. A rotation vector differs from a
/// quaternion vector by the factor 2 (`q_vec = sin(theta/2) axis`) and its
/// Jacobian entry differs by that factor squared, so 500 in radians weighs a
/// radian as 500 in quaternions did. The observable it guards is
/// `free_body_reaches_point_more_by_translating_than_rotating`, a point
/// coincidence the body could close either by sliding 3 units or by spinning
/// about its offset anchor; measured on that fixture, the slide's share reads
/// tx = 1.97 at 10 (and the solve burns its whole 200-step phase hunting the
/// anchor), 2.47 at 50, 2.73 at 100, 2.95 at 500, 2.99 at 2000 against an
/// assertion of tx > 2.5 -- so 10 and 50 fail it, 100 passes, and 500 keeps
/// the pre-manifold constant while converging in 33 iterations. The whole
/// suite is green from 100 to 10000, which is the band to re-measure in if a
/// future change moves these numbers.
///
/// The division by `max_diag` is the scale half: the driver reads its own
/// `lambda0 = 1e-3 * max_diag` off the same diagonal, which under this
/// parameterisation grows with the lever arm squared, so at a 400-unit lever
/// lambda0 is 320 and an undivided scale would start rotation at 1.6e5 times
/// its own curvature (and translation at 320 times) -- a dozen-plus accepted
/// steps of pure lambda-shrinkage before any step is Gauss-Newton sized.
/// Divided out, each column starts at `1e-3 * its base ratio` whatever the
/// drawing measures.
///
/// It weights only the Marquardt damping and the seed anchor, never the
/// residual and never the convergence condition.
const ROT_DAMP_SCALE: f64 = 500.0;

/// Cell ceiling on the dense Jacobian this solver will allocate.
///
/// The dense LM driver materialises the m*n Jacobian plus a J^T J of n*n and
/// LU workspaces alongside it, so memory scales as several multiples of m*n
/// f64s. A well-formed but oversized header (say 1000 bodies x 500k spherical
/// mates) would otherwise trap the wasm heap mid-allocation, and the resulting
/// OOM abort kills the worker outright instead of returning anything. Solves
/// above the budget are refused up front with the failing status until the
/// sparse-LM migration replaces the dense path; 2e8 cells (~1.6 GB of f64) sits
/// far above every legitimate assembly yet far below what aborts the heap.
const DENSE_CELL_BUDGET: usize = 200_000_000;

/// The budget gate behind `solve_mate`, parameterised so tests can drive it
/// with tiny numbers instead of reserving a real one. An m*n that overflows
/// usize counts as over budget: wrapping it back under would defeat the check.
fn dense_cells_over_budget(m: usize, n: usize, budget: usize) -> bool {
    match m.checked_mul(n) {
        Some(cells) => cells > budget,
        None => true,
    }
}

/// Residual count contributed by one mate of `kind`. A standalone function (not
/// inlined into `MateProblem::new`) so `mate_residual_count_matches_actual_residuals_pushed`
/// can drive it directly: a future arm that bumps this without bumping the
/// matching `residuals()` push count -- or the reverse -- fails that test
/// loudly instead of writing a residual row into another mate's block.
fn mate_residual_count(kind: MateKind) -> usize {
    match kind {
        MateKind::Fixed => 7,
        MateKind::Spherical => 3,
        MateKind::Parallel => 1,
        MateKind::Sliding => 7,
        MateKind::Rotating => 6,
        MateKind::SlidingRotating => 6,
        MateKind::Tangential => 1,
        MateKind::CopyRotation => 1,
        MateKind::ParallelPlaneDistance => 2,
    }
}

/// Characteristic drawing length for the relative `mate_status` threshold.
///
/// Built from the AABB diagonal over the seed body translations and the mate
/// anchors' local points. The threshold is relative on purpose: a modelling
/// conflict is a fraction of the drawing, so a 1e4-unit assembly with a
/// one-unit conflict reads like a 1-unit assembly with a 1e-4 conflict, and
/// the verdict does not flip when the same assembly is redrawn in different
/// units. (The rev 2 f32 wire's size-proportional quantum was the original
/// motivation; the rev 3 f64 wire removes that noise but not the design.) The
/// floor at 1.0 preserves the historical absolute 1e-4 behaviour for models
/// under one unit.
fn geometry_scale(x0: &[f64], mates: &[Mate]) -> f64 {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut add = |p: [f64; 3]| {
        for i in 0..3 {
            if p[i] < min[i] {
                min[i] = p[i];
            }
            if p[i] > max[i] {
                max[i] = p[i];
            }
        }
    };
    for bi in 0..(x0.len() / 7) {
        let off = bi * 7;
        add([x0[off], x0[off + 1], x0[off + 2]]);
    }
    for m in mates {
        add(m.a.geometry.point);
        add(m.b.geometry.point);
    }
    if !min[0].is_finite() {
        return 1.0;
    }
    let dx = max[0] - min[0];
    let dy = max[1] - min[1];
    let dz = max[2] - min[2];
    (dx * dx + dy * dy + dz * dz).sqrt().max(1.0)
}

impl MateProblem {
    pub fn new(input: &MateInput) -> Self {
        let n_bodies = input.bodies.len();
        let grounded: Vec<bool> = (0..n_bodies).map(|i| input.is_fixed(i)).collect();

        let x0: Vec<f64> = input.params_initial.clone();
        // The param dimension the solver optimizes IS the seed buffer: every
        // LM-side slice (step vector, J^T J diagonal, damping scale) is sized
        // from x0's length, so reporting bodies*7 here would desync the
        // Jacobian's columns from the state vector and panic inside nalgebra.
        // Well-formed inputs carry exactly bodies*7 entries; an in-memory
        // caller can hand us fewer or more, and bodies whose block falls
        // outside the buffer simply contribute no rows (same drop-don't-panic
        // posture as the stale-mate filter below).
        let n = x0.len();

        // Every mate residual and Jacobian row indexes `body_index * 7`, and the
        // index comes off the wire, so a stale mate (one authored against a body
        // that has since left the assembly) would run off the end of x. Drop the
        // whole mate: a half-applied mate is worse than an absent one, and the
        // solve still reports the remaining assembly honestly. The block end is
        // computed checked: on wasm32 an unchecked `(bi + 1) * 7` wraps for
        // absurd counts, and the wrapped compare would keep a body or mate that
        // indexes off the end.
        let block_within = |bi: usize| {
            bi.checked_add(1)
                .and_then(|next| next.checked_mul(7))
                .is_some_and(|end| end <= x0.len())
        };
        let addressable = |bi: u32| (bi as usize) < n_bodies && block_within(bi as usize);
        let mut mates: Vec<Mate> = Vec::new();
        let mut kept_input_indices: Vec<usize> = Vec::new();
        for (input_index, m) in input.mates.iter().enumerate() {
            // A mate needs two different parts. The host refuses this at the pick
            // (and solveAssembly.ts guards it), but the headless api.rs entry
            // point accepts an arbitrary wire, and a same-body mate reaches the
            // Jacobian fillers where off_a == off_b makes both sides write the
            // same cells. Drop it here, matching the stale-mate posture: it
            // contributes no row and the rest of the assembly solves honestly.
            let same_body = m.a.body_index == m.b.body_index;
            if addressable(m.a.body_index) && addressable(m.b.body_index) && !same_body {
                kept_input_indices.push(input_index);
                mates.push(m.clone());
            }
        }

        let mate_residual_total: usize = mates.iter().map(|m| mate_residual_count(m.kind)).sum();
        // The rows are the mates' rows and nothing else: grounding and unit
        // norm are state invariants now, not residuals. `mate_residual_count`
        // and the per-mate slicing in `solve_mate_impl` are therefore exact.
        let m = mate_residual_total;

        // Reduced state layout. A body becomes a solver parameter only when it
        // is free AND its whole 7-param block sits in the seed buffer: a
        // grounded body's pose is a constant in the residuals, and a body
        // whose block is missing cannot be read at all (its mates were dropped
        // above for exactly that reason). Each parameter owns 6 columns --
        // translation verbatim plus the rotation increment that composes onto
        // `q_ref`.
        let mut body_col: Vec<Option<usize>> = vec![None; n_bodies];
        let mut n_red = 0usize;
        for bi in 0..n_bodies {
            if !grounded[bi] && block_within(bi) {
                body_col[bi] = Some(n_red);
                n_red += 6;
            }
        }

        // Seed quaternions enter the state normalised: "unit by construction"
        // starts here, so a host buffer carrying a non-unit quaternion solves
        // and reports the pose its normalisation names. A GROUNDED body's
        // buffer never passes through this -- it is echoed bit-exact from the
        // seed in `expand`.
        let mut q_ref = vec![0.0; n_bodies * 4];
        for bi in 0..n_bodies {
            let base = bi * 4;
            q_ref[base..base + 4].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
            if block_within(bi) {
                let off = bi * 7;
                let seed_q = [x0[off + 3], x0[off + 4], x0[off + 5], x0[off + 6]];
                q_ref[base..base + 4].copy_from_slice(&quat_normalize(&seed_q));
            }
        }

        // Precompute seed-frame world axes for CopyRotation mates plus each
        // body's twist at the seed pose about those axes, and the pose-free
        // canonical roll frames for Fixed and Sliding.
        let mut seed_axes: Vec<Option<([f64; 3], [f64; 3])>> = vec![None; mates.len()];
        let mut seed_twist: Vec<(f64, f64)> = vec![(0.0, 0.0); mates.len()];
        let mut roll_frames: Vec<Option<([f64; 3], [f64; 3])>> = vec![None; mates.len()];
        for (i, m) in mates.iter().enumerate() {
            if m.kind == MateKind::CopyRotation {
                let off_a = m.a.body_index as usize * 7;
                let off_b = m.b.body_index as usize * 7;
                let a_w = world_direction(&x0, off_a, &m.a.geometry.axis);
                let b_w = world_direction(&x0, off_b, &m.b.geometry.axis);
                let seed_a = normalise_axis(&a_w);
                let seed_b = normalise_axis(&b_w);
                seed_axes[i] = Some((seed_a, seed_b));

                let qa = (x0[off_a + 3], x0[off_a + 4], x0[off_a + 5], x0[off_a + 6]);
                let qb = (x0[off_b + 3], x0[off_b + 4], x0[off_b + 5], x0[off_b + 6]);
                let twist_a0 = twist_angle(qa.0, qa.1, qa.2, qa.3, &seed_a);
                let twist_b0 = twist_angle(qb.0, qb.1, qb.2, qb.3, &seed_b);
                seed_twist[i] = (twist_a0, twist_b0);
            }
            if matches!(m.kind, MateKind::Fixed | MateKind::Sliding) {
                roll_frames[i] = Some((m.a.geometry.perp, m.b.geometry.perp));
            }
        }

        let scale = geometry_scale(&x0, &mates);

        MateProblem {
            n,
            x0,
            mates,
            input_mate_count: input.mates.len(),
            kept_input_indices,
            bodies: input.bodies.clone(),
            m,
            n_red,
            body_col,
            q_ref: RefCell::new(q_ref),
            seed_axes,
            seed_twist,
            roll_frames,
            scale,
        }
    }

    /// Characteristic length of the drawing, floored at 1.0. `mate_status`
    /// multiplies its relative residual tolerance by this so the threshold
    /// tracks the model rather than an absolute distance in the wire's units.
    pub fn geometry_scale(&self) -> f64 {
        self.scale
    }

    /// Absolute roll: the signed angle from A's canonical reference direction to
    /// B's, measured about A's current world axis, minus the authored `angle`.
    /// Shared by `Fixed` and `Sliding`. The reference directions are the wire
    /// perps (`MateGeometry.perp`) carried into world space, so the residual is
    /// a pure function of the two poses and the authored target: zero seed
    /// dependence, hence re-solving from a baked (already-solved) doc changes
    /// nothing, and any rotational error a previous solve left behind is pulled
    /// back out instead of adopted as the new truth.
    ///
    /// `atan2(dot(cross(xa, xb), w), dot(xa, xb))` reads the angle of `xb`
    /// projected into the plane perpendicular to `w`; `xa` lies in that plane
    /// exactly (rigid rotation keeps it perpendicular to A's axis), and `xb`
    /// falls into it as the axis residuals align the axes, so near a solution
    /// this is the plain dihedral roll. The wrap keeps the residual in
    /// (-pi, pi]: a target of +179 deg and a pose at -179 deg are 2 deg apart,
    /// not 358. Far from a solution `xb` can lean onto `w` instead, where the
    /// projection has no length and the angle has no meaning; the code below
    /// says so rather than letting `atan2` of a vanishing pair pretend the
    /// roll is fine.
    fn abs_roll_residual(
        &self,
        x: &[f64],
        mi: usize,
        off_a: usize,
        off_b: usize,
        target: f64,
    ) -> f64 {
        let (sin_r, cos_r) = self.roll_dihedral(x, mi, off_a, off_b);
        let frame_len = (sin_r * sin_r + cos_r * cos_r).sqrt();
        let error = wrap_to_pi(sin_r.atan2(cos_r) - target);
        if frame_len >= Self::ROLL_FRAME_TRUST {
            return error;
        }
        // Inside the cone where B's canonical reference lines up with A's
        // axis -- which happens exactly when the two axes are near
        // perpendicular, i.e. nowhere near a solution -- `atan2` is evaluating
        // a pair whose length is heading to zero: the angle is undefined, and
        // worse, `atan2(0, 0)` reads 0, so the undefined pose reads "roll
        // satisfied". That false minimum is a trap: a descent chasing the axis
        // residual walks into it, the row's finite-difference slope explodes to
        // ~2*pi/eps over a 1e-6 step, J^T J picks up the square, and LM freezes
        // into a false convergence on a pose whose axis residual is still
        // sqrt(2). Fade the error to the worst case (+pi) across the cone
        // instead: continuous at the rim, maximum rather than minimum at the
        // apex, and bounded in slope, so the row keeps its guidance without the
        // trap. The fade factor is a smoothstep, not a plain `min(1, x)`:
        // smoothstep leaves the rim with zero derivative, so the two branches
        // meet C1 and a finite difference straddling the rim measures the real
        // slope instead of a kink (measured: the linear version skewed the roll
        // row's 1e-6 stencil by ~24 against a true slope of ~11, which is
        // exactly the kind of wrong Jacobian that sends a step uphill).
        //
        // Every solution has frame_len near 1, where f is exactly 1 and nothing
        // here is in force.
        let x = frame_len / Self::ROLL_FRAME_TRUST;
        let f = if x >= 1.0 {
            1.0
        } else {
            x * x * (3.0 - 2.0 * x)
        };
        f * error + (1.0 - f) * std::f64::consts::PI
    }

    /// The roll angle's argument pair `(sin_r, cos_r)` at pose `x`, split out
    /// of `abs_roll_residual` because its LENGTH is what says whether the
    /// angle exists at all (see `ROLL_FRAME_TRUST`).
    fn roll_dihedral(&self, x: &[f64], mi: usize, off_a: usize, off_b: usize) -> (f64, f64) {
        let mate = &self.mates[mi];
        let (xa_l, xb_l) = self.roll_frames[mi].unwrap_or(([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]));
        let w = normalise_axis(&world_direction(x, off_a, &mate.a.geometry.axis));
        let xa_w = world_direction(x, off_a, &xa_l);
        let xb_w = world_direction(x, off_b, &xb_l);
        let cr = cross3(&xa_w, &xb_w);
        let sin_r = cr[0] * w[0] + cr[1] * w[1] + cr[2] * w[2];
        let cos_r = xa_w[0] * xb_w[0] + xa_w[1] * xb_w[1] + xa_w[2] * xb_w[2];
        (sin_r, cos_r)
    }

    /// Half-width of the cone (measured as the length of `(sin_r, cos_r)`,
    /// the sine of the angle between B's reference and A's axis) inside which
    /// the dihedral is treated as undefined. Measured, not guessed: at 0.1 the
    /// false minima still rimmed the cone -- a solve settled one part outside
    /// it, where `atan2` is already meaningless (its 1e-6 stencil then skews by
    /// ~24 against a true slope of ~11) and the row's value trades against the
    /// axis rows into a stationary point with an axis residual of sqrt(2) --
    /// while 0.2, 0.3 and 0.5 all carry the suite green. Every solution sits
    /// at frame_len near 1 (aligned axes put B's reference perpendicular to
    /// A's axis), so any half-width below 1 leaves the solved pose on the pure
    /// branch with f = 1; 0.3 is the middle of the green band.
    const ROLL_FRAME_TRUST: f64 = 0.3;

    /// Per-param multiplier on the LM Marquardt damping, over the REDUCED
    /// state: one entry per state entry, `1` on a body's translations and
    /// `ROT_DAMP_SCALE` on its rotation increments, so a step trades a spin
    /// for a slide where the constraints leave the choice open. Grounded
    /// bodies have no entries at all now, which is what replaced their old
    /// "scale 1.0 because they are pinned anyway" row.
    ///
    /// Both are divided by the seed Jacobian's largest J^T J diagonal. That
    /// diagonal is also what sets the driver's initial damping
    /// (`lambda0 = 1e-3 * max_diag`), and under the manifold parameterisation
    /// it grows with the square of the drawing's lever arms (a rotation
    /// column is O(lever), a translation column O(1)). Dividing it out keeps
    /// the damping relative to each column's own curvature constant across
    /// scales, so the first step stays Gauss-Newton-like on a 10000-unit
    /// lever instead of taking dozens of iterations to burn lambda down --
    /// and it leaves the ROT_DAMP_SCALE ratio as the only slide-over-spin
    /// knob, which is the thing worth measuring.
    fn reduced_damp_scale(&self) -> Vec<f64> {
        let y0 = self.reduced_x0();
        let j0 = self.jacobian_reduced(&y0);
        let mut max_diag = 0.0;
        for c in 0..j0.ncols() {
            let diag = (0..j0.nrows())
                .map(|r| j0[(r, c)] * j0[(r, c)])
                .sum::<f64>();
            if diag > max_diag {
                max_diag = diag;
            }
        }
        // An all-zero Jacobian (no mates left, every body grounded) has no
        // scale to divide by; 1.0 keeps the entries finite and the ratio
        // intact rather than producing inf.
        let norm = if max_diag > 0.0 { max_diag } else { 1.0 };
        let mut scale = vec![1.0 / norm; self.n_red];
        for bi in 0..self.bodies.len() {
            if let Some(col) = self.body_col[bi] {
                for j in 0..3 {
                    scale[col + 3 + j] = ROT_DAMP_SCALE / norm;
                }
            }
        }
        scale
    }

    // ─── Manifold state: expand / reduced closures ───

    /// The LM starting state: each free body's seed translation, with its
    /// rotation vector at zero (the seed orientation IS `q_ref`, so `w` reads
    /// the rotation AWAY from the seed). Zeroed on purpose: the driver's
    /// anchor target is `x0`, and `retract` only re-bases bodies that have
    /// strayed, so an unfolded start is what keeps "w = 0" meaning the same
    /// thing as the anchor's target for the whole solve.
    pub(crate) fn reduced_x0(&self) -> Vec<f64> {
        let mut y = Vec::with_capacity(self.n_red);
        for bi in 0..self.bodies.len() {
            if let Some(col) = self.body_col[bi] {
                let off = bi * 7;
                debug_assert_eq!(col, y.len(), "reduced column map drifted");
                y.extend_from_slice(&self.x0[off..off + 3]);
                y.extend_from_slice(&[0.0; 3]);
            }
        }
        y
    }

    /// Materialise the 7-param pose buffer the residual and Jacobian builders
    /// read, from the reduced state plus the per-body reference quaternions.
    ///
    /// Grounded (and block-less) bodies pass through as the seed bytes: their
    /// pose is a constant, echoed bit-exact. A free body takes its translation
    /// from the state and composes `exp(w) * q_ref`, normalised -- unit by
    /// construction at every `w`, which is what `params_solved` reports. The
    /// `w = 0` branch reproduces `q_ref` itself (no rounding pass), so a body
    /// the solver never moved comes back as its own seed quaternion.
    pub(crate) fn expand(&self, y: &[f64]) -> Vec<f64> {
        let mut x = self.x0.clone();
        let q_ref = self.q_ref.borrow();
        for bi in 0..self.bodies.len() {
            let Some(col) = self.body_col[bi] else {
                continue;
            };
            let off = bi * 7;
            x[off] = y[col];
            x[off + 1] = y[col + 1];
            x[off + 2] = y[col + 2];
            let w = [y[col + 3], y[col + 4], y[col + 5]];
            let base = bi * 4;
            let q = [
                q_ref[base],
                q_ref[base + 1],
                q_ref[base + 2],
                q_ref[base + 3],
            ];
            let composed = if w == [0.0, 0.0, 0.0] {
                q
            } else {
                quat_normalize(&quat_mul(&quat_exp(&w), &q))
            };
            x[off + 3] = composed[0];
            x[off + 4] = composed[1];
            x[off + 5] = composed[2];
            x[off + 6] = composed[3];
        }
        x
    }

    /// The LM driver's retraction hook: fold any body whose rotation vector
    /// has strayed past `FOLD_W` back onto its reference (`w = 0`, `q_ref`
    /// taking over the pose), leaving every other coordinate untouched. The
    /// pose is identical before and after -- only the chart changes -- so the
    /// residual the accept test priced still describes the state.
    ///
    /// Why the radius exists: `exp(w)` is a well-conditioned chart on the
    /// rotation group for small `w` and degenerates at `|w| = 2*pi`, where a
    /// full turn has wrapped onto itself and the chain `d(exp(w) q_ref)/dw`
    /// loses two dimensions. A solve CAN land there -- a chain of flipped
    /// mates driven from identity spins one body a full turn and then reports
    /// two phantom DOF off the collapsed Jacobian (that is the regression
    /// `two_flipped_fixed_chain_from_identity` pins). Folding at 4 radians
    /// keeps every Jacobian evaluation far from the degeneracy while staying
    /// above any orientation a mate legitimately asks of a body from its
    /// seed (a half-turn weld needs pi). The cost: a body folded this way
    /// forgets where it was seeded -- the anchor's `w = 0` target then means
    /// "as re-based", which only matters past the radius, where the anchor's
    /// quadratic price was already negligible.
    pub(crate) fn retract(&self, y: &mut [f64]) {
        const FOLD_W: f64 = 4.0;
        let mut q_ref = self.q_ref.borrow_mut();
        for bi in 0..self.bodies.len() {
            let Some(col) = self.body_col[bi] else {
                continue;
            };
            let w = [y[col + 3], y[col + 4], y[col + 5]];
            let norm2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
            if norm2.is_nan() || norm2 <= FOLD_W * FOLD_W {
                continue; // in chart, nothing to fold (a NaN state never gets here)
            }
            let base = bi * 4;
            let q = [
                q_ref[base],
                q_ref[base + 1],
                q_ref[base + 2],
                q_ref[base + 3],
            ];
            let folded = quat_normalize(&quat_mul(&quat_exp(&w), &q));
            q_ref[base..base + 4].copy_from_slice(&folded);
            y[col + 3] = 0.0;
            y[col + 4] = 0.0;
            y[col + 5] = 0.0;
        }
    }

    /// Residuals over the reduced state (the closure
    /// `solve_lm_damped_retract` walks). Identical rows to `residuals` on the
    /// pose it expands to.
    pub(crate) fn residuals_reduced(&self, y: &[f64]) -> Vec<f64> {
        self.residuals(&self.expand(y))
    }

    /// Build the residuals closure over the reduced state.
    pub fn residuals_fn(&self) -> impl Fn(&[f64]) -> Vec<f64> + '_ {
        |y: &[f64]| self.residuals_reduced(y)
    }

    /// Build the dense Jacobian closure over the reduced state (m x n_red).
    pub fn jacobian_fn(&self) -> impl Fn(&[f64]) -> DMatrix<f64> + '_ {
        |y: &[f64]| self.jacobian_reduced(y)
    }
}

mod jacobian;
mod math;

use math::*;

// ─── Residuals ───

impl MateProblem {
    /// Compute the residual vector at the 7-param pose `x`: one block per kept
    /// mate, in mate order, exactly `m` rows. The state-derived properties
    /// (unit norm, grounded pose) are not residuals here; see the module doc.
    fn residuals(&self, x: &[f64]) -> Vec<f64> {
        let mut r = Vec::with_capacity(self.m);

        for (mi, mate) in self.mates.iter().enumerate() {
            let off_a = mate.a.body_index as usize * 7;
            let off_b = mate.b.body_index as usize * 7;
            let start = r.len();

            match mate.kind {
                MateKind::Fixed => {
                    // Point coincidence with a 3D offset carried in A's frame:
                    // p_a - p_b - R_a * offset. The offset rotates with A, so a
                    // weld holds the same relative placement however the pair is
                    // oriented -- a world-frame offset would slide the parts
                    // apart the moment A turned.
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let off_w = world_direction(x, off_a, &mate.offset);
                    r.push(pa[0] - pb[0] - off_w[0]);
                    r.push(pa[1] - pb[1] - off_w[1]);
                    r.push(pa[2] - pb[2] - off_w[2]);
                    // Axis alignment with a DEFINITE sign: a_w - sign * b_w.
                    // cross(a_w, b_w) vanishes for both parallel and anti-parallel
                    // b_w, so the weld could settle either way and flip a part
                    // normal-to-antinormal between solves. The sign is the
                    // authored `flip` (captured by the editor when the refs are
                    // picked), never re-derived from the seed dot: a seed-derived
                    // sign flipped the weld the moment a drag swung the axes past
                    // perpendicular.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                    // Absolute roll: the axis difference above is rank 2 (both
                    // are unit vectors), so rolling body B about the shared axis
                    // leaves it at zero. This 7th residual is the missing rank.
                    r.push(self.abs_roll_residual(x, mi, off_a, off_b, mate.angle));
                }
                MateKind::Spherical => {
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    r.push(pa[0] - pb[0]);
                    r.push(pa[1] - pb[1]);
                    r.push(pa[2] - pb[2]);
                }
                MateKind::Parallel => {
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let dot = a_w[0] * b_w[0] + a_w[1] * b_w[1] + a_w[2] * b_w[2];
                    let sign = if mate.flip { -1.0 } else { 1.0 };
                    r.push(dot - sign);
                }
                MateKind::Sliding => {
                    // Prismatic: signed axis difference + perp displacement cross
                    // plus a roll pin, so slide along the shared axis is the only
                    // free DOF. The sign is the authored flip, same as Fixed's:
                    // the cross-product form this replaced was zero for parallel
                    // AND anti-parallel axes, so the joint could flip sides.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                    // Perp displacement cross: cross(p_a - p_b, a_w).
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let d0 = pa[0] - pb[0];
                    let d1 = pa[1] - pb[1];
                    let d2 = pa[2] - pb[2];
                    r.push(d1 * a_w[2] - d2 * a_w[1]);
                    r.push(d2 * a_w[0] - d0 * a_w[2]);
                    r.push(d0 * a_w[1] - d1 * a_w[0]);
                    // Absolute roll pin to the authored angle, same as Fixed's.
                    r.push(self.abs_roll_residual(x, mi, off_a, off_b, mate.angle));
                }
                MateKind::Rotating => {
                    // Point coincidence.
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    r.push(pa[0] - pb[0]);
                    r.push(pa[1] - pb[1]);
                    r.push(pa[2] - pb[2]);
                    // Signed axis difference w/ flip (see Fixed's arm).
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                }
                MateKind::SlidingRotating => {
                    // Cylindrical: signed axis difference + perp displacement
                    // cross, so slide along the shared axis and roll about it are
                    // the free DOF.
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let s = axis_sign(mate.flip);
                    r.push(a_w[0] - s * b_w[0]);
                    r.push(a_w[1] - s * b_w[1]);
                    r.push(a_w[2] - s * b_w[2]);
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let d0 = pa[0] - pb[0];
                    let d1 = pa[1] - pb[1];
                    let d2 = pa[2] - pb[2];
                    r.push(d1 * a_w[2] - d2 * a_w[1]);
                    r.push(d2 * a_w[0] - d0 * a_w[2]);
                    r.push(d0 * a_w[1] - d1 * a_w[0]);
                }
                MateKind::Tangential => {
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    r.push(self.tangential_residual(
                        mate.a.anchor_kind,
                        mate.b.anchor_kind,
                        &pa,
                        &pb,
                        &a_w,
                        &b_w,
                        mate.axial_offset(),
                        mate.radius,
                    ));
                }
                MateKind::CopyRotation => {
                    // Relative, not absolute: (twist_b - twist_b0) = ratio *
                    // (twist_a - twist_a0). A gear mate authored while both
                    // bodies are already rotated must LINK their future
                    // rotation, not snap them to an absolute relationship they
                    // never had.
                    let (seed_a_w, seed_b_w) = match &self.seed_axes[mi] {
                        Some(v) => *v,
                        None => ([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]),
                    };
                    let (twist_a0, twist_b0) = self.seed_twist[mi];
                    let (qx_a, qy_a, qz_a, qw_a) =
                        (x[off_a + 3], x[off_a + 4], x[off_a + 5], x[off_a + 6]);
                    let (qx_b, qy_b, qz_b, qw_b) =
                        (x[off_b + 3], x[off_b + 4], x[off_b + 5], x[off_b + 6]);

                    let twist_a = twist_angle(qx_a, qy_a, qz_a, qw_a, &seed_a_w);
                    let twist_b = twist_angle(qx_b, qy_b, qz_b, qw_b, &seed_b_w);

                    // Ratio 1 is a rigid roll link whose target lives on the
                    // same circle `abs_roll_residual` wraps: `twist_angle`
                    // spans (-2pi, 2pi], so driving the pair past +/-2pi (or a
                    // quaternion sign flip) jumps the raw delta by a full turn
                    // and stalls LM on the branch cut -- the same trap
                    // `fill_roll_fd`'s wrap_to_pi(fp - fm) handles. Ratio != 1
                    // stays unwrapped DELIBERATELY: its target manifold
                    // repeats every 2*pi/ratio, so which representative is
                    // "nearest" depends on a design decision this fix does not
                    // make, and a silent wrap there would change behaviour
                    // under a fixture that locks today's numbers.
                    if mate.ratio == 1.0 {
                        r.push(wrap_to_pi((twist_b - twist_b0) - (twist_a - twist_a0)));
                    } else {
                        r.push((twist_b - twist_b0) - mate.ratio * (twist_a - twist_a0));
                    }
                }
                MateKind::ParallelPlaneDistance => {
                    let pa = world_point(x, off_a, &mate.a.geometry.point);
                    let pb = world_point(x, off_b, &mate.b.geometry.point);
                    let a_w = world_direction(x, off_a, &mate.a.geometry.axis);
                    let d0 = pb[0] - pa[0];
                    let d1 = pb[1] - pa[1];
                    let d2 = pb[2] - pa[2];
                    let dist = d0 * a_w[0] + d1 * a_w[1] + d2 * a_w[2];
                    // Only the axial component can act here: this residual
                    // measures the plane separation along A's normal, and the
                    // offset's in-plane part points along the two DOF the mate
                    // deliberately leaves free. See `Mate::axial_offset`.
                    r.push(dist - mate.axial_offset());
                    // Parallelism: nothing above aligns the normals -- the name and
                    // the Flip checkbox both promised it. Same formula as `Parallel`.
                    let b_w = world_direction(x, off_b, &mate.b.geometry.axis);
                    let dot = a_w[0] * b_w[0] + a_w[1] * b_w[1] + a_w[2] * b_w[2];
                    let sign = if mate.flip { -1.0 } else { 1.0 };
                    r.push(dot - sign);
                }
            }

            // The mate's own rows carry its weight, so an under-weighted drag
            // objective yields to a real mate in the same least-squares sum.
            if mate.weight != 1.0 {
                for v in &mut r[start..] {
                    *v *= mate.weight;
                }
            }
        }

        r
    }

    /// Tangential signed-distance residual, formula selected by anchor kind pair.
    #[allow(clippy::too_many_arguments)]
    fn tangential_residual(
        &self,
        ka: AnchorKind,
        kb: AnchorKind,
        pa: &[f64; 3],
        pb: &[f64; 3],
        a_w: &[f64; 3],
        b_w: &[f64; 3],
        offset: f64,
        radius: f64,
    ) -> f64 {
        let d0 = pa[0] - pb[0];
        let d1 = pa[1] - pb[1];
        let d2 = pa[2] - pb[2];

        match (ka, kb) {
            (AnchorKind::Plane, AnchorKind::Plane) => {
                // Signed distance from a's point to b's plane.
                d0 * b_w[0] + d1 * b_w[1] + d2 * b_w[2] - offset
            }
            (AnchorKind::Plane, AnchorKind::Cylinder) | (AnchorKind::Plane, AnchorKind::Cone) => {
                // Distance from cylinder/cone point to plane minus radius. A
                // cone is approximated by a cylinder of the wire's single
                // Mate.radius: the real radius varies along the cone axis, so
                // this matches the contact only at whichever station that
                // radius corresponds to. See the AnchorKind doc.
                (d0 * a_w[0] + d1 * a_w[1] + d2 * a_w[2]).abs() - radius - offset
            }
            (AnchorKind::Cylinder, AnchorKind::Plane) | (AnchorKind::Cone, AnchorKind::Plane) => {
                (d0 * b_w[0] + d1 * b_w[1] + d2 * b_w[2]).abs() - radius - offset
            }
            (AnchorKind::Cylinder, AnchorKind::Cylinder)
            | (AnchorKind::Cylinder, AnchorKind::Cone)
            | (AnchorKind::Cone, AnchorKind::Cylinder)
            | (AnchorKind::Cone, AnchorKind::Cone) => {
                // Shortest distance between two axes minus the radii. Each cone
                // is again the cylinder of the single Mate.radius, so a
                // cone/cone or cylinder/cone tangency is only exact where the
                // cone's true radius equals that value; a cone whose radius
                // changes over the contact cannot be represented by this wire
                // (one radius per mate). See the AnchorKind doc.
                let n0 = a_w[1] * b_w[2] - a_w[2] * b_w[1];
                let n1 = a_w[2] * b_w[0] - a_w[0] * b_w[2];
                let n2 = a_w[0] * b_w[1] - a_w[1] * b_w[0];
                let n_norm2 = n0 * n0 + n1 * n1 + n2 * n2;
                let axis_dist = if n_norm2 > 1e-24 {
                    (d0 * n0 + d1 * n1 + d2 * n2).abs() / n_norm2.sqrt()
                } else {
                    // Parallel axes: use perp distance.
                    let perp0 = d1 * a_w[2] - d2 * a_w[1];
                    let perp1 = d2 * a_w[0] - d0 * a_w[2];
                    let perp2 = d0 * a_w[1] - d1 * a_w[0];
                    (perp0 * perp0 + perp1 * perp1 + perp2 * perp2).sqrt()
                };
                axis_dist - 2.0 * radius - offset
            }
            _ => {
                // Unsupported anchor pair: every pair containing a Sphere, Line,
                // Circle, Point or Torus on either side (those five against
                // anything: each other, Point, Plane, Cylinder, Cone). The
                // point-to-point fallback this used to compute is geometrically
                // WRONG unless both anchor points happen to be surface centres
                // (a Sphere's centre, say): an anchor picked mid-line or on a
                // circle's rim measures an unrelated distance, and the solve
                // quietly converged on whatever that number asked for. Return a
                // non-finite residual so a headless `api.rs` caller can never
                // converge on it; `mate_status` classifies a non-finite residual
                // norm as `Overconstrained`. A real per-side radius (and
                // `Anchor.radius`) is what would make one of these pairs valid
                // again, and that is deliberately out of scope here.
                f64::NAN
            }
        }
    }
}

/// Relative factor for the SVD rank cutoff (see `singular_value_cutoff`).
const RANK_REL_TOL: f64 = 1e-10;

/// Rank cutoff for a Jacobian whose largest singular value is `smax`.
///
/// The naive form from the review, `1e-6 * smax`, does not work on THIS
/// matrix and was rejected on measured spectra: the Jacobian mixes units, and
/// the translation columns are a ratio of model-unit residual to model-unit
/// step, so they stay dimensionless O(1) however small the model is drawn.
/// `smax` therefore never shrinks with geometry, and `1e-6 * smax` can sit
/// above the very singular values that must keep counting -- a 1e-7-scale
/// triple spherical weld carries genuine constraint directions around 1e-6,
/// where a cutoff at `1e-6 * smax` discards them (the exact bug class this
/// fix exists to remove). `1e-10 * smax` keeps the relative spirit with real
/// margins on both sides: four-plus orders above the finite-difference noise
/// of the roll/tangential filler rows (measured junk at ~1e-12 and below),
/// and well below the smallest genuine geometric direction for any sane
/// modelling scale down to nanometres (rotation columns track the lever arm,
/// so ~1e-8 at a 1e-9 drawing). A true zero direction (a hinge's free roll
/// measured 6.5e-18) stays excluded. An all-zero spectrum falls back to the
/// legacy absolute cutoff; every direction is rank-deficient there under any
/// positive tolerance anyway.
fn singular_value_cutoff(smax: f64) -> f64 {
    if smax > 0.0 {
        RANK_REL_TOL * smax
    } else {
        1e-6
    }
}

/// Relative factor for the `mate_status` residual tolerance. The RMS residual
/// threshold is `RESIDUAL_REL_TOL * scale`, so the same assembly reads the same
/// regardless of the drawing unit.
const RESIDUAL_REL_TOL: f64 = 1e-4;

/// `residual_norm` is an L2 norm over `m` residuals, so it grows with the
/// number of mates even when every individual residual is converged to the
/// same tolerance -- an absolute threshold here would flag a large,
/// correctly-solved assembly as overconstrained. Scale to an RMS-per-residual
/// figure so the threshold means the same thing regardless of problem size,
/// then compare against the tolerance relative to the drawing's characteristic
/// length `scale` so it also means the same thing regardless of unit.
fn mate_status(residual_norm: f64, m: usize, dof: usize, scale: f64) -> MateStatus {
    // A non-finite norm means NaN reached the residuals (the wire codec gates
    // its floats, but a host can still seed an in-memory MateInput with one).
    // It must classify as the failing state and never as FullyConstrained:
    // that would tell the editor the assembly is solved and lock the UI on
    // garbage, while Underconstrained would invite dragging a pose the solver
    // knows nothing about. Overconstrained is the enum's only error-ish state.
    if !residual_norm.is_finite() {
        return MateStatus::Overconstrained;
    }
    let rms_residual = if m > 0 {
        residual_norm / (m as f64).sqrt()
    } else {
        0.0
    };
    if rms_residual > RESIDUAL_REL_TOL * scale {
        MateStatus::Overconstrained
    } else if dof > 0 {
        MateStatus::Underconstrained
    } else {
        MateStatus::FullyConstrained
    }
}

// ─── Solve entry point ───

/// Run the mate solver: build a Problem, call solve_lm, compute status, build output.
pub fn solve_mate(input: &MateInput) -> MateOutput {
    solve_mate_impl(input, DENSE_CELL_BUDGET, false)
}

/// Live-drag variant of `solve_mate`: identical solve and pose, but the dense
/// rank/dof analysis (a full SVD of the Jacobian) is skipped and both are
/// reported as 0. A live drag tick reads only the pose and discards the
/// diagnostics, so the SVD is pure per-frame cost. Kept as a separate entry
/// point rather than a wire/record flag so the mate record layout, and the
/// `MATE_MAGIC` bump a width change needs, stay untouched.
pub fn solve_mate_live(input: &MateInput) -> MateOutput {
    solve_mate_impl(input, DENSE_CELL_BUDGET, true)
}

/// `solve_mate` with the dense-cell ceiling injected (test hook; production
/// always passes `DENSE_CELL_BUDGET`) and the live fast-path selected.
fn solve_mate_impl(input: &MateInput, budget: usize, live: bool) -> MateOutput {
    let problem = MateProblem::new(input);
    let m = problem.m;
    let n_red = problem.n_red;

    // Refuse before the first dense allocation: past this point every step
    // reserves matrices proportional to m*n (the 7-param fill matrix, which is
    // the larger of the two the manifold chain allocates), and an OOM there
    // aborts the worker instead of returning the failing status below.
    if dense_cells_over_budget(m, problem.n, budget) {
        return MateOutput {
            params_solved: input.params_initial.clone(),
            overall_status: MateStatus::Overconstrained.to_u8(),
            mate_residuals: Vec::new(),
            diagnostics: MateDiagnostics {
                // Infinity reads as "no convergence measurement exists", which
                // is exactly the truth for a solve that never ran.
                residual_norm: f64::INFINITY,
                rank: 0,
                dof: 0,
                iters: 0,
                ms: 0.0,
            },
        };
    }

    let y0 = problem.reduced_x0();
    let residuals_fn = problem.residuals_fn();
    let jacobian_fn = problem.jacobian_fn();

    // Rotation vectors are damped stiffer than translations so an
    // underdetermined solve slides a part rather than spinning it
    // (ROT_DAMP_SCALE). This weights only the LM step and the seed anchor,
    // never the residual, so the reported diagnostics below are untouched and
    // a mate that needs a rotation still reaches it.
    let damp_scale = problem.reduced_damp_scale();
    // The retraction hook: it folds a rotation vector that has strayed past
    // the chart's radius back onto its reference, which is what keeps every
    // Jacobian evaluation (the driver asks only after retracting) away from
    // the degeneracy of `exp` at a full turn. The pose is unchanged by the
    // fold, so the residual the accept test priced still holds.
    let mut retract = |y: &mut [f64]| problem.retract(y);
    let lm_result =
        lm::solve_lm_damped_retract(&y0, &residuals_fn, &jacobian_fn, &damp_scale, &mut retract);

    // Rank analysis via SVD. Skipped on a live drag tick, which reads only the
    // pose and discards the verdict: the SVD is pure per-frame cost there, and
    // the full solve on pointer-up is what owns the rank/dof the editor shows.
    // Also skipped when the residuals are poisoned: nalgebra's SVD convergence
    // test never fires on NaN, so this call would spin forever and wedge the
    // serialized worker. `mate_status` then reports the failure instead of a
    // rank that cannot be trusted.
    let poisoned = !lm_result.residual_norm.is_finite();
    let (rank, dof) = if live {
        (0u32, 0u32)
    } else {
        let dof = if n_red == 0 || poisoned {
            // No free body (or no trusted residuals): nothing can move.
            0usize
        } else if m == 0 {
            // No mate rows at all, so the Jacobian is empty and every free
            // DOF is unconstrained. The driver returns before touching the
            // state here, so there is no spectrum to read -- and calling the
            // SVD of an empty matrix would report rank 0 anyway.
            n_red
        } else {
            let svd = lm_result.jacobian.svd(true, false);
            // The rank cutoff must scale with the drawing unit: an assembly laid
            // out at 1e-9 m has exactly the same DOF as the same assembly at 1 m,
            // but its geometry-proportional singular values shrink linearly with
            // the unit and a fixed absolute cutoff misreads them as rank loss
            // (measured: three spherical mates at 1e-9 reported 3 phantom DOF).
            // See `singular_value_cutoff` for why the factor is what it is.
            let smax = svd.singular_values.iter().copied().fold(0.0_f64, f64::max);
            let tol = singular_value_cutoff(smax);
            let rank = svd.singular_values.iter().filter(|&&s| s > tol).count();
            n_red.saturating_sub(rank)
        };
        ((n_red - dof) as u32, dof as u32)
    };

    let status = mate_status(
        lm_result.residual_norm,
        m,
        dof as usize,
        problem.geometry_scale(),
    );

    // The wire layout is still 7 params per body; composing the final unit
    // quaternions here is the only place the reduced state and the seed buffer
    // meet. A grounded body comes back as its own seed bytes, bit-exact.
    let params_solved: Vec<f64> = problem.expand(&lm_result.x);

    // Per-mate residual norms at the solved pose, one per INPUT mate. Kept
    // mates are sliced by the per-kind counts `residuals()` pushed them in; a
    // dropped mate keeps its slot as NaN so a later residual cannot shift under
    // the host's positional fold. The host reads a non-finite value as "no
    // residual". `params_solved` is the very pose the solver minimised over,
    // so this is the residual the host can re-derive from the poses it shows.
    let solved_residuals = problem.residuals(&params_solved);
    let mut block_start = 0usize;
    let mut mate_residuals = vec![f64::NAN; problem.input_mate_count];
    for (kept_pos, &input_index) in problem.kept_input_indices.iter().enumerate() {
        let m = &problem.mates[kept_pos];
        let count = mate_residual_count(m.kind);
        mate_residuals[input_index] = solved_residuals[block_start..block_start + count]
            .iter()
            .map(|v| v * v)
            .sum::<f64>()
            .sqrt();
        block_start += count;
    }

    MateOutput {
        params_solved,
        overall_status: status.to_u8(),
        mate_residuals,
        diagnostics: MateDiagnostics {
            residual_norm: lm_result.residual_norm,
            rank,
            dof,
            iters: lm_result.iters,
            // Wall-clock is measured by the JS host (it has performance.now());
            // the crate has no portable clock on wasm32-unknown-unknown. An
            // `Instant::now()` here panics the moment a mate reaches a browser,
            // and `solve.rs` avoids it for the same reason.
            ms: 0.0,
        },
    }
}

// ─── Tests ───

#[cfg(test)]
mod tests;
