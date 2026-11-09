//! The per-body moved report: re-solving an already-satisfied assembly must
//! keep every seed, and a real edit must report the part it drove.
//!
//! The fixture is the plan's three-part assembly: one grounded body, one
//! revolute body on it, and one prismatic body on it. It is seeded slightly off
//! the manifold so the first solve has real work, then re-solved from its own
//! solved poses, which is the sequence a document walks on every commit.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

const SCALES: [f64; 3] = [1.0, 100.0, 2000.0];

/// One grounded body, one rotating body driven onto it, one sliding body
/// driven onto it, all seeded off the manifold by a fraction of the scale. The
/// rotating mate's axial offset is `offset` (in scale units), so a test can
/// change it to ask for a real translation.
fn perturbed_assembly(scale: f64, offset: f64) -> MateInput {
    let s = scale;
    MateInput {
        bodies: (0..3).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0, // body 0: grounded, identity
            0.1 * s,
            -0.07 * s,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0, // body 1: off the axis
            0.05 * s,
            0.03 * s,
            2.0 * s,
            0.0,
            0.0,
            0.0,
            1.0, // body 2: off the axis
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate(
                MateKind::Rotating,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false,
                offset * s,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Sliding,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(2, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    }
}

/// Re-solve the assembly from its own first solution and measure the largest
/// pose drift: translation in drawing units, rotation in radians.
fn re_solve_drift(scale: f64) -> (MateOutput, MateOutput, f64, f64) {
    let first = solve_mate(&perturbed_assembly(scale, 0.0));
    let mut second_input = perturbed_assembly(scale, 0.0);
    second_input.params_initial = first.params_solved.clone();
    let second = solve_mate(&second_input);

    let mut translation = 0.0_f64;
    let mut angle = 0.0_f64;
    for body in 0..3 {
        let o = body * 7;
        translation = translation.max(
            ((second.params_solved[o] - first.params_solved[o]).powi(2)
                + (second.params_solved[o + 1] - first.params_solved[o + 1]).powi(2)
                + (second.params_solved[o + 2] - first.params_solved[o + 2]).powi(2))
            .sqrt(),
        );
        let dot = (0..4)
            .map(|k| second.params_solved[o + 3 + k] * first.params_solved[o + 3 + k])
            .sum::<f64>()
            .abs()
            .min(1.0);
        angle = angle.max(2.0 * dot.acos());
    }
    (first, second, translation, angle)
}

#[test]
fn re_solving_a_satisfied_assembly_reports_every_instance_unmoved() {
    // The measurement the tolerance constant's doc quotes. Printed so a
    // re-measure is one `--nocapture` run away; the assertion is the contract.
    let mut worst_translation = 0.0_f64;
    let mut worst_angle = 0.0_f64;
    for scale in SCALES {
        let (first, second, translation, angle) = re_solve_drift(scale);
        // Precondition: the first solve really had work to do, so a no-op
        // solve cannot satisfy the assertion below vacuously.
        assert!(
            first.params_solved[7].abs() < 1e-9 * scale
                && first.params_solved[8].abs() < 1e-9 * scale
                && first.params_solved[9].abs() < 1e-9 * scale,
            "scale {scale}: the seeded body was not pulled onto the axis"
        );
        eprintln!(
            "scale {scale}: re-solve drift {translation:e} world, {angle:e} rad (residual {:e})",
            first.diagnostics.residual_norm
        );
        assert!(
            translation <= crate::tolerance::pose_keep_tol(scale),
            "scale {scale}: translation {translation:e} exceeds {:e}",
            crate::tolerance::pose_keep_tol(scale)
        );
        assert!(
            angle <= crate::tolerance::POSE_KEEP_ANGLE,
            "scale {scale}: angle {angle:e} exceeds {:e}",
            crate::tolerance::POSE_KEEP_ANGLE
        );
        assert!(
            second.moved.iter().all(|&m| m == 0),
            "scale {scale}: an unchanged re-solve reported a moved body: {:?}",
            second.moved
        );
        worst_translation = worst_translation.max(translation);
        worst_angle = worst_angle.max(angle);
    }
    eprintln!("worst: {worst_translation:e} world, {worst_angle:e} rad");
}

#[test]
fn a_changed_mate_offset_reports_the_driven_part_only() {
    let scale = 100.0;
    let first = solve_mate(&perturbed_assembly(scale, 0.0));
    // Ask the rotating mate for a full-scale axial offset: body 1 must move,
    // body 0 is grounded and body 2's own mate is untouched.
    let mut edited = perturbed_assembly(scale, 1.0);
    edited.params_initial = first.params_solved.clone();
    let out = solve_mate(&edited);

    assert!((out.params_solved[9] - scale).abs() < 1e-6 * scale);
    assert_eq!(out.moved[0], 0, "the grounded body reported moved");
    assert_eq!(out.moved[1], 1, "the driven body was not reported");
    assert_eq!(out.moved[2], 0, "the untouched sliding body reported moved");
}
