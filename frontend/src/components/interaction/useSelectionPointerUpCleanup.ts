import { useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export function runPointerUpCleanup() {
  const state = useSketchEditorStore.getState()
  if (!state.isPointerDown) return

  state.setIsPointerDown(false)
}

export function useSelectionPointerUpCleanup() {
  useEffect(() => {
    window.addEventListener('pointerup', runPointerUpCleanup)
    return () => window.removeEventListener('pointerup', runPointerUpCleanup)
  }, [])
}
