// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { useCallback } from 'react'
import { useSketchEditorStore, getSketchCallback } from '../../stores/sketchEditorStore'
import { toolRegistry } from '../../registry/toolRegistry'
import type { DragToolContext } from '../../tools/DragTool'

/** Returns a function that initiates drag through the tool registry when the pointer
 *  goes down on a sketch element. The store writes (setDragPending, setOrbitEnabled,
 *  setIsPointerDown) are handled by the DragTool handler rather than being inlined here.
 *  See feature/feature_headless_viewport.md Step 5. */
export function useDragInitiation() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setOrbitEnabled = useSketchEditorStore(s => s.setOrbitEnabled)
  const setIsPointerDown = useSketchEditorStore(s => s.setIsPointerDown)
  const setDragStartClient = useSketchEditorStore(s => s.setDragStartClient)
  const setDragPending = useSketchEditorStore(s => s.setDragPending)
  const setDrag = useSketchEditorStore(s => s.setDrag)
  const setDragSnap = useSketchEditorStore(s => s.setDragSnap)

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

    const dragTool = toolRegistry.get('drag')
    const state = useSketchEditorStore.getState()
    if (dragTool) {
      const context: DragToolContext = {
        normalSelection: state.normalSelection,
        internalHoverSelection: state.internalHoverSelection,
        dynamicSelection: state.dynamicSelection,
        isPointerDown: true,
        activeFeatureId: state.activeFeatureId,
        hoveredVertexId: config.id,
        hoveredVertexPosition: [config.startWorld[0], config.startWorld[1]],
        hoveredSnapKind: state.hoveredSnapKind,
        onMutation: getSketchCallback('onMutation'),
        drag: null,
        dragPending: null,
        dragSnap: state.dragSnap,
        setDrag,
        setDragPending,
        setDragSnap,
        startClient: [event.clientX, event.clientY],
        setOrbitEnabled,
      }
      dragTool.handlers.onPointerDown?.(
        event as PointerEvent,
        config.startWorld,
        context,
      )
    }
  }, [activeTool, setOrbitEnabled, setIsPointerDown, setDragStartClient, setDragPending, setDrag, setDragSnap])

  return { initDrag }
}
