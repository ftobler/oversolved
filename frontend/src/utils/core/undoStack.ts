// Pure stack arithmetic shared by the part and assembly undo engines. The
// engines own their stores or refs and the setState/commit calls; this module
// only computes the next arrays, so the same bookkeeping cannot drift between
// the two.

// Append an entry and drop the oldest once the cap is exceeded. A single push
// can only overflow by one, but the slice keeps the cap exact for any caller.
export function pushCapped<T>(stack: readonly T[], entry: T, cap: number): T[] {
  const next = [...stack, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

// Move the top entry of `from` onto `to`. The entry that lands on `to` is built
// from the one leaving, so the same label or mutation round-trips in both
// directions. Returns null when `from` is empty so the caller can treat an
// empty-stack undo as a no-op without building anything.
//
// Conservation invariant: undo.length + redo.length <= MAX_UNDO_DEPTH holds at
// all times. pushCapped caps the undo stack and clears redo, and a move shifts
// exactly one entry across, so a non-empty `from` leaves `to` at most one below
// the cap and the grown `to` can never exceed it.
export function moveTop<T, U>(
  from: readonly T[],
  to: readonly U[],
  counterpart: (top: T) => U,
): { from: T[]; to: U[] } | null {
  if (from.length === 0) return null
  const top = from[from.length - 1]
  return { from: from.slice(0, -1), to: [...to, counterpart(top)] }
}
