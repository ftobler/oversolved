//! Seeds the host cannot always fix: an exactly anti-parallel axis pair is a
//! stationary point of the axis residual, and a solve that stalls there must
//! not read as a modelling conflict.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

/// Body 0 grounded at the origin, body 1 seeded with a half turn about X so
/// its +Z axis points along world -Z, exactly opposite to what a non-flipped
/// rotating mate asks for.
fn antiparallel_input() -> MateInput {
    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 3.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate(
            MateKind::Rotating,
            mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Line),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Line),
            false,
            0.0,
            1.0,
            0.0,
        )],
    }
}

#[test]
fn antiparallel_seed_escapes() {
    let out = solve_mate(&antiparallel_input());
    assert!(
        out.diagnostics.residual_norm < 1e-10,
        "residual={} iters={}",
        out.diagnostics.residual_norm,
        out.diagnostics.iters
    );
}

/// A fixed mate seeded 150 degrees round the shared axis: satisfiable, but
/// the first descent stalls (measured: residual 1.34 after 20 iterations).
#[test]
fn stalled_but_satisfiable_reads_not_converged() {
    let mut input = antiparallel_input();
    input.mates[0].kind = MateKind::Fixed;
    let half = 150.0f64.to_radians() / 2.0;
    input.params_initial[10] = half.sin();
    input.params_initial[13] = half.cos();
    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::NotConverged.to_u8());
}

/// Two welds pinning B to two different places on a grounded A can never both
/// hold, whatever the seed: that stays a real conflict.
#[test]
fn contradictory_welds_stay_overconstrained() {
    let mut input = antiparallel_input();
    input.params_initial[10] = 0.0;
    input.params_initial[13] = 1.0;
    let weld = |x: f64| {
        mate(
            MateKind::Fixed,
            mate_ref(0, x, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Line),
            mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Line),
            false,
            0.0,
            1.0,
            0.0,
        )
    };
    input.mates = vec![weld(0.0), weld(5.0)];
    let out = solve_mate(&input);
    assert_eq!(out.overall_status, MateStatus::Overconstrained.to_u8());
}
