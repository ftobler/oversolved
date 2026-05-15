import { useCallback, useEffect, useRef } from 'react'
import type { PartDoc, Mutation } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { useUndoRedo } from '@/hooks/useUndoRedo'
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
} from '@/utils/yamlMutations'

export { healDoc, BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

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
    switch (m.type) {
      case 'move_vertex':
        applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
        break
      case 'move_vertex_with_constraint': {
        applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
        const draggedRef = `vertex:${m.featureId}:${m.entityId}:${m.vertexKey}`
        const snapRef = m.snapVertexId ?? m.snapEntityRef
        if (snapRef) {
          applyAddConstraint(next, m.featureId, m.constraintKind, [draggedRef, snapRef])
        }
        break
      }
      case 'move_entity':
        applyMoveEntity(next, m.featureId, m.entityId, m.delta)
        break
      case 'add_constraint':
        applyAddConstraint(next, m.featureId, m.kind, m.targets, m.value)
        break
      case 'set_constraint_value':
        applySetConstraintValue(next, m.featureId, m.constraintId, m.value)
        break
      case 'set_constraint_pos':
        applySetConstraintPos(next, m.featureId, m.constraintId, m.pos)
        break
      case 'delete':
        applyDeleteElements(next, m.targets)
        break
      case 'add_entity':
        applyAddEntity(next, m.featureId, m.kind, m.params, m.entityId)
        break
      case 'add_entity_with_constraint':
        applyAddEntityWithConstraint(next, m.featureId, m.kind, m.params, m.vertexKey, m.snapVertexId, m.constraintKind, m.snapEntityRef, m.entityId)
        break
      case 'add_projected_entity':
        applyAddProjectedEntity(next, m.featureId, m.kind, m.source)
        break
      case 'add_rect':
        applyAddRect(next, m.featureId, m.p0, m.p1)
        break
      case 'add_center_rect':
        applyAddCenterRect(next, m.featureId, m.center, m.corner)
        break
      case 'toggle_construction':
        applyToggleConstruction(next, m.targets)
        break
      case 'set_feature_plane':
        applySetFeaturePlane(next, m.featureId, m.plane)
        break
      case 'add_sketch':
        applyAddSketch(next, m.featureId, m.label)
        break
      case 'delete_feature':
        applyDeleteFeature(next, m.featureId)
        break
      case 'set_feature_visibility':
        applySetFeatureVisibility(next, m.featureId, m.visible)
        break
      case 'add_plane':
        applyAddPlane(next, m.featureId, m.label, m.definition as Record<string, unknown> | undefined)
        break
      case 'set_plane_definition_field':
        applySetPlaneDefinitionField(next, m.featureId, m.field, m.value)
        break
      case 'rename_feature':
        applyRenameFeature(next, m.featureId, m.label)
        break
      case 'toggle_sketch_plane_visibility':
        applyToggleSketchPlaneVisibility(next)
        break
      case 'toggle_plane_visibility':
        applyTogglePlaneVisibility(next)
        break
      case 'add_extrude':
        applyAddExtrude(next, m.featureId, m.label, m.sketchQuery, m.distance)
        break
      case 'set_extrude_distance':
        applySetExtrudeDistance(next, m.featureId, m.distance)
        break
      case 'set_extrude_direction':
        applySetExtrudeDirection(next, m.featureId, m.direction)
        break
      case 'set_extrude_operation':
        applySetExtrudeOperation(next, m.featureId, m.operation)
        break
      case 'set_extrude_merge_target':
        applySetExtrudeMergeTarget(next, m.featureId, m.mergeTarget)
        break
      case 'add_extrude_profile':
        applyAddExtrudeProfile(next, m.featureId, m.sketchQuery)
        break
      case 'remove_extrude_profile':
        applyRemoveExtrudeProfile(next, m.featureId, m.index)
        break
      case 'add_revolve':
        applyAddRevolve(next, m.featureId, m.label, m.sketchQuery, m.angle)
        break
      case 'set_revolve_angle':
        applySetRevolveAngle(next, m.featureId, m.angle)
        break
      case 'set_revolve_direction':
        applySetRevolveDirection(next, m.featureId, m.direction)
        break
      case 'set_revolve_axis':
        applySetRevolveAxis(next, m.featureId, m.axis)
        break
      case 'set_revolve_operation':
        applySetRevolveOperation(next, m.featureId, m.operation)
        break
      case 'set_revolve_merge_target':
        applySetRevolveMergeTarget(next, m.featureId, m.mergeTarget)
        break
      case 'add_revolve_profile':
        applyAddRevolveProfile(next, m.featureId, m.sketchQuery)
        break
      case 'remove_revolve_profile':
        applyRemoveRevolveProfile(next, m.featureId, m.index)
        break
      case 'add_import_step':
        applyAddImportStep(next, m.featureId, m.fileId, m.label)
        break
      case 'add_fillet':
        applyAddFillet(next, m.featureId, m.label)
        break
      case 'add_chamfer':
        applyAddChamfer(next, m.featureId, m.label)
        break
      case 'set_fillet_radius':
        applySetFilletRadius(next, m.featureId, m.radius)
        break
      case 'set_chamfer_distance':
        applySetChamferDistance(next, m.featureId, m.distance)
        break
      case 'set_chamfer_angle':
        applySetChamferAngle(next, m.featureId, m.angle)
        break
      case 'set_chamfer_kind':
        applySetChamferKind(next, m.featureId, m.kind)
        break
      case 'add_fillet_edge':
        applyAddFilletEdge(next, m.featureId, m.edgeQuery)
        break
      case 'remove_fillet_edge':
        applyRemoveFilletEdge(next, m.featureId, m.index)
        break
      case 'add_chamfer_edge':
        applyAddChamferEdge(next, m.featureId, m.edgeQuery)
        break
      case 'remove_chamfer_edge':
        applyRemoveChamferEdge(next, m.featureId, m.index)
        break
      case 'add_boolean':
        applyAddBoolean(next, m.featureId, m.label)
        break
      case 'set_boolean_operation':
        applySetBooleanOperation(next, m.featureId, m.operation)
        break
      case 'set_boolean_target':
        applySetBooleanTarget(next, m.featureId, m.target)
        break
      case 'add_boolean_tool':
        applyAddBooleanTool(next, m.featureId, m.tool)
        break
      case 'remove_boolean_tool':
        applyRemoveBooleanTool(next, m.featureId, m.tool)
        break
      case 'set_boolean_keep_tools':
        applySetBooleanKeepTools(next, m.featureId, m.keepTools)
        break
      case 'add_array':
        applyAddArray(next, m.featureId, m.label)
        break
      case 'set_array_mode':
        applySetArrayMode(next, m.featureId, m.mode)
        break
      case 'set_array_source_body':
        applySetArraySourceBody(next, m.featureId, m.sourceBody)
        break
      case 'set_array_operation':
        applySetArrayOperation(next, m.featureId, m.operation)
        break
      case 'set_array_include_source':
        applySetArrayIncludeSource(next, m.featureId, m.includeSource)
        break
      case 'set_array_count_x':
        applySetArrayCountX(next, m.featureId, m.count)
        break
      case 'set_array_pitch_x':
        applySetArrayPitchX(next, m.featureId, m.pitch)
        break
      case 'set_array_direction_x_query':
        applySetArrayDirectionXQuery(next, m.featureId, m.query)
        break
      case 'set_array_count_y':
        applySetArrayCountY(next, m.featureId, m.count)
        break
      case 'set_array_pitch_y':
        applySetArrayPitchY(next, m.featureId, m.pitch)
        break
      case 'set_array_direction_y_query':
        applySetArrayDirectionYQuery(next, m.featureId, m.query)
        break
      case 'set_array_count':
        applySetArrayCount(next, m.featureId, m.count)
        break
      case 'set_array_step_angle':
        applySetArrayStepAngle(next, m.featureId, m.stepAngle)
        break
      case 'set_array_axis':
        applySetArrayAxis(next, m.featureId, m.axis)
        break
      case 'set_array_direction_x':
        applySetArrayDirectionX(next, m.featureId, m.direction_x)
        break
      case 'set_array_direction_y':
        applySetArrayDirectionY(next, m.featureId, m.direction_y)
        break
      case 'add_delete_body':
        applyAddDeleteBody(next, m.featureId, m.body, m.label)
        break
      case 'set_delete_body_target':
        applySetDeleteBodyTarget(next, m.featureId, m.body)
        break
      case 'add_hole':
        applyAddHole(next, m.featureId, m.label)
        break
      case 'set_hole_sketch':
        applySetHoleSketch(next, m.featureId, m.sketch)
        break
      case 'set_hole_diameter':
        applySetHoleDiameter(next, m.featureId, m.diameter)
        break
      case 'set_hole_depth':
        applySetHoleDepth(next, m.featureId, m.depth)
        break
      case 'set_hole_depth_mode':
        applySetHoleDepthMode(next, m.featureId, m.depthMode)
        break
      case 'set_hole_direction':
        if (m.direction)
          applySetHoleDirection(next, m.featureId, m.direction)
        break
      case 'set_hole_target':
        applySetHoleTarget(next, m.featureId, m.target)
        break
      case 'add_transform':
        applyAddTransform(next, m.featureId, m.label)
        break
      case 'set_transform_field':
        applySetTransformField(next, m.featureId, m.field, m.value)
        break
      case 'rename_part':
        applyRenamePart(next, m.bodyId, m.name)
        break
      case 'set_part_color':
        applySetPartColor(next, m.bodyId, m.color)
        break
      case 'set_part_transparency':
        applySetPartTransparency(next, m.bodyId, m.transparency)
        break
      case 'set_part_metalness':
        applySetPartMetalness(next, m.bodyId, m.metalness)
        break
      case 'reorder_features':
        applyReorderFeatures(next, m.featureId, m.toIndex)
        break
      case 'reorder_pick_field':
        applyReorderPickField(next, m.featureId, m.field, m.fromIndex, m.toIndex)
        break
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
