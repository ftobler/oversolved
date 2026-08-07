import { useState, useCallback, useRef, useEffect } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, SketchData, EntityStatus, BuildResponse, BodyResult, PartStyleEntry, RebuildValidation, FeatureHandleData } from '@/types/cad'
import { useSolverStore } from '@/stores/solverStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { unflattenGeometry } from '@/utils/geometry/geometryMapping'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'

import { PART_COLOR_PALETTE } from '@/utils/core/partColors'
import { BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'
import { failLoud } from '@/stores/stateInvariants'
import { isDocFullyPorted, unportedKinds } from '@/kernel/builder'
import { solveViaWorker, cancelSolver } from '@/kernel/worker/solverClient'
import { SUPERSEDED_ERROR } from '@/kernel/worker/solverProtocol'

const SKETCH_KINDS = new Set(['sketch', 'plane'])
// Solve failures that are not document errors and must not reach the error
// banner: the user cancelled, the watchdog killed a hung Worker, a Worker trap
// (the crash itself or its cooldown backoff), or a newer solve flushed this one
// out of the Worker queue before it ran. The trap is crash noise, not a
// document failure: the console error already surfaced it, and every reSolve
// inside the cooldown rejects with the backoff string purely by design.
const BENIGN_SOLVE_FAILURES = new Set([
  'solve cancelled',
  'solver worker timed out',
  'solver worker crashed',
  'solver worker crashed (backoff)',
  SUPERSEDED_ERROR,
])
const EMPTY_PICK_BODIES: Record<string, BodyResult> = {}

/**
 * Discriminated union over the dual-world invariant:
 * - `'full'`: normal mode, no pick bodies (compile-time absent from type)
 * - `'editing'`: feature edit mode, both worlds active
 *
 * The union guarantees that pickBodies can never be set or read outside the
 * `'editing'` variant. Any code that accesses `world.pickBodies` without first
 * narrowing `world.status === 'editing'` is a type error.
 */
type WorldState =
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
    if (nextStyle[bodyId]) continue
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
  { onFirstSolve, onSolveApplied }: { onFirstSolve?: () => void; onSolveApplied?: (featureIds: string[]) => void } = {},
  docRef: React.MutableRefObject<PartDoc | null>,
  setDoc: React.Dispatch<React.SetStateAction<PartDoc | null>>,
) {
  const [solveResults, setSolveResults] = useState<Record<string, SketchData>>({})
  // Single state atom for the dual-world invariant: the body geometry in
  // normal mode vs. the pair (bodies + pickBodies) during feature editing.
  // The WorldState union enforces at compile time that pickBodies only exists
  // inside the 'editing' variant, accessing it on 'full' is a type error.
  const [world, setWorld] = useState<WorldState>({ status: 'full', bodies: {} })
  const bodies: Record<string, BodyResult> = world.bodies
  const pickBodies: Record<string, BodyResult> = world.status === 'editing' ? world.pickBodies : EMPTY_PICK_BODIES
  // True once a solve carrying pick bodies has landed. Entering an edit flips
  // the store's editing flags immediately, but the two worlds only exist after
  // that solve returns -- a ghost preview drawn before it has no "before" state
  // to subtract, so it paints the entire model as new (pink) geometry.
  const pickStateReady = world.status === 'editing'
  const [solving, setSolving] = useState(false)
  const [featureTimings, setFeatureTimings] = useState<Record<string, number>>({})
  const [solveTime, setSolveTime] = useState<number | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [solveResult, setSolveRawResult] = useState<string>('')
  const [validation, setValidation] = useState<RebuildValidation | null>(null)
  const firstSolveDone = useRef(false)
  const requestIdRef = useRef(0)
  const cancelledRef = useRef(false)

  const applySolveResult = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number): PartDoc => {
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
      body_ids?: string[]
      value?: number
      exception?: string
      handle?: FeatureHandleData
      solve_ms?: number
      projection_errors?: string[]
    }>

    const cloned: PartDoc = structuredClone(d)
    const results: Record<string, SketchData> = {}
    for (const [id, feature] of Object.entries(result)) {
      const featureDef = (cloned.features ?? []).find(f => f.id === id)
      if (feature.geometry) {
        applyGeometryToFeature(cloned, id, feature.geometry)
        // A projection can resolve to a different kind than was declared at pick
        // time (a tilted circle -> ellipse, a partial ellipse -> spline). The
        // resolved kind shapes the rendered sketch here without rewriting the
        // authored entity kind in the doc on every solve.
        const resolvedEntities = feature.resolved_kinds
          ? (featureDef?.entities ?? []).map(e => ({ ...e, kind: feature.resolved_kinds?.[e.id] ?? e.kind }))
          : featureDef?.entities
        const solved = unflattenGeometry(feature.geometry, resolvedEntities)
        const astPosById = new Map(
          (featureDef?.constraints ?? [])
            .filter(c => c.pos)
            .map(c => [c.id, c.pos!])
        )
        // Superfluous constraints stay visible and flagged instead of being
        // written out of the doc; the flag is what the cleanup command reads.
        const constraints: import('@/types/cad').Constraints | undefined = feature.constraints
          ? Object.fromEntries(
              Object.entries(feature.constraints).map(([cid, c]) => {
                const pos = astPosById.get(cid)
                const render = pos ? { ...c.render, pos } : c.render
                return [cid, { render, residual: c.residual, ...(c.superfluous ? { superfluous: true } : {}) }]
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
          ...(feature.projection_errors?.length && { projection_errors: feature.projection_errors }),
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
          // `body_ids` and `value` are read by the feature tree and were being
          // dropped here, so both consumers silently saw undefined: the
          // split-sibling mesh-error check fell back to `body_id` alone, and a
          // variable's inline `name = 100` never rendered.
          ...(feature.body_ids !== undefined && { body_ids: feature.body_ids }),
          ...(feature.value !== undefined && { value: feature.value }),
          ...(feature.exception !== undefined && { exception: feature.exception }),
          ...(feature.handle !== undefined && { handle: feature.handle }),
          ...(feature.plane_transform && { plane_transform: feature.plane_transform }),
        }
      }
    }
    if (data.bodies) {
      reconcilePartStyle(cloned, data.bodies)
    }
    setSolveResults(results)
    // A fresh solve owns the per-primitive pick claims: the geometry that just
    // re-tessellated can shift a pickKey's positional index onto a different
    // primitive, so every claim recorded before this solve is stale. Clear them
    // here, the one point every applied solve converges on, so computeHighlight
    // re-highlights by the durable query membership until the user picks again.
    useSketchEditorStore.getState().clearSelectedPicks()
    // A fresh result for a feature supersedes any retained pre-delete snapshot
    // of it (usePartDoc's undo stash). Only an APPLIED solve reaches this point
    // (the request-id staleness guard runs before applyBuildResponse calls us),
    // so a stale or failing solve never clears the stash.
    onSolveApplied?.(Object.keys(results))
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
    return cloned
  }, [setCodeText, modeRef, docRef, setDoc, onSolveApplied])

  const applyBuildResponse = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number, expectedRequestId?: number): PartDoc | null => {
    // Stale-guard: if a newer reSolve has been issued, discard this response.
    if (expectedRequestId !== undefined && expectedRequestId !== requestIdRef.current) return null
    const cloned = applySolveResult(d, data, solveTimeMs)
    // Single set, the world transitions atomically.
    // Every solve requested with an in-range pick_boundary carries pick_bodies,
    // {} when the checkpoint is unavailable or the boundary is 0 (the empty doc
    // before the first feature), so the world enters 'editing'. Out-of-range
    // boundaries (only possible via direct build() calls) still omit the key.
    // Otherwise it goes to 'full' and pickBodies is structurally absent from
    // the type.
    const store = usePartEditorStore.getState()
    const wasEditing = store.pickBoundary !== null
    if (wasEditing && data.pick_bodies !== undefined) {
      setWorld({ status: 'editing', bodies: data.bodies ?? {}, pickBodies: data.pick_bodies })
    } else {
      setWorld({ status: 'full', bodies: data.bodies ?? {} })
    }
    return cloned
  }, [applySolveResult])

  const reSolve = useCallback(async (
    d: PartDoc,
    opts?: { validate?: boolean; bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string }; _suppressFirstSolve?: boolean; _restoreSolveResults?: Record<string, SketchData> },
  ) => {
    setSolving(true)
    setSolveTime(null)
    const startTime = performance.now()

    const currentRequestId = ++requestIdRef.current
    const isStale = () => currentRequestId !== requestIdRef.current
    const isCurrent = () => currentRequestId === requestIdRef.current && !cancelledRef.current
    // handleMutation prunes solveResults optimistically for content-removing
    // edits; on a failing solve that prune would leave the affected features as
    // ghosts. Restore the pruned entries so the last known geometry stays
    // visible. A stale failure skips this because a newer solve owns the record.
    const restorePrunedResults = () => {
      const restored = opts?._restoreSolveResults
      if (restored && isCurrent()) {
        setSolveResults(prev => ({ ...prev, ...restored }))
      }
    }
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
        if (!firstSolveDone.current && !opts?._suppressFirstSolve && onFirstSolve) {
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
        restorePrunedResults()
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
        bypassCache: opts?.bypassCache,
      })
      // A stale solve must exit before any setState: a newer reSolve owns the
      // banner and the spinner, so a stale null must not paint "Local solver
      // unavailable" nor clear solving under the newer solve.
      if (isStale()) return
      if (!local) {
        const msg = 'Local solver unavailable (OCC.js failed to load)'
        setSolveError(msg)
        setSolveRawResult(msg)
        restorePrunedResults()
        if (!cancelledRef.current) setSolving(false)
        return
      }
      const endTime = performance.now()
      const solveTimeMs = Math.round((endTime - startTime) * 100) / 100
      if (local._validation) setValidation(local._validation)
      // applyBuildResponse sets bodies (the preview/result state) and, when a
      // pick_boundary was requested, pick_bodies (the "before" state). The TS
      // kernel tessellates the pick checkpoint's bodies, so pick_bodies carry
      // real mesh/edge geometry to pick against while editing.
      applyBuildResponse(d, local as BuildResponse, solveTimeMs, currentRequestId)
      if (!firstSolveDone.current && !opts?._suppressFirstSolve && onFirstSolve) {
        firstSolveDone.current = true
        setTimeout(onFirstSolve, 0)
      }
      if (!cancelledRef.current) setSolving(false)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      // Every failure restores the pruned entries (guarded against a stale
      // failure); the error banner stays suppressed for the benign kinds.
      restorePrunedResults()
      // A stale non-benign failure (e.g. a crash surfaced after dropWorker
      // rejected a superseded solve) must not banner either: the newer solve's
      // outcome owns the banner, and its benign result will never clear it.
      if (isStale()) return
      if (!BENIGN_SOLVE_FAILURES.has(reason)) {
        setSolveError(String(e))
        setSolveRawResult(String(e))
      }
    } finally {
      if (isCurrent()) setSolving(false)
    }
  }, [onFirstSolve, uuid, applyBuildResponse])

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  useEffect(() => {
    useSolverStore.getState().setOnCancelSolve(() => {
      cancelSolver()
    })
    return () => {
      useSolverStore.getState().setOnCancelSolve(null)
    }
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
    pickStateReady,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    setSolveRawResult,
    featureTimings,
    reSolve,
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
