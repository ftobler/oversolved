// One viewport pick reduced to what an instance pattern needs: a point to put
// the reference on, and a normal to turn a copy onto (or null when the pick
// carries none). The dispatch table is the plan's: a sketch entity takes its
// point from its kind and the sketch plane's normal; a body face, edge or vertex
// is read from its own geometry. A cylindrical or conical face and a circular
// edge take their sense from the free-end rule (shared/axisSense.ts), which is
// the same rule the linear direction pick uses.
//
// A pick that resolves to no target is returned as null and the caller drops it
// with a warning naming the pick. A pick that names something the table refuses
// (a whole sketch or a whole body in the targets list) throws, so the sentence
// reaches the feature instead of being silently dropped.

import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { HandleTable } from '../../occ/handleTable'
import type { Body } from '../../types3d'
import type { Repository } from '../../query'
import { exploreEdges } from '../../occ/edgeModifier'
import { edgeToGeom, faceCentroid, faceNormal, faceSurfaceFrame, type Vec3 } from '../../occ/primitives'
import { sha256Hex } from '../../sha256'
import { resolveBarePlaneId } from '../../solverConstants'
import { parseSketchEntityRef, sketchIdFromQuery, soleEntityInQuery } from './bodyRef'
import { buildFaceIndex, resolveFacesByQuery, type FaceIndex } from './faceResolution'
import { resolveSketchPlane } from '../postRegister'
import { sketchToWorld2d, type PlaneLike } from './planes'
import { resolveAxisCarrier, type AxisSenseContext } from './axisSense'

type Dict = Record<string, unknown>

export interface PickTarget {
  // The stable naming key: the sketch entity id, or a short hash of the pick
  // ref so deleting an earlier pick cannot rename a later copy's faces.
  key: string
  // A readable label for the editor hint and warning text.
  label: string
  point: Vec3
  normal: Vec3 | null
}

export interface PickTargetContext {
  oc: OccModule
  scope: DisposeScope
  table: HandleTable
  globalRepo: Repository
  bodyStore: Record<string, Body>
  featuresById: Record<string, Dict>
}

function unit(v: readonly number[] | null | undefined): Vec3 | null {
  if (v === null || v === undefined) return null
  const len = Math.hypot(v[0], v[1], v[2])
  return len < 1e-12 ? null : [v[0] / len, v[1] / len, v[2] / len]
}

function shortRefKey(ref: string): string {
  return sha256Hex(ref).slice(0, 8)
}

function isSketchEntityPick(ctx: PickTargetContext, ref: string): { sketchId: string; entityId: string } | null {
  const direct = parseSketchEntityRef(ref)
  if (direct !== null) return { sketchId: direct.sketchId, entityId: direct.eid }
  // A bare `@<sketchId>` is the whole-sketch pick the targets list refuses.
  const bare = ref.replace(/^[@$]/, '')
  if (ctx.featuresById[bare]?.kind === 'sketch') return { sketchId: bare, entityId: '' }
  // A headless script reaches the same entity as `@<sketchId>/<entityId>`; the
  // sketch is only a sketch when the document says so.
  const slash = /^@([^/]+)\/(.+)$/.exec(ref)
  if (slash !== null) {
    const sketch = ctx.featuresById[slash[1]]
    if (sketch !== undefined && sketch.kind === 'sketch') {
      return { sketchId: slash[1], entityId: slash[2].split('/')[0] }
    }
  }
  if (!ref.startsWith('?')) return null
  // An area pick is a body face unless its ancestry names a sketch. A sketch
  // area bounded by several curves names no one entity, which the caller reads
  // as a whole-sketch refusal.
  const sketchId = sketchIdFromQuery(ref, ctx.globalRepo)
  if (sketchId === null) return null
  return { sketchId, entityId: soleEntityInQuery(ref, sketchId) ?? '' }
}

/** One solved sketch entity's point, in sketch coordinates. */
function sketchEntityPoint(kind: string, params: number[], entity: Dict): number[] | null {
  if (kind === 'point') return [params[0] ?? 0, params[1] ?? 0]
  if (kind === 'line') {
    return [(params[0] + params[2]) / 2, (params[1] + params[3]) / 2]
  }
  if (kind === 'circle' || kind === 'arc' || kind === 'ellipse') {
    return [params[0] ?? 0, params[1] ?? 0]
  }
  if (kind === 'spline') {
    // The cubic Bezier's middle station: (P1 + 3 P2 + 3 P3 + P4) / 8.
    const at = (offset: number): number =>
      (params[offset] + 3 * params[offset + 2] + 3 * params[offset + 4] + params[offset + 6]) / 8
    return [at(0), at(1)]
  }
  if (kind === 'fit_spline') {
    // Fit points then the optional handles; the middle fit point is the station.
    const handles = entity.handles === 'both' ? 2 : entity.handles === 'start' || entity.handles === 'end' ? 1 : 0
    const count = Math.max(0, (params.length - 2 * handles) / 2)
    if (count === 0) return null
    const middle = Math.floor((count - 1) / 2)
    return [params[2 * middle] ?? 0, params[2 * middle + 1] ?? 0]
  }
  return null
}

function sketchTarget(ctx: PickTargetContext, ref: string): PickTarget | 'whole-sketch' | null {
  const named = isSketchEntityPick(ctx, ref)
  if (named === null) return null
  if (named.entityId === '') return 'whole-sketch'
  const sketch = ctx.featuresById[named.sketchId]
  if (sketch === undefined || sketch.kind !== 'sketch') return null
  const entities = (sketch.entities as Dict[] | undefined) ?? []
  const entity = entities.find((row) => row.id === named.entityId)
  if (entity === undefined) return null
  const initial = (sketch.initial as Record<string, number[]> | undefined) ?? {}
  const params = initial[named.entityId]
  if (params === undefined) return null
  // The solved plane the sketch registered is authoritative (a face parent
  // resolves to the face's centroid and axes); the stored parent ref is only
  // the fallback for a hand-built document.
  const solved = ctx.globalRepo.elements.get('_pt_' + named.sketchId) as PlaneLike | undefined
  const plane = solved ?? resolveSketchPlane(sketch.plane as string | undefined, ctx.globalRepo) as PlaneLike
  const xy = sketchEntityPoint(String(entity.kind ?? ''), params, entity)
  if (xy === null) return null
  return {
    key: named.entityId,
    label: named.entityId,
    point: sketchToWorld2d(xy, plane) as Vec3,
    normal: unit(plane.normal),
  }
}

/** The face's own surface point at its (u, v) centre: a sphere, torus or
 *  freeform face has no analytic centre point, and this is the table's answer. */
function faceSurfaceCentrePoint(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  adaptor.D1(u, v, p, du, dv)
  return [p.X(), p.Y(), p.Z()]
}

function faceTarget(
  ctx: PickTargetContext,
  ref: string,
  data: Dict,
  sense: AxisSenseContext,
  indexFor: (body: Body) => FaceIndex,
): PickTarget | null {
  const bodyId = typeof data.body_id === 'string' ? data.body_id : ''
  const body = ctx.bodyStore[bodyId]
  if (body === undefined || body.shape === null) return null
  const face = resolveFacesByQuery(ctx.oc, ctx.scope, ctx.table, body, indexFor(body), [ref]).get(ref) ?? null
  const surfaceType = String(data.type ?? 'face')
  const label = `face ${String(data.face_index ?? '')}`.trim()
  if (face === null) {
    // The repository still knows a plane's centroid and normal; a curved face
    // without its OCC handle has no free end, so that pick is unresolved
    // instead of guessed from a radial normal.
    if (surfaceType !== 'flatface') return null
    const normal = unit(data.normal as number[])
    const centroid = data.centroid as number[] | undefined
    if (normal === null || centroid === undefined) return null
    return { key: shortRefKey(ref), label, point: [centroid[0], centroid[1], centroid[2]], normal }
  }
  if (surfaceType === 'flatface') {
    const normal = unit(data.normal as number[]) ?? faceNormal(ctx.oc, ctx.scope, face)
    return { key: shortRefKey(ref), label, point: faceCentroid(ctx.oc, ctx.scope, face), normal }
  }
  if (surfaceType === 'cylinderface' || surfaceType === 'coneface') {
    // The direction is the shared free-end rule; the point is where that
    // direction leaves the face (its axial end), which only the pattern needs.
    const carrierKind = surfaceType === 'cylinderface' ? 'cylinderface' : 'coneface'
    const rawAxis = unit(data.axis as number[] | undefined)
    const senseResult = resolveAxisCarrier(
      carrierKind, ref, rawAxis, sense, ctx.globalRepo, ctx.bodyStore,
    )
    const direction = senseResult?.direction ?? rawAxis
    if (direction !== null) {
      const point = faceEndPoint(ctx.oc, ctx.scope, face, direction)
      if (point !== null) return { key: shortRefKey(ref), label, point, normal: direction }
    }
  }
  const point = faceSurfaceCentrePoint(ctx.oc, ctx.scope, face) ?? faceCentroid(ctx.oc, ctx.scope, face)
  return { key: shortRefKey(ref), label, point, normal: faceNormal(ctx.oc, ctx.scope, face) }
}

/** The axial end a face's direction leaves from: the high end when the
 *  direction runs with the surface axis, the low end otherwise. The free-end
 *  rule itself lives in axisSense.ts; this only places its result on the face. */
function faceEndPoint(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  direction: Vec3,
): Vec3 | null {
  const frame = faceSurfaceFrame(oc, scope, face)
  if (frame === null) return null
  const axis = unit(frame.axis)
  if (axis === null) return null
  let low = Infinity
  let high = -Infinity
  for (const edge of exploreEdges(oc, scope, face)) {
    let geom: ReturnType<typeof edgeToGeom>['ed']
    try {
      geom = edgeToGeom(oc, scope, edge).ed
    } catch {
      continue
    }
    const point = geom.kind === 'circle' || geom.kind === 'arc' || geom.kind === 'ellipse'
      ? geom.center
      : geom.kind === 'line'
        ? [(geom.start[0] + geom.end[0]) / 2, (geom.start[1] + geom.end[1]) / 2, (geom.start[2] + geom.end[2]) / 2]
        : null
    if (point === null) continue
    const t = (point[0] - frame.origin[0]) * axis[0]
      + (point[1] - frame.origin[1]) * axis[1]
      + (point[2] - frame.origin[2]) * axis[2]
    low = Math.min(low, t)
    high = Math.max(high, t)
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  const withAxis = direction[0] * axis[0] + direction[1] * axis[1] + direction[2] * axis[2] >= 0
  const t = withAxis ? high : low
  return [frame.origin[0] + axis[0] * t, frame.origin[1] + axis[1] * t, frame.origin[2] + axis[2] * t]
}

function edgeTarget(ctx: PickTargetContext, ref: string, data: Dict, sense: AxisSenseContext): PickTarget | null {
  const kind = String(data.kind ?? '')
  if (kind === 'line') {
    const start = data.start as number[] | undefined
    const end = data.end as number[] | undefined
    if (!start || !end) return null
    return {
      key: shortRefKey(ref),
      label: 'edge',
      point: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      normal: null,
    }
  }
  // A circular body edge: its centre is the point, its sense comes from the
  // faces around it through the shared free-end rule. A bare edge with no
  // readable neighbour keeps the axis it resolved with.
  if (!data.center || !data.axis) return null
  const center = data.center as Vec3
  const axis = unit(data.axis as number[]) ?? [0, 0, 1]
  const senseResult = resolveAxisCarrier(
    'circular_edge', ref, axis, sense, ctx.globalRepo, ctx.bodyStore,
  )
  return { key: shortRefKey(ref), label: 'edge', point: center, normal: senseResult?.direction ?? axis }
}

function vertexTarget(ref: string, data: Dict): PickTarget | null {
  const origin = data.origin as number[] | undefined
  if (!origin) return null
  return { key: shortRefKey(ref), label: 'vertex', point: [origin[0], origin[1], origin[2]], normal: null }
}

/** The OCC context the shared free-end rule needs for one resolution pass. */
export function axisSenseContext(ctx: PickTargetContext): AxisSenseContext {
  return { oc: ctx.oc, scope: ctx.scope, table: ctx.table }
}

/**
 * Resolve one pick. Null means the pick names nothing the table can use (the
 * caller drops it with a warning); a throw means the pick names something the
 * table refuses, such as a whole sketch.
 */
export function resolvePickTarget(
  ctx: PickTargetContext,
  ref: string,
  sense: AxisSenseContext = axisSenseContext(ctx),
  indexFor: (body: Body) => FaceIndex = faceIndexCache(ctx),
): PickTarget | null {
  if (!ref) return null
  const sketch = sketchTarget(ctx, ref)
  if (sketch === 'whole-sketch') {
    throw new Error(
      `instance_pattern: '${ref}' is a whole sketch, which names no single target; ` +
      'use the Sketch target form, or pick one point of it',
    )
  }
  if (sketch !== null) return sketch

  const data = ctx.globalRepo.query(ref, null, ctx.bodyStore) as Dict | null
  if (data !== null) {
    const type = String(data.type ?? '')
    if (type === 'sketch-feature') {
      throw new Error(
        `instance_pattern: '${ref}' is a whole sketch, which names no single target; ` +
        'use the Sketch target form, or pick one point of it',
      )
    }
    if (type === 'vertex') return vertexTarget(ref, data)
    if (type === 'solid') {
      throw new Error(
        `instance_pattern: '${ref}' is a body, which names no single target; pick one of its faces, edges or vertices`,
      )
    }
    if (data.kind === 'line' || (data.center && data.axis)) return edgeTarget(ctx, ref, data, sense)
    if (type.endsWith('face') || (data.centroid && data.normal)) return faceTarget(ctx, ref, data, sense, indexFor)
  }

  // A plane (builtin, datum, or a flat-face query) carries an origin and a
  // normal; a sketch's own plane element is not a target.
  const bare = ref.replace(/^[@$]/, '')
  const feature = ctx.featuresById[bare]
  const builtin = bare.startsWith('builtin_plane_')
  if (feature?.kind === 'plane' || builtin || resolveBarePlaneId(ref) !== null || resolveBarePlaneId(bare) !== null) {
    const plane = resolveSketchPlane(ref, ctx.globalRepo)
    return { key: shortRefKey(ref), label: 'plane', point: plane.origin as Vec3, normal: unit(plane.normal) }
  }
  return null
}

/** One face index per body for the whole resolution pass. A pattern of many
 *  face picks walks each body's faces once, not once per pick. */
export function faceIndexCache(ctx: PickTargetContext): (body: Body) => FaceIndex {
  const cache = new Map<string, FaceIndex>()
  return (body: Body): FaceIndex => {
    let index = cache.get(body.id)
    if (index === undefined) {
      index = buildFaceIndex(ctx.oc, ctx.scope, ctx.table, body)
      cache.set(body.id, index)
    }
    return index
  }
}
