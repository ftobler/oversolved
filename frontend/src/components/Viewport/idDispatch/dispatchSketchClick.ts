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
    onMutationBatch: getSketchCallback('onMutationBatch'),
    hoveredEntityKind: entityKind ?? null,
    dimensionPicks: state.dimensionPicks,
    addDimensionPick: state.addDimensionPick,
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
  // Drag initiation only under the idle/drag entry: getEffectiveTool(null) is
  // 'drag', and every drawing tool commits on pointer-down instead.
  if (effectiveTool !== 'drag') return

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
    pushMode: () => {},
    popMode: () => {},
  }

  dragTool.handlers.onPointerDown?.(
    { clientX, clientY, stopPropagation: () => {} } as PointerEvent,
    [0, 0],
    ctx,
  )
}
