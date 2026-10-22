// The one clipping plane every clipped body material shares.
//
// three reads a material's `clippingPlanes` array on every draw and reads each
// Plane's own values, so the section keeps ONE Plane and updates it in place
// when the offset or flip changes. Only the enabled/disabled transition touches
// the plane list itself, and that needs a program recompile on a custom shader
// (the clipping chunks are compiled in), hence `needsUpdate`.
//
// `applySectionClipping` is deliberately the only writer of a material's list:
// the bodies, their edges, the caps and the ID layers all route through it, so
// a layer cannot be left clipping with a stale plane list.
//
// Construction is lazy because several jsdom tests stub `three` with just the
// geometry classes they need; importing this module must not need Plane or
// Vector3 until a section is actually on.
import * as THREE from 'three'

let SECTION_PLANE: THREE.Plane | null = null
let SECTION_PLANE_LIST: THREE.Plane[] | null = null

function ensurePlane(): THREE.Plane {
  if (!SECTION_PLANE) {
    SECTION_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    SECTION_PLANE_LIST = [SECTION_PLANE]
  }
  return SECTION_PLANE
}

// True while the shared plane is the live section. CPU raycasts that can hit a
// body read this to discard a hit on the removed side; the ID buffer needs no
// such filter because its layers clip in the GPU.
let active = false

/** The shared plane object. Callers may read its normal/constant, never keep it. */
export function getSectionClipPlane(): THREE.Plane {
  return ensurePlane()
}

/**
 * The live plane list. Materials may hold this array for their lifetime: the
 * plane object inside it is updated in place, and only the list itself is
 * attached/detached on a toggle.
 */
export function getSectionClipPlaneList(): THREE.Plane[] {
  ensurePlane()
  return SECTION_PLANE_LIST!
}

export function isSectionClippingActive(): boolean {
  return active
}

/**
 * Point the shared plane at `plane` and mark the section live, or clear it.
 * Copied in place so every material's plane list keeps referencing the same
 * object across updates.
 */
export function setSectionClipPlane(plane: THREE.Plane | null): void {
  if (!plane) {
    active = false
    return
  }
  ensurePlane().copy(plane)
  active = true
}

/**
 * The plane list a streaming material should carry while the section is on.
 * Null (not an empty array) is what three treats as "no local clipping".
 */
export function sectionClippingPlanes(): THREE.Plane[] | null {
  return active ? getSectionClipPlaneList() : null
}

/**
 * Attach the shared plane list to a material, or clear it. Custom ShaderMaterials
 * must also be built with `clipping: true`; built-in materials need no flag.
 */
export function applySectionClipping(
  material: THREE.Material | null | undefined,
  clip: boolean,
): void {
  if (!material) return
  const next = clip ? getSectionClipPlaneList() : null
  if (material.clippingPlanes === next) return
  material.clippingPlanes = next
  material.needsUpdate = true
}

/**
 * Whether a world point is on the removed side of the live section. Clipping
 * discards where `dot(normal, p) + constant > 0`, i.e. a positive signed
 * distance. Without an active section nothing is clipped.
 */
export function isPointClipped(point: THREE.Vector3 | readonly [number, number, number]): boolean {
  if (!active) return false
  const plane = ensurePlane()
  const x = Array.isArray(point) ? point[0] : (point as THREE.Vector3).x
  const y = Array.isArray(point) ? point[1] : (point as THREE.Vector3).y
  const z = Array.isArray(point) ? point[2] : (point as THREE.Vector3).z
  return plane.normal.x * x + plane.normal.y * y + plane.normal.z * z + plane.constant > 0
}

/** Test helper: forget the live plane without going through React. */
export function resetSectionClippingForTest(): void {
  active = false
  if (SECTION_PLANE) SECTION_PLANE.set(new THREE.Vector3(0, 0, 1), 0)
}
