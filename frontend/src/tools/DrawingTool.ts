import type { Tool, ToolContext, ToolHandlers, ToolId } from '@/registry/toolRegistry'
import type { Point, Entity, ActiveTool } from '@/types/cad'
import { ENTITY_BY_ACTIVE_TOOL } from '@/registry'
import type { SnapKind } from '@/registry'
import { computeDrawClick } from '@/components/Geometry3D/drawLogic'
import type { DrawSnapState } from '@/components/Geometry3D/drawLogic'
import { getToolPickConfig } from '@/registry/toolPickConfig'
import { randomId } from '@/utils/yamlMutations'
import { toolModeHandlers } from '@/tools/toolMode'
import { devOnly } from '@/stores/stateInvariants'

export interface DrawingToolContext extends ToolContext {
  drawPoints: Point[]
  drawSnapVertexId: string | null
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
  entityKind: ToolId
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

      // A gesture that emits several mutations (an end-snapped line adds the
      // entity and the constraint; a face project adds one per boundary edge)
      // must undo as a single step, so it goes through the batch seam. A
      // future context that forgets the seam would silently drop the whole
      // gesture (the optional call is a no-op), so warn in dev.
      if (result.mutations.length > 1) {
        if (!context.onMutationBatch) {
          if (devOnly) console.warn(`[DrawingTool] ${config.entityKind}: gesture emitted ${result.mutations.length} mutations but the context has no onMutationBatch - dropping the batch.`)
        }
        context.onMutationBatch?.(result.mutations)
      } else if (result.mutations.length === 1) {
        context.onMutation?.(result.mutations[0])
      }

      if (result.nextDrawSnap !== null) {
        context.setDrawSnap(result.nextDrawSnap.vertexId)
      }

      if (result.nextDrawPoints !== null) {
        context.setDrawPoints(result.nextDrawPoints)
      }

      if (result.gestureComplete) {
        context.clearDraw()
        // The tool's arming policy owns the disarm decision, not this adapter:
        // a sticky tool (e.g. line) stays armed so the next click starts a fresh
        // entity of the same kind; only one-shot tools reset to select.
        if (!getToolPickConfig(config.entityKind).staysArmedAfterCommit) {
          context.setActiveTool(null)
        }
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