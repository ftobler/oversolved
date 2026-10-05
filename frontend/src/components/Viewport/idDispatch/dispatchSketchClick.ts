import { useSketchEditorStore, getEffectiveTool, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import type { DimensionToolContext } from '@/tools/DimensionTool'
import type { DragToolContext } from '@/tools/DragTool'

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
    // The id buffer resolves the pick, not a screen ray, so there is no world
    // point here: [0, 0] is a placeholder on a dead part of the contract. The
    // event is coordinate-only by design (ToolPointerEvent) so a handler that
    // reaches for a richer field fails to compile rather than reading undefined.
    tool.handlers.onClick(
      { clientX, clientY },
      [0, 0],
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

  // The gesture fields are shared, not per-pointer. A second pointer pressing
  // another sketch mid-gesture would overwrite dragPending, which the first
  // pointer's release then clears: the second gesture never activates and the
  // camera unlocks while its finger is still down. Ignore the second press.
  if (state.drag || state.dragPending) return

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

  // Same placeholder world point as the click path: the adapters hand over the
  // id-buffer pick, which carries no screen-to-world coordinate.
  dragTool.handlers.onPointerDown?.(
    { clientX, clientY },
    [0, 0],
    ctx,
  )
}
