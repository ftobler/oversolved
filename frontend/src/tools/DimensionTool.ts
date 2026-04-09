import type { Tool, ToolContext, ToolHandlers } from '../registry/toolRegistry'
import { resolveSingleEntityDimension, resolveTwoTargetDimension } from '../registry'

export interface DimensionToolContext extends ToolContext {
  pendingDimTarget: string | null
  pendingDimEntityKind: string | null
  setPendingDim: (target: string | null, entityKind: string | null) => void
  openDialog: (opts: { position: [number, number]; label: string; onConfirm: (val: string) => void }) => void
}

export interface DimensionTool extends Tool {
  readonly category: 'dimension'
}

export function createDimensionTool(): DimensionTool {
  const handlers: ToolHandlers<DimensionToolContext> = {
    onPointerDown: () => null,

    onPointerMove: () => {},

    onPointerUp: () => {},

    onClick: (e, _worldPt, context) => {
      const target = context.hoveredEntityId ?? context.hoveredVertexId
      if (!target || !context.activeFeatureId) return

      const isVertex = target.startsWith('vertex:')
      const entityKind = isVertex ? undefined : target.split(':')[2]

      if (!context.pendingDimTarget) {
        if (!isVertex && entityKind) {
          const dimKind = resolveSingleEntityDimension(entityKind!)
          if (dimKind) {
            const featureId = context.activeFeatureId
            context.openDialog({
              position: [e.clientX, e.clientY],
              label: 'Dimension value',
              onConfirm: (input) => {
                const val = parseFloat(input)
                if (isNaN(val) || val <= 0) return
                context.onMutation?.({
                  type: 'add_constraint',
                  featureId,
                  kind: dimKind,
                  targets: [target],
                  value: val,
                })
                context.setPendingDim(null, null)
              },
            })
            return
          }
        }
        context.setPendingDim(target, entityKind ?? null)
        return
      }

      const firstIsVertex = context.pendingDimTarget.startsWith('vertex:')
      const secondIsVertex = isVertex
      const firstEntityKind = firstIsVertex ? undefined : context.pendingDimTarget.split(':')[2]
      const constraintKind = resolveTwoTargetDimension(firstIsVertex, secondIsVertex, firstEntityKind, entityKind)
      const firstTarget = context.pendingDimTarget
      const featureId = context.activeFeatureId

      context.openDialog({
        position: [e.clientX, e.clientY],
        label: 'Dimension value',
        onConfirm: (input) => {
          const val = parseFloat(input)
          if (isNaN(val) || val <= 0) return
          context.onMutation?.({
            type: 'add_constraint',
            featureId,
            kind: constraintKind,
            targets: [firstTarget, target],
            value: val,
          })
          context.setPendingDim(null, null)
        },
      })
    },
  }

  return {
    id: 'dimension',
    label: 'Dimension',
    category: 'dimension' as const,
    showInToolbar: true,

    activate: () => {},

    deactivate: () => {},

    handlers,
  }
}