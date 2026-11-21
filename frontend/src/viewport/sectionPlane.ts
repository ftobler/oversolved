// Where the section plane sits and which half it removes.
//
// A section is a viewing aid, so its plane is derived from data the viewport
// already has (a builtin direction, a solved user plane, a planar face) rather
// than authored into the document. This module is the pure half: given a source
// and the scene's plane/face lookup, produce the normal, point and in-plane axes
// the one shared THREE.Plane is built from. It also fits the faint guide
// rectangle: the model's bounds projected onto those same axes.
import * as THREE from 'three'
import type { Feature, PartResult, PlaneTransform } from '@/types/cad'
import { BUILTIN_PLANES } from '@/kernel/solverConstants'
import { normalToFrame } from '@/kernel/types3d'
import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'
import { computeVertexBounds, unionVertexBounds, type VertexBounds } from '@/utils/geometry/vertexBounds'
import { isPartHiddenByFeature } from '@/utils/partRender'
import type { BuiltinSectionPlaneId, SectionPlaneSource, SectionTilt } from './sectionTypes'
import { NO_TILT, tiltedSectionFrame } from './sectionTilt'

export type { BuiltinSectionPlaneId, SectionPlaneSource } from './sectionTypes'
export {
  applySectionTiltSwing, clampSectionTilt, MAX_SECTION_TILT_DEG, NO_TILT,
  sectionOffsetFromTiltedDrag, tiltedSectionFrame,
} from './sectionTilt'
export type { SectionTilt, TiltedSectionFrame } from './sectionTilt'

// Size of the cap quad in world units. The cap is the cut face of an infinite
// plane; the quad only has to cover the model, so a generously large one keeps
// the plane from ending inside a big imported solid. The stencil count is what
// decides where it paints, so an oversized quad costs nothing visible. Lives
// here so the visible cap and the ID-buffer cap cannot disagree.
export const SECTION_CAP_SIZE = 10000

export interface SectionFrame {
  // Unit normal of the plane, before offset, flip and tilt.
  normal: [number, number, number]
  // A point the plane passes through, before offset.
  point: [number, number, number]
  // Unit in-plane axes of the source, right-handed: `u x v = normal`. They are
  // the reference a tilt's pitch and yaw are counted from, and the axes a
  // sketch on the same face would use, so the rings line up with the geometry.
  u: [number, number, number]
  v: [number, number, number]
}

export const BUILTIN_SECTION_PLANES: readonly BuiltinSectionPlaneId[] = ['front', 'top', 'right']

// The builtin sketch planes' own canonical normals and axes, so the section
// agrees with the plane the user sees when they pick Front/Top/Right in the
// tree. Sourced from the kernel's one table rather than a second copy.
export function builtinSectionFrame(id: BuiltinSectionPlaneId): SectionFrame {
  const plane = BUILTIN_PLANES[`builtin_plane_${id}`]
  const normal = unitNormal(plane.normal as number[])
  const u = unitNormal(plane.x_axis as number[])
  const v = unitNormal(plane.y_axis as number[])
  if (!normal || !u || !v) throw new Error(`builtin section plane ${id} has no usable frame`)
  const origin = plane.origin as number[]
  return {
    normal,
    point: [origin[0], origin[1], origin[2]],
    u,
    v,
  }
}

export interface SectionFrameSources {
  // The solved transform of a user-defined plane, or null when it is gone.
  planeTransform: (query: string) => Pick<PlaneTransform, 'rotation' | 'origin'> | null | undefined
  // The normal and center of a planar B-rep face, or null when it is gone.
  // `pickKey` names the exact primitive when a query is shared. Its in-plane
  // axes are not carried: a face has no authored spin, so the resolver derives
  // them from the normal the same way a face sketch does.
  faceFrame: (query: string, pickKey?: string) => Pick<SectionFrame, 'normal' | 'point'> | null
}

function unitNormal(normal: readonly number[]): [number, number, number] | null {
  const [x, y, z] = normal
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  const length = Math.hypot(x, y, z)
  if (!(length > 1e-9)) return null
  return [x / length, y / length, z / length]
}

/**
 * The in-plane axes for a normal, honouring a transform row when it is usable.
 *
 * `u` is the row projected into the plane and `v` is derived from the normal,
 * so `u x v = normal` holds exactly even if a stored transform is slightly
 * non-orthonormal. A degenerate row falls back to the sketch convention.
 */
function planeAxes(normal: Vec3, uRow?: readonly number[]): { u: Vec3; v: Vec3 } {
  const fallback = normalToFrame([normal[0], normal[1], normal[2]])
  const raw = uRow ? unitNormal(uRow) : null
  if (!raw) return { u: fallback.x_axis, v: fallback.y_axis }
  const projected = sub(raw, scale(normal, dot(raw, normal)))
  const u = unitNormal(projected)
  if (!u) return { u: fallback.x_axis, v: fallback.y_axis }
  const v = unitNormal(cross(normal, u))
  return v ? { u, v } : { u: fallback.x_axis, v: fallback.y_axis }
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
    // PlaneTransform stores its axes as rows, so the last triplet is the normal
    // and the first two are the plane's own x/y.
    const [x0, x1, x2, , , , nx, ny, nz] = transform.rotation
    const normal = unitNormal([nx, ny, nz])
    if (normal) {
      const { u, v } = planeAxes(normal, [x0, x1, x2])
      const [px, py, pz] = transform.origin
      return { normal, point: [px, py, pz], u, v }
    }
  }

  const face = sources.faceFrame(source.query, source.pickKey)
  if (!face) return null
  const normal = unitNormal(face.normal)
  if (!normal) return null
  const { u, v } = planeAxes(normal)
  return { normal, point: [face.point[0], face.point[1], face.point[2]], u, v }
}

/** Move a frame's point along its own normal. */
export function offsetFramePoint(frame: SectionFrame, offset: number): [number, number, number] {
  const [nx, ny, nz] = frame.normal
  const [px, py, pz] = frame.point
  return [px + nx * offset, py + ny * offset, pz + nz * offset]
}

export interface SectionOutlineRect {
  center: Vec3
  halfU: number
  halfV: number
}

/**
 * The outline rectangle for a section plane: the model's bounds projected into
 * the plane's own 2D axes, grown to include the plane anchor (where the arrow
 * sits) and padded by a margin. Null when there is no geometry, and the caller
 * then keeps a default size.
 *
 * The eight box corners are exact for a builtin plane and any axis-aligned user
 * plane. A plane tilted against the model's axes over-estimates by at most the
 * box's corner reach, which is acceptable for a guide outline and keeps the
 * measurement cheap enough to repeat on every offset drag.
 */
export function sectionOutlineRect(
  bounds: VertexBounds | null,
  anchor: Vec3,
  u: Vec3,
  v: Vec3,
): SectionOutlineRect | null {
  if (!bounds) return null
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max

  // The anchor starts the range, so the arrow's base is always inside the
  // rectangle even when the plane source (the origin, a far-away user plane)
  // sits outside the model.
  let minS = 0, maxS = 0
  let minT = 0, maxT = 0
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [
      i & 1 ? maxX : minX,
      i & 2 ? maxY : minY,
      i & 4 ? maxZ : minZ,
    ]
    const offset = sub(corner, anchor)
    const s = dot(offset, u)
    const t = dot(offset, v)
    if (s < minS) minS = s
    if (s > maxS) maxS = s
    if (t < minT) minT = t
    if (t > maxT) maxT = t
  }

  const midS = (minS + maxS) / 2
  const midT = (minT + maxT) / 2
  // A tenth of the larger side on every side, with a floor of one world unit:
  // a thin plate seen edge-on would otherwise get a zero-width rectangle, and a
  // tiny part an invisible border.
  const margin = Math.max(0.1 * Math.max(maxS - minS, maxT - minT), 1)
  return {
    center: add(anchor, add(scale(u, midS), scale(v, midT))),
    halfU: (maxS - minS) / 2 + margin,
    halfV: (maxT - minT) / 2 + margin,
  }
}

export interface SectionOutlineParts {
  parts: Record<string, PartResult> | undefined
  features: Feature[] | undefined
  visibleParts: Set<string> | undefined
  visibleFeatures: ReadonlySet<string> | undefined
}

/**
 * The union of the bounds of the parts the viewport draws. A part hidden by its
 * part row or by its creating feature's eye is skipped while another part is in
 * view; when every part is hidden the union still measures all of them, because
 * hiding the model must not shrink the section guide to the default square.
 * Null when no part has a solved mesh (a sketch-only document, or before the
 * first solve).
 */
export function sectionOutlineBounds(model: SectionOutlineParts): VertexBounds | null {
  const { parts, features, visibleParts, visibleFeatures } = model
  const meshed = Object.entries(parts ?? {}).filter(([, part]) => part.mesh?.vertices)
  const drawn = meshed.filter(([partId, part]) =>
    (visibleParts === undefined || visibleParts.has(partId))
    && !isPartHiddenByFeature(part.created_by, features, visibleFeatures))
  let union: VertexBounds | null = null
  for (const [, part] of drawn.length > 0 ? drawn : meshed) {
    union = unionVertexBounds(union, computeVertexBounds(part.mesh!.vertices))
  }
  return union
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
 * The three.js clipping plane for a frame.
 *
 * three clips points whose signed distance to the plane is NEGATIVE
 * (`clipping_planes_vertex` writes `vClipPosition = -mvPosition.xyz`, and the
 * fragment discards where `dot(vClipPosition, plane.xyz) > plane.w`). The
 * unflipped section keeps the half BEHIND the source normal, which is the far
 * half a camera looking along the normal sees into: the cut face then faces the
 * viewer. So the plane is built with the negated normal, and `flipped` keeps it
 * pointing at the source normal instead (the near half survives).
 *
 * `offset` slides the pivot along the SOURCE normal before the tilt is applied,
 * so a positive offset always moves the cut in the same world direction
 * whichever side survives. The tilted plane passes through that same pivot with
 * the tilted normal, so the point under the gizmo stays on the plane.
 */
export function sectionPlaneFromFrame(
  frame: SectionFrame,
  offset: number,
  flipped: boolean,
  tilt: SectionTilt = NO_TILT,
  out: THREE.Plane = new THREE.Plane(),
): THREE.Plane {
  const normal = new THREE.Vector3(...tiltedSectionFrame(frame, tilt).normal)
  const point = new THREE.Vector3(...offsetFramePoint(frame, offset))
  out.setFromNormalAndCoplanarPoint(normal, point)
  // Keeping the negative side is the default; flipping negates both fields,
  // which is exactly keeping the other half-space.
  if (!flipped) out.negate()
  return out
}

/** A value-comparison key for the resolved frame, used to avoid dirtying the
 *  pick buffer on a solve that moved nothing. The axes are part of it because a
 *  user plane's in-plane spin can change while its normal does not, and the
 *  rings and the outline then have to follow. */
export function sectionFrameKey(frame: SectionFrame | null): string {
  if (!frame) return 'none'
  const f = (v: number): string => v.toFixed(6)
  return `${frame.normal.map(f).join(',')}|${frame.point.map(f).join(',')}|`
    + `${frame.u.map(f).join(',')}|${frame.v.map(f).join(',')}`
}
