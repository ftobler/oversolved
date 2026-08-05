import type { ActiveHighlight } from './selectionHighlight'

// Re-exported so a consumer can pull the builders and the shape they build from
// one module, without also reaching into selectionHighlight.
export type { ActiveHighlight } from './selectionHighlight'

// Shared empty set so an empty framing (nothing under the cursor, no live pick
// claims) is a stable reference and does not thrash the highlight memos each
// render. Both pickKeys and queries back onto it, hence the neutral name.
// Exported so a consumer that must run an ActiveHighlight WITHOUT the live pick
// claims (the legacy per-triangle face path, whose queries are indexed by
// triangle, not by the face-indexed pick keys the id layer mints) can build one
// from the same stable reference.
export const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()

/**
 * Click framing: the durable selection state exactly as the store holds it.
 * `selectedPicks` maps query -> the pickKeys of the primitives selected under it
 * (the store groups the live claims by query so a toggle-off drops them, and
 * holds a SET because several distinct primitives can share one query); the
 * highlight decision only needs the claimed pickKeys, so the groups are
 * flattened into the set shape computeHighlight consumes. This is the ONE
 * builder Body3D uses for the selection highlight, so the memo that wraps it and
 * the symmetry test both exercise identical wiring.
 */
export function selectActiveFrom(
  selectedPicks: ReadonlyMap<string, ReadonlySet<string>>,
  normalSelection: ReadonlySet<string>,
): ActiveHighlight {
  if (selectedPicks.size === 0) return { pickKeys: EMPTY_STRING_SET, queries: normalSelection }
  const pickKeys = new Set<string>()
  for (const claims of selectedPicks.values()) for (const k of claims) pickKeys.add(k)
  return { pickKeys, queries: normalSelection }
}

/**
 * Hover framing: a single pointed primitive expressed as a transient selection
 * of size <= 1. A null field drops to the shared empty set, so an empty hover
 * means "nothing under the cursor". Same shape as the click framing, so both
 * flow through computeHighlight and stay symmetric by construction.
 */
export function hoverActiveFrom(
  hoveredPickKey: string | null,
  hoveredSelectionId: string | null,
): ActiveHighlight {
  return {
    pickKeys: hoveredPickKey !== null ? new Set([hoveredPickKey]) : EMPTY_STRING_SET,
    queries: hoveredSelectionId !== null ? new Set([hoveredSelectionId]) : EMPTY_STRING_SET,
  }
}
