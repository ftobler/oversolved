import type { Tool, ToolContext, ToolHandlers, ToolId } from '@/registry/toolRegistry'
import type { Point, Entity, ActiveTool } from '@/types/cad'
import { ENTITY_BY_ACTIVE_TOOL } from '@/registry'
import type { SnapKind } from '@/registry'
import { computeDrawClick } from '@/utils/geometry/drawLogic'
import type { DrawSnapState } from '@/utils/geometry/drawLogic'
import { getToolPickConfig } from '@/registry/toolPickConfig'
import { commitDrawGesture } from '@/tools/commitDrawGesture'
import { randomId } from '@/utils/yamlMutations'
import { toolModeHandlers } from '@/tools/toolMode'
import { failLoud } from '@/stores/stateInvariants'

export interface DrawingToolContext extends ToolContext {
  drawPoints: Point[]
  drawSnapRefs: (string | null)[]
  setDrawHover: (pt: Point | null) => void
  // Replaces the intermediate-click buffer through zustand so the preview is
  // reactive on the committing click (mutating the handed-in array in place
  // bypassed change detection and deferred the re-render to the next move).
  setDrawPoints: (pts: Point[]) => void
  clearDraw: () => void
  setActiveTool: (tool: ActiveTool) => void
  hoveredVertexId: string | null
  hoveredVertexPosition: Point | null
  hoveredSnapKind: SnapKind | null
  hoveredSourceKind?: string | null
  hoveredFaceEdges?: { source: string; kind: string }[] | null
  alignmentSnapPoint: Point | null
  alignmentSnapKind: 'kinda_horizontal' | 'kinda_vertical' | null
  setDrawSnap: (refs: (string | null)[]) => void
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
  entityKind: ToolId
  paramCount: number
}

export function createDrawingTool(config: DrawingToolConfig): DrawingTool {
  const entityDef = ENTITY_BY_ACTIVE_TOOL.get(config.entityKind)
  const paramCount = entityDef?.paramCount ?? config.paramCount

  const handlers: ToolHandlers<DrawingToolContext> = {
    onPointerDown: (_e, worldPt, context) => {
      // Drawing requires an active sketch. A literal fallback here would mint
      // geometry under a phantom feature id, so refuse loudly instead; prod
      // still returns the no-op rather than corrupting the doc.
      if (!context.activeFeatureId) {
        failLoud(`[DrawingTool] ${config.entityKind}: no active feature to draw into`)
        return null
      }
      const snap: DrawSnapState = {
        hoveredVertexId: context.hoveredVertexId,
        hoveredVertexPosition: context.hoveredVertexPosition,
        hoveredSnapKind: context.hoveredSnapKind,
        hoveredSelectionId: context.hoveredSelectionId,
        hoveredSourceKind: context.hoveredSourceKind,
        hoveredFaceEdges: context.hoveredFaceEdges,
        drawSnapRefs: context.drawSnapRefs,
        alignmentSnapPoint: context.alignmentSnapPoint,
        alignmentSnapKind: context.alignmentSnapKind,
        ngonSides: context.ngonSides,
      }

      const result = computeDrawClick(
        config.entityKind,
        context.drawPoints,
        [worldPt[0], worldPt[1]],
        snap,
        context.activeFeatureId,
        () => randomId(12),
        context.sketch as Record<string, Entity> | undefined,
        context.otherSketches as Record<string, Record<string, Entity>> | undefined,
      )

      // One commit path for both a click-built and a stamped gesture: the
      // batch seam, the buffer reset and the arming policy live in the helper.
      commitDrawGesture(result, {
        onMutation: context.onMutation,
        onMutationBatch: context.onMutationBatch,
        clearDraw: context.clearDraw,
        disarm: () => context.setActiveTool(null),
        staysArmedAfterCommit: getToolPickConfig(config.entityKind).staysArmedAfterCommit,
      }, `[DrawingTool] ${config.entityKind}`)

      if (result.nextDrawSnap !== null) {
        context.setDrawSnap(result.nextDrawSnap.refs)
      }

      if (result.nextDrawPoints !== null) {
        context.setDrawPoints(result.nextDrawPoints)
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
    id: config.entityKind,
    label: config.entityKind,
    category: 'drawing' as const,
    entityKind: config.entityKind,
    paramCount,

    ...toolModeHandlers(config.entityKind),

    handlers,
  }
}
