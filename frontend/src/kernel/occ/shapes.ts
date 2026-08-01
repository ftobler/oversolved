/**
 * Pure geometry helpers (triangle area, face sort key) live here, and the make-a-body entry
 * points (`buildBox`, `buildCylinder`, `buildExtrudedProfile`) compose `primitives.ts` and
 * register the produced solid in the [[HandleTable]]. This module never touches OCC.js types
 * directly; that is primitives.ts's job.
 */

import { DisposeScope } from './disposeScope'
import { HandleTable, type OccHandle } from './handleTable'
import type { OccModule } from './occTypes'
import {
  makeArcEdge,
  makeBox,
  makeCircleEdge,
  makeCylinder,
  makeFaceFromWire,
  makeLineEdge,
  makePrism,
  makeWire,
  round6,
  type SurfaceType,
  type Vec3,
} from './primitives'

// ─── pure helpers ───

/** Area of a triangle from three 3D points (mirrors `_triangle_area`). */
export function triangleArea(p0: Vec3, p1: Vec3, p2: Vec3): number {
  const v1: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
  const v2: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
  const nx = v1[1] * v2[2] - v1[2] * v2[1]
  const ny = v1[2] * v2[0] - v1[0] * v2[2]
  const nz = v1[0] * v2[1] - v1[1] * v2[0]
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz)
}

export interface FaceSortItem {
  centroid: Vec3
  normal: Vec3
  surfaceType: SurfaceType
  axis?: Vec3
}

/**
 * Sort key mirroring `_face_sort_key_from_tuple`: flat faces before curved,
 * then by (normal, centroid) rounded to 6 decimals. Returned as a flat numeric
 * tuple for lexicographic comparison.
 */
export function faceSortKey(item: FaceSortItem): number[] {
  const typeOrder = item.surfaceType === 'flatface' ? 0 : 1
  const n = item.normal
  const c = item.centroid
  return [typeOrder, round6(n[0]), round6(n[1]), round6(n[2]), round6(c[0]), round6(c[1]), round6(c[2])]
}

/** Lexicographic comparator over `faceSortKey` outputs. */
export function compareFaceSortKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

// ─── body building ───

interface BoxSpec {
  dx: number
  dy: number
  dz: number
  owner?: string
}

export function buildBox(oc: OccModule, table: HandleTable, spec: BoxSpec): OccHandle {
  const scope = new DisposeScope()
  try {
    const solid = makeBox(oc, scope, spec.dx, spec.dy, spec.dz)
    return table.register(solid, spec.owner)
  } finally {
    scope.dispose()
  }
}

interface CylinderSpec {
  center: Vec3
  axis: Vec3
  radius: number
  height: number
  owner?: string
}

export function buildCylinder(oc: OccModule, table: HandleTable, spec: CylinderSpec): OccHandle {
  const scope = new DisposeScope()
  try {
    const solid = makeCylinder(oc, scope, spec.center, spec.axis, spec.radius, spec.height)
    return table.register(solid, spec.owner)
  } finally {
    scope.dispose()
  }
}

interface ExtrudeProfileSpec {
  // Closed polygon of world-space corners (not repeating the first point).
  loop: Vec3[]
  // Extrude direction (unit vector).
  direction: Vec3
  distance: number
  owner?: string
}

export function buildExtrudedProfile(
  oc: OccModule,
  table: HandleTable,
  spec: ExtrudeProfileSpec,
): OccHandle {
  if (spec.loop.length < 3) throw new Error('extrude profile needs at least 3 points')
  const scope = new DisposeScope()
  try {
    const edges = spec.loop.map((p, i) =>
      makeLineEdge(oc, scope, p, spec.loop[(i + 1) % spec.loop.length]),
    )
    const wire = makeWire(oc, scope, edges)
    const face = makeFaceFromWire(oc, scope, wire)
    const solid = makePrism(oc, scope, face, spec.direction, spec.distance)
    return table.register(solid, spec.owner)
  } finally {
    scope.dispose()
  }
}

/** One profile edge: a straight segment, a circular arc, or a full circle. */
export type EdgeSpec =
  | { kind: 'line'; start: Vec3; end: Vec3 }
  | {
      kind: 'arc'
      center: Vec3
      normal: Vec3
      xAxis: Vec3
      radius: number
      angleStart: number
      angleEnd: number
    }
  | { kind: 'circle'; center: Vec3; normal: Vec3; xAxis: Vec3; radius: number }

interface ProfileExtrudeSpec {
  edges: EdgeSpec[]
  direction: Vec3
  distance: number
  owner?: string
}

/**
 * Extrude a profile made of mixed line/arc/circle edges (the general make-a-body
 * path: rounded rectangles, slots, circles). The edges must form a single closed
 * loop in order.
 */
export function buildProfileExtrude(
  oc: OccModule,
  table: HandleTable,
  spec: ProfileExtrudeSpec,
): OccHandle {
  if (spec.edges.length < 1) throw new Error('profile needs at least one edge')
  const scope = new DisposeScope()
  try {
    const edges = spec.edges.map((e) => {
      if (e.kind === 'line') return makeLineEdge(oc, scope, e.start, e.end)
      if (e.kind === 'circle') return makeCircleEdge(oc, scope, e.center, e.normal, e.xAxis, e.radius)
      return makeArcEdge(oc, scope, e.center, e.normal, e.xAxis, e.radius, e.angleStart, e.angleEnd)
    })
    const wire = makeWire(oc, scope, edges)
    const face = makeFaceFromWire(oc, scope, wire)
    const solid = makePrism(oc, scope, face, spec.direction, spec.distance)
    return table.register(solid, spec.owner)
  } finally {
    scope.dispose()
  }
}
