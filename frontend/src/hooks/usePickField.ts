import { useCallback, useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { isPickAllowed } from '@/utils/query/pickOrder'

/**
 * Layer-2 pick-field consumer. A pick chip is a consumer of normal selection,
 * never a parallel click path: viewport clicks always `toggleNormalSelection`,
 * and this hook observes the result while its field is the single
 * store-owned `activePickField`.
 *
 * When a new (non-chip-owned) item appears in `normalSelection`, it calls
 * `onPick(selectionId)` so the editor can dispatch its mutation, then clears
 * the selection so the chip's sync effect re-populates chip-owned items.
 * Single-pick fields auto-close after one pick; `multi` fields stay open.
 *
 * Re-clicking an already-picked element toggles it out of `normalSelection`
 * (the viewport click path is symmetric). A chip-owned id that has dropped out
 * of `normalSelection` is that toggle-off, so we call `onUnpick(selectionId)`
 * to let the editor dispatch the matching remove mutation.
 *
 * `features` is the build-order stack. Passing it enables the circular-dependency
 * guard: this is the one choke point every pick chip funnels through, so the
 * rule "you may only pick from features before you" is enforced here once
 * instead of in each editor.
 *
 * Returns `{ isPicking, toggle }`: `toggle` activates this field (clearing any
 * other active field) or deactivates it if already active.
 */
export function usePickField(
  featureId: string,
  field: string,
  onPick: (selectionId: string) => void,
  opts?: {
    multi?: boolean
    onUnpick?: (selectionId: string) => void
    features?: readonly { id: string }[]
  },
): { isPicking: boolean; toggle: () => void } {
  const multi = opts?.multi ?? false
  const onUnpick = opts?.onUnpick
  const features = opts?.features
  const activePickField = useSketchEditorStore(s => s.activePickField)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isPicking = activePickField?.featureId === featureId && activePickField?.field === field

  useEffect(() => {
    if (!isPicking) return
    const s = useSketchEditorStore.getState()
    for (const id of s.normalSelection) {
      if (!s.chipOwnedSelection.has(id)) {
        if (features && !isPickAllowed(id, featureId, features)) {
          // Circular dependency: the host would reference its own output or a
          // later feature's. Drop the pick but keep the field open (unlike an
          // accepted pick) so the user can go straight for valid geometry.
          s.clearNormalSelection()
          return
        }
        onPick(id)
        s.clearNormalSelection()
        if (!multi) s.setActivePickField(null)
        return
      }
    }
    // No new pick: a chip-owned id missing from normalSelection is a re-click
    // toggle-off, so remove it from the chip.
    if (!onUnpick) return
    for (const id of s.chipOwnedSelection) {
      if (!s.normalSelection.has(id)) {
        onUnpick(id)
        // Mirror the onPick path: empty both selection sets so the unstable
        // callback identity can't re-fire this remove before the async re-solve
        // updates `values` and the chip's sync effect repopulates the survivors.
        s.clearNormalSelection()
        return
      }
    }
  }, [normalSelection, isPicking, onPick, onUnpick, multi, features, featureId])

  const toggle = useCallback(() => {
    const s = useSketchEditorStore.getState()
    const cur = s.activePickField
    if (cur?.featureId === featureId && cur?.field === field) {
      s.setActivePickField(null)
    } else {
      s.setActivePickField({ featureId, field, multi })
    }
  }, [featureId, field, multi])

  return { isPicking, toggle }
}
