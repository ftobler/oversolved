import type { Tool, ToolContext, ToolHandlers } from '../registry/toolRegistry'
import type { Point } from '../types/cad'
import { ENTITY_BY_ACTIVE_TOOL } from '../registry'

export interface DrawingToolContext extends ToolContext {
  addDrawPoint: (pt: Point) => void
  setDrawHover: (pt: Point | null) => void
  drawPoints: Point[]
  drawSnapVertexId: string | null
  drawSnapEntityRef: string | null
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
      const snapVertexId = context.drawSnapVertexId
      const snapPosition = snapVertexId ? context.hoveredVertexPosition : null

      context.addDrawPoint(snapPosition ?? worldPt)

      if (context.drawPoints.length + 1 >= paramCount / 2) {
        context.onMutation?.({
          type: 'add_entity',
          featureId: context.activeFeatureId ?? 'S1',
          kind: config.entityKind,
          params: buildParams(context.drawPoints, snapVertexId),
        })

        context.addDrawPoint(worldPt)
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

    activate: () => {
    },

    deactivate: () => {
    },

    handlers,
  }
}

function buildParams(points: Point[], snapVertexId: string | null): number[] {
  const params: number[] = []
  for (const pt of points) {
    params.push(pt[0], pt[1])
  }
  if (snapVertexId && points.length > 0) {
    const lastIdx = points.length - 1
    params[lastIdx * 2] = points[lastIdx][0]
    params[lastIdx * 2 + 1] = points[lastIdx][1]
  }
  return params
}