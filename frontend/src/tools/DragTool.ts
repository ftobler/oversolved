import type { Tool, ToolContext, ToolHandlers } from '../registry/toolRegistry'
import type { Point } from '../types/cad'

export interface DragToolContext extends ToolContext {
  drag: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point; currentWorld: Point; startClient: [number, number] } | null
  dragPending: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point } | null
  dragSnap: { entityId: string; position: Point } | null
  setDrag: (drag: DragToolContext['drag']) => void
  setDragPending: (pending: DragToolContext['dragPending']) => void
}

export interface DragTool extends Tool {
  readonly category: 'drag'
  readonly dragModes: ('vertex' | 'edge' | 'dim_label')[]
}

const CLICK_VS_DRAG_THRESHOLD = 4

export function createDragTool(): DragTool {
  const handlers: ToolHandlers<DragToolContext> = {
    onPointerDown: (_e, worldPt, context) => {
      const vertexId = context.hoveredVertexId
      if (!vertexId || !context.activeFeatureId) return null

      const parts = vertexId.split(':')
      const featureId = parts[1]
      const entityId = parts[2]
      const vertexKey = parts[3] ?? ''

      const pending: DragToolContext['dragPending'] = {
        type: 'vertex',
        vertexId,
        featureId,
        entityId,
        vertexKey,
        startWorld: worldPt,
      }
      context.setDragPending(pending)
      return null
    },

    onPointerMove: (_e, worldPt, _drag, context) => {
      const pending = context.dragPending
      if (!pending) return

      const dx = worldPt[0] - pending.startWorld[0]
      const dy = worldPt[1] - pending.startWorld[1]

      if (!context.drag && Math.hypot(dx, dy) > CLICK_VS_DRAG_THRESHOLD / 100) {
        context.setDrag({
          type: pending.type,
          vertexId: pending.vertexId,
          featureId: pending.featureId,
          entityId: pending.entityId,
          vertexKey: pending.vertexKey,
          startWorld: pending.startWorld,
          currentWorld: worldPt,
          startClient: [0, 0],
        })
      }

      if (context.drag) {
        context.drag.currentWorld = worldPt
        context.setDrag({ ...context.drag })
      }
    },

    onPointerUp: (_e, worldPt, _drag, context) => {
      const pending = context.dragPending
      if (!pending) return

      context.setDragPending(null)

      const dx = worldPt[0] - pending.startWorld[0]
      const dy = worldPt[1] - pending.startWorld[1]

      if (Math.hypot(dx, dy) <= CLICK_VS_DRAG_THRESHOLD / 100) {
        context.setDrag(null)
        return
      }

      if (context.dragSnap) {
        context.onMutation?.({
          type: 'move_vertex_with_constraint',
          featureId: pending.featureId,
          entityId: pending.entityId,
          vertexKey: pending.vertexKey,
          to: worldPt,
          constraintKind: 'coincident',
          snapVertexId: context.dragSnap.entityId,
        })
      } else {
        context.onMutation?.({
          type: 'move_vertex',
          featureId: pending.featureId,
          entityId: pending.entityId,
          vertexKey: pending.vertexKey,
          to: worldPt,
        })
      }

      context.setDrag(null)
    },
  }

  return {
    id: 'drag',
    label: 'Drag',
    category: 'drag' as const,
    dragModes: ['vertex', 'edge', 'dim_label'],
    showInToolbar: true,

    activate: () => {
    },

    deactivate: () => {
    },

    handlers,
  }
}