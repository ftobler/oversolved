import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import type { Point } from '@/types/cad'
import type { DragState, DragPendingState } from '@/stores/sketchEditorStore'
import { shouldActivateDrag, computeDragMutation } from '@/utils/geometry/dragLogic'
import { getLastDragSolve } from '@/utils/geometry/dragSolveRegistry'
import type { SnapTarget } from '@/utils/geometry/snapDetection'
import { toolModeHandlers } from '@/tools/toolMode'

export interface DragToolContext extends ToolContext {
  drag: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point; currentWorld: Point; startClient: [number, number] } | null
  dragPending: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point } | null
  dragSnap: SnapTarget | null
  setDrag: (drag: DragToolContext['drag']) => void
  setDragPending: (pending: DragToolContext['dragPending']) => void
  setDragSnap: (snap: SnapTarget | null) => void
  startClient: [number, number] | null
}

/**
 * The store fields a drag context is assembled from. The sketch editor's state
 * is structurally assignable, so this module needs no store import.
 */
export interface DragContextSource {
  normalSelection: Set<string>
  hoveredSelectionId: string | null
  isPointerDown: boolean
  activeFeatureId: string | null
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: string | null
  drag: DragState | null
  dragPending: DragPendingState | null
  dragSnap: SnapTarget | null
  dragStartClient: [number, number] | null
}

export interface DragContextHandlers {
  onMutation: ToolContext['onMutation']
  setDrag: DragToolContext['setDrag']
  setDragPending: DragToolContext['setDragPending']
  setDragSnap: DragToolContext['setDragSnap']
}

/**
 * The fields a caller overrides. The activation and commit frames override the
 * hover with their own grab facts; the pointer-down id dispatch overrides the
 * store reads it has just written, which the snapshot it passes predates.
 */
export interface DragContextOverrides {
  hoveredSelectionId?: string | null
  isPointerDown?: boolean
  hoveredVertexId?: string | null
  hoveredVertexPosition?: [number, number] | null
  drag?: DragToolContext['drag']
  dragPending?: DragToolContext['dragPending']
  startClient?: [number, number] | null
}

/** DragTool only ever sees a sketch vertex/edge drag: a dimension label or a
 *  feature handle is another owner's gesture. Narrowing here rather than at each
 *  call site keeps the tool's context type honest. */
function asToolDrag(drag: DragState | null): DragToolContext['drag'] {
  return drag && (drag.type === 'vertex' || drag.type === 'edge') ? drag : null
}

function asToolPending(pending: DragPendingState | null): DragToolContext['dragPending'] {
  return pending && (pending.type === 'vertex' || pending.type === 'edge') ? pending : null
}

/**
 * Build the context handed to DragTool's handlers. Every producer goes through
 * this one builder -- the activation frame, the commit frame and the id-buffer
 * pointer-down dispatch: they used to spell the same literal out separately and
 * could drift on any field ToolContext grows.
 */
export function buildDragToolContext(
  source: DragContextSource,
  handlers: DragContextHandlers,
  overrides: DragContextOverrides = {},
): DragToolContext {
  return {
    normalSelection: source.normalSelection,
    hoveredSelectionId: overrides.hoveredSelectionId !== undefined
      ? overrides.hoveredSelectionId
      : source.hoveredSelectionId,
    isPointerDown: overrides.isPointerDown !== undefined ? overrides.isPointerDown : source.isPointerDown,
    activeFeatureId: source.activeFeatureId,
    hoveredVertexId: overrides.hoveredVertexId !== undefined ? overrides.hoveredVertexId : source.hoveredVertexId,
    hoveredVertexPosition: overrides.hoveredVertexPosition !== undefined
      ? overrides.hoveredVertexPosition
      : source.hoveredVertexPosition,
    hoveredSnapKind: source.hoveredSnapKind,
    onMutation: handlers.onMutation,
    drag: overrides.drag !== undefined ? overrides.drag : asToolDrag(source.drag),
    dragPending: overrides.dragPending !== undefined ? overrides.dragPending : asToolPending(source.dragPending),
    dragSnap: source.dragSnap,
    setDrag: handlers.setDrag,
    setDragPending: handlers.setDragPending,
    setDragSnap: handlers.setDragSnap,
    startClient: overrides.startClient !== undefined ? overrides.startClient : source.dragStartClient,
    // Store-owned mode stack: the drag context never pushes or pops.
    pushMode: () => {},
    popMode: () => {},
  }
}

export interface DragTool extends Tool {
  readonly category: 'drag'
  readonly dragModes: ('vertex' | 'edge' | 'dim_label')[]
}

export function createDragTool(): DragTool {
  const handlers: ToolHandlers<DragToolContext> = {
    onPointerDown: (_e, worldPt, context) => {
      const hoveredId = context.hoveredVertexId
      if (!hoveredId || !context.activeFeatureId) return null

      if (hoveredId.startsWith('vertex:')) {
        const parts = hoveredId.split(':')
        const pending: DragToolContext['dragPending'] = {
          type: 'vertex',
          vertexId: hoveredId,
          featureId: parts[1],
          entityId: parts.slice(2, -1).join(':'),
          vertexKey: parts[parts.length - 1],
          startWorld: worldPt,
        }
        context.setDragPending(pending)
      } else if (hoveredId.startsWith('entity:')) {
        const parts = hoveredId.split(':')
        const pending: DragToolContext['dragPending'] = {
          type: 'edge',
          vertexId: hoveredId,
          featureId: parts[1],
          entityId: parts.slice(2).join(':'),
          vertexKey: '',
          startWorld: [0, 0],
        }
        context.setDragPending(pending)
      }
      return null
    },

    onPointerMove: (_e, worldPt, _drag, context) => {
      const pending = context.dragPending
      if (!pending) return

      if (!context.drag && context.startClient) {
        if (!shouldActivateDrag(context.startClient, [_e.clientX, _e.clientY])) return

        // For edge drags: resolve startWorld at activation time. The cursor was
        // over the entity when pointerdown fired, so worldPt (the cursor position
        // at activation) is a reasonable reference point for computing deltas.
        const resolvedStartWorld = pending.type === 'edge' ? worldPt : pending.startWorld

        context.setDrag({
          type: pending.type,
          vertexId: pending.vertexId,
          featureId: pending.featureId,
          entityId: pending.entityId,
          vertexKey: pending.vertexKey,
          startWorld: resolvedStartWorld,
          currentWorld: worldPt,
          startClient: context.startClient,
        })
      }
      // No live-drag update here: the caller passes drag: null while activating,
      // and once a drag is live the view owns per-move updates itself. A branch
      // updating context.drag would be unreachable in production.
    },

    onPointerUp: (_e, _worldPt, _drag, context) => {
      const pending = context.dragPending
      if (!pending) return

      context.setDragPending(null)

      if (!context.drag || !context.startClient) return

      const endClient: [number, number] = [_e.clientX, _e.clientY]
      // The last WASM drag-frame solve rides along so the commit hard solve
      // seeds from the on-screen state (no basin jump on release). Read here,
      // synchronously in the pointer-up handler -- the rAF loop's cleanup
      // clears the registry only after the store update re-renders.
      const mutation = computeDragMutation(endClient, context.drag, context.dragSnap ?? null, getLastDragSolve())
      if (mutation) {
        context.onMutation?.(mutation)
      }

      context.setDrag(null)
      context.setDragSnap(null)
    },
  }

  return {
    id: 'drag',
    label: 'Drag',
    category: 'drag' as const,
    dragModes: ['vertex', 'edge', 'dim_label'],

    ...toolModeHandlers('drag'),

    handlers,
  }
}
