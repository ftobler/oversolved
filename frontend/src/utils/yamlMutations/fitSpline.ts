/**
 * Fit-spline document mutations: the variable-size entity's own editors.
 *
 * A fit spline's params are positional (`2 N + 2 h`), and its `fit<k>` vertex
 * keys are positional too, so inserting or deleting a point renumbers every
 * later `fit<j>` constraint ref in the same mutation. Keeping these writers
 * beside each other is what makes that atomic: a caller cannot edit the params
 * without also fixing the refs.
 */
import type { PartConstraint, PartDoc, PartEntityDef, Point, SketchFeature } from '@/types/cad'
import { CONSTRAINT_REF_FIELDS, findSketchFeature, fitPointRef, isVertexKeyRef, mintEntityId, parseFitPointRef, resolveSketch, round, warn } from './helpers'
import { handlesFromTangents } from '@/utils/geometry/fitSpline'
import { fitPointIndex, MAX_FIT_POINT_KEY } from '@/types/vertexKeys'

export const MAX_FIT_POINTS = MAX_FIT_POINT_KEY + 2

export type FitSplineHandles = 'start' | 'end' | 'both'

export interface FitSplineAddOptions {
  /** Authored end tangents as D-vectors; the writer converts them to handles. */
  tangents?: [Point | null, Point | null]
  /** CadQuery's default: rescale the tangent magnitudes. */
  tangentScale?: boolean
}

export interface FitSplineDocEntity {
  def: PartEntityDef
  points: Point[]
  handleStart?: Point
  handleEnd?: Point
}

function handleCount(handles?: FitSplineHandles): number {
  return handles === 'both' ? 2 : handles === 'start' || handles === 'end' ? 1 : 0
}

/** Decode one fit_spline entity from the document, or null when absent/malformed. */
export function readFitSpline(feature: SketchFeature, eid: string): FitSplineDocEntity | null {
  const def = feature.entities?.find(e => e.id === eid)
  if (!def || def.kind !== 'fit_spline') return null
  const params = feature.initial?.[eid]
  if (!Array.isArray(params)) return null
  const count = handleCount(def.handles)
  const remaining = params.length - 2 * count
  if (remaining < 4 || remaining % 2 !== 0) return null
  const n = remaining / 2
  const points: Point[] = []
  for (let i = 0; i < n; i++) points.push([params[2 * i], params[2 * i + 1]])
  let next = 2 * n
  const out: FitSplineDocEntity = { def, points }
  if (def.handles === 'start' || def.handles === 'both') {
    out.handleStart = [params[next], params[next + 1]]
    next += 2
  }
  if (def.handles === 'end' || def.handles === 'both') out.handleEnd = [params[next], params[next + 1]]
  return out
}

/** Persist the points and handles back into the entity record and its block. */
export function writeFitSpline(
  feature: SketchFeature,
  def: PartEntityDef,
  points: Point[],
  handleStart?: Point,
  handleEnd?: Point,
): void {
  const block = [
    ...points.flatMap(p => [p[0], p[1]]),
    ...(handleStart ? [handleStart[0], handleStart[1]] : []),
    ...(handleEnd ? [handleEnd[0], handleEnd[1]] : []),
  ]
  if (!feature.initial) feature.initial = {}
  feature.initial[def.id] = block.map(round)
  const handles: FitSplineHandles | undefined =
    handleStart && handleEnd ? 'both' : handleStart ? 'start' : handleEnd ? 'end' : undefined
  if (handles) def.handles = handles
  else delete def.handles
}

/** True when the point list is a legal fit spline: 2..64 finite points, no zero span. */
export function fitPointsProblem(points: readonly Point[]): string | null {
  if (points.length < 2) return `needs at least 2 fit points, got ${points.length}`
  if (points.length > MAX_FIT_POINTS) return `has ${points.length} fit points, the limit is ${MAX_FIT_POINTS}`
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return 'has a non-finite fit point'
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1][0] === points[i][0] && points[i - 1][1] === points[i][1]) {
      return `has coincident consecutive fit points ${i - 1},${i}`
    }
  }
  return null
}

/**
 * Author a fit spline into the sketch. `params` is the flat fit-point list; the
 * optional tangents are converted to absolute handles here (D2 + OCCT's
 * `ScaleTangents`), so the document stores the same handle points the UI would.
 */
export function applyAddFitSpline(
  doc: PartDoc,
  featureId: string,
  params: number[],
  entityId: string | undefined,
  options: FitSplineAddOptions = {},
): string | null {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return null
  const points: Point[] = []
  for (let i = 0; i + 1 < params.length; i += 2) points.push([params[i], params[i + 1]])
  if (params.length % 2 !== 0) {
    warn('applyAddFitSpline: ignoring an odd param count', { featureId, count: params.length })
    return null
  }
  const problem = fitPointsProblem(points)
  if (problem) {
    warn(`applyAddFitSpline: ${problem}`, { featureId })
    return null
  }
  let handleStart: Point | undefined
  let handleEnd: Point | undefined
  if (options.tangents) {
    const [t0, t1] = options.tangents
    if ((t0 && (t0[0] === 0 && t0[1] === 0)) || (t1 && (t1[0] === 0 && t1[1] === 0))) {
      warn('applyAddFitSpline: ignoring a zero tangent', { featureId })
      return null
    }
    const handles = handlesFromTangents(points, [t0, t1], options.tangentScale ?? true)
    handleStart = handles.handleStart
    handleEnd = handles.handleEnd
  }
  const eid = mintEntityId(feature.entities ?? [], entityId)
  const def: PartEntityDef = { id: eid, kind: 'fit_spline' }
  feature.entities = feature.entities ?? []
  feature.entities.push(def)
  writeFitSpline(feature, def, points, handleStart, handleEnd)
  return eid
}

// ─── positional ref rewriting ───

/** Rewrite one stored ref's `fit<k>` key. Returns `undefined` when the ref
 *  should be dropped (it named a deleted point), otherwise the same shape. */
function rewriteRef(ref: unknown, eid: string, map: (k: number) => number | null): unknown | undefined {
  if (typeof ref === 'string') {
    const k = parseFitPointRef(ref, eid)
    if (k === null) return ref
    const next = map(k)
    return next === null ? undefined : fitPointRef(eid, next)
  }
  if (ref && typeof ref === 'object') {
    const obj = ref as { entity?: unknown; point?: unknown; role?: unknown; ref?: unknown }
    if (obj.role !== undefined && obj.ref !== undefined) {
      const inner = rewriteRef(obj.ref, eid, map)
      return inner === undefined ? undefined : { ...obj, ref: inner }
    }
    if (obj.entity === eid && typeof obj.point === 'string') {
      const k = fitPointIndex(obj.point)
      if (k === null) return ref
      const next = map(k)
      return next === null ? undefined : { ...obj, point: `fit${next}` }
    }
  }
  return ref
}

/** Apply a fit-point index map to every constraint ref naming `eid`; a ref that
 *  maps to null drops its whole constraint (it named a deleted point). */
function rewriteConstraintRefs(feature: SketchFeature, eid: string, map: (k: number) => number | null): void {
  if (!feature.constraints) return
  const kept: PartConstraint[] = []
  for (const c of feature.constraints) {
    let dropped = false
    const next: PartConstraint = { ...c }
    for (const key of CONSTRAINT_REF_FIELDS) {
      const value = next[key]
      if (value === undefined) continue
      const rewritten = rewriteRef(value, eid, map)
      if (rewritten === undefined) {
        dropped = true
        break
      }
      Object.assign(next, { [key]: rewritten })
    }
    if (!dropped) kept.push(next)
  }
  feature.constraints = kept
}

/** Insert a fit point at `index` (0..N) and renumber the refs after it. */
export function applyInsertFitPoint(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  index: number,
  point: Point,
): void {
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return
  const entity = readFitSpline(feature, entityId)
  if (!entity) return
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return
  const at = Math.max(0, Math.min(entity.points.length, Math.trunc(index)))
  const points = [...entity.points]
  points.splice(at, 0, [point[0], point[1]])
  if (fitPointsProblem(points)) return
  writeFitSpline(feature, entity.def, points, entity.handleStart, entity.handleEnd)
  // A point inserted before interior point k shifts k to k+1; start/end keep
  // their names (they now name the new endpoints).
  rewriteConstraintRefs(feature, entityId, k => (k >= at + 1 ? k + 1 : k))
}

/** Set or remove one end handle. `null` removes it and every constraint that
 *  named `c1`/`c2`. */
export function applySetFitSplineHandle(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  end: 'start' | 'end',
  handle: Point | null,
): void {
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return
  const entity = readFitSpline(feature, entityId)
  if (!entity) return
  const handleStart = end === 'start' ? (handle ?? undefined) : entity.handleStart
  const handleEnd = end === 'end' ? (handle ?? undefined) : entity.handleEnd
  if (handle && (!Number.isFinite(handle[0]) || !Number.isFinite(handle[1]))) return
  writeFitSpline(feature, entity.def, entity.points, handleStart, handleEnd)
  if (handle === null && feature.constraints) {
    const key = end === 'start' ? 'c1' : 'c2'
    feature.constraints = feature.constraints.filter(c => !refsFitKey(c, entityId, key))
  }
}

function refsFitKey(c: PartConstraint, eid: string, key: string): boolean {
  for (const field of CONSTRAINT_REF_FIELDS) {
    const ref = c[field]
    if (typeof ref === 'string') {
      if (isVertexKeyRef(ref, eid, key)) return true
    } else if (ref && typeof ref === 'object') {
      const obj = ref as { entity?: unknown; point?: unknown }
      if (obj.entity === eid && obj.point === key) return true
    }
  }
  return false
}

/** Delete interior fit point `k` (1..N-2), renumbering the later refs. */
export function applyDeleteFitPoint(
  doc: PartDoc,
  featureId: string,
  entityId: string,
  k: number,
): void {
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return
  const entity = readFitSpline(feature, entityId)
  if (!entity) return
  if (k < 1 || k > entity.points.length - 2) return
  const points = entity.points.filter((_, i) => i !== k)
  if (fitPointsProblem(points)) return
  writeFitSpline(feature, entity.def, points, entity.handleStart, entity.handleEnd)
  // The deleted point's own constraints are dropped; every later point shifts
  // down one.
  rewriteConstraintRefs(feature, entityId, point => {
    if (point === k) return null
    return point > k ? point - 1 : point
  })
}
