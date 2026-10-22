// Where the section plane sits and which half it removes.
//
// A section is a viewing aid, so its plane is derived from data the viewport
// already has (a builtin direction, a solved user plane, a planar face) rather
// than authored into the document. This module is the pure half: given a source
// and the scene's plane/face lookup, produce the normal and point the one
// shared THREE.Plane is built from.
import * as THREE from 'three'
import type { PlaneTransform } from '@/types/cad'

export type BuiltinSectionPlaneId = 'front' | 'top' | 'right'

/**
 * The plane the user chose. `query` covers both a user-defined plane and a
 * planar face: the resolver tries the solve result's plane transform first and
 * the body face frame second, so a query that stops resolving is detectable in
 * one place.
 */
export type SectionPlaneSource =
  | { kind: 'builtin'; id: BuiltinSectionPlaneId }
  | { kind: 'query'; query: string }

export interface SectionFrame {
  // Unit normal of the plane, before offset and flip.
  normal: [number, number, number]
  // A point the plane passes through, before offset.
  point: [number, number, number]
}

export const BUILTIN_SECTION_PLANES: readonly BuiltinSectionPlaneId[] = ['front', 'top', 'right']

// The builtin sketch planes' own normals, so the section agrees with the plane
// the user sees when they pick Front/Top/Right in the tree.
const BUILTIN_FRAMES: Record<BuiltinSectionPlaneId, SectionFrame> = {
  front: { normal: [0, 0, 1], point: [0, 0, 0] },
  top: { normal: [0, 1, 0], point: [0, 0, 0] },
  right: { normal: [1, 0, 0], point: [0, 0, 0] },
}

export function builtinSectionFrame(id: BuiltinSectionPlaneId): SectionFrame {
  const frame = BUILTIN_FRAMES[id]
  return { normal: [...frame.normal], point: [...frame.point] }
}

export interface SectionFrameSources {
  // The solved transform of a user-defined plane, or null when it is gone.
  planeTransform: (query: string) => Pick<PlaneTransform, 'rotation' | 'origin'> | null | undefined
  // The normal and center of a planar B-rep face, or null when it is gone.
  faceFrame: (query: string) => SectionFrame | null
}

function unitNormal(normal: readonly number[]): [number, number, number] | null {
  const [x, y, z] = normal
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  const length = Math.hypot(x, y, z)
  if (!(length > 1e-9)) return null
  return [x / length, y / length, z / length]
}

/**
 * The frame a source names right now, or null when it no longer resolves. A
 * builtin always resolves; a query stops resolving when its plane feature or
 * face left the document after a solve, which is what disables the section with
 * a reason rather than clipping against a stale plane.
 */
export function resolveSectionFrame(source: SectionPlaneSource, sources: SectionFrameSources): SectionFrame | null {
  if (source.kind === 'builtin') return builtinSectionFrame(source.id)

  const transform = sources.planeTransform(source.query)
  if (transform) {
    // PlaneTransform stores its axes as rows, so the last triplet is the normal.
    const [, , , , , , nx, ny, nz] = transform.rotation
    const normal = unitNormal([nx, ny, nz])
    if (normal) {
      const [px, py, pz] = transform.origin
      return { normal, point: [px, py, pz] }
    }
  }

  const face = sources.faceFrame(source.query)
  if (!face) return null
  const normal = unitNormal(face.normal)
  if (!normal) return null
  return { normal, point: [face.point[0], face.point[1], face.point[2]] }
}

/** Move a frame's point along its own normal. */
export function offsetFramePoint(frame: SectionFrame, offset: number): [number, number, number] {
  const [nx, ny, nz] = frame.normal
  const [px, py, pz] = frame.point
  return [px + nx * offset, py + ny * offset, pz + nz * offset]
}

/**
 * The section arrow's drag mapping: the offset is a world distance along the
 * source normal, so axis travel maps onto it one-to-one (closestParamOnAxis
 * already normalises the axis).
 */
export function sectionOffsetFromDrag(startOffset: number, startParam: number, currentParam: number): number {
  return startOffset + (currentParam - startParam)
}

/**
 * The three.js clipping plane for a frame. `offset` slides the plane along the
 * normal; `flipped` swaps which side survives by negating both the normal and
 * the constant, which is exactly keeping the other half-space.
 */
export function sectionPlaneFromFrame(
  frame: SectionFrame,
  offset: number,
  flipped: boolean,
  out: THREE.Plane = new THREE.Plane(),
): THREE.Plane {
  const normal = new THREE.Vector3(...frame.normal)
  const point = new THREE.Vector3(...offsetFramePoint(frame, offset))
  out.setFromNormalAndCoplanarPoint(normal, point)
  if (flipped) out.negate()
  return out
}

/** A short label for the dropdown's current source. */
export function sectionSourceLabel(source: SectionPlaneSource): string {
  if (source.kind === 'builtin') {
    return source.id === 'front' ? 'Front' : source.id === 'top' ? 'Top' : 'Right'
  }
  return `Picked ${source.query}`
}
