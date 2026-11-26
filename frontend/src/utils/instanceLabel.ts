// A top-level part instance is anonymous in the document: its display name is
// the bound part document's name in the workspace. Two placements of one part
// therefore read identically unless the view adds an ordinal, which is what a
// mate chip and the Parts tree both need when the user picks between them.
// The ordinal is derived from the CURRENT authored instance order, never stored:
// deleting the first of three copies must not leave a gap in the numbering.

import type { PartInstance } from '@/types/cad'

/**
 * The label of one top-level instance, or undefined for a handle the document
 * no longer holds. Only instances of the same part document share the ordinal
 * sequence; a second document keeps its own, unnumbered name.
 */
export function instanceLabel(
  instances: readonly PartInstance[],
  docNames: Readonly<Record<string, string>>,
  handle: string,
): string | undefined {
  const inst = instances.find(i => i.handle === handle)
  if (!inst) return undefined
  const name = docNames[inst.doc_id] || inst.doc_id
  const siblings = instances.filter(i => i.doc_id === inst.doc_id)
  if (siblings.length <= 1) return name
  // Identity, not handle equality: the authored order is the array order, and a
  // duplicate handle would be a corrupt document rather than a second ordinal.
  const ordinal = siblings.indexOf(inst) + 1
  // The first placement keeps the part's own name; only later copies are
  // numbered, so a single instance is never decorated with a redundant "(1)".
  return ordinal === 1 ? name : `${name} (${ordinal})`
}
