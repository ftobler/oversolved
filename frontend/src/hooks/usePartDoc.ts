import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { PartDoc, SketchData, Mutation, EntityStatus, BuildResponse, PartStyleEntry } from '../types/cad'

type UndoEntry = { doc: PartDoc; mutation: Mutation }
import { unflattenGeometry } from '../utils/geometryMapping'
import { getCachedBuildResponse, cacheBuildResponse } from '../utils/buildCache'
import { PART_COLOR_PALETTE, normalizeHexColor } from '../utils/partColors'
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
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  applyAddRevolve,
  applySetRevolveAngle,
  applySetRevolveAxis,
  applySetRevolveOperation,
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
} from '../utils/yamlMutations'
import type { PartFeature } from '../types/cad'

export const BUILTIN_FEATURE_DEFAULTS: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top',    kind: 'plane' },
  { id: 'Front',  kind: 'plane' },
  { id: 'Right',  kind: 'plane' },
]

const BUILTIN_FEATURE_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

function pickPartColor(partNumber: number): string {
  return PART_COLOR_PALETTE[(partNumber - 1) % PART_COLOR_PALETTE.length]
}

function reconcilePartStyle(doc: PartDoc, bodies: Record<string, import('../types/cad').BodyResult> | undefined): void {
  const bodyIds = Object.keys(bodies ?? {})
  if (bodyIds.length === 0) return

  const style = doc.part_style ?? {}
  const usedPartNumbers = new Set<number>()
  for (const entry of Object.values(style)) {
    const match = /^part (\d+)$/i.exec(entry?.name ?? '')
    if (match) usedPartNumbers.add(Number(match[1]))
  }

  const nextStyle: Record<string, PartStyleEntry> = { ...style }
  let nextPartNumber = 1
  const nextFreePartNumber = () => {
    while (usedPartNumbers.has(nextPartNumber)) nextPartNumber += 1
    usedPartNumbers.add(nextPartNumber)
    return nextPartNumber++
  }

  for (const bodyId of bodyIds) {
    const current = nextStyle[bodyId]
    if (current) {
      const normalizedColor = normalizeHexColor(current.color)
      nextStyle[bodyId] = {
        ...current,
        ...(normalizedColor ? { color: normalizedColor } : {}),
      }
      continue
    }
    const partNumber = nextFreePartNumber()
    const createdBy = bodies?.[bodyId]?.created_by
    nextStyle[bodyId] = {
      name: `part ${partNumber}`,
      color: pickPartColor(partNumber),
      created_by: createdBy,
    }
  }

  doc.part_style = nextStyle
}

export function healDoc(raw: unknown): PartDoc {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const userFeatures = Array.isArray(doc.features) ? (doc.features as PartFeature[]) : []
  const existingIds = new Set(userFeatures.map(f => f.id))
  const missingBuiltins = BUILTIN_FEATURE_DEFAULTS.filter(f => !existingIds.has(f.id))
  return {
    ...doc,
    version:  (doc.version as number) ?? 1,
    kind:     (doc.kind    as string) ?? 'part',
    features: [...missingBuiltins, ...userFeatures],
  } as PartDoc
}

export function usePartDoc(uuid: string | undefined, mode: string, setCodeText: (t: string) => void, { solveOnLoad = true, onFirstSolve }: { solveOnLoad?: boolean; onFirstSolve?: () => void } = {}) {
  const [doc, setDoc] = useState<PartDoc | null>(null)
  const [docName, setDocName] = useState<string>('')
  const [ownerUsername, setOwnerUsername] = useState<string>('')
  const docRef = useRef<PartDoc | null>(null)
  // Use a ref for mode so reSolve does not change identity on every mode switch.
  // Without this, reSolve changing would re-trigger the document-load useEffect,
  // discarding any unsaved in-memory mutations (e.g. a freshly added sketch).
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [solveResults, setSolveResults] = useState<Record<string, SketchData>>({})
  const [bodies, setBodies] = useState<Record<string, import('../types/cad').BodyResult>>({})
  const [pickBodies, setPickBodies] = useState<Record<string, import('../types/cad').BodyResult>>({})
  const [solving, setSolving] = useState(false)
  const [featureTimings, setFeatureTimings] = useState<Record<string, number>>({})
  const [solveTime, setSolveTime] = useState<number | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [solveResult, setSolveRawResult] = useState<string>('')
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([])
  const suppressUndoRef = useRef(false)
  const previewOriginalDoc = useRef<PartDoc | null>(null)
  const [permission, setPermission] = useState<string>('owner')
  const [isPublic, setIsPublic] = useState(false)
  const [fromCache, setFromCache] = useState(false)
  const [cacheTimestamp, setCacheTimestamp] = useState<number | null>(null)
  const firstSolveDone = useRef(false)
  const rollbackPosRef = useRef<number | null>(null)
  const pickBoundaryRef = useRef<number | null>(null)
  const requestIdRef = useRef(0)
  const cancelledRef = useRef(false)

  const applyBuildResponse = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number) => {
    const result = data.result as Record<string, { geometry?: Record<string, number[]>; status?: string; features?: Record<string, { status?: string }>; topology?: import('../types/cad').Topology; plane_transform?: import('../types/cad').PlaneTransform; constraints?: Record<string, { residual: number; render: import('../types/cad').ConstraintRender; superfluous: boolean }>; plane?: { origin: number[]; x_axis: number[]; y_axis: number[]; normal: number[] }; body_id?: string; exception?: string; solve_ms?: number }>

    const results: Record<string, SketchData> = {}
    for (const [id, feature] of Object.entries(result)) {
      const featureDef = (d.features ?? []).find(f => f.id === id)
      if (feature.geometry) {
        if (featureDef) {
          featureDef.initial = feature.geometry
          if (feature.constraints && featureDef.constraints) {
            const superfluousIds = new Set(
              Object.entries(feature.constraints)
                .filter(([, c]) => c.superfluous)
                .map(([cid]) => cid)
            )
            if (superfluousIds.size > 0) {
              featureDef.constraints = featureDef.constraints.filter(c => !superfluousIds.has(c.id))
            }
          }
        }
        const solved = unflattenGeometry(feature.geometry, featureDef?.entities)
        const astPosById = new Map(
          (featureDef?.constraints ?? [])
            .filter(c => c.pos)
            .map(c => [c.id, c.pos!])
        )
        const constraints: import('../types/cad').Constraints | undefined = feature.constraints
          ? Object.fromEntries(
              Object.entries(feature.constraints)
                .filter(([, c]) => !c.superfluous)
                .map(([cid, c]) => {
                  const pos = astPosById.get(cid)
                  const render = pos ? { ...c.render, pos } : c.render
                  return [cid, { render, residual: c.residual }]
                })
            )
          : undefined
        const entityStatus = feature.features
          ? (Object.fromEntries(
              Object.entries(feature.features).map(([eid, e]) => [eid, (e as { status?: string }).status || 'underconstrained'])
            ) as EntityStatus)
          : undefined
        results[id] = {
          solved,
          topology: feature.topology,
          status: feature.status,
          ...(constraints && { constraints }),
          ...(entityStatus && { features: entityStatus }),
          ...(feature.plane_transform && { plane_transform: feature.plane_transform }),
        }
      } else if (feature.plane) {
        const planeRaw = feature.plane as { x_axis: number[]; y_axis: number[]; normal: number[]; origin: number[] }
        const plane = {
          origin: planeRaw.origin as [number, number, number],
          x_axis: planeRaw.x_axis as [number, number, number],
          y_axis: planeRaw.y_axis as [number, number, number],
          normal: planeRaw.normal as [number, number, number],
        }
        results[id] = {
          solved: {},
          status: feature.status,
          plane,
          plane_transform: {
            rotation: [
              ...plane.x_axis,
              ...plane.y_axis,
              ...plane.normal,
            ],
            origin: plane.origin,
          },
        }
      } else {
        results[id] = {
          solved: unflattenGeometry(featureDef?.initial, featureDef?.entities),
          status: feature.status ?? 'exception',
          ...(feature.body_id !== undefined && { body_id: feature.body_id }),
          ...(feature.exception !== undefined && { exception: feature.exception }),
        }
      }
    }
    setSolveResults(results)
    const timings: Record<string, number> = {}
    for (const [id, feature] of Object.entries(result)) {
      if (typeof feature.solve_ms === 'number') {
        timings[id] = feature.solve_ms
      }
    }
    setFeatureTimings(timings)
    reconcilePartStyle(d, data.bodies)
    setBodies(data.bodies ?? {})
    setPickBodies(data.pick_bodies ?? {})
    setSolveRawResult(stringifyYaml(data.result))
    const updatedDoc = { ...d }
    setDoc(updatedDoc)
    docRef.current = updatedDoc
    if (modeRef.current === 'code') {
      setCodeText(stringifyYaml(d))
    }
    setSolveError(null)
    if (solveTimeMs !== undefined) {
      setSolveTime(solveTimeMs)
    }
  }, [setCodeText])

  const reSolve = useCallback(async (d: PartDoc, rollbackPosition?: number | null) => {
    setSolving(true)
    setSolveTime(null)
    const startTime = performance.now()
    const isFirstSolve = !firstSolveDone.current
    if (isFirstSolve) firstSolveDone.current = true

    const currentRequestId = ++requestIdRef.current
    try {
      const allFeatures = d.features ?? []
      const effectiveRollback = rollbackPosition ?? rollbackPosRef.current ?? allFeatures.length
      rollbackPosRef.current = effectiveRollback

      // Send ALL features to backend; backend handles rollback slicing internally.
      // Filter out built-in features for the solve payload.
      const solveFeatures = allFeatures.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))

      // Rollback position is an index into the FULL feature list (including builtins).
      // Backend receives solveFeatures without builtins, so adjust the index.
      const builtinCount = allFeatures.length - solveFeatures.length
      const adjustedRollback = Math.max(0, effectiveRollback - builtinCount)

      const isPreview = rollbackPosition !== undefined || pickBoundaryRef.current !== null
      const pickBoundary = pickBoundaryRef.current

      // Check cache before fetching.
      if (uuid) {
        const cached = await getCachedBuildResponse(uuid, d, effectiveRollback, pickBoundary)
        if (cached && cached.isFresh) {
          applyBuildResponse(d, cached.entry.buildResponse)
          setFromCache(true)
          setCacheTimestamp(cached.entry.timestamp)
          if (!cancelledRef.current) setSolving(false)
          if (isFirstSolve && onFirstSolve) {
            setTimeout(onFirstSolve, 0)
          }
          return
        }
      }

      const solvePayload: Record<string, unknown> = {
        ...d,
        ...(uuid ? { id: uuid } : {}),
        features: solveFeatures,
        rollback_position: adjustedRollback,
        request_id: currentRequestId,
        is_preview: isPreview,
      }

      if (pickBoundary !== null) {
        solvePayload.pick_boundary = pickBoundary
      }

      const response = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(solvePayload),
      })

      // Discard stale response - if another solve started, ignore this one
      if (currentRequestId !== requestIdRef.current) {
        return
      }

      const data = await response.json()
      const endTime = performance.now()
      const solveTimeMs = Math.round((endTime - startTime) * 100) / 100
      if (!response.ok) {
        setSolveError(data.error || `Solve failed (${response.status})`)
        setSolveRawResult(data.error || `Solve failed (${response.status})`)
      } else {
        const buildResponse = data as BuildResponse
        applyBuildResponse(d, buildResponse, solveTimeMs)
        setFromCache(false)
        setCacheTimestamp(null)
        if (uuid) {
          await cacheBuildResponse(uuid, d, effectiveRollback, pickBoundary, buildResponse)
        }
        if (isFirstSolve && onFirstSolve) {
          setTimeout(onFirstSolve, 0)
        }
      }
    } catch (e) {
      setSolveError(String(e))
      setSolveRawResult(String(e))
    } finally {
      if (!cancelledRef.current) setSolving(false)
    }
  }, [onFirstSolve, applyBuildResponse, uuid])

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    setSolveResults(prev => {
      const next = { ...prev }
      if (m.type === 'delete_feature') {
        delete next[m.featureId]
      } else if ('featureId' in m) {
        delete next[m.featureId]
      } else if (m.type === 'delete') {
        return {}
      }
      return next
    })

    const next: PartDoc = JSON.parse(JSON.stringify(current))
    if (!suppressUndoRef.current) {
      setUndoStack(prev => [...prev, { doc: current, mutation: m }])
      setRedoStack([])
    }
    switch (m.type) {
      case 'move_vertex':
        applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
        break
      case 'move_vertex_with_constraint': {
        applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
        const draggedRef = `vertex:${m.featureId}:${m.entityId}:${m.vertexKey}`
        // snapVertexId: point-to-point coincident; snapEntityRef: point-on-entity coincident
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
      case 'set_revolve_axis':
        applySetRevolveAxis(next, m.featureId, m.axis)
        break
      case 'set_revolve_operation':
        applySetRevolveOperation(next, m.featureId, m.operation)
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
  }, [reSolve])

  const handleUndo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const entry = next.pop()!
      if (docRef.current) setRedoStack(r => [...r, { doc: docRef.current!, mutation: entry.mutation }])
      docRef.current = entry.doc
      setDoc(entry.doc)
      reSolve(entry.doc)
      return next
    })
  }, [reSolve])

  const handleRedo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const entry = next.pop()!
      if (docRef.current) setUndoStack(u => [...u, { doc: docRef.current!, mutation: entry.mutation }])
      docRef.current = entry.doc
      setDoc(entry.doc)
      reSolve(entry.doc)
      return next
    })
  }, [reSolve])

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  useEffect(() => {
    if (!uuid) return
    setLoading(true)
    fetch(`/api/documents/${uuid}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        const parsed = healDoc(parseYaml(data.content))
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        setOwnerUsername(data.owner_username || '')
        setPermission(data.permission || 'owner')
        setIsPublic(data.is_public || false)
        setLoading(false)
        if (solveOnLoad) reSolve(parsed)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
  }, [uuid, solveOnLoad, reSolve])

  const saveDoc = useCallback(async (uuid: string, document: PartDoc, screenshot?: () => Promise<string | null>) => {
    try {
      const body: { content: string; preview_image?: string } = { content: stringifyYaml(document) }
      if (screenshot) {
        const dataUrl = await screenshot()
        if (dataUrl) {
          body.preview_image = dataUrl.split(',')[1]
        }
      }
      const response = await fetch(`/api/documents/${uuid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('Failed to save document')
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      const response = await fetch(`/api/documents/${uuid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw new Error('Failed to rename document')
      setDocName(name)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [])

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    previewOriginalDoc.current = JSON.parse(JSON.stringify(originalDoc))
    suppressUndoRef.current = true
  }, [])

  const commitPreview = useCallback((mutation: Mutation) => {
    if (!previewOriginalDoc.current) return
    setUndoStack(prev => [...prev, { doc: previewOriginalDoc.current!, mutation }])
    setRedoStack([])
    suppressUndoRef.current = false
    previewOriginalDoc.current = null
  }, [])

  const cancelPreview = useCallback(() => {
    suppressUndoRef.current = false
    const original = previewOriginalDoc.current
    previewOriginalDoc.current = null
    return original
  }, [])

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
    fromCache,
    cacheTimestamp,
    setRollbackPos: (pos: number | null) => { rollbackPosRef.current = pos },
    setPickBoundary: (pos: number | null) => { pickBoundaryRef.current = pos },
    startPreviewMode,
    commitPreview,
    cancelPreview,
  }
}
