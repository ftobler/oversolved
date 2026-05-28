import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import type { ActiveTool } from '@/types/cad'
import { resolveDimension } from '@/registry'
import type { DimensionPick } from '@/registry'

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

function openConfirmDialog(
  context: DimensionToolContext,
  featureId: string,
  constraintKind: string,
  targets: string[],
  screenPos: [number, number],
): void {
  context.openDialog({
    position: screenPos,
    label: 'Dimension value',
    onConfirm: (input) => {
      const val = parseFloat(input)
      if (isNaN(val) || val <= 0) return
      context.onMutation?.({ type: 'add_constraint', featureId, kind: constraintKind, targets, value: val })
      context.setActiveTool(null)
      context.setPendingDim(null, null)
    },
  })
}

export function createDimensionTool(): DimensionTool {
  const handlers: ToolHandlers<DimensionToolContext> = {
    onPointerDown: () => null,

    onPointerMove: () => {},

    onPointerUp: () => {},

    onClick: (e, _worldPt, context) => {
      const target = context.hoveredSelectionId ?? context.hoveredVertexId
      if (!target || !context.activeFeatureId) return

      const featureId = context.activeFeatureId
      const screenPos: [number, number] = [e.clientX, e.clientY]
      const isVertex = isPoint(target)
      // Vertices carry no entity kind -- their constraint type is inferred from
      // the pair of targets, not from the geometry they belong to.
      const entityKind = isVertex ? null : context.hoveredEntityKind
      const newPick: DimensionPick = { isVertex, target, entityKind }

      if (!context.pendingDimTarget) {
        // First click. Closed entities (circle, arc) resolve immediately; lines
        // and vertices need a second click and are buffered into pendingDim.
        const resolved = resolveDimension([newPick])
        if (resolved) {
          openConfirmDialog(context, featureId, resolved.constraintKind, [target], screenPos)
          return
        }
        context.setPendingDim(target, entityKind)
        return
      }

      // Second click. Clearing pendingDim first prevents a stale highlight if
      // the dialog is dismissed.
      const firstPick: DimensionPick = {
        isVertex: isPoint(context.pendingDimTarget),
        target: context.pendingDimTarget,
        entityKind: context.pendingDimEntityKind,
      }
      context.setPendingDim(null, null)

      const resolved = resolveDimension([firstPick, newPick])
      if (!resolved) return
      const targets = firstPick.target === newPick.target
        ? [firstPick.target]
        : [firstPick.target, newPick.target]
      openConfirmDialog(context, featureId, resolved.constraintKind, targets, screenPos)
    },
  }

  return {
    id: 'dimension',
    label: 'Dimension',
    category: 'dimension' as const,
    showInToolbar: true,

    activate: (context) => { context.pushMode('tool:dimension') },

    deactivate: (context) => { context.popMode('tool:dimension') },

    handlers,
  }
}
