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
  applySetExtrudeDistance,
  applySetExtrudeDirection,
  applySetExtrudeOperation,
  applySetExtrudeMergeTarget,
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  applyAddRevolve,
  applySetRevolveAngle,
  applySetRevolveDirection,
  applySetRevolveAxis,
  applySetRevolveOperation,
  applySetRevolveMergeTarget,
  applyAddRevolveProfile,
  applyRemoveRevolveProfile,
  applyAddImportStep,
  applyAddFillet,
  applyAddChamfer,
  applySetFilletRadius,
  applySetChamferDistance,
  applySetChamferAngle,
  applySetChamferKind,
  applyAddFilletEdge,
  applyRemoveFilletEdge,
  applyAddChamferEdge,
  applyRemoveChamferEdge,
  applyAddBoolean,
  applySetBooleanOperation,
  applySetBooleanTarget,
  applyAddBooleanTool,
  applyRemoveBooleanTool,
  applySetBooleanKeepTools,
  applyAddArray,
  applySetArrayMode,
  applySetArraySourceBody,
  applySetArrayOperation,
  applySetArrayIncludeSource,
  applySetArrayCountX,
  applySetArrayPitchX,
  applySetArrayDirectionXQuery,
  applySetArrayCountY,
  applySetArrayPitchY,
  applySetArrayDirectionYQuery,
  applySetArrayCount,
  applySetArrayStepAngle,
  applySetArrayAxis,
  applySetArrayDirectionX,
  applySetArrayDirectionY,
  applyAddDeleteBody,
  applySetDeleteBodyTarget,
  applyAddHole,
  applySetHoleSketch,
  applySetHoleDiameter,
  applySetHoleDepth,
  applySetHoleDepthMode,
  applySetHoleDirection,
  applySetHoleTarget,
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
  set_extrude_distance: (next, m) =>
    applySetExtrudeDistance(next, m.featureId, m.distance),
  set_extrude_direction: (next, m) =>
    applySetExtrudeDirection(next, m.featureId, m.direction),
  set_extrude_operation: (next, m) =>
    applySetExtrudeOperation(next, m.featureId, m.operation),
  set_extrude_merge_target: (next, m) =>
    applySetExtrudeMergeTarget(next, m.featureId, m.mergeTarget),
  add_extrude_profile: (next, m) =>
    applyAddExtrudeProfile(next, m.featureId, m.sketchQuery),
  remove_extrude_profile: (next, m) =>
    applyRemoveExtrudeProfile(next, m.featureId, m.index),
  add_revolve: (next, m) =>
    applyAddRevolve(next, m.featureId, m.label, m.sketchQuery, m.angle),
  set_revolve_angle: (next, m) =>
    applySetRevolveAngle(next, m.featureId, m.angle),
  set_revolve_direction: (next, m) =>
    applySetRevolveDirection(next, m.featureId, m.direction),
  set_revolve_axis: (next, m) =>
    applySetRevolveAxis(next, m.featureId, m.axis),
  set_revolve_operation: (next, m) =>
    applySetRevolveOperation(next, m.featureId, m.operation),
  set_revolve_merge_target: (next, m) =>
    applySetRevolveMergeTarget(next, m.featureId, m.mergeTarget),
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
  set_fillet_radius: (next, m) =>
    applySetFilletRadius(next, m.featureId, m.radius),
  set_chamfer_distance: (next, m) =>
    applySetChamferDistance(next, m.featureId, m.distance),
  set_chamfer_angle: (next, m) =>
    applySetChamferAngle(next, m.featureId, m.angle),
  set_chamfer_kind: (next, m) =>
    applySetChamferKind(next, m.featureId, m.kind),
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
  set_boolean_operation: (next, m) =>
    applySetBooleanOperation(next, m.featureId, m.operation),
  set_boolean_target: (next, m) =>
    applySetBooleanTarget(next, m.featureId, m.target),
  add_boolean_tool: (next, m) =>
    applyAddBooleanTool(next, m.featureId, m.tool),
  remove_boolean_tool: (next, m) =>
    applyRemoveBooleanTool(next, m.featureId, m.tool),
  set_boolean_keep_tools: (next, m) =>
    applySetBooleanKeepTools(next, m.featureId, m.keepTools),
  add_array: (next, m) =>
    applyAddArray(next, m.featureId, m.label),
  set_array_mode: (next, m) =>
    applySetArrayMode(next, m.featureId, m.mode),
  set_array_source_body: (next, m) =>
    applySetArraySourceBody(next, m.featureId, m.sourceBody),
  set_array_operation: (next, m) =>
    applySetArrayOperation(next, m.featureId, m.operation),
  set_array_include_source: (next, m) =>
    applySetArrayIncludeSource(next, m.featureId, m.includeSource),
  set_array_count_x: (next, m) =>
    applySetArrayCountX(next, m.featureId, m.count),
  set_array_pitch_x: (next, m) =>
    applySetArrayPitchX(next, m.featureId, m.pitch),
  set_array_direction_x_query: (next, m) =>
    applySetArrayDirectionXQuery(next, m.featureId, m.query),
  set_array_count_y: (next, m) =>
    applySetArrayCountY(next, m.featureId, m.count),
  set_array_pitch_y: (next, m) =>
    applySetArrayPitchY(next, m.featureId, m.pitch),
  set_array_direction_y_query: (next, m) =>
    applySetArrayDirectionYQuery(next, m.featureId, m.query),
  set_array_count: (next, m) =>
    applySetArrayCount(next, m.featureId, m.count),
  set_array_step_angle: (next, m) =>
    applySetArrayStepAngle(next, m.featureId, m.stepAngle),
  set_array_axis: (next, m) =>
    applySetArrayAxis(next, m.featureId, m.axis),
  set_array_direction_x: (next, m) =>
    applySetArrayDirectionX(next, m.featureId, m.direction_x),
  set_array_direction_y: (next, m) =>
    applySetArrayDirectionY(next, m.featureId, m.direction_y),
  set_body_visibility: (next, m) =>
    applySetBodyVisibility(next, m.bodyId, m.visible),
  add_delete_body: (next, m) =>
    applyAddDeleteBody(next, m.featureId, m.body, m.label),
  set_delete_body_target: (next, m) =>
    applySetDeleteBodyTarget(next, m.featureId, m.body),
  add_hole: (next, m) =>
    applyAddHole(next, m.featureId, m.label),
  set_hole_sketch: (next, m) =>
    applySetHoleSketch(next, m.featureId, m.sketch),
  set_hole_diameter: (next, m) =>
    applySetHoleDiameter(next, m.featureId, m.diameter),
  set_hole_depth: (next, m) =>
    applySetHoleDepth(next, m.featureId, m.depth),
  set_hole_depth_mode: (next, m) =>
    applySetHoleDepthMode(next, m.featureId, m.depthMode),
  set_hole_direction: (next, m) => {
    if (m.direction) applySetHoleDirection(next, m.featureId, m.direction)
  },
  set_hole_target: (next, m) =>
    applySetHoleTarget(next, m.featureId, m.target),
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
  }
}
