import { useEffect } from 'react'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import type { PartEditorData } from '@/stores/partEditorStore'

export function useSyncPartEditorStore(data: PartEditorData): void {
  const {
    features, doc, rollbackPosition, editingFeatureId, activeSketchFeatureId,
    visibleFeatures, visibleBodies, partLabels, solveResults, bodies, pickBodies,
    isRebuilding, featureTimings, validation, ghostMode, otherSketches,
    partColors, partStyle, undoStack, redoStack,
  } = data

  useEffect(() => {
    usePartEditorStore.getState().setSnapshot(data)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, doc, rollbackPosition, editingFeatureId, activeSketchFeatureId,
    visibleFeatures, visibleBodies, partLabels, solveResults, bodies, pickBodies,
    isRebuilding, featureTimings, validation, ghostMode, otherSketches,
    partColors, partStyle, undoStack, redoStack])

  useEffect(() => {
    return () => {
      usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
    }
  }, [])
}
