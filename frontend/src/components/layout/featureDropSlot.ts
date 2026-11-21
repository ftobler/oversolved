// The one insertion rule the Features list uses. A pointer's vertical position
// maps to a slot from the feature rows' own rects rather than from the element
// under the cursor, so the gaps between rows, the rollback bar's band and the
// empty tail below the last row all resolve to a slot. The native HTML5 drop
// read `e.target`, which left those bands without a droppable element and the
// cue stuck on the row last hovered.

/** The insertion index for a pointer at `clientY` over the list: the first
 *  feature row whose vertical midpoint is below the pointer, or the end.
 *  Clamped past the built-ins. Gaps, the rollback bar and the empty tail all
 *  resolve: the rule reads row rects, not the element under the cursor. */
export function slotAt(
  rowRects: ReadonlyArray<{ top: number; height: number }>,
  clientY: number,
  minSlot: number,
): number {
  for (let i = 0; i < rowRects.length; i++) {
    const rect = rowRects[i]
    if (clientY < rect.top + rect.height / 2) return Math.max(i, minSlot)
  }
  return Math.max(rowRects.length, minSlot)
}

export interface DropCueEdges {
  // Row index that draws a line on its top edge, or null.
  top: number | null
  // Row index that draws a line on its bottom edge, or null.
  bottom: number | null
}

/** Which row edges draw the insertion line for `slot`. A plain slot marks both
 *  sides of its gap. When the slot holds the rollback bar, the feature lands on
 *  the side it is coming from, so only that side is marked: a row dragged down
 *  into the bar's slot lands above the bar, one dragged up lands below it.
 *  `draggedIndex` is negative for the bar's own drag, which marks both sides. */
export function dropCueEdges(
  slot: number,
  rowCount: number,
  barSlot: number,
  draggedIndex: number,
): DropCueEdges {
  const top = slot < rowCount ? slot : null
  const bottom = slot > 0 ? slot - 1 : null
  if (slot === barSlot && draggedIndex >= 0) {
    if (draggedIndex < barSlot) return { top: null, bottom }
    return { top, bottom: null }
  }
  return { top, bottom }
}
