import type { Tool, ToolContext, ToolHandlers } from '../registry/toolRegistry'
import type { Point } from '../types/cad'
import { shouldActivateDrag, computeDragMutation } from '../components/Geometry3D/dragLogic'
import type { SnapTarget } from '../components/Geometry3D/snapDetection'

export interface DragToolContext extends ToolContext {
  drag: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point; currentWorld: Point; startClient: [number, number] } | null
  dragPending: { type: 'vertex' | 'edge'; vertexId: string; featureId: string; entityId: string; vertexKey: string; startWorld: Point } | null
  dragSnap: SnapTarget | null
  setDrag: (drag: DragToolContext['drag']) => void
  setDragPending: (pending: DragToolContext['dragPending']) => void
  setDragSnap: (snap: SnapTarget | null) => void
  startClient: [number, number] | null
  setOrbitEnabled: (enabled: boolean) => void
}

export interface DragTool extends Tool {
  readonly category: 'drag'
  readonly dragModes: ('vertex' | 'edge' | 'dim_label')[]
}

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

      if (!context.drag && context.startClient) {
        if (!shouldActivateDrag(context.startClient, [_e.clientX, _e.clientY])) return
        context.setDrag({
          type: pending.type,
          vertexId: pending.vertexId,
          featureId: pending.featureId,
          entityId: pending.entityId,
          vertexKey: pending.vertexKey,
          startWorld: pending.startWorld,
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

      if (!context.drag || !context.startClient) {
        context.setOrbitEnabled(true)
        return
      }

      const endClient: [number, number] = [_e.clientX, _e.clientY]
      const mutation = computeDragMutation(endClient, context.drag, context.dragSnap ?? null, null)
      if (mutation) {
        context.onMutation?.(mutation)
      }

      context.setDrag(null)
      context.setDragSnap(null)
      context.setOrbitEnabled(true)
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