//! Wire error type for the mate codec, over the shared byte cursors.
//!
//! `Reader` / `Writer` come from `solver-core` and are re-exported here so the
//! encode/decode sites in `mate.rs` name one module. `CodecError` is *not*
//! shared with the sketch solver: the two formats have separate magics and
//! separate domain variants (a bad `MateKind` is not a bad entity `Kind`), and
//! keeping the enums apart is what lets either format version on its own.

pub use solver_core::bytes::{Reader, Writer};
use solver_core::bytes::Eof;

#[derive(Debug, PartialEq, Eq)]
pub enum CodecError {
    UnexpectedEof,
    BadMagic,
    /// A `MateKind` or `AnchorKind` byte outside the known range.
    BadKind(u8),
    /// The header's `n_params` is not `n_bodies * 7`. Every per-body loop reads
    /// a fixed 7-param block, so a disagreeing header cannot be solved at all.
    ParamCountMismatch,
}

/// Lets `r.u32()?` inside a `Result<_, CodecError>` function convert the
/// cursor's only failure mode without an explicit map_err at every call site.
impl From<Eof> for CodecError {
    fn from(_: Eof) -> Self {
        CodecError::UnexpectedEof
    }
}
