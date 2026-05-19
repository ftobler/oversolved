import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSketchEditorStore, getEffectiveTool, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import type { DimensionToolContext } from '@/tools/DimensionTool'
import type { Point } from '@/types/cad'

/**
 * Layer 4 -- Tool Layer: shared click dispatch for interactive sketch elements.
 *
 * Both EntityItem (entities/edges) and VertexDot (vertices) route clicks here.
 * All tool-based clicks dispatch through the tool registry. Non-tool paths
 * (pendingPickField commit, clear selection) remain direct store calls.
 *
 * Uses a single combined selector via useShallow to reduce per-entity
 * subscription count from 15+ down to 1.
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
  const {
    activeTool,
    toggleNormalSelection,
    normalSelection,
    dynamicSelection,
    isPointerDown,
    activeFeatureId,
    internalHoverSelection,
    hoveredVertexId,
    hoveredVertexPosition,
    hoveredSnapKind,
    pendingDimTarget,
    pendingDimEntityKind,
    setPendingDim,
    openDialog,
    setActiveTool,
  } = useSketchEditorStore(useShallow(s => ({
    activeTool: s.activeTool,
    toggleNormalSelection: s.toggleNormalSelection,
    normalSelection: s.normalSelection,
    dynamicSelection: s.dynamicSelection,
    isPointerDown: s.isPointerDown,
    activeFeatureId: s.activeFeatureId,
    internalHoverSelection: s.internalHoverSelection,
    hoveredVertexId: s.hoveredVertexId,
    hoveredVertexPosition: s.hoveredVertexPosition,
    hoveredSnapKind: s.hoveredSnapKind,
    pendingDimTarget: s.pendingDimTarget,
    pendingDimEntityKind: s.pendingDimEntityKind,
    setPendingDim: s.setPendingDim,
    openDialog: s.openDialog,
    setActiveTool: s.setActiveTool,
  })))

  return useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    e.stopPropagation()

    const effectiveTool = getEffectiveTool(activeTool)
    const tool = toolRegistry.get(effectiveTool)

    const context = {
      normalSelection,
      internalHoverSelection,
      dynamicSelection,
      isPointerDown,
      activeFeatureId,
      hoveredVertexId,
      hoveredVertexPosition,
      hoveredSnapKind,
      // onMutation is not in store state; read from module-level ref at call time.
      onMutation: getSketchCallback('onMutation'),
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
  }, [activeTool, isEditing, id, entityKind,
    toggleNormalSelection,
    normalSelection, dynamicSelection, isPointerDown, activeFeatureId,
    internalHoverSelection, hoveredVertexId, hoveredVertexPosition, hoveredSnapKind,
    pendingDimTarget, pendingDimEntityKind, setPendingDim, openDialog, setActiveTool])
}
