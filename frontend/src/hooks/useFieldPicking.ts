import { useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

/**
 * Watches `normalSelection` for new non-chip-owned items while `isPicking`
 * is true. When a new item appears, it calls `onPick(selectionId)` so the
 * calling editor can dispatch the appropriate mutation, then clears the
 * selection so the chip's sync effect can re-populate chip-owned items.
 *
 * This replaces the old `pendingPickField` / `commitFieldPick` pattern:
 * viewport clicks always just `toggleNormalSelection`; this hook picks up
 * the result and routes it to the active editor's field logic.
 */
export function useFieldPicking(
  isPicking: boolean,
  onPick: (selectionId: string) => void,
): void {
  const normalSelection = useSketchEditorStore(s => s.normalSelection)

  useEffect(() => {
    if (!isPicking) return

    const s = useSketchEditorStore.getState()
    for (const id of s.normalSelection) {
      if (!s.chipOwnedSelection.has(id)) {
        onPick(id)
        s.clearNormalSelection()
        return
      }
    }
  }, [normalSelection, isPicking, onPick])
}
