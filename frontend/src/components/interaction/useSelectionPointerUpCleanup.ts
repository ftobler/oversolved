import { useEffect } from 'react'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

export function runPointerUpCleanup() {
  const state = useSketchEditorStore.getState()
  if (!state.isPointerDown) return

  const dynamic = state.dynamicSelection
  if (dynamic.size > 0) {
    for (const id of dynamic) {
      state.toggleNormalSelection(id)
    }
  }

  state.setIsPointerDown(false)
  useSketchEditorStore.setState({ dynamicSelection: new Set() })
}

export function useSelectionPointerUpCleanup() {
  useEffect(() => {
    window.addEventListener('pointerup', runPointerUpCleanup)
    return () => window.removeEventListener('pointerup', runPointerUpCleanup)
  }, [])
}
