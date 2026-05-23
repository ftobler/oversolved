import { useCallback, useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

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
 * Returns `{ isPicking, toggle }`: `toggle` activates this field (clearing any
 * other active field) or deactivates it if already active.
 */
export function usePickField(
  featureId: string,
  field: string,
  onPick: (selectionId: string) => void,
  opts?: { multi?: boolean },
): { isPicking: boolean; toggle: () => void } {
  const multi = opts?.multi ?? false
  const activePickField = useSketchEditorStore(s => s.activePickField)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isPicking = activePickField?.featureId === featureId && activePickField?.field === field

  useEffect(() => {
    if (!isPicking) return
    const s = useSketchEditorStore.getState()
    for (const id of s.normalSelection) {
      if (!s.chipOwnedSelection.has(id)) {
        onPick(id)
        s.clearNormalSelection()
        if (!multi) s.setActivePickField(null)
        return
      }
    }
  }, [normalSelection, isPicking, onPick, multi])

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
