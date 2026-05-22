import { useSketchEditorStore, getEffectiveTool, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import type { DimensionToolContext } from '@/tools/DimensionTool'
import type { DragToolContext } from '@/tools/DragTool'
import type { Point } from '@/types/cad'

/**
 * Shared tool-click dispatch logic called by the id-buffer adapters.
 * Routes sketch entity / vertex clicks through the tool registry,
 * providing the synchronously-resolved ID as `hoveredSelectionId`.
 */
export function dispatchSketchClick(
  id: string,
  entityKind: string | undefined,
  clientX: number,
  clientY: number,
): void {
  const state = useSketchEditorStore.getState()
  const effectiveTool = getEffectiveTool(state.activeTool)
  const tool = toolRegistry.get(effectiveTool)

  const context = {
    normalSelection: state.normalSelection,
    hoveredSelectionId: id,
    isPointerDown: state.isPointerDown,
    activeFeatureId: state.activeFeatureId,
    hoveredVertexId: state.hoveredVertexId,
    hoveredVertexPosition: state.hoveredVertexPosition,
    hoveredSnapKind: state.hoveredSnapKind,
    toggleNormalSelection: state.toggleNormalSelection,
    clearNormalSelection: state.clearNormalSelection,
    onMutation: getSketchCallback('onMutation'),
    pendingDimTarget: state.pendingDimTarget,
    pendingDimEntityKind: state.pendingDimEntityKind,
    hoveredEntityKind: entityKind ?? null,
    setPendingDim: state.setPendingDim,
    openDialog: state.openDialog,
    setActiveTool: state.setActiveTool,
    pushMode: () => {},
    popMode: () => {},
  }

  if (tool?.handlers.onClick) {
    if (effectiveTool === 'dimension' && !state.activeFeatureId) return
    tool.handlers.onClick(
      { clientX, clientY } as PointerEvent,
      [0, 0] as Point,
      context as DimensionToolContext,
    )
    return
  }

  state.toggleNormalSelection(id)
}

/**
 * Unified drag-initiation. Called by both sketchVertexAdapter and
 * sketchEntityAdapter on pointerdown to begin a sketch-element drag
 * through the DragTool registry handler.
 */
export function dispatchDragInitiation(
  id: string,
  featureId: string,
  _entityId: string,
  _vertexKey: string,
  clientX: number,
  clientY: number,
): void {
  const state = useSketchEditorStore.getState()
  const effectiveTool = getEffectiveTool(state.activeTool)

  if (!state.activeFeatureId || state.activeFeatureId !== featureId) return
  if (effectiveTool !== null && effectiveTool !== 'select' && effectiveTool !== 'drag') return

  state.setOrbitEnabled(false)
  state.setIsPointerDown(true)
  state.setDragStartClient([clientX, clientY])

  const dragTool = toolRegistry.get('drag')
  if (!dragTool) return

  const ctx: DragToolContext = {
    normalSelection: state.normalSelection,
    hoveredSelectionId: id,
    isPointerDown: true,
    activeFeatureId: state.activeFeatureId,
    hoveredVertexId: id,
    hoveredVertexPosition: null,
    hoveredSnapKind: state.hoveredSnapKind,
    onMutation: getSketchCallback('onMutation'),
    drag: null,
    dragPending: null,
    dragSnap: state.dragSnap,
    setDrag: state.setDrag,
    setDragPending: state.setDragPending,
    setDragSnap: state.setDragSnap,
    startClient: [clientX, clientY],
    setOrbitEnabled: state.setOrbitEnabled,
    pushMode: () => {},
    popMode: () => {},
  }

  dragTool.handlers.onPointerDown?.(
    { clientX, clientY, stopPropagation: () => {} } as PointerEvent,
    [0, 0],
    ctx,
  )
}
