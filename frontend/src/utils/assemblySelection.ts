// The assembly tree's selection subject and the one accessor every reader uses.
//
// The part editor's tree subject and the B-rep entity selection used to live in
// three independent store fields, and "a part and a mate are both selected" was
// representable (the delete path then silently preferred the mate). A tagged
// union makes that state unrepresentable: there is one `subject` slot, and at
// most one of a part handle or a mate id occupies it.
//
// Pure and React free, so the store can hold the union and every consumer reads
// it through `readSelection` without re-deriving "which selection" by hand.

/** The tree subject. At most one is set; the union is the invariant. */
export type AssemblySubject =
  | { kind: 'part'; handle: string }
  | { kind: 'mate'; id: string }

export interface AssemblySelectionView {
  // Zero or one handle today, a set so widening to multi-part subject selection
  // is local to the accessor.
  parts: ReadonlySet<string>
  mate: string | null
  // B-rep entities selected for measurement; orthogonal to the subject.
  entities: ReadonlySet<string>
}

/**
 * The ONE accessor every reader uses. Pure, no store: the union guarantees a
 * part and a mate can never both be present, so `parts` and `mate` are never
 * simultaneously populated.
 */
export function readSelection(
  subject: AssemblySubject | null,
  entities: ReadonlySet<string>,
): AssemblySelectionView {
  const parts = new Set<string>()
  let mate: string | null = null
  if (subject !== null) {
    if (subject.kind === 'part') parts.add(subject.handle)
    else mate = subject.id
  }
  return { parts, mate, entities }
}
