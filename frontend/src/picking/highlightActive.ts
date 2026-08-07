import type { ActiveHighlight } from './selectionHighlight'

// Re-exported so a consumer can pull the builders and the shape they build from
// one module, without also reaching into selectionHighlight.
export type { ActiveHighlight } from './selectionHighlight'

// Shared empty set so an empty framing (nothing under the cursor) is a stable
// reference and does not thrash the highlight memos each render.
export const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()

// Shared empty claim map for the same purpose: an ActiveHighlight with no live
// pick claims reuses one reference, so the highlight memos keyed on `pickKeys`
// never re-run for a claims-free body. Exported so a consumer that must run an
// ActiveHighlight WITHOUT the live pick claims (the legacy per-triangle face
// path, whose queries are indexed by triangle, not by the face-indexed pick keys
// the id layer mints) can build one from the same stable reference.
export const EMPTY_CLAIM_MAP: ReadonlyMap<string, ReadonlySet<string>> = new Map()

/**
 * Click framing: the durable selection state exactly as the store holds it.
 * `selectedPicks` maps query -> the pickKeys of the primitives selected under it
 * (the store groups the live claims by query so a toggle-off drops them, and
 * holds a SET because several distinct primitives can share one query). The
 * grouping is preserved into `pickKeys` rather than flattened: computeHighlight
 * validates each claim against the primitive that currently owns its index, and
 * that check needs the query the claim was recorded under. This is the ONE
 * builder Body3D uses for the selection highlight, so the memo that wraps it and
 * the symmetry test both exercise identical wiring.
 */
export function selectActiveFrom(
  selectedPicks: ReadonlyMap<string, ReadonlySet<string>>,
  normalSelection: ReadonlySet<string>,
): ActiveHighlight {
  if (selectedPicks.size === 0) return { pickKeys: EMPTY_CLAIM_MAP, queries: normalSelection }
  return { pickKeys: selectedPicks, queries: normalSelection }
}

/**
 * Hover framing: a single pointed primitive expressed as a transient selection
 * of size <= 1. A null field drops to the shared empty sets, so an empty hover
 * means "nothing under the cursor". Same shape as the click framing, so both
 * flow through computeHighlight and stay symmetric by construction. A pickKey
 * without its paired query is dropped: the query is what gives the key meaning,
 * and computeHighlight's query gate would reject the claim anyway.
 */
export function hoverActiveFrom(
  hoveredPickKey: string | null,
  hoveredSelectionId: string | null,
): ActiveHighlight {
  return {
    pickKeys: hoveredPickKey !== null && hoveredSelectionId !== null
      ? new Map([[hoveredSelectionId, new Set([hoveredPickKey])]])
      : EMPTY_CLAIM_MAP,
    queries: hoveredSelectionId !== null ? new Set([hoveredSelectionId]) : EMPTY_STRING_SET,
  }
}
