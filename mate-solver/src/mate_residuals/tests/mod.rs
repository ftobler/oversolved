//! Mate residual and Jacobian tests, split by concern: `solve_kinds` and
//! `solve_constraints` drive whole solves per mate kind and edge case,
//! `jacobian_fd` cross-checks the analytic Jacobian against finite
//! differences, `dynamics` covers dropped mates, damping and authored roll,
//! and `roll_scale` covers wraparound, rank scale and the unsupported-pair
//! backstop.

mod common;
mod dynamics;
mod jacobian_fd;
mod roll_scale;
mod solve_constraints;
mod solve_kinds;
