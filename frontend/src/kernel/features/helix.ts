// The helix leaf. It resolves the reference to an axis/radius/extent (the OCC
// surface for a cylinder face; the repo payload for edges and sketch curves),
// computes the parameters with helixMath, and registers the curve as PLAIN DATA
// under `_curve_<id>` plus a bare-id axis entry and the two endpoints, exactly
// as solvePlane registers its frame. A helix is not a body: it never touches
// bodyStore. The OCC edge is rebuilt on demand by occ/helixEdge.buildCurveEdge,
// so a checkpoint restore needs no special handling.

import type { Repository } from '../query'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { DisposeScope } from '../occ/disposeScope'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { sortedFacesOf } from '../occ/faceLoops'
import { resolveFaceIndexViaUuid } from './faceProfile'
import { resolveCircularReference } from './shared/directionQuery'
import {
  helixFrame,
  helixPoint,
  helixSamples,
  endParam,
  resolveHelixParams,
  type HelixDescriptor,
  type HelixReference,
  type Vec3,
} from './helixMath'
import type { HelixFeatureDef } from '@/types/cad'

type Dict = Record<string, unknown>

// Points per turn in the display polyline. 24 keeps a helix as fine as the mesh
// edges beside it (the mesher's angular deflection) without bloating the doc.
const POINTS_PER_TURN = 24

const SLASH_FACE = /^@([^/]+)\/face\/(\d+)$/

function normalize(v: number[]): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2])
  if (n < 1e-12) return null
  return [v[0] / n, v[1] / n, v[2] / n]
}

function findBodyForRef(bodyStore: Record<string, Body>, id: string): Body | null {
  const exact = bodyStore[id]
  if (exact !== undefined && exact.shape !== null) return exact
  const prefixed = bodyStore['body_' + id]
  if (prefixed !== undefined && prefixed.shape !== null) return prefixed
  for (const b of Object.values(bodyStore)) {
    if (b.created_by === id && b.shape !== null) return b
  }
  return null
}

/** The OCC face a face pick names, via its body and (UUID-remapped) index. */
function occFaceForRef(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  refStr: string,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): OccShape {
  const slash = SLASH_FACE.exec(refStr)
  let body: Body | null
  let faceIndex: number
  if (slash) {
    body = findBodyForRef(bodyStore, slash[1])
    faceIndex = parseInt(slash[2], 10)
  } else {
    const entry = globalRepo.query(refStr, null, bodyStore) as Dict | null
    const bodyId = entry?.body_id as string | undefined
    const idx = entry?.face_index as number | undefined
    if (bodyId === undefined || idx === undefined) {
      throw new Error(`helix: reference ${JSON.stringify(refStr)} is not a body face`)
    }
    body = bodyStore[bodyId] ?? null
    faceIndex = idx
  }
  if (body === null || body.shape === null) throw new Error(`helix: reference body not found for ${JSON.stringify(refStr)}`)
  const shape = table.get<OccShape>(body.shape)
  const faces = sortedFacesOf(oc, scope, shape)
  const resolved = resolveFaceIndexViaUuid(oc, scope, shape, faceIndex, globalRepo, bodyStore, body.face_uuids, faces)
  const index = resolved ?? faceIndex
  if (index >= faces.length) throw new Error(`helix: face index ${index} out of range for ${JSON.stringify(refStr)}`)
  return faces[index]
}

/** A cylinder face's axis, low-end axis point, radius and axial extent, read
 *  from its OCC surface (V is the axial coordinate on a cylinder). */
function cylinderFaceReference(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  refStr: string,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): HelixReference {
  const face = occFaceForRef(oc, scope, table, refStr, globalRepo, bodyStore)
  const ad = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (ad.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) {
    throw new Error('helix: the picked face is not cylindrical; pick a cylinder face')
  }
  const cyl = scope.track(ad.Cylinder())
  const axDir = cyl.Axis().Direction()
  const axis = normalize([axDir.X(), axDir.Y(), axDir.Z()])
  if (axis === null) throw new Error('helix: the picked cylinder has no axis')
  const radius = cyl.Radius()
  const v0 = ad.FirstVParameter()
  const v1 = ad.LastVParameter()
  const loc = scope.track(cyl.Position()).Location()
  const lowV = Math.min(v0, v1)
  const origin: Vec3 = [
    loc.X() + lowV * axis[0],
    loc.Y() + lowV * axis[1],
    loc.Z() + lowV * axis[2],
  ]
  return {
    kind: 'cylinderface',
    axis,
    origin,
    radius,
    extent: Math.abs(v1 - v0),
  }
}

/** Refuse a reference by its own name when it is a shape a helix cannot sit on. */
function refuseUnsupportedReference(refStr: string, globalRepo: Repository, bodyStore: Record<string, Body>): void {
  const entry = globalRepo.query(refStr, null, bodyStore) as Dict | null
  if (entry === null) return
  const type = entry.type as string | undefined
  if (type === 'flatface') {
    throw new Error('helix: a flat face cannot carry a helix; pick a cylinder face or a circle')
  }
  if (type === 'coneface') {
    throw new Error('helix: a cone face cannot carry a helix; pick a cylinder face or a circle')
  }
  if (type === 'sphereface' || type === 'torusface') {
    throw new Error(`helix: a ${type} cannot carry a helix; pick a cylinder face or a circle`)
  }
  if (entry.kind === 'ellipse') {
    throw new Error('helix: an ellipse edge cannot carry a helix; pick a circle or a line')
  }
}

export interface HelixResult {
  [key: string]: unknown
  status: string
  helix: {
    radius: number
    pitch: number
    turns: number
    height: number
    helix_angle: number
    length: number
  }
  curve: { kind: 'spline'; points: Vec3[] }
}

/**
 * Solve a helix feature. Registers `_curve_<id>` (the plain descriptor
 * buildCurveEdge consumes), `<id>` (its axis, for downstream axis picks),
 * `<id>/start` and `<id>/end`, and returns the derived values plus the display
 * polyline.
 */
export function solveHelix(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): HelixResult {
  const featureId = feature.id as string
  const definition = (feature.helix as Dict) ?? ({} as Dict)
  const refStr = definition.reference as string | undefined
  if (typeof refStr !== 'string' || refStr === '') {
    throw new Error('helix: a reference pick is required')
  }

  refuseUnsupportedReference(refStr, globalRepo, bodyStore)
  const base = resolveCircularReference(refStr, globalRepo, bodyStore)
  if (base === null) {
    throw new Error(`helix: could not resolve reference ${JSON.stringify(refStr)}`)
  }

  const ref: HelixReference =
    base.kind === 'cylinderface'
      ? cylinderFaceReference(oc, scope, table, refStr, globalRepo, bodyStore)
      : {
          kind: base.kind,
          axis: base.axis as Vec3,
          origin: base.origin as Vec3,
          radius: base.radius,
          xAxis: base.xAxis as Vec3 | undefined,
          extent: base.extent,
        }

  const params = resolveHelixParams(definition as HelixFeatureDef, ref)
  const desc = helixFrame(ref, params, definition as HelixFeatureDef)

  const start = helixPoint(desc, 0)
  const end = helixPoint(desc, endParam(desc))
  const descriptor = {
    kind: 'helix',
    origin: desc.origin,
    axis: desc.axis,
    // The reference axis + raw start angle are kept so buildCurveEdge can redo
    // the in-frame (reverse) conversion startUV owns; the climb axis alone
    // would lose the mirror.
    ref_axis: desc.refAxis,
    x_axis: desc.xAxis,
    radius: desc.radius,
    pitch: desc.pitch,
    turns: desc.turns,
    start_angle: desc.startAngleDeg,
    hand: desc.hand,
  }
  globalRepo.register('_curve_' + featureId, descriptor)
  globalRepo.register(featureId, {
    type: 'curve',
    kind: 'helix',
    start,
    end,
    axis: desc.axis,
    center: desc.origin,
    radius: desc.radius,
  })
  globalRepo.register(featureId + '/start', { type: 'vertex', origin: start })
  globalRepo.register(featureId + '/end', { type: 'vertex', origin: end })

  return {
    status: 'ok',
    helix: {
      radius: params.radius,
      pitch: params.pitch,
      turns: params.turns,
      height: params.height,
      helix_angle: params.helix_angle,
      length: params.length,
    },
    curve: { kind: 'spline', points: helixSamples(desc, POINTS_PER_TURN) },
  }
}

/** Rebuild a helix's OCC edge from the repo descriptor it registered. */
export function descriptorFromRepo(globalRepo: Repository, featureId: string): HelixDescriptor | null {
  const d = globalRepo.elements.get('_curve_' + featureId) as Dict | undefined
  if (d === undefined || d.kind !== 'helix') return null
  return {
    origin: d.origin as Vec3,
    axis: d.axis as Vec3,
    refAxis: (d.ref_axis as Vec3 | undefined) ?? (d.axis as Vec3),
    xAxis: d.x_axis as Vec3,
    radius: d.radius as number,
    pitch: d.pitch as number,
    turns: d.turns as number,
    startAngleDeg: d.start_angle as number,
    hand: (d.hand as 'right' | 'left') ?? 'right',
  }
}
