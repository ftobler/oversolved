import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import type { Point } from '@/types/cad'
import { shouldActivateDrag, computeDragMutation } from '@/components/Geometry3D/dragLogic'
import { getLastDragSolve } from '@/components/Geometry3D/dragSolveRegistry'
import type { SnapTarget } from '@/components/Geometry3D/snapDetection'

export interface DragToolContext extends ToolContext {
  drag: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point; currentWorld: Point; startClient: [number, number] } | null
  dragPending: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point } | null
  dragSnap: SnapTarget | null
  setDrag: (drag: DragToolContext['drag']) => void
  setDragPending: (pending: DragToolContext['dragPending']) => void
  setDragSnap: (snap: SnapTarget | null) => void
  startClient: [number, number] | null
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

      if (context.drag) {
        context.drag.currentWorld = worldPt
        context.setDrag({ ...context.drag })
      }
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
      const mutation = computeDragMutation(endClient, context.drag, context.dragSnap ?? null, null, getLastDragSolve())
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
    showInToolbar: true,

    activate: (context) => { context.pushMode('tool:drag') },

    deactivate: (context) => { context.popMode('tool:drag') },

    handlers,
  }
}