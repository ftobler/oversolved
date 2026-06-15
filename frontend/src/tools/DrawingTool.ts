import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import type { Point, Entity } from '@/types/cad'
import { ENTITY_BY_ACTIVE_TOOL } from '@/registry'
import type { SnapKind } from '@/registry'
import { computeDrawClick } from '@/components/Geometry3D/drawLogic'
import type { DrawSnapState } from '@/components/Geometry3D/drawLogic'
import { randomId } from '@/utils/yamlMutations'

export interface DrawingToolContext extends ToolContext {
  drawPoints: Point[]
  drawSnapVertexId: string | null
  setDrawHover: (pt: Point | null) => void
  clearDraw: () => void
  setActiveTool: (tool: string | null) => void
  hoveredVertexId: string | null
  hoveredVertexPosition: Point | null
  hoveredSnapKind: SnapKind | null
  hoveredSourceKind?: string | null
  hoveredFaceEdges?: { source: string; kind: string }[] | null
  alignmentSnapPoint: Point | null
  alignmentSnapKind: string | null
  alignmentSnapVertexId: string | null
  setDrawSnap: (vertexId: string | null) => void
  sketch?: Record<string, Entity>
  otherSketches?: Record<string, Record<string, Entity>>
  ngonSides?: number
}

export interface DrawingTool extends Tool {
  readonly category: 'drawing'
  readonly entityKind: string
  readonly paramCount: number
}

export interface DrawingToolConfig {
  entityKind: string
  paramCount: number
}

export function createDrawingTool(config: DrawingToolConfig): DrawingTool {
  const entityDef = ENTITY_BY_ACTIVE_TOOL.get(config.entityKind)
  const paramCount = entityDef?.paramCount ?? config.paramCount

  const handlers: ToolHandlers<DrawingToolContext> = {
    onPointerDown: (_e, worldPt, context) => {
      const snap: DrawSnapState = {
        hoveredVertexId: context.hoveredVertexId,
        hoveredVertexPosition: context.hoveredVertexPosition,
        hoveredSnapKind: context.hoveredSnapKind,
        hoveredSelectionId: context.hoveredSelectionId,
        hoveredSourceKind: context.hoveredSourceKind,
        hoveredFaceEdges: context.hoveredFaceEdges,
        drawSnapVertexId: context.drawSnapVertexId,
        alignmentSnapPoint: context.alignmentSnapPoint,
        alignmentSnapKind: context.alignmentSnapKind,
        alignmentSnapVertexId: context.alignmentSnapVertexId,
        ngonSides: context.ngonSides,
      }

      const result = computeDrawClick(
        config.entityKind,
        context.drawPoints,
        [worldPt[0], worldPt[1]],
        snap,
        context.activeFeatureId ?? 'S1',
        () => randomId(12),
        context.sketch as Record<string, Entity> | undefined,
        context.otherSketches as Record<string, Record<string, Entity>> | undefined,
      )

      if (config.entityKind === 'project') {
        // [PROJECT-DEBUG] temporary instrumentation for edge-pick bug
        console.log('[PROJECT-DEBUG] DrawingTool emit', {
          mutationCount: result.mutations.length,
          mutations: result.mutations,
          hasOnMutation: !!context.onMutation,
          clearTool: result.clearTool,
        })
      }
      for (const m of result.mutations) {
        context.onMutation?.(m)
      }

      if (result.nextDrawSnap !== null) {
        context.setDrawSnap(result.nextDrawSnap.vertexId)
      }

      if (result.clearTool) {
        context.clearDraw()
        context.setActiveTool(null)
      } else if (result.nextDrawPoints !== null) {
        context.drawPoints.length = 0
        context.drawPoints.push(...result.nextDrawPoints)
      }

      return null
    },

    onPointerMove: (_e, worldPt, _drag, context) => {
      context.setDrawHover(worldPt)
    },

    onPointerUp: () => {
    },
  }

  return {
    id: config.entityKind as Tool['id'],
    label: config.entityKind,
    category: 'drawing' as const,
    entityKind: config.entityKind,
    paramCount,
    showInToolbar: entityDef?.showInToolbar ?? true,

    activate: (context) => { context.pushMode('tool:' + config.entityKind) },

    deactivate: (context) => { context.popMode('tool:' + config.entityKind) },

    handlers,
  }
}