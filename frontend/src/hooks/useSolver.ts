import { useState, useCallback, useRef, useEffect } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, SketchData, EntityStatus, BuildResponse, BodyResult, PartStyleEntry, RebuildValidation } from '@/types/cad'
import { useSolverStore } from '@/stores/solverStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { unflattenGeometry } from '@/utils/geometry/geometryMapping'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'

import { PART_COLOR_PALETTE, normalizeHexColor } from '@/utils/core/partColors'
import { BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'
import { failLoud } from '@/stores/stateInvariants'
import { isDocFullyPorted, unportedKinds } from '@/kernel/builder'
import { solveViaWorker } from '@/kernel/worker/solverClient'

const SKETCH_KINDS = new Set(['sketch', 'plane'])

/**
 * Discriminated union over the dual-world invariant:
 * - `'full'` — normal mode, no pick bodies (compile-time absent from type)
 * - `'editing'` — feature edit mode, both worlds active
 *
 * The union guarantees that pickBodies can never be set or read outside the
 * `'editing'` variant. Any code that accesses `world.pickBodies` without first
 * narrowing `world.status === 'editing'` is a type error.
 */
export type WorldState =
  | { status: 'full'; bodies: Record<string, BodyResult> }
  | { status: 'editing'; bodies: Record<string, BodyResult>; pickBodies: Record<string, BodyResult> }

export function pickPartColor(partNumber: number): string {
  return PART_COLOR_PALETTE[(partNumber - 1) % PART_COLOR_PALETTE.length]
}

export function reconcilePartStyle(doc: PartDoc, bodies: Record<string, BodyResult> | undefined): void {
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

export function useSolver(
  uuid: string | undefined,
  setCodeText: (t: string) => void,
  modeRef: React.MutableRefObject<string>,
  { onFirstSolve }: { onFirstSolve?: () => void } = {},
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
) {
  const [solveResults, setSolveResults] = useState<Record<string, SketchData>>({})
  // Single state atom for the dual-world invariant: the body geometry in
  // normal mode vs. the pair (bodies + pickBodies) during feature editing.
  // The WorldState union enforces at compile time that pickBodies only exists
  // inside the 'editing' variant — accessing it on 'full' is a type error.
  const [world, setWorld] = useState<WorldState>({ status: 'full', bodies: {} })
  const bodies: Record<string, BodyResult> = world.bodies
  const pickBodies: Record<string, BodyResult> = world.status === 'editing' ? world.pickBodies : {}
  const [solving, setSolving] = useState(false)
  const [featureTimings, setFeatureTimings] = useState<Record<string, number>>({})
  const [solveTime, setSolveTime] = useState<number | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [solveResult, setSolveRawResult] = useState<string>('')
  const [validation, setValidation] = useState<RebuildValidation | null>(null)
  const firstSolveDone = useRef(false)
  const requestIdRef = useRef(0)
  const cancelledRef = useRef(false)

  const applySolveResult = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number): { cloned: PartDoc; hadCleanup: boolean } => {
    const result = data.result as Record<string, {
      geometry?: Record<string, number[]>
      resolved_kinds?: Record<string, string>
      status?: string
      features?: Record<string, { status?: string }>
      topology?: import('@/types/cad').Topology
      originLocal?: [number, number]
      plane_transform?: import('@/types/cad').PlaneTransform
      constraints?: Record<string, { residual: number; render: import('@/types/cad').ConstraintRender; superfluous: boolean }>
      plane?: { origin: number[]; x_axis: number[]; y_axis: number[]; normal: number[] }
      body_id?: string
      exception?: string
      solve_ms?: number
      projection_errors?: string[]
    }>

    const cloned: PartDoc = structuredClone(d)
    let hadCleanup = false
    const results: Record<string, SketchData> = {}
    for (const [id, feature] of Object.entries(result)) {
      const featureDef = (cloned.features ?? []).find(f => f.id === id)
      if (feature.geometry) {
        const superfluousIds = feature.constraints
          ? new Set(Object.entries(feature.constraints).filter(([, c]) => c.superfluous).map(([cid]) => cid))
          : new Set<string>()
        const cleaned = applyGeometryToFeature(cloned, id, feature.geometry, superfluousIds, feature.resolved_kinds, feature.projection_errors)
        if (cleaned) hadCleanup = true
        const solved = unflattenGeometry(feature.geometry, featureDef?.entities)
        const astPosById = new Map(
          (featureDef?.constraints ?? [])
            .filter(c => c.pos)
            .map(c => [c.id, c.pos!])
        )
        const constraints: import('@/types/cad').Constraints | undefined = feature.constraints
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
          ...(feature.originLocal && { originLocal: feature.originLocal }),
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
          ...(feature.plane_transform && { plane_transform: feature.plane_transform }),
        }
      }
    }
    if (data.bodies) {
      reconcilePartStyle(cloned, data.bodies)
    }
    setSolveResults(results)
    const timings: Record<string, number> = {}
    for (const [id, feature] of Object.entries(result)) {
      if (typeof feature.solve_ms === 'number') {
        timings[id] = feature.solve_ms
      }
    }
    setFeatureTimings(timings)
    setDoc(cloned)
    docRef.current = cloned
    // The result dump only feeds the code tab's read-only pane. Serialize it
    // lazily (and as JSON, the native shape of the JS result object) only when
    // that tab is open, instead of on every solve. The document codeText stays
    // YAML -- that is the editable input representation.
    if (modeRef.current === 'code') {
      setSolveRawResult(JSON.stringify(data.result, null, 2))
      setCodeText(stringifyYaml(cloned))
    }
    setSolveError(null)
    if (solveTimeMs !== undefined) {
      setSolveTime(solveTimeMs)
    }
    return { cloned, hadCleanup }
  }, [setCodeText, modeRef, docRef, setDoc])

  const applyBuildResponse = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number, expectedRequestId?: number): { cloned: PartDoc; hadCleanup: boolean } | null => {
    // Stale-guard: if a newer reSolve has been issued, discard this response.
    if (expectedRequestId !== undefined && expectedRequestId !== requestIdRef.current) return null
    const solveResult = applySolveResult(d, data, solveTimeMs)
    // Single set — the world transitions atomically.
    // If the solve was requested with a pick_boundary the response carries
    // pick_bodies (or {} when the checkpoint was unavailable), so the
    // world enters 'editing'. Otherwise it goes to 'full' and pickBodies
    // is structurally absent from the type.
    const store = usePartEditorStore.getState()
    const wasEditing = store.pickBoundary !== null
    if (wasEditing && data.pick_bodies !== undefined) {
      setWorld({ status: 'editing', bodies: data.bodies ?? {}, pickBodies: data.pick_bodies })
    } else {
      setWorld({ status: 'full', bodies: data.bodies ?? {} })
    }
    return solveResult
  }, [applySolveResult])

  const reSolve = useCallback(async (
    d: PartDoc,
    opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string }; _isCleanupReSolve?: boolean },
  ) => {
    setSolving(true)
    setSolveTime(null)
    const startTime = performance.now()

    const currentRequestId = ++requestIdRef.current
    const isStale = () => currentRequestId !== requestIdRef.current
    const isCurrent = () => currentRequestId === requestIdRef.current && !cancelledRef.current
    try {
      const allFeatures = d.features ?? []

      const store = usePartEditorStore.getState()
      const storeRollback = store.rollbackPosition
      const pickBoundary = store.pickBoundary
      const editingFeatureId = store.editingFeatureId
      const effectiveRollback = storeRollback ?? allFeatures.length

      let solveFeatures = allFeatures.slice(0, effectiveRollback).filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
      const dragAnchor = opts?.dragAnchor
      if (dragAnchor) {
        // Transient hint: tells the solver which entity was just dragged so it can
        // anchor it firmly at the dropped position. Attached only to the payload
        // clone, never persisted to the doc or cache key.
        solveFeatures = solveFeatures.map(f =>
          f.id === dragAnchor.featureId ? { ...f, drag_anchor: dragAnchor.entityId } : f,
        )
      }
      const adjustedRollback = solveFeatures.length
      const isPreview = storeRollback !== null || pickBoundary !== null

      assertEditingInvariant(editingFeatureId, allFeatures, effectiveRollback, pickBoundary)

      const solvePayload: Record<string, unknown> = {
        ...d,
        ...(uuid ? { id: uuid } : {}),
        features: solveFeatures,
        rollback_position: adjustedRollback,
        request_version: currentRequestId,
        is_preview: isPreview,
      }

      if (pickBoundary !== null) {
        solvePayload.pick_boundary = pickBoundary
      }

      if (opts?.validate) {
        solvePayload._validate = true
      }

      // Empty doc or preview-only (rollback at 0): nothing to solve. Clear the
      // result/body state so the viewport empties.
      if (solveFeatures.length === 0) {
        if (isStale()) return
        setSolveResults({})
        setWorld({ status: 'full', bodies: {} })
        setSolveError(null)
        if (!firstSolveDone.current && onFirstSolve) {
          firstSolveDone.current = true
          setTimeout(onFirstSolve, 0)
        }
        if (!cancelledRef.current) setSolving(false)
        return
      }

      // The browser TS/WASM kernel is the only solver. A doc with an unported
      // feature kind cannot be solved locally; surface that instead of failing
      // silently (the Python WebSocket fallback was removed with the daemon).
      if (!isDocFullyPorted(solveFeatures)) {
        const missing = [...unportedKinds(solveFeatures)].join(', ')
        const msg = `Cannot solve: unported feature kinds: ${missing}`
        setSolveError(msg)
        setSolveRawResult(msg)
        if (!cancelledRef.current) setSolving(false)
        return
      }

      // The solver Worker owns the cross-solve checkpoint cache (persistent
      // HandleTable + last BuildState, keyed by doc id) so incremental rebuild
      // reuses the clean prefix; the work runs off the main thread so a long
      // solve never freezes the UI.
      const local = await solveViaWorker(solvePayload, {
        pickBoundary: pickBoundary ?? null,
        rollbackPosition: adjustedRollback,
        validate: opts?.validate,
      })
      if (!local) {
        const msg = 'Local solver unavailable (OCC.js failed to load)'
        setSolveError(msg)
        setSolveRawResult(msg)
        if (!cancelledRef.current) setSolving(false)
        return
      }
      if (isStale()) return
      const endTime = performance.now()
      const solveTimeMs = Math.round((endTime - startTime) * 100) / 100
      if (local._validation) setValidation(local._validation)
      // applyBuildResponse sets bodies (the preview/result state) and, when a
      // pick_boundary was requested, pick_bodies (the "before" state). The TS
      // kernel tessellates the pick checkpoint's bodies, so pick_bodies carry
      // real mesh/edge geometry to pick against while editing.
      const buildResult = applyBuildResponse(d, local as unknown as BuildResponse, solveTimeMs, currentRequestId)
      if (!firstSolveDone.current && onFirstSolve) {
        firstSolveDone.current = true
        setTimeout(onFirstSolve, 0)
      }
      // One-shot re-solve after dangling-projection cleanup: projection_errors
      // caused stale entities to be removed from the doc; re-solve with the
      // cleaned doc so the solver sees the reduced entity set. Not triggered on
      // the cleanup re-solve itself to prevent infinite recursion.
      if (buildResult?.hadCleanup && !opts?._isCleanupReSolve) {
        await reSolve(buildResult.cloned, { ...opts, _isCleanupReSolve: true })
        return  // inner call handles setSolving(false) via finally
      }
      if (!cancelledRef.current) setSolving(false)
    } catch (e) {
      const msg = String(e)
      setSolveError(msg)
      setSolveRawResult(msg)
    } finally {
      if (isCurrent()) setSolving(false)
    }
  }, [onFirstSolve, uuid, applyBuildResponse])

  const resetSolver = useCallback(() => {
    firstSolveDone.current = false
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  useEffect(() => {
    return () => {
      useSolverStore.getState().setIsSolving(false)
    }
  }, [])

  // Subscribe to pickBoundary cleared -> drop pickBodies so the viewport
  // doesn't keep rendering them after an exit/cancel. Reads the current
  // world via ref so the update keeps the latest bodies.
  const worldRef = useRef(world)
  worldRef.current = world
  useEffect(() => {
    return usePartEditorStore.subscribe((state, prev) => {
      if (prev.pickBoundary !== null && state.pickBoundary === null) {
        setWorld({ status: 'full', bodies: worldRef.current.bodies })
      }
    })
  }, [])

  return {
    solveResults,
    setSolveResults,
    bodies,
    pickBodies,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    setSolveRawResult,
    featureTimings,
    reSolve,
    resetSolver,
    validation,
    clearValidation: () => setValidation(null),
  }
}

function assertEditingInvariant(
  editingFeatureId: string | null,
  allFeatures: PartDoc['features'],
  rollback: number,
  pickBoundary: number | null,
): void {
  if (editingFeatureId === null) return
  const features = allFeatures ?? []
  const idx = features.findIndex(f => f.id === editingFeatureId)
  if (idx < 0) return  // edit FSM hasn't synced to doc yet (e.g. add+enter)
  const feature = features[idx]
  if (SKETCH_KINDS.has(feature.kind)) return  // sketches/planes don't use pick_boundary

  const expectedRollback = idx + 1
  const nonBuiltIns = features.filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
  const expectedPickBoundary = nonBuiltIns.findIndex(f => f.id === editingFeatureId)

  if (rollback !== expectedRollback) {
    failLoud(
      `[invariant] editingFeatureId='${editingFeatureId}' (idx=${idx}, kind=${feature.kind}) `
      + `expected rollback=${expectedRollback}, got ${rollback}`,
    )
  }
  if (pickBoundary !== expectedPickBoundary) {
    failLoud(
      `[invariant] editingFeatureId='${editingFeatureId}' (idx=${idx}, kind=${feature.kind}) `
      + `expected pick_boundary=${expectedPickBoundary}, got ${pickBoundary}`,
    )
  }
}
