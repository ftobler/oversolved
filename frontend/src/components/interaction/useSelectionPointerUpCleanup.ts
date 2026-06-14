import { useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// Safety net for stuck drag state. Orbit (camera pan/drag) is derived as
// `!drag && !dragPending` (SceneController), and those fields are normally
// cleared by the per-sketch DragPlane's window pointerup handler (Dragging.tsx).
// That handler unmounts with the sketch, so a document load that remounts the
// DragPlane mid-gesture loses the cleanup and leaves dragPending stuck non-null,
// disabling the camera permanently. This clears the leftover so orbit recovers.
//
// Guarded by isPointerDown: a fresh gesture (re-)sets it via dispatchDragInitiation,
// so if a new drag began in the meantime we leave its state alone.
export function runPointerUpDragSafetyNet() {
  const state = useSketchEditorStore.getState()
  if (state.isPointerDown) return
  if (!state.drag && !state.dragPending) return

  state.setDrag(null)
  state.setDragPending(null)
  state.setDragStartClient(null)
  state.setDragSnap(null)
}

export function runPointerUpCleanup() {
  const state = useSketchEditorStore.getState()
  if (!state.isPointerDown) return

  state.setIsPointerDown(false)

  // Defer the drag-state safety net to a macrotask so it runs after every
  // synchronous pointerup handler -- in particular the DragPlane commit
  // (Dragging.tsx upImpl -> DragTool.onPointerUp), which reads
  // drag/dragPending/dragStartClient to finalize a real drag. This cleanup's
  // window listener is registered first (at Viewport mount), so clearing the
  // state synchronously here would clobber that commit. On a normal release the
  // commit clears the state first and this is a no-op; only a lost gesture
  // (e.g. DragPlane unmounted by a load race) leaves state to recover.
  setTimeout(runPointerUpDragSafetyNet, 0)
}

export function useSelectionPointerUpCleanup() {
  useEffect(() => {
    window.addEventListener('pointerup', runPointerUpCleanup)
    return () => window.removeEventListener('pointerup', runPointerUpCleanup)
  }, [])
}
