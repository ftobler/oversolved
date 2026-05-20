import { useState, useCallback, useRef, useEffect } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, SketchData, EntityStatus, BuildResponse, BodyResult, PartStyleEntry, RebuildValidation } from '@/types/cad'
import { solverWs } from '@/hooks/solverWs'
import { useSolverStore } from '@/stores/solverStore'
import { unflattenGeometry } from '@/utils/geometryMapping'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'
import { useGeometryCache } from '@/hooks/useGeometryCache'
import { PART_COLOR_PALETTE, normalizeHexColor } from '@/utils/partColors'
import { unpackBodies, unpackPickBodies } from '@/utils/geometryUnpack'
import type { GeometryHeader } from '@/utils/geometryUnpack'
import { BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

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
  const [bodies, setBodies] = useState<Record<string, BodyResult>>({})
  const [pickBodies, setPickBodies] = useState<Record<string, BodyResult>>({})
  const [solving, setSolving] = useState(false)
  const [featureTimings, setFeatureTimings] = useState<Record<string, number>>({})
  const [solveTime, setSolveTime] = useState<number | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [solveResult, setSolveRawResult] = useState<string>('')
  const [validation, setValidation] = useState<RebuildValidation | null>(null)
  const firstSolveDone = useRef(false)
  const rollbackPosRef = useRef<number | null>(null)
  const pickBoundaryRef = useRef<number | null>(null)
  const requestIdRef = useRef(0)
  const lastValidMsgIdRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)

  const { getCachedBuildResponse, cacheBuildResponse, cacheGeometry } = useGeometryCache(uuid)

  const applySolveResult = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number) => {
    const result = data.result as Record<string, {
      geometry?: Record<string, number[]>
      status?: string
      features?: Record<string, { status?: string }>
      topology?: import('@/types/cad').Topology
      plane_transform?: import('@/types/cad').PlaneTransform
      constraints?: Record<string, { residual: number; render: import('@/types/cad').ConstraintRender; superfluous: boolean }>
      plane?: { origin: number[]; x_axis: number[]; y_axis: number[]; normal: number[] }
      body_id?: string
      exception?: string
      solve_ms?: number
    }>

    const cloned: PartDoc = structuredClone(d)
    const results: Record<string, SketchData> = {}
    for (const [id, feature] of Object.entries(result)) {
      const featureDef = (cloned.features ?? []).find(f => f.id === id)
      if (feature.geometry) {
        const superfluousIds = feature.constraints
          ? new Set(Object.entries(feature.constraints).filter(([, c]) => c.superfluous).map(([cid]) => cid))
          : new Set<string>()
        applyGeometryToFeature(cloned, id, feature.geometry, superfluousIds)
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
    setSolveResults(results)
    const timings: Record<string, number> = {}
    for (const [id, feature] of Object.entries(result)) {
      if (typeof feature.solve_ms === 'number') {
        timings[id] = feature.solve_ms
      }
    }
    setFeatureTimings(timings)
    setSolveRawResult(stringifyYaml(data.result))
    setDoc(cloned)
    docRef.current = cloned
    if (modeRef.current === 'code') {
      setCodeText(stringifyYaml(cloned))
    }
    setSolveError(null)
    if (solveTimeMs !== undefined) {
      setSolveTime(solveTimeMs)
    }
  }, [setCodeText, modeRef, docRef, setDoc])

  const applyGeometryUpdate = useCallback((msgId: number, header: GeometryHeader, buffer: ArrayBuffer, jsonHeaderLen: number) => {
    try {
      if (lastValidMsgIdRef.current !== null && msgId !== lastValidMsgIdRef.current) {
        return
      }
      const unpacked = unpackBodies(header, buffer, jsonHeaderLen)
      const d = docRef.current
      if (d) reconcilePartStyle(d, unpacked)
      setBodies(unpacked)
      if (header.pick_bodies && Object.keys(header.pick_bodies).length > 0) {
        setPickBodies(unpackPickBodies(header, buffer, jsonHeaderLen))
      } else {
        setPickBodies({})
      }
      if (uuid && d) {
        const rollback = rollbackPosRef.current ?? (d.features?.length ?? 0)
        const pickBoundary = pickBoundaryRef.current
        cacheGeometry(d, rollback, pickBoundary, { header, buffer, jsonHeaderLen })
      }
    } catch (e) {
      console.error('[usePartDoc] Error applying geometry update:', e)
    }
  }, [uuid, docRef, cacheGeometry])

  useEffect(() => {
    return solverWs.onGeometryUpdate(applyGeometryUpdate)
  }, [applyGeometryUpdate])

  const applyBuildResponse = useCallback((d: PartDoc, data: BuildResponse, solveTimeMs?: number) => {
    applySolveResult(d, data, solveTimeMs)
    if (data.bodies) {
      reconcilePartStyle(d, data.bodies)
      setBodies(data.bodies)
    }
    if (data.pick_bodies !== undefined) {
      setPickBodies(data.pick_bodies)
    }
  }, [applySolveResult])

  const reSolve = useCallback(async (
    d: PartDoc,
    rollbackPosition?: number | null,
    opts?: { validate?: boolean; bypassCache?: boolean },
  ) => {
    setSolving(true)
    setSolveTime(null)
    const startTime = performance.now()

    const currentRequestId = ++requestIdRef.current
    const isStale = () => currentRequestId !== requestIdRef.current
    const isCurrent = () => currentRequestId === requestIdRef.current && !cancelledRef.current
    try {
      const allFeatures = d.features ?? []
      const effectiveRollback = rollbackPosition !== undefined
        ? (rollbackPosition ?? allFeatures.length)
        : ((rollbackPosRef.current ?? allFeatures.length) || allFeatures.length)

      const solveFeatures = allFeatures.slice(0, effectiveRollback).filter(f => !BUILTIN_FEATURE_IDS.has(f.id))

      const adjustedRollback = solveFeatures.length

      const isPreview = rollbackPosition !== undefined || pickBoundaryRef.current !== null
      const pickBoundary = pickBoundaryRef.current

      if (uuid && !opts?.bypassCache) {
        const cached = await getCachedBuildResponse(d, effectiveRollback, pickBoundary)
        if (cached && cached.isFresh) {
          if (isStale()) {
            return
          }
          rollbackPosRef.current = effectiveRollback
          applyBuildResponse(d, cached.entry.buildResponse)
          if (cached.entry.geometry) {
            const { header, buffer, jsonHeaderLen } = cached.entry.geometry
            lastValidMsgIdRef.current = header.msgId
            applyGeometryUpdate(header.msgId, header, buffer, jsonHeaderLen)
          }
          if (!cancelledRef.current) setSolving(false)
          if (!firstSolveDone.current && onFirstSolve) {
            firstSolveDone.current = true
            setTimeout(onFirstSolve, 0)
          }
          return
        }
      }

      if (isStale()) {
        return
      }

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

      const response = await solverWs.solve(solvePayload) as Record<string, unknown>

      if (isStale()) {
        return
      }

      // Defense-in-depth: even though solverWs routes by msgId, verify the backend
      // echoed our request_version. Drop responses with a stale or missing version.
      const respVersion = response.request_version
      if (typeof respVersion === 'number' && respVersion < requestIdRef.current) {
        return
      }
      rollbackPosRef.current = effectiveRollback
      if (response.msgId != null) {
        lastValidMsgIdRef.current = response.msgId as number
      }

      const endTime = performance.now()
      const solveTimeMs = Math.round((endTime - startTime) * 100) / 100

      if (response.error) {
        setSolveError(String(response.error))
        setSolveRawResult(String(response.error))
      } else {
        const buildResponse = response as unknown as BuildResponse
        if (buildResponse.validation !== undefined) {
          setValidation(buildResponse.validation)
        } else if (opts?.validate) {
          // Validation was requested but the server did not echo one back.
          setValidation(null)
        }
        if (uuid) {
          // Don't update cache if validation failed structurally -- the bad
          // state stays available for debugging until the user retries.
          const v = buildResponse.validation
          const okToCache = !v || v.passed || v.fp_only === true
          if (okToCache) {
            await cacheBuildResponse(d, effectiveRollback, pickBoundary, buildResponse)
          }
          if (isStale()) return
        }
        applySolveResult(d, buildResponse, solveTimeMs)
        if (!firstSolveDone.current && onFirstSolve) {
          firstSolveDone.current = true
          setTimeout(onFirstSolve, 0)
        }
      }
    } catch (e) {
      const msg = String(e)
      if (!msg.includes('WebSocket closed')) {
        setSolveError(msg)
        setSolveRawResult(msg)
      }
    } finally {
      if (isCurrent()) setSolving(false)
    }
  }, [onFirstSolve, uuid, applyBuildResponse, applySolveResult, applyGeometryUpdate, getCachedBuildResponse, cacheBuildResponse])

  const resetSolver = useCallback(() => {
    rollbackPosRef.current = null
    firstSolveDone.current = false
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  useEffect(() => {
    return () => {
      solverWs.disconnect()
      useSolverStore.getState().setIsSolving(false)
    }
  }, [])

  const setRollbackPos = useCallback((pos: number | null) => { rollbackPosRef.current = pos }, [])

  const setPickBoundary = useCallback((pos: number | null) => {
    pickBoundaryRef.current = pos
    if (pos === null) setPickBodies({})
  }, [setPickBodies])

  return {
    solveResults,
    setSolveResults,
    bodies,
    pickBodies,
    setPickBodies,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    setSolveRawResult,
    featureTimings,
    reSolve,
    resetSolver,
    setRollbackPos,
    setPickBoundary,
    validation,
    clearValidation: () => setValidation(null),
  }
}
