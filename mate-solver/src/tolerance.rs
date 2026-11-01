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
/// thousands. `1e-4` is the pre-split width at unit scale, so unit drawings
/// read exactly as they did before the classes were separated; at any larger
/// scale the old mixed budget was looser than this and the fix tightens it.
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
