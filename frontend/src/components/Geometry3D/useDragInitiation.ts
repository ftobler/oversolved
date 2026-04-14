// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { useCallback } from 'react'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

/** Returns a function that records a pending drag when the pointer goes down on a sketch element.
 *  Encapsulates the shared pattern from EntityItem and VertexDot so the store writes live in
 *  one tested place rather than duplicated across components. The caller (component) is
 *  responsible for computing startWorld before invoking the returned function: for vertex
 *  elements startWorld is the vertex center [x, y]; for edge elements it is the sanitized
 *  hit point. See feature/feature_headless_viewport.md Step 5. */
export function useDragInitiation() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)

  const initDrag = useCallback((
    event: { stopPropagation(): void; clientX: number; clientY: number },
    config: {
      type: 'vertex' | 'edge'
      id: string
      featureId: string
      entityId: string
      vertexKey: string
      startWorld: [number, number]
      isEditing: boolean
      markAsClicked: () => void
    },
  ) => {
    if (!config.isEditing || (activeTool !== null && activeTool !== 'select')) return
    event.stopPropagation()
    config.markAsClicked()
    setOrbitEnabled(false)
    setIsPointerDown(true)
    setDragStartClient([event.clientX, event.clientY])
    setDragPending({
      type: config.type,
      vertexId: config.id,
      featureId: config.featureId,
      entityId: config.entityId,
      vertexKey: config.vertexKey,
      startWorld: config.startWorld,
    })
  }, [activeTool, setDragStartClient, setDragPending, setOrbitEnabled, setIsPointerDown])

  return { initDrag }
}
