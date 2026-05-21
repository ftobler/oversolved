import { useSketchEditorStore, getEffectiveTool, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import type { DimensionToolContext } from '@/tools/DimensionTool'
import type { DragToolContext } from '@/tools/DragTool'
import type { Point } from '@/types/cad'

/**
 * Shared tool-click dispatch logic extracted from useToolClickDispatch.
 * Called by the id-buffer adapters so sketch entity / vertex clicks go
 * through the tool registry identically to the pre-267.5 R3F handlers.
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
    internalHoverSelection: state.internalHoverSelection,
    isPointerDown: state.isPointerDown,
    activeFeatureId: state.activeFeatureId,
    hoveredVertexId: state.hoveredVertexId,
    hoveredVertexPosition: state.hoveredVertexPosition,
    hoveredSnapKind: state.hoveredSnapKind,
    onMutation: getSketchCallback('onMutation'),
    pendingDimTarget: state.pendingDimTarget,
    pendingDimEntityKind: state.pendingDimEntityKind,
    hoveredEntityKind: entityKind ?? null,
    setPendingDim: state.setPendingDim,
    openDialog: state.openDialog,
    setActiveTool: state.setActiveTool,
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
 *
 * - Vertex drags: passes the vertex ID as hoveredVertexId, DragTool
 *   resolves type='vertex' and parses entityId/vertexKey from the ID.
 * - Entity (edge) drags: passes the entity ID as hoveredVertexId with
 *   vertexKey='edge', DragTool resolves type='edge'.
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
    internalHoverSelection: state.internalHoverSelection,
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
