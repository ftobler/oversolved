//! Numerics and wire primitives shared by the two solver crates.
//!
//! What lives here is exactly what `sketch-solver` and `mate-solver` genuinely
//! have in common, and nothing else:
//!   - [`lm`]: the hand-rolled Levenberg-Marquardt driver (dense and sparse),
//!     with analytic and finite-difference Jacobians.
//!   - [`sparse`]: the sparse Jacobian row type the residual builders emit.
//!   - [`bytes`]: the little-endian [`bytes::Reader`] / [`bytes::Writer`]
//!     cursors both flat codecs are built on.
//!
//! Deliberately absent: anything that knows what a sketch or a mate *is*. The
//! two wire formats have separate magics, separate encoders, and separate
//! error enums; only the cursor is shared. That is what lets either format
//! version without dragging the other along.

pub mod bytes;
pub mod lm;
pub mod sparse;
