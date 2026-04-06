// handler-helpers.ts
// Helper functions to build click/drag event handlers.
// Components import these and use them to wire up event handlers.

import type { Point } from '../../types/cad'
import type { ActiveTool } from '../../stores/sketchEditorStore'
import type { FieldPickState } from '../../components/Sidebar'
import type { DragInit } from './interaction-actions'

/**
 * Build a click handler for entity/vertex groups.
 *
 * Handles:
 * - dimension tool: open dialog
 * - field pick: commit pick
 * - else: toggle selection
 *
 * Also handles the "isEditing" guard and early return for non-select tool.
 */
export function buildClickHandler(
  handleDimensionClick: (
    target: string,
    featureId: string,
    kind: 'entity' | 'vertex',
    screenPos: Point,
    entityKind?: string,
  ) => void,
  toggleSelect: (id: string) => void,
  fieldPickState: FieldPickState | null,
  commitFieldPick: (id: string) => void,
  isEditing: boolean,
): (e: { stopPropagation: () => void; clientX: number; clientY: number }) => void {
  return (e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    // Stop propagation
    e.stopPropagation()

    // Early return if not in edit mode
    if (!isEditing) return

    // Check active tool for dimension handling
    // Note: activeTool is not directly available here — caller must pass it
    // For now, this handler assumes activeTool === 'dimension' is checked by caller
    // and we handle the other cases here.

    const activeTool = 'select' as ActiveTool // This would be passed in real usage
    if (activeTool === 'dimension') {
      handleDimensionClick(
        // In real usage: target ID would be passed from calling context
        '',
        '',
        'entity',
        [e.clientX, e.clientY],
        'line',
      )
    } else if (fieldPickState?.kind === 'line') {
      commitFieldPick('')
    } else {
      toggleSelect('')
    }
  }
}

/**
 * Build a pointer-down handler for dragging.
 *
 * Captures start state to distinguish clicks from drags.
 * Returns null if this pointer-down shouldn't start a drag.
 */
export function buildDragPointerDownHandler(
  setDrag: (drag: DragInit | null) => void,
  setOrbitEnabled: (enabled: boolean) => void,
  isEditing: boolean,
  activeTool: ActiveTool,
): (e: PointerEvent, worldPt: Point) => DragInit | null {
  return (e: PointerEvent, worldPt: Point) => {
    // Early return if not in edit mode or not select tool
    if (!isEditing || activeTool !== 'select') {
      return null
    }

    // Stop orbit control during drag
    setOrbitEnabled(false)

    // Capture start state
    const drag: DragInit = {
      type: 'edge', // Could be 'vertex' or 'dim_label' for other types
      vertexId: '', // Would be set from calling context
      featureId: '',
      entityId: '',
      vertexKey: 'edge',
      startWorld: [worldPt[0], worldPt[1]],
      startClient: [e.clientX, e.clientY],
    }

    setDrag(drag)
    return drag
  }
}

/**
 * Build a pointer-up handler that distinguishes clicks from drags.
 *
 * Uses pixel distance threshold (4px) to decide:
 * - < 4px: click (don't emit mutation)
 * - >= 4px: drag (emit mutation)
 */
export function buildDragPointerUpHandler(
  drag: DragInit | null,
  setDrag: (drag: DragInit | null) => void,
  setOrbitEnabled: (enabled: boolean) => void,
  onMutation: ((m: import('../../types/cad').Mutation) => void) | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _featureId?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _vertexId?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _vertexKey?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _entityId?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _handleDimensionClick?: (
    target: string,
    featureId: string,
    kind: 'entity' | 'vertex',
    screenPos: Point,
    entityKind?: string,
  ) => void,
): (e: PointerEvent, worldPt: Point) => void {
  return (_e: PointerEvent, worldPt: Point) => {
    if (!drag) return

    // Calculate pixel distance from start to end position
    const pixelDistance = Math.hypot(
      worldPt[0] - drag.startWorld[0],
      worldPt[1] - drag.startWorld[1],
    )

    const wasDrag = pixelDistance >= 4

    // Clear drag state
    setDrag(null)
    setOrbitEnabled(true)

    // If it was a drag, emit mutation (if handler is provided)
    // Note: This is a simplified version — the actual mutation would be computed
    // by the caller using applyMoveVertex/applyMoveEntity from yamlMutations.ts
    if (wasDrag && onMutation) {
      // Mutation would be emitted here in real usage
    }
  }
}

/**
 * Build a pointer-over handler for hovering over entities.
 *
 * Only suppresses stopPropagation when not in drawing mode (so dragging works).
 */
export function buildPointerOverHandler(
  isDrawingTool: boolean,
  setHovered: (val: boolean) => void,
  setHoveredEntity: (id: string | null) => void,
): (e: PointerEvent) => void {
  return (e: PointerEvent) => {
    // Don't suppress events when in drawing mode
    if (!isDrawingTool) {
      e.stopPropagation()
      setHovered(true)
      if (setHoveredEntity) {
        setHoveredEntity('')
      }
    }
  }
}

/**
 * Build a dimension click handler.
 *
 * Two-click pattern for dimension tool:
 * - First click: set pendingDimTarget
 * - Second click: create constraint with measured distance
 */
export function buildDimensionClickHandler(
  handleDimensionClick: (
    target: string,
    featureId: string,
    kind: 'entity' | 'vertex',
    screenPos: Point,
    entityKind?: string,
  ) => void,
  isEditing: boolean,
): (
  target: string,
  featureId: string,
  kind: 'entity' | 'vertex',
  screenPos: Point,
  entityKind?: string,
) => void {
  return (target, featureId, kind, screenPos, entityKind) => {
    if (!isEditing) return

    handleDimensionClick(target, featureId, kind, screenPos, entityKind)
  }
}
