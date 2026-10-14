// Greedy delta minimisation for a failing fuzz sequence: drop one step at a
// time, accept the drop while the failure predicate still holds, then repeat to
// a fixpoint. The fixpoint matters because drops interact: removing a step can
// make an earlier one redundant only after the first is gone. The predicate is
// the caller's replay of a candidate sequence, so it must be deterministic and
// must not depend on the previous call's state.
//
// The caller guarantees the original sequence fails; when it does not, the
// minimiser returns the sequence unchanged rather than inventing a failure.
export async function minimizeSequence<Step>(
  steps: readonly Step[],
  fails: (candidate: readonly Step[]) => boolean | Promise<boolean>,
): Promise<Step[]> {
  let current = [...steps]
  if (!(await fails(current))) return current
  let reduced = true
  while (reduced) {
    reduced = false
    for (let i = 0; i < current.length; i++) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1))
      if (await fails(candidate)) {
        current = candidate
        reduced = true
        break
      }
    }
  }
  return current
}
