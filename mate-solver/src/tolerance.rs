//! The mate verdict's per-row tolerance widths.
//!
//! A mate's residual vector mixes displacements with orientation measures. One
//! RMS budget relative to the drawing is only meaningful for the first kind: a
//! radian does not grow with the model, so on a large enough drawing a
//! rotational conflict can sit inside a length-derived budget and read as
//! solved. `mate_status` therefore reads each row against the width of its own
//! class and takes the MAX over the rows, not their RMS.
//!
//! The classes are assigned where the rows are pushed
//! (`mate_residuals.rs::mate_row_classes`): length rows are displacements in
//! the wire's units, orientation rows are angles.

/// Relative width of a length row's verdict: `RESIDUAL_REL_TOL * scale`, where
/// `scale` is the drawing's characteristic length (floored at 1). Relative on
/// purpose: a modelling conflict is a fraction of the drawing, so the same
/// assembly drawn in different units reads the same.
pub(crate) const RESIDUAL_REL_TOL: f64 = 1e-4;

/// Absolute width of an orientation row's verdict, in radians.
///
/// Absolute because an angle is scale-free: the same 3 degree disagreement
/// between two mates is a conflict whether the assembly spans one unit or
/// thousands. `1e-4` matches the pre-split width at unit scale (the verdict
/// aggregates with max now, so a multi-row mate can still read differently);
/// at any larger scale the old mixed budget was looser than this and the fix
/// tightens it.
/// It is also the angle whose tangential miss on a lever the size of the
/// drawing equals the length width above (`RESIDUAL_REL_TOL * scale` at a
/// scale-sized lever), so the two classes agree in the ordinary case where an
/// anchor sits about one drawing-radius from its body origin.
///
/// The unit-axis difference `|a_w - s * b_w|` is the chord of the same angle
/// (`2 sin(theta/2)`, equal to `theta` to third order), so it reads against
/// this width too. `dot - sign` is the cosine form of that angle: it reads
/// `1 - cos(theta)` near a solution, so this width bounds the misalignment it
/// can hide at about 0.8 degrees, the same reading it had at unit scale.
pub(crate) const RESIDUAL_ANGLE_TOL: f64 = 1e-4;

/// How far a solved pose may sit from the seed it was solved from and still
/// count as "the document already holds this": a fraction of the drawing's
/// characteristic length, the same model `RESIDUAL_REL_TOL` uses (the scale is
/// floored at 1, so this is never smaller than the absolute floor).
///
/// Assembly seeds carry no storage grid, unlike sketch params, so the width is
/// relative to the drawing rather than absolute. Measured on the re-solve of
/// the three-body assembly (one fixed, one rotating, one sliding) from its own
/// solved poses at scales 1, 100 and 2000: the second solve returned the
/// first's bytes exactly, 0 drift at every scale. What matters more is the
/// driver's dead band: a seed perturbed by less than `GTOL` (1e-10 absolute on
/// these unit-direction rows) is left untouched, and one perturbed further is
/// snapped back by the whole perturbation. `1e-9 * scale` is ten times that
/// band at unit scale and grows with the drawing, so a solve that acts always
/// moves further than this rung. The bound is deliberately generous, because
/// the bake's cost is asymmetric: keeping a pose a hair off the seed is
/// invisible, while writing one every re-solve walks every part in every
/// document diff.
pub(crate) const POSE_KEEP_REL_TOL: f64 = 1e-9;

/// The rotation angle, in radians, below which a solved pose is the seed's:
/// the rotational twin of [`POSE_KEEP_REL_TOL`]. Absolute because a radian does
/// not grow with the drawing (the same reasoning as [`RESIDUAL_ANGLE_TOL`]).
/// The re-solve above measured 0 rad of drift; the driver's GTOL bounds the
/// rotations it can leave alone at ~1e-10 rad, so this rung is a thousand
/// times above the noise and still far below anything visible.
pub(crate) const POSE_KEEP_ANGLE: f64 = 1e-7;

/// The translation width that still reads as "the solve did not move this
/// part", in drawing units. `scale` is the crate's characteristic length,
/// floored at 1 by `MateProblem::geometry_scale`.
pub(crate) fn pose_keep_tol(scale: f64) -> f64 {
    POSE_KEEP_REL_TOL * scale
}
