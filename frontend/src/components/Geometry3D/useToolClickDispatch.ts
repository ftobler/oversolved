import { useCallback } from 'react'
import { useSketchEditorStore, getEffectiveTool } from '../../stores/sketchEditorStore'
import { toolRegistry } from '../../registry/toolRegistry'
import type { DimensionToolContext } from '../../tools/DimensionTool'
import type { Point } from '../../types/cad'

/**
 * Layer 4 -- Tool Layer: shared click dispatch for interactive sketch elements.
 *
 * Both EntityItem (entities/edges) and VertexDot (vertices) route clicks here.
 * All tool-based clicks dispatch through the tool registry. Non-tool paths
 * (pendingPickField commit, clear selection) remain direct store calls.
 */
export function useToolClickDispatch({
  id,
  isEditing,
  entityKind,
}: {
  /** Full composite element ID. */
  id: string
  isEditing: boolean
  /** Entity kind string for dimension resolution (e.g. 'line', 'circle'). */
  entityKind?: string
}): (e: { stopPropagation: () => void; clientX: number; clientY: number }) => void {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const activeFeatureId = useSketchEditorStore(s => s.activeFeatureId)
  const internalHoverSelection = useSketchEditorStore(s => s.internalHoverSelection)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const pendingDimTarget = useSketchEditorStore(s => s.pendingDimTarget)
  const pendingDimEntityKind = useSketchEditorStore(s => s.pendingDimEntityKind)
  const setPendingDim = useSketchEditorStore(s => s.setPendingDim)
  const openDialog = useSketchEditorStore(s => s.openDialog)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)

  return useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    e.stopPropagation()

    const effectiveTool = getEffectiveTool(activeTool)
    const tool = toolRegistry.get(effectiveTool)

    // Dimension tool owns its own two-click flow and must not be interrupted by
    // a pending field pick -- it needs to stay active until the user places the
    // dimension. All other tools treat any click as the pick confirmation.
    if (pendingPickField && effectiveTool !== 'dimension') {
      toggleNormalSelection(id)
      commitFieldPick()
      return
    }

    const context = {
      normalSelection,
      internalHoverSelection,
      dynamicSelection,
      isPointerDown,
      activeFeatureId,
      hoveredVertexId,
      hoveredVertexPosition,
      hoveredSnapKind,
      onMutation,
      // dimension-specific fields passed through context
      pendingDimTarget,
      pendingDimEntityKind,
      hoveredEntityKind: entityKind ?? null,
      setPendingDim,
      openDialog,
      setActiveTool,
    }

    if (tool?.handlers.onClick) {
      // Dimension clicks on non-editing entities (inactive sketch geometry) must be
      // silently ignored -- the two-click state machine should not advance on ghost hits.
      if (effectiveTool === 'dimension' && !isEditing) return
      tool.handlers.onClick(
        { clientX: e.clientX, clientY: e.clientY } as PointerEvent,
        [0, 0] as Point,
        context as DimensionToolContext
      )
      return
    }

    // Fallback: tool exists but has no onClick -- treat as plain selection.
    // Mirror the dimension guard from above so a broken/future tool without onClick
    // cannot accidentally commit a field pick while the dimension flow is running.
    toggleNormalSelection(id)
    if (pendingPickField && effectiveTool !== 'dimension') commitFieldPick()
  }, [activeTool, isEditing, id, entityKind,
    pendingPickField, commitFieldPick, toggleNormalSelection,
    normalSelection, dynamicSelection, isPointerDown, activeFeatureId,
    internalHoverSelection, hoveredVertexId, hoveredVertexPosition, hoveredSnapKind, onMutation,
    pendingDimTarget, pendingDimEntityKind, setPendingDim, openDialog, setActiveTool])
}
