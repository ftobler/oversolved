import type { ActiveHighlight } from './selectionHighlight'

// Re-exported so a consumer can pull the builders and the shape they build from
// one module, without also reaching into selectionHighlight.
export type { ActiveHighlight } from './selectionHighlight'

// Shared empty set so an empty hover (nothing under the cursor) is a stable
// reference and does not thrash the highlight memos each render. Both pickKeys
// and queries back onto it, hence the neutral name.
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()

/**
 * Click framing: the durable selection sets exactly as the store holds them.
 * This is the ONE builder Body3D uses for the selection highlight, so the memo
 * that wraps it and the symmetry test both exercise identical wiring.
 */
export function selectActiveFrom(
  selectedPickKeys: ReadonlySet<string>,
  normalSelection: ReadonlySet<string>,
): ActiveHighlight {
  return { pickKeys: selectedPickKeys, queries: normalSelection }
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
