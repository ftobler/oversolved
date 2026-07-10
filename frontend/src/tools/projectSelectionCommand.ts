// Glue between the pure projection lowering and the live registries: resolves
// entity/edge/face kinds from the sketch callback and the body dispatch tables.
import { getSketchCallback, useSketchEditorStore } from '@/stores/sketchEditorStore'
import { getEntityKind } from '@/types/cad'
import { findEdgeKindForQuery, findFaceBoundaryEdges } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import { projectionMutationsForSelection, type ProjectionResolvers } from '@/tools/projectionMutations'

export const liveProjectionResolvers: ProjectionResolvers = {
  entityKind: (featureId, entityId) => {
    const entity = getSketchCallback('getSketch')?.(featureId)?.[entityId]
    return entity ? getEntityKind(entity) : null
  },
  edgeKind: (query) => findEdgeKindForQuery(query) ?? null,
  faceEdges: (query) => findFaceBoundaryEdges(query),
}

/**
 * Project everything in the current normal selection onto the active sketch and
 * consume the selection. Returns false when there is nothing to project (empty
 * or wholly unprojectable selection, or no sketch open), so the caller can fall
 * back to entering the interactive project tool.
 */
export function projectSelection(resolvers: ProjectionResolvers = liveProjectionResolvers): boolean {
  const { normalSelection, activeFeatureId } = useSketchEditorStore.getState()
  const onMutation = getSketchCallback('onMutation')
  if (!onMutation || !activeFeatureId || normalSelection.size === 0) return false

  const mutations = projectionMutationsForSelection(normalSelection, activeFeatureId, resolvers)
  if (mutations.length === 0) return false

  for (const m of mutations) onMutation(m)
  // The selection was the tool's input; consuming it is what lets the action
  // complete on the click that started it, with no follow-up pick.
  useSketchEditorStore.getState().clearNormalSelection()
  return true
}
