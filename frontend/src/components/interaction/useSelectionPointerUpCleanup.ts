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
    // pointercancel / lostpointercapture matter under a load race: a blocking
    // WASM re-solve (e.g. triggered by entering a sketch edit) or the removal of
    // an element involved in the gesture makes the browser end the gesture with
    // pointercancel instead of pointerup. Without catching those, isPointerDown
    // and drag/dragPending stay stuck -- which freezes the camera, since orbit is
    // derived as !isPointerDown || (!drag && !dragPending). Routing all three to
    // the same cleanup guarantees the gesture state is released however it ends.
    window.addEventListener('pointerup', runPointerUpCleanup)
    window.addEventListener('pointercancel', runPointerUpCleanup)
    window.addEventListener('lostpointercapture', runPointerUpCleanup)
    return () => {
      window.removeEventListener('pointerup', runPointerUpCleanup)
      window.removeEventListener('pointercancel', runPointerUpCleanup)
      window.removeEventListener('lostpointercapture', runPointerUpCleanup)
    }
  }, [])
}
