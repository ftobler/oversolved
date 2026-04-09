import { useCallback } from 'react'
import { useSketchEditorStore, getEffectiveTool } from '../../stores/sketchEditorStore'
import { toolRegistry } from '../../registry/toolRegistry'
import type { Point } from '../../types/cad'

/**
 * Layer 4 — Tool Layer: shared click dispatch for interactive sketch elements.
 *
 * Both EntityItem (entities/edges) and VertexDot (vertices) need the same
 * three-way dispatch on click:
 *   1. dimension tool  → open dimension dialog via handleDimensionClick
 *   2. field pick mode → commit the selection to a parameter field
 *   3. otherwise       → toggle static selection
 *
 * Parameters that differ between element types are passed as arguments so this
 * hook has no knowledge of what kind of element it operates on.
 */
export function useToolClickDispatch({
  id,
  featureId,
  isEditing,
  dimensionKind,
  entityKind,
  fieldPickKind,
}: {
  /** Full composite element ID. */
  id: string
  featureId: string
  isEditing: boolean
  /** 'entity' for edge elements, 'vertex' for vertex elements. */
  dimensionKind: 'entity' | 'vertex'
  /** Passed to handleDimensionClick for entity-level dimension resolution. */
  entityKind?: string
  /** The fieldPick kind this element responds to: 'line' for entities, 'point' for vertices. */
  fieldPickKind: 'line' | 'point'
}): (e: { stopPropagation: () => void; clientX: number; clientY: number }) => void {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)
  const handleDimClick = useSketchEditorStore(s => s.handleDimensionClick)
  const fieldPickState = useSketchEditorStore(s => s.fieldPickState)
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

  return useCallback((e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    e.stopPropagation()

    const effectiveTool = getEffectiveTool(activeTool)
    const tool = toolRegistry.get(effectiveTool)

    const context = {
      normalSelection,
      internalHoverSelection,
      selection: normalSelection,  // Legacy alias
      hoveredEntityId: internalHoverSelection,  // Legacy alias
      dynamicSelection,
      isPointerDown,
      activeFeatureId,
      hoveredVertexId,
      hoveredVertexPosition,
      hoveredSnapKind,
      onMutation,
    }

    if (tool?.handlers.onClick && effectiveTool !== 'dimension' && !fieldPickState?.kind) {
      tool.handlers.onClick(
        { clientX: e.clientX, clientY: e.clientY } as PointerEvent,
        [0, 0] as Point,
        context
      )
      return
    }

    if (activeTool === 'dimension') {
      if (!isEditing) return
      handleDimClick(id, featureId, dimensionKind, [e.clientX, e.clientY], entityKind)
    } else if (fieldPickState?.kind === fieldPickKind) {
      commitFieldPick(id)
    } else {
      toggleNormalSelection(id)
    }
  }, [activeTool, isEditing, id, featureId, dimensionKind, entityKind, fieldPickKind,
    handleDimClick, fieldPickState, commitFieldPick, toggleNormalSelection,
    normalSelection, dynamicSelection, isPointerDown, activeFeatureId,
    internalHoverSelection, hoveredVertexId, hoveredVertexPosition, hoveredSnapKind, onMutation])
}
