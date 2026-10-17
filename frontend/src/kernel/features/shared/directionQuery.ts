// Direction resolution and the 3D line/direction/axis query resolvers shared
// by the array, revolve and sweep leaves. Pure, no OCC.

import type { Repository } from '../../query'
import { sketchToWorld2d, type PlaneLike } from './planes'

type Dict = Record<string, unknown>

/**
 * Resolve an extrude/revolve direction string to (direction_vec, distance,
 * effective_plane) (mirrors `_resolve_direction`). `reverse` flips the normal;
 * `symmetric` keeps the normal but shifts the plane origin back by half the
 * distance so the solid straddles the sketch plane.
 */
export function resolveDirection(
  normal: number[],
  pt: PlaneLike,
  direction: string,
  distance: number,
): [number[], number, PlaneLike] {
  if (direction === 'reverse') {
    return [normal.map((n) => -n), distance, pt]
  }
  if (direction === 'symmetric') {
    const directionVec = [...normal]
    const shift = normal.map((n) => (-n * distance) / 2)
    const shifted: PlaneLike = {
      origin: [pt.origin[0] + shift[0], pt.origin[1] + shift[1], pt.origin[2] + shift[2]],
      x_axis: pt.x_axis,
      y_axis: pt.y_axis,
      normal: pt.normal,
    }
    return [directionVec, distance, shifted]
  }
  return [[...normal], distance, pt]
}

function normalize3(d: number[]): number[] | null {
  const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
  if (length > 1e-12) return [d[0] / length, d[1] / length, d[2] / length]
  return null
}

/**
 * A reference reduced to the axis/radius/extent a helix (or any circular
 * consumer) needs, resolved from the repo. `faceRef` is the original query when
 * `kind` is a cylinder face, so a caller can reach the OCC surface for the
 * radius and axial extent the repo entry does not carry.
 */
export interface CircularReference {
  kind: 'cylinderface' | 'circular_edge' | 'sketch_circle' | 'straight_edge' | 'sketch_line'
  axis: number[]
  origin: number[]
  radius?: number
  xAxis?: number[]
  extent?: number
  faceRef?: string
}

/**
 * Resolve a query to a circular/linear reference, shared by the direction/axis
 * resolvers and the helix leaf. Handles straight edge ({start, end}), circular/
 * arc/ellipse edge ({center, axis}), sketch line/circle/arc
 * ({external_params, kind}) lifted through the sketch plane, and cylindrical
 * face (type + axis). A planar face is NOT handled here: the direction
 * resolvers fall back to its normal themselves.
 *
 * Edge payloads from edgeAncestryPayload carry all geometry keys regardless of
 * the actual edge kind, with undefined for inapplicable fields; truthy checks
 * guard against mismatches.
 */
export function resolveCircularReference(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): CircularReference | null {
  if (!query) return null
  const data = globalRepo.query(query, null, bodyStore) as Dict | null
  if (!data) return null

  // Circular / arc / ellipse edge: truthy center/axis. Checked BEFORE the
  // straight branch because a registered helix carries BOTH (center/axis for
  // its axis, start/end for its endpoints); it is a curve about an axis, so
  // `@<helixId>` must resolve to that axis, not to its start-to-end chord.
  if (data.center && data.axis) {
    const dir = normalize3(data.axis as number[])
    if (dir) {
      const center = [...(data.center as number[])]
      const radius = typeof data.radius === 'number' ? data.radius : undefined
      const xAxis = Array.isArray(data.x_axis) ? (data.x_axis as number[]) : undefined
      return { kind: 'circular_edge', axis: dir, origin: center, radius, xAxis }
    }
  }

  // Straight 3D edge: truthy start/end (circular edges carry undefined start/end).
  if (data.start && data.end) {
    const start = data.start as number[]
    const end = data.end as number[]
    const dir = normalize3([end[0] - start[0], end[1] - start[1], end[2] - start[2]])
    if (dir) {
      const extent = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])
      return { kind: 'straight_edge', axis: dir, origin: start, extent }
    }
  }

  // Sketch line / circle / arc: lifted through the sketch plane.
  if (data && 'external_params' in data) {
    const sketchId = (data.sketch_id as string) ?? ''
    const plane = sketchId ? (globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined) : undefined
    if (plane) {
      const params = data.external_params as number[]
      if (data.kind === 'line') {
        const start = sketchToWorld2d(params.slice(0, 2), plane)
        const end = sketchToWorld2d(params.slice(2, 4), plane)
        const dir = normalize3([end[0] - start[0], end[1] - start[1], end[2] - start[2]])
        if (dir) {
          const extent = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])
          return { kind: 'sketch_line', axis: dir, origin: start, extent }
        }
      } else if (data.kind === 'circle' || data.kind === 'arc') {
        // Circle/arc centre in 2D [cx, cy] → 3D; axis = sketch plane normal.
        const center = sketchToWorld2d(params.slice(0, 2), plane)
        const dir = normalize3(plane.normal)
        if (dir) {
          const radius = Number.isFinite(params[2]) ? params[2] : undefined
          return { kind: 'sketch_circle', axis: dir, origin: center, radius, xAxis: [...plane.x_axis] }
        }
      }
    }
  }

  // Cylindrical face: prefer surface_frame (the analytic axis origin) over
  // the centroid, which for a partial cylinder may not lie on the axis.
  if (data.axis && data.type === 'cylinderface') {
    const dir = normalize3(data.axis as number[])
    if (dir) {
      const sf = (data.surface_frame as { origin?: number[]; axis?: number[]; radius?: number } | undefined)
      const origin = sf?.origin ?? (data.origin as number[] | undefined) ?? (data.centroid as number[] | undefined) ?? [0, 0, 0]
      const radius = typeof sf?.radius === 'number' ? sf.radius : undefined
      return { kind: 'cylinderface', axis: dir, origin: [...origin], radius, faceRef: query }
    }
  }

  return null
}

/**
 * Resolve a query to a 3D line {start, direction}, shared by the direction/axis
 * resolvers. Circular/linear references go through resolveCircularReference; a
 * planar face falls back to its normal (the array runs along it).
 */
function resolveQueryToLine(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): { start: number[]; dir: number[] } | null {
  const circ = resolveCircularReference(query, globalRepo, bodyStore)
  if (circ) return { start: [...circ.origin], dir: circ.axis }

  if (!query) return null
  const data = globalRepo.query(query, null, bodyStore) as Dict | null
  if (!data) return null

  // Planar face: the array runs along the face normal.
  if ('normal' in data) {
    const dir = normalize3(data.normal as number[])
    if (dir) {
      const origin = (data.origin as number[] | undefined) ?? (data.centroid as number[] | undefined) ?? [0, 0, 0]
      return { start: [...origin], dir }
    }
  }

  return null
}

/**
 * Resolve a direction query to a unit vector (mirrors `_resolve_direction_query`).
 * Handles both 3D edge results ({start, end}) and 2D sketch-line results
 * ({external_params, kind: "line", sketch_id}) lifted through their plane.
 * Returns `fallback` when the query is empty or yields no usable direction.
 */
export function resolveDirectionQuery(
  query: string,
  globalRepo: Repository,
  fallback: number[],
  bodyStore: Record<string, unknown> | null = null,
): number[] {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? line.dir : fallback
}

/**
 * Resolve an axis query to (origin, unit direction) (mirrors `_resolve_axis_query`).
 * Same data shapes as `resolveDirectionQuery`; the axis origin is the line start.
 * Returns the fallbacks when the query is empty or yields no usable axis.
 */
export function resolveAxisQuery(
  query: string,
  globalRepo: Repository,
  fallbackOrigin: number[],
  fallbackDirection: number[],
  bodyStore: Record<string, unknown> | null = null,
): [number[], number[]] {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? [[...line.start], line.dir] : [fallbackOrigin, fallbackDirection]
}

/**
 * Resolve a direction query to a unit vector, or `null` when the query is empty
 * or does not resolve to a usable edge/face. Unlike `resolveDirectionQuery`
 * there is no silent world-axis fallback: the array leaf treats `null` as a
 * solve error so an unpicked direction never arrays along an arbitrary axis.
 */
export function resolveDirectionQueryStrict(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null = null,
): number[] | null {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? line.dir : null
}

/**
 * Resolve an axis query to (origin, unit direction), or `null` when the query is
 * empty or does not resolve to a usable edge/face. The strict counterpart to
 * `resolveAxisQuery`; the circular-array leaf treats `null` as a solve error so
 * an unpicked axis never rotates about an arbitrary line.
 */
export function resolveAxisQueryStrict(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null = null,
): [number[], number[]] | null {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? [[...line.start], line.dir] : null
}
