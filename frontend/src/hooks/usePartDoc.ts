import { useCallback, useEffect, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PRIMARY_PICK_FIELD, isCompatibleWithField, applyCompatibleSelection } from '@/utils/featurePickRegistry'
import {
  applyMoveVertex,
  applyMoveEntity,
  applyAddConstraint,
  applyDeleteElements,
  applyAddEntity,
  applyAddEntityWithConstraint,
  applyAddProjectedEntity,
  applyAddRect,
  applyAddCenterRect,
  applySetConstraintValue,
  applySetConstraintPos,
  applyToggleConstruction,
  applySetFeaturePlane,
  applyAddSketch,
  applyDeleteFeature,
  applySetFeatureVisibility,
  applyRenameFeature,
  applyAddPlane,
  applySetPlaneDefinitionField,
  applyTogglePlaneVisibility,
  applyToggleSketchPlaneVisibility,
  applyAddExtrude,
  applySetExtrudeField,
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  applyAddRevolve,
  applySetRevolveField,
  applyAddRevolveProfile,
  applyRemoveRevolveProfile,
  applyAddImportStep,
  applyAddFillet,
  applyAddChamfer,
  applySetFilletField,
  applySetChamferField,
  applyAddFilletEdge,
  applyRemoveFilletEdge,
  applyAddChamferEdge,
  applyRemoveChamferEdge,
  applyAddBoolean,
  applySetBooleanField,
  applyAddBooleanTool,
  applyRemoveBooleanTool,
  applyAddArray,
  applySetArrayField,
  applyAddDeleteBody,
  applySetDeleteBodyField,
  applyAddHole,
  applySetHoleField,
  applyAddTransform,
  applySetTransformField,
  applyRenamePart,
  applySetPartColor,
  applySetPartTransparency,
  applySetPartMetalness,
  applyReorderFeatures,
  applyReorderPickField,
  applyMirrorEntities,
  applyAddMirror,
  applySetMirrorField,
  applySetBodyVisibility,
  applySetFeatureSuppression,
} from '@/utils/yamlMutations'

export { healDoc, BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

type MutationHandlers = {
  [K in Mutation['type']]: (doc: PartDoc, m: Extract<Mutation, { type: K }>) => void
}

export const mutationHandlers: MutationHandlers = {
  move_vertex: (next, m) =>
    applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to),
  move_vertex_with_constraint: (next, m) => {
    applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
    const draggedRef = `vertex:${m.featureId}:${m.entityId}:${m.vertexKey}`
    const snapRef = m.snapVertexId ?? m.snapEntityRef
    if (snapRef) {
      applyAddConstraint(next, m.featureId, m.constraintKind, [draggedRef, snapRef])
    }
  },
  move_entity: (next, m) =>
    applyMoveEntity(next, m.featureId, m.entityId, m.delta),
  add_constraint: (next, m) =>
    applyAddConstraint(next, m.featureId, m.kind, m.targets, m.value),
  set_constraint_value: (next, m) =>
    applySetConstraintValue(next, m.featureId, m.constraintId, m.value),
  set_constraint_pos: (next, m) =>
    applySetConstraintPos(next, m.featureId, m.constraintId, m.pos),
  delete: (next, m) =>
    applyDeleteElements(next, m.targets),
  add_entity: (next, m) =>
    applyAddEntity(next, m.featureId, m.kind, m.params, m.entityId),
  add_entity_with_constraint: (next, m) =>
    applyAddEntityWithConstraint(next, m.featureId, m.kind, m.params, m.vertexKey, m.snapVertexId, m.constraintKind, m.snapEntityRef, m.entityId),
  add_projected_entity: (next, m) =>
    applyAddProjectedEntity(next, m.featureId, m.kind, m.source),
  add_rect: (next, m) =>
    applyAddRect(next, m.featureId, m.p0, m.p1),
  add_center_rect: (next, m) =>
    applyAddCenterRect(next, m.featureId, m.center, m.corner),
  toggle_construction: (next, m) =>
    applyToggleConstruction(next, m.targets),
  set_feature_plane: (next, m) =>
    applySetFeaturePlane(next, m.featureId, m.plane),
  add_sketch: (next, m) =>
    applyAddSketch(next, m.featureId, m.label),
  delete_feature: (next, m) =>
    applyDeleteFeature(next, m.featureId),
  set_feature_visibility: (next, m) =>
    applySetFeatureVisibility(next, m.featureId, m.visible),
  add_plane: (next, m) =>
    applyAddPlane(next, m.featureId, m.label, m.definition as Record<string, unknown> | undefined),
  set_plane_definition_field: (next, m) =>
    applySetPlaneDefinitionField(next, m.featureId, m.field, m.value),
  rename_feature: (next, m) =>
    applyRenameFeature(next, m.featureId, m.label),
  toggle_sketch_plane_visibility: (next) =>
    applyToggleSketchPlaneVisibility(next),
  toggle_plane_visibility: (next) =>
    applyTogglePlaneVisibility(next),
  add_extrude: (next, m) =>
    applyAddExtrude(next, m.featureId, m.label, m.sketchQuery, m.distance),
  set_extrude_field: (next, m) =>
    applySetExtrudeField(next, m.featureId, m.field, m.value),
  add_extrude_profile: (next, m) =>
    applyAddExtrudeProfile(next, m.featureId, m.sketchQuery),
  remove_extrude_profile: (next, m) =>
    applyRemoveExtrudeProfile(next, m.featureId, m.index),
  add_revolve: (next, m) =>
    applyAddRevolve(next, m.featureId, m.label, m.sketchQuery, m.angle),
  set_revolve_field: (next, m) =>
    applySetRevolveField(next, m.featureId, m.field, m.value),
  add_revolve_profile: (next, m) =>
    applyAddRevolveProfile(next, m.featureId, m.sketchQuery),
  remove_revolve_profile: (next, m) =>
    applyRemoveRevolveProfile(next, m.featureId, m.index),
  add_import_step: (next, m) =>
    applyAddImportStep(next, m.featureId, m.fileId, m.label),
  add_fillet: (next, m) =>
    applyAddFillet(next, m.featureId, m.label),
  add_chamfer: (next, m) =>
    applyAddChamfer(next, m.featureId, m.label),
  set_fillet_field: (next, m) =>
    applySetFilletField(next, m.featureId, m.field, m.value),
  set_chamfer_field: (next, m) =>
    applySetChamferField(next, m.featureId, m.field, m.value),
  add_fillet_edge: (next, m) =>
    applyAddFilletEdge(next, m.featureId, m.edgeQuery),
  remove_fillet_edge: (next, m) =>
    applyRemoveFilletEdge(next, m.featureId, m.index),
  add_chamfer_edge: (next, m) =>
    applyAddChamferEdge(next, m.featureId, m.edgeQuery),
  remove_chamfer_edge: (next, m) =>
    applyRemoveChamferEdge(next, m.featureId, m.index),
  add_boolean: (next, m) =>
    applyAddBoolean(next, m.featureId, m.label),
  set_boolean_field: (next, m) =>
    applySetBooleanField(next, m.featureId, m.field, m.value),
  add_boolean_tool: (next, m) =>
    applyAddBooleanTool(next, m.featureId, m.tool),
  remove_boolean_tool: (next, m) =>
    applyRemoveBooleanTool(next, m.featureId, m.tool),
  add_array: (next, m) =>
    applyAddArray(next, m.featureId, m.label),
  set_array_field: (next, m) =>
    applySetArrayField(next, m.featureId, m.field, m.value),
  set_body_visibility: (next, m) =>
    applySetBodyVisibility(next, m.bodyId, m.visible),
  add_delete_body: (next, m) =>
    applyAddDeleteBody(next, m.featureId, m.body, m.label),
  set_delete_body_field: (next, m) =>
    applySetDeleteBodyField(next, m.featureId, m.field, m.value),
  add_hole: (next, m) =>
    applyAddHole(next, m.featureId, m.label),
  set_hole_field: (next, m) =>
    applySetHoleField(next, m.featureId, m.field, m.value),
  add_transform: (next, m) =>
    applyAddTransform(next, m.featureId, m.label),
  set_transform_field: (next, m) =>
    applySetTransformField(next, m.featureId, m.field, m.value),
  rename_part: (next, m) =>
    applyRenamePart(next, m.bodyId, m.name),
  set_part_color: (next, m) =>
    applySetPartColor(next, m.bodyId, m.color),
  set_part_transparency: (next, m) =>
    applySetPartTransparency(next, m.bodyId, m.transparency),
  set_part_metalness: (next, m) =>
    applySetPartMetalness(next, m.bodyId, m.metalness),
  mirror_entities: (next, m) =>
    applyMirrorEntities(next, m.featureId, m.entityIds, m.mirrorLineId),
  add_mirror: (next, m) =>
    applyAddMirror(next, m.featureId, m.label),
  set_mirror_field: (next, m) =>
    applySetMirrorField(next, m.featureId, m.field, m.value),
  reorder_features: (next, m) =>
    applyReorderFeatures(next, m.featureId, m.toIndex),
  reorder_pick_field: (next, m) =>
    applyReorderPickField(next, m.featureId, m.field, m.fromIndex, m.toIndex),
  set_feature_suppression: (next, m) =>
    applySetFeatureSuppression(next, m.featureId, m.suppressed),
  edit_session: () => {},  // undo-only marker; no doc mutation needed
}

export function usePartDoc(uuid: string | undefined, mode: string, setCodeText: (t: string) => void, { solveOnLoad = true, onFirstSolve }: { solveOnLoad?: boolean; onFirstSolve?: () => void } = {}) {
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  const reSolveRef = useRef<((d: PartDoc) => void) | null>(null)

  const {
    doc, setDoc, docRef, docName, setDocName, ownerUsername,
    loading, error, setError, permission, isPublic,
    saveDoc, renameDoc,
  } = useDocumentState(uuid, reSolveRef, { solveOnLoad })

  const {
    solveResults, setSolveResults, bodies, pickBodies, setPickBodies,
    solving, solveTime, solveError, setSolveError, solveResult, setSolveRawResult,
    featureTimings, reSolve, setRollbackPos, setPickBoundary,
    validation, clearValidation,
  } = useSolver(uuid, setCodeText, modeRef, { onFirstSolve }, docRef, setDoc)

  useEffect(() => { reSolveRef.current = reSolve }, [reSolve])

  const {
    undoStack, redoStack, suppressUndoRef, pushUndo, handleUndo, handleRedo,
    saveUndoStackSnapshot, restoreUndoStackSnapshot, clearUndoStackSnapshot,
  } = useUndoRedo(docRef, setDoc, reSolve)

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    setSolveResults(prev => {
      if (m.type === 'delete_feature') {
        const next = { ...prev }
        delete next[m.featureId]
        return next
      }
      if (m.type === 'delete') {
        return {}
      }
      return prev
    })

    const next: PartDoc = structuredClone(current)
    if (!suppressUndoRef.current) {
      pushUndo(m, current)
    }
    type AnyHandler = (doc: PartDoc, m: Mutation) => void
    const handler = (mutationHandlers as Record<string, AnyHandler | undefined>)[m.type]
    if (import.meta.env.DEV && !handler) {
      console.error(`[handleMutation] no handler for mutation type: ${m.type}`)
    }
    handler?.(next, m)

    // Auto-activate primary pick chip on add_feature (feature 223)
    const pickInfo = PRIMARY_PICK_FIELD[m.type]
    if (pickInfo) {
      const featId = (m as unknown as { featureId: string }).featureId
      const store = useSketchEditorStore.getState()
      const compatibleIds = [...store.normalSelection].filter(id =>
        isCompatibleWithField(id, pickInfo.field, pickInfo.hostKind),
      )
      for (const id of compatibleIds) {
        applyCompatibleSelection(next, featId, pickInfo.field, pickInfo.hostKind, id)
      }
      store.setPendingPickField({
        featureId: featId,
        field: pickInfo.field,
        hostKind: pickInfo.hostKind,
      })
    }

    docRef.current = next
    setDoc(next)
    reSolve(next)
  }, [docRef, setDoc, reSolve, setSolveResults, setSolveError, suppressUndoRef, pushUndo])

  const previewOriginalDoc = useRef<PartDoc | null>(null)

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    previewOriginalDoc.current = structuredClone(originalDoc)
    suppressUndoRef.current = true
  }, [suppressUndoRef])

  const commitPreview = useCallback((mutation: Mutation) => {
    if (!previewOriginalDoc.current) return
    pushUndo(mutation, previewOriginalDoc.current)
    suppressUndoRef.current = false
    previewOriginalDoc.current = null
  }, [suppressUndoRef, pushUndo])

  const cancelPreview = useCallback(() => {
    suppressUndoRef.current = false
    const original = previewOriginalDoc.current
    previewOriginalDoc.current = null
    return original
  }, [suppressUndoRef])

  const editSnapshotRef = useRef<PartDoc | null>(null)

  const startEditSession = useCallback((suppressUndo: boolean) => {
    if (!docRef.current) return
    editSnapshotRef.current = structuredClone(docRef.current)
    saveUndoStackSnapshot()
    if (suppressUndo) {
      suppressUndoRef.current = true
    }
  }, [docRef, saveUndoStackSnapshot, suppressUndoRef])

  const commitEditSession = useCallback(() => {
    const snapshot = editSnapshotRef.current
    editSnapshotRef.current = null
    suppressUndoRef.current = false
    if (snapshot && docRef.current) {
      pushUndo(
        { type: 'edit_session', featureId: '' },
        snapshot,
      )
    }
    clearUndoStackSnapshot()
  }, [suppressUndoRef, pushUndo, clearUndoStackSnapshot, docRef])

  const cancelEditSession = useCallback(() => {
    suppressUndoRef.current = false
    const snapshot = editSnapshotRef.current
    editSnapshotRef.current = null
    if (snapshot) {
      docRef.current = snapshot
      setDoc(snapshot)
    }
    restoreUndoStackSnapshot()
  }, [suppressUndoRef, docRef, setDoc, restoreUndoStackSnapshot])

  return {
    doc,
    setDoc,
    docRef,
    docName,
    setDocName,
    ownerUsername,
    loading,
    error,
    setError,
    solveResults,
    setSolveResults,
    featureTimings,
    bodies,
    pickBodies,
    setPickBodies,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    setSolveRawResult,
    undoStack,
    redoStack,
    reSolve,
    validation,
    clearValidation,
    handleMutation,
    handleUndo,
    handleRedo,
    saveDoc,
    renameDoc,
    permission,
    isPublic,
    setRollbackPos,
    setPickBoundary,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
  }
}
