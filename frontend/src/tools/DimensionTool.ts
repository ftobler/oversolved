import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import type { ActiveTool } from '@/types/cad'
import { resolveSingleEntityDimension, resolveTwoTargetDimension } from '@/registry'

export interface DimensionToolContext extends ToolContext {
  pendingDimTarget: string | null
  pendingDimEntityKind: string | null
  hoveredEntityKind: string | null
  setPendingDim: (target: string | null, entityKind: string | null) => void
  setActiveTool: (tool: ActiveTool) => void
  openDialog: (opts: { position: [number, number]; label: string; onConfirm: (val: string) => void }) => void
}

export interface DimensionTool extends Tool {
  readonly category: 'dimension'
}

const isPoint = (t: string) => t.startsWith('vertex:') || t.startsWith('@builtin_')

export function createDimensionTool(): DimensionTool {
  const handlers: ToolHandlers<DimensionToolContext> = {
    onPointerDown: () => null,

    onPointerMove: () => {},

    onPointerUp: () => {},

    onClick: (e, _worldPt, context) => {
      const target = context.internalHoverSelection ?? context.hoveredVertexId
      if (!target || !context.activeFeatureId) return

      const featureId = context.activeFeatureId
      const screenPos: [number, number] = [e.clientX, e.clientY]
      const isVertex = isPoint(target)
      // Vertices carry no entity kind -- their constraint type is inferred from the
      // pair of targets, not from the geometry they belong to.
      const entityKind = isVertex ? null : context.hoveredEntityKind

      if (!context.pendingDimTarget) {
        // First click. Closed entities (circle, arc) resolve immediately to a
        // single-entity dimension dialog; lines and vertices require a second click.
        if (!isVertex && entityKind && entityKind !== 'line') {
          const dimKind = resolveSingleEntityDimension(entityKind)
          if (dimKind) {
            context.openDialog({
              position: screenPos,
              label: 'Dimension value',
              onConfirm: (input) => {
                const val = parseFloat(input)
                if (isNaN(val) || val <= 0) return
                context.onMutation?.({ type: 'add_constraint', featureId, kind: dimKind, targets: [target], value: val })
                context.setActiveTool(null)
                context.setPendingDim(null, null)
              },
            })
            return
          }
        }
        context.setPendingDim(target, entityKind)
      } else {
        // Second click. Resolve constraint kind from the ordered target pair.
        // Clearing pendingDimTarget first prevents a stale highlight if the dialog is dismissed.
        const first = context.pendingDimTarget
        const firstEntityKind = context.pendingDimEntityKind
        context.setPendingDim(null, null)

        if (first === target && firstEntityKind) {
          // Same entity clicked twice: create single-entity dimension (e.g. line length)
          const singleKind = resolveSingleEntityDimension(firstEntityKind)
          if (!singleKind) return
          context.openDialog({
            position: screenPos,
            label: 'Dimension value',
            onConfirm: (input) => {
              const val = parseFloat(input)
              if (isNaN(val) || val <= 0) return
              context.onMutation?.({ type: 'add_constraint', featureId, kind: singleKind, targets: [target], value: val })
              context.setActiveTool(null)
            },
          })
          return
        }

        const dimKind = resolveTwoTargetDimension(
          isPoint(first),
          isPoint(target),
          firstEntityKind ?? undefined,
          entityKind ?? undefined,
        )
        context.openDialog({
          position: screenPos,
          label: 'Dimension value',
          onConfirm: (input) => {
            const val = parseFloat(input)
            if (isNaN(val) || val <= 0) return
            context.onMutation?.({ type: 'add_constraint', featureId, kind: dimKind, targets: [first, target], value: val })
            context.setActiveTool(null)
          },
        })
      }
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
