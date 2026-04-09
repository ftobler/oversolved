import { useEffect } from 'react'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

export function useSelectionPointerUpCleanup() {
  useEffect(() => {
    const cleanup = () => {
      const { isPointerDown, setIsPointerDown } = useSketchEditorStore.getState()
      if (isPointerDown) {
        setIsPointerDown(false)
        useSketchEditorStore.setState({ dynamicSelection: new Set() })
      }
    }
    window.addEventListener('pointerup', cleanup)
    return () => window.removeEventListener('pointerup', cleanup)
  }, [])
}
