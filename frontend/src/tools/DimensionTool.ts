import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import type { DimensionPick } from '@/registry'
import { toolModeHandlers } from '@/tools/toolMode'

export interface DimensionToolContext extends ToolContext {
  hoveredEntityKind: string | null
  dimensionPicks: readonly DimensionPick[]
  addDimensionPick: (pick: DimensionPick) => void
}

export interface DimensionTool extends Tool {
  readonly category: 'dimension'
}

const isPoint = (t: string) => t.startsWith('vertex:') || t.startsWith('@builtin_')

/**
 * Dimension tool, sticky placement.
 *
 * Each entity / vertex click is appended to `dimensionPicks` in the store. The
 * resolver derives the current kind on the fly. An empty-space click is NOT
 * handled here: the id-buffer dispatcher routes empty clicks to
 * `finalizeDimensionPlacement` on the store directly, because empty clicks
 * never produce a hit and so never reach this onClick handler. That keeps the
 * tool focused on what to do with picks; the store owns the dialog + dispatch.
 */
export function createDimensionTool(): DimensionTool {
  const handlers: ToolHandlers<DimensionToolContext> = {
    onPointerDown: () => null,
    onPointerMove: () => {},
    onPointerUp: () => {},

    onClick: (_e, _worldPt, context) => {
      const target = context.hoveredSelectionId ?? context.hoveredVertexId
      if (!target || !context.activeFeatureId) return
      const isVertex = isPoint(target)
      // Vertices carry no entity kind -- their constraint type is inferred from
      // the pair of targets, not from the geometry they belong to.
      const entityKind = isVertex ? null : context.hoveredEntityKind
      context.addDimensionPick({ isVertex, target, entityKind })
    },
  }

  return {
    id: 'dimension',
    label: 'Dimension',
    category: 'dimension' as const,

    ...toolModeHandlers('dimension'),

    handlers,
  }
}
