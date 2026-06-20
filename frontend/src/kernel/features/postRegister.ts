/**
 * After a feature solves, register its solved state into the repo so downstream features can
 * resolve it.
 *
 * Two halves run here: 1. Profile extraction (the MVP slice, commit `5598813`): plane
 * (`_pt_<id>`) and topology (`_topo_<id>`) so extrude/revolve/hole can build the profile. 2.
 * Query resolution (this shard): solved-entity slash registration (`@feature/entity/...`) plus
 * topology surface/edge/vertex ancestry, so picks/dimensions resolve into solved sketch
 * geometry. The hole leaf reads a point's `<sketch>/<eid>/xy` element straight out of (1)'s
 * slash registry.
 *
 * Deferred follow-on: area re-id (`match_area_reid` + `_apply_area_reid`), which keeps area
 * picks edit-stable across topology-changing edits (line -> arc). The full-doc parity harness
 * always rebuilds from scratch, so prev surfaces are empty and re-id never fires there; it only
 * matters in the live incremental path.
 */

import type { Repository } from '../query'
import {
  canonical,
  evictAncestryAndRegister,
  parseAncestry,
  ref,
  isClassifierId,
} from '../query'
import { frameFromPlaneTransform } from '../types3d'
import { loopCentroid, type LoopEdge } from '../profileLoops'
import { BUILTIN_PLANES } from '../solverConstants'
import type { PlaneLike } from './shared'

type Dict = Record<string, unknown>

const BARE_PLANE: Record<string, string> = {
  Top: 'builtin_plane_top',
  Front: 'builtin_plane_front',
  Right: 'builtin_plane_right',
}

function planeLikeOf(plane: Dict): PlaneLike {
  return {
    origin: plane.origin as number[],
    x_axis: plane.x_axis as number[],
    y_axis: plane.y_axis as number[],
    normal: plane.normal as number[],
  }
}

function isPlaneLike(v: unknown): v is PlaneLike {
  return !!v && typeof v === 'object' && 'normal' in (v as Dict) && 'origin' in (v as Dict)
}

function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Resolve a sketch's plane query to a plane frame. Handles builtin planes
 * (`builtin_plane_*`, bare
 * `Front`/`Top`/`Right`), plane features already registered as `_pt_<id>`,
 * and ancestry queries (`?...:flatface`) resolved through the repository
 * (face elements carry `origin`/`normal`/`x_axis`/`y_axis`).
 * Falls back to the front plane when nothing matches.
 */
export function resolveSketchPlane(
  planeQuery: string | null | undefined,
  globalRepo: Repository,
): PlaneLike {
  const front = planeLikeOf(BUILTIN_PLANES.builtin_plane_front)
  if (!planeQuery) return front

  // Ancestry queries mirror Python's resolve_ref calling globalRepo.query().
  if (planeQuery.startsWith('?')) {
    const resolved = globalRepo.query(planeQuery, null) as Dict | null
    if (resolved && isDict(resolved)) {
      if (isPlaneLike(resolved)) return resolved
      if (resolved.origin && resolved.normal) {
        return planeLikeOf(resolved)
      }
    }
    return front
  }

  const bare = planeQuery.replace(/^[@$]/, '')
  if (BUILTIN_PLANES[bare]) return planeLikeOf(BUILTIN_PLANES[bare])
  if (BARE_PLANE[planeQuery]) return planeLikeOf(BUILTIN_PLANES[BARE_PLANE[planeQuery]])
  const reg = globalRepo.elements.get('_pt_' + bare) ?? globalRepo.elements.get(bare)
  if (isPlaneLike(reg)) return reg
  return front
}

/** Rich geometry for one solved entity. */
export function enrichSketchEntity(kind: string, ep: number[]): Dict {
  const rad = (deg: number): number => (deg * Math.PI) / 180
  if (kind === 'line') return { start: [ep[0], ep[1]], end: [ep[2], ep[3]] }
  if (kind === 'circle') return { center: [ep[0], ep[1]], radius: ep[2] }
  if (kind === 'arc') {
    const [cx, cy, r, a0, a1] = ep
    return {
      center: [cx, cy],
      radius: r,
      angle_start: a0,
      angle_end: a1,
      start: [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))],
      end: [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))],
    }
  }
  if (kind === 'ellipse') {
    // Full closed ellipse (partial elliptical arcs are lowered to splines).
    // `kind` is carried so topology classifies it unambiguously: it has a
    // center like a circle but is not one.
    const [cx, cy, a, b, theta] = ep
    return { kind: 'ellipse', center: [cx, cy], a, b, theta }
  }
  if (kind === 'spline') {
    // Cubic Bezier: P1/P4 on-curve endpoints, P2/P3 control handles. `kind`
    // disambiguates it from a line (both carry start/end and no radius).
    const [x1, y1, x2, y2, x3, y3, x4, y4] = ep
    return { kind: 'spline', start: [x1, y1], end: [x4, y4], c1: [x2, y2], c2: [x3, y3] }
  }
  if (kind === 'point') return { x: ep[0], y: ep[1] }
  return {}
}

/**
 * `BuildDeps.postRegister`: register solved sketch state into the repo. No-ops
 * for features whose result carries no plane/topology/geometry (extrude,
 * fillet, ...), matching Python's key-presence checks.
 */
export function postRegister(
  globalRepo: Repository,
  featureId: string,
  feature: Dict,
  featureResult: Dict,
): void {
  if (featureResult.status === 'exception') return

  // Variable features publish a named scalar. Register it by stable feature id
  // (`_var_<id>`) and by label so name-based queries resolve. Last registration
  // under a colliding label wins, matching the "last-wins" shadowing semantics.
  if (typeof featureResult.value === 'number') {
    const varName = String(feature.label ?? featureId)
    const payload = {
      type: 'variable',
      value: featureResult.value,
      expression: featureResult.expression,
      label: varName,
    }
    globalRepo.register('_var_' + featureId, payload)
    globalRepo.register(varName, payload)
  }

  clearFeatureGeometryRegistrations(globalRepo, featureId)

  if (featureResult.geometry !== undefined) {
    registerSolvedGeometrySlash(
      globalRepo,
      featureId,
      feature,
      featureResult.geometry as Record<string, unknown>,
    )
  }

  const pt = featureResult.plane_transform as { rotation: number[]; origin: number[] } | undefined
  if (pt) {
    globalRepo.register('_pt_' + featureId, frameFromPlaneTransform(pt))
  }
  if (featureResult.topology !== undefined) {
    globalRepo.register('_topo_' + featureId, featureResult.topology)
    if (pt) {
      const plane = frameFromPlaneTransform(pt) as unknown as PlaneLike
      const topology = featureResult.topology as Dict
      registerTopologySurfaces(globalRepo, topology, plane)
      registerTopologyEdges(globalRepo, topology, plane)
      registerTopologyVertices(globalRepo, topology, plane, featureId)
    }
    registerSketchFeature(globalRepo, featureId, featureResult)
  }
}

/**
 * Remove all geometry registrations previously made for a feature. Prevents ghost references when
 * entities are deleted and the feature is re-solved. Clears ancestral entries
 * keyed by the bare `@feature_id` tag (topology) or whose payload carries
 * `sketch_id == feature_id` (entity params), then the direct slash elements.
 */
export function clearFeatureGeometryRegistrations(globalRepo: Repository, featureId: string): void {
  const featureTag = ref(featureId)
  const eidsToRemove = new Set<string>()
  const keysToRemove: string[] = []

  for (const [key, entry] of [...globalRepo.ancestral]) {
    if (entry.set.has(featureTag)) {
      keysToRemove.push(key)
      for (const eid of entry.eids) eidsToRemove.add(eid)
      continue
    }
    for (const eid of entry.eids) {
      const payload = globalRepo.elements.get(eid)
      if (isDict(payload) && payload.sketch_id === featureId) {
        eidsToRemove.add(eid)
        keysToRemove.push(key)
        break
      }
    }
  }

  for (const eid of eidsToRemove) globalRepo.elements.delete(eid)
  for (const key of keysToRemove) globalRepo.ancestral.delete(key)
  globalRepo.clearBySketchId(featureId)
}

/**
 * Register solved geometry under slash query paths (`@feature/entity/sub`). Accepts flat-param
 * arrays (the solver's output) or rich dicts. The hole leaf reads point `/xy` from here.
 */
function registerSolvedGeometrySlash(
  globalRepo: Repository,
  featureId: string,
  feature: Dict,
  geometry: Record<string, unknown>,
): void {
  const entities = new Map<string, Dict>()
  for (const e of (feature.entities as Dict[]) ?? []) entities.set(e.id as string, e)

  for (const [eid, val] of Object.entries(geometry)) {
    const entity = entities.get(eid)
    if (!entity) continue
    const kind = entity.kind as string
    const prefix = featureId + '/' + eid

    let params: number[]
    if (isDict(val)) {
      if (kind === 'line') {
        params = [...((val.start as number[]) ?? [0, 0]), ...((val.end as number[]) ?? [0, 0])]
      } else if (kind === 'circle') {
        params = [...((val.center as number[]) ?? [0, 0]), (val.radius as number) ?? 0]
      } else if (kind === 'arc') {
        const [cx, cy] = (val.center as number[]) ?? [0, 0]
        params = [cx, cy, (val.radius as number) ?? 0, (val.angle_start as number) ?? 0, (val.angle_end as number) ?? 0]
      } else if (kind === 'point') {
        params = [...((val.xy as number[]) ?? [0, 0])]
      } else {
        continue
      }
    } else {
      params = [...(val as number[])]
    }

    globalRepo.register(prefix, { external_params: params, kind, sketch_id: featureId })
    if (kind === 'line') {
      globalRepo.register(prefix + '/start', { external_xy: params.slice(0, 2), sketch_id: featureId })
      globalRepo.register(prefix + '/end', { external_xy: params.slice(2, 4), sketch_id: featureId })
    } else if (kind === 'circle') {
      globalRepo.register(prefix + '/center', { external_xy: params.slice(0, 2), sketch_id: featureId })
    } else if (kind === 'arc') {
      const [cx, cy, r, aStart, aEnd] = params
      globalRepo.register(prefix + '/start', {
        external_xy: [cx + r * Math.cos(radians(aStart)), cy + r * Math.sin(radians(aStart))],
        sketch_id: featureId,
      })
      globalRepo.register(prefix + '/end', {
        external_xy: [cx + r * Math.cos(radians(aEnd)), cy + r * Math.sin(radians(aEnd))],
        sketch_id: featureId,
      })
      globalRepo.register(prefix + '/center', { external_xy: [cx, cy], sketch_id: featureId })
    } else if (kind === 'point') {
      globalRepo.register(prefix + '/xy', { external_xy: params.slice(0, 2), sketch_id: featureId })
    }
  }
}

function radians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Structural strict equality (mirrors Python `dict == dict`; no float tolerance). */
function payloadEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => payloadEqual(x, b[i]))
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => k in b && payloadEqual(a[k], b[k]))
  }
  return false
}

/**
 * Register an ancestral payload, skipping when an identical payload already
 * lives under the key. Without the skip, re-solves churn element ids
 * unnecessarily; the exact-key evict still prevents accumulation, but the
 * dedup keeps the registry stable across solves.
 */
function registerAncestralDeduped(
  globalRepo: Repository,
  ids: string[],
  payload: Record<string, unknown>,
): void {
  const entry = globalRepo.ancestral.get(canonical(ids))
  if (entry && entry.eids.some((eid) => payloadEqual(globalRepo.elements.get(eid), payload))) {
    return
  }
  evictAncestryAndRegister(globalRepo, ids, payload)
}

/** Transform 2D sketch coordinates into 3D world space. */
function sketchToWorld2d(xy: number[], plane: PlaneLike): number[] {
  const { x_axis, y_axis, origin } = plane
  const [u, v] = xy
  return [
    origin[0] + u * x_axis[0] + v * y_axis[0],
    origin[1] + u * x_axis[1] + v * y_axis[1],
    origin[2] + u * x_axis[2] + v * y_axis[2],
  ]
}

/**
 * Register each topology surface as a face-typed plane. Classifiers stay off the ancestral key (the
 * resolver scores them in a separate tier) and ride on the payload instead.
 */
function registerTopologySurfaces(globalRepo: Repository, topology: Dict, plane: PlaneLike): void {
  for (const surface of (topology.surfaces as Dict[]) ?? []) {
    const query = surface.query as string | undefined
    if (!query || !query.startsWith('?')) continue

    const boundary = (surface.boundary as LoopEdge[]) ?? []
    const worldOrigin = boundary.length
      ? sketchToWorld2d(loopCentroid(boundary), plane)
      : [...plane.origin]

    const [ids] = parseAncestry(query)
    const keyIds = ids.filter((i) => !isClassifierId(i))
    const classifiers = ids.filter(isClassifierId).map((i) => i.slice(1))
    const payload = {
      type: 'flatface',
      origin: worldOrigin,
      x_axis: [...plane.x_axis],
      y_axis: [...plane.y_axis],
      normal: [...plane.normal],
      classifiers,
    }
    registerAncestralDeduped(globalRepo, keyIds, payload)
  }
}

/** Register each topology edge with its ancestry query. */
function registerTopologyEdges(globalRepo: Repository, topology: Dict, plane: PlaneLike): void {
  for (const edge of (topology.edges as Dict[]) ?? []) {
    const query = edge.query as string | undefined
    if (!query || !query.startsWith('?')) continue

    const kind = (edge.kind as string) ?? 'line'
    const edgeData: Dict = {
      type: kind === 'line' ? 'straightedge' : 'edge',
      kind,
      start: sketchToWorld2d((edge.start as number[]) ?? [0, 0], plane),
      end: sketchToWorld2d((edge.end as number[]) ?? [0, 0], plane),
    }
    if ('center' in edge) {
      edgeData.center = sketchToWorld2d(edge.center as number[], plane)
      edgeData.radius = edge.radius
    }

    const [ids] = parseAncestry(query)
    registerAncestralDeduped(globalRepo, ids, edgeData)
  }
}

/** Register each topology vertex with its ancestry query. */
function registerTopologyVertices(
  globalRepo: Repository,
  topology: Dict,
  plane: PlaneLike,
  featureId: string,
): void {
  const allVertices: Record<string, Dict> = {
    ...((topology.vertices as Record<string, Dict>) ?? {}),
    ...((topology.intersection_points as Record<string, Dict>) ?? {}),
  }

  for (const [vid, v] of Object.entries(allVertices)) {
    const worldXy = sketchToWorld2d([(v.x as number) ?? 0, (v.y as number) ?? 0], plane)
    // make/parse round-trips to identity; the ancestor list is the registration key.
    const ids = featureId ? [vid, 'vertex', ref(featureId)] : [vid, 'vertex']
    const vertexData = { type: 'vertex', x: worldXy[0], y: worldXy[1], z: worldXy[2] }
    registerAncestralDeduped(globalRepo, ids, vertexData)
  }
}

/** Register the sketch feature itself as a sketch-feature entity. */
function registerSketchFeature(globalRepo: Repository, featureId: string, featureResult: Dict): void {
  if (!featureId || featureResult.topology === undefined) return
  globalRepo.registerAncestor([ref(featureId)], { type: 'sketch-feature', feature_id: featureId })
}
