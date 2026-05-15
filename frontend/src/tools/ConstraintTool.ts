import type { Tool, ToolContext, ToolHandlers, ToolId } from '@/registry/toolRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry'

export type ConstraintToolContext = ToolContext

export interface ConstraintTool extends Tool {
  readonly category: 'constraint'
  readonly constraintKind: string
  readonly requiresSelection: number
}

export interface ConstraintToolConfig {
  constraintKind: string
  requiresSelection: number
}

export function createConstraintTool(config: ConstraintToolConfig): ConstraintTool {
  const constraintDef = CONSTRAINT_BY_KIND.get(config.constraintKind)

  const handlers: ToolHandlers<ConstraintToolContext> = {
    onPointerDown: () => {
      return null
    },

    onPointerUp: (_e, _worldPt, _drag, context) => {
      const selectionArray = Array.from(context.normalSelection)
      if (selectionArray.length < config.requiresSelection) {
        return
      }

      if (config.constraintKind === 'midpoint') {
        const entityTargets = selectionArray.filter(t => t.startsWith('entity:'))
        const vertexTargets = selectionArray.filter(t => t.startsWith('vertex:'))
        const validLinePoint = entityTargets.length === 1 && vertexTargets.length === 1
        const validThreeVertex = vertexTargets.length === 3 && entityTargets.length === 0
        if (!validLinePoint && !validThreeVertex) return
      }

      context.onMutation?.({
        type: 'add_constraint',
        featureId: context.activeFeatureId ?? 'S1',
        kind: config.constraintKind,
        targets: selectionArray,
      })
    },
  }

  return {
    id: config.constraintKind as ToolId,
    label: config.constraintKind,
    category: 'constraint' as const,
    constraintKind: config.constraintKind,
    requiresSelection: config.requiresSelection,
    showInToolbar: constraintDef?.showInToolbar ?? false,

    activate: () => {
    },

    deactivate: () => {
    },

    handlers,
  }
}