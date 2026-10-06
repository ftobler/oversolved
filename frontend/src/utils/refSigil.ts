// Reference sigil handling shared across the pick, query and feature code.
//
// A reference is absolute (`@name`, a document-scoped or builtin element) or
// host-local (`$name`, an entity inside the owning feature), and some callers
// accept either. Stripping the sigil used to be spelled with a regex or a
// startsWith/slice per call site, and the sigil sets had drifted; this is the
// single definition.

/**
 * Drop a leading run of any of the given `sigils` from `ref`.
 *
 * Only leading sigils go: a sigil later in the string (inside a slash-
 * registered element path, say) is part of the reference and is kept. Callers
 * that accept exactly one sigil pass it, so `stripRefSigil(ref, '$')` leaves an
 * `@name` untouched.
 */
export function stripRefSigil(ref: string, sigils: string): string {
  let i = 0
  while (i < ref.length && sigils.includes(ref[i])) i++
  return ref.slice(i)
}
