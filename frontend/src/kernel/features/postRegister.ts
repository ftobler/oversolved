/**
 * Port of `solver_registry._post_register` (the MVP slice): after a sketch
 * solves, register its plane and topology into the repo as `_pt_<id>` /
 * `_topo_<id>` so downstream features (extrude/revolve/hole/...) can resolve the
 * profile. Without this the live TS kernel throws `sketch not found` on every
 * extrude -- the gap that kept phase 4a from actually working.
 *
 * Deferred (next sub-shard, needed for face/edge picks on cut/fillet/boolean):
 * `_register_solved_geometry_slash`, surface/edge/vertex ancestry registration,
 * and area re-id. Those drive query resolution, not basic profile extraction.
 */

import type { Repository } from '../query'
import { frameFromPlaneTransform } from '../types3d'
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

/**
 * Resolve a sketch's plane query to a plane frame (port of
 * `_resolve_sketch_plane`). Handles builtin planes (`builtin_plane_*`, bare
 * `Front`/`Top`/`Right`) and plane features already registered as `_pt_<id>`;
 * falls back to the front plane.
 */
export function resolveSketchPlane(
  planeQuery: string | null | undefined,
  globalRepo: Repository,
): PlaneLike {
  const front = planeLikeOf(BUILTIN_PLANES.builtin_plane_front)
  if (!planeQuery) return front
  const bare = planeQuery.replace(/^[@$]/, '')
  if (BUILTIN_PLANES[bare]) return planeLikeOf(BUILTIN_PLANES[bare])
  if (BARE_PLANE[planeQuery]) return planeLikeOf(BUILTIN_PLANES[BARE_PLANE[planeQuery]])
  const reg = globalRepo.elements.get('_pt_' + bare) ?? globalRepo.elements.get(bare)
  if (isPlaneLike(reg)) return reg
  return front
}

/** Rich geometry for one solved entity (port of `_geometry_from_array`). */
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
  if (kind === 'point') return { x: ep[0], y: ep[1] }
  return {}
}

/**
 * `BuildDeps.postRegister`: register solved sketch state into the repo. No-ops
 * for features whose result carries no plane/topology (extrude, fillet, ...),
 * matching Python's key-presence checks.
 */
export function postRegister(
  globalRepo: Repository,
  featureId: string,
  _feature: Dict,
  featureResult: Dict,
): void {
  if (featureResult.status === 'exception') return
  const pt = featureResult.plane_transform as { rotation: number[]; origin: number[] } | undefined
  if (pt) {
    globalRepo.elements.set('_pt_' + featureId, frameFromPlaneTransform(pt))
  }
  if (featureResult.topology !== undefined) {
    globalRepo.elements.set('_topo_' + featureId, featureResult.topology)
  }
}
