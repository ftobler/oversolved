import { useEffect } from 'react'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import type { PartEditorData } from '@/stores/partEditorStore'

// Mirrored slice: everything except the fields the store itself owns.
// rollbackPosition, pickBoundary, and editingFeatureId are mutated via
// their dedicated setters; setSnapshot preserves them.
type MirroredPartEditorData = Omit<
  PartEditorData,
  'rollbackPosition' | 'pickBoundary' | 'editingFeatureId'
>

export function useSyncPartEditorStore(data: MirroredPartEditorData): void {
  const {
    features, doc, activeSketchFeatureId,
    visibleFeatures, visibleBodies, partLabels, solveResults, bodies, pickBodies,
    isRebuilding, featureTimings, validation, ghostMode, otherSketches,
    partColors, partStyle, undoStack, redoStack,
  } = data

  useEffect(() => {
    // setSnapshot expects the full PartEditorData shape, but preserves the
    // store-owned fields itself, so the values we pass for those are ignored.
    usePartEditorStore.getState().setSnapshot({
      ...data,
      rollbackPosition: null,
      pickBoundary: null,
      editingFeatureId: null,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, doc, activeSketchFeatureId,
    visibleFeatures, visibleBodies, partLabels, solveResults, bodies, pickBodies,
    isRebuilding, featureTimings, validation, ghostMode, otherSketches,
    partColors, partStyle, undoStack, redoStack])

  useEffect(() => {
    return () => {
      usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
      // Reset owned fields on unmount too — setSnapshot preserves them, so
      // call their setters explicitly.
      usePartEditorStore.getState().setRollbackPosition(null)
      usePartEditorStore.getState().setPickBoundary(null)
      usePartEditorStore.getState().setEditingFeatureId(null)
    }
  }, [])
}
