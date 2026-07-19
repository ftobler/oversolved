// The triad gizmo's grab regions as world-space triangle soup, generated
// without a viewport.
//
// Why the gizmo is picked from the ID buffer and not from R3F's raycaster: the
// gizmo's materials run with `depthTest: false`, so it always DRAWS on top, but
// the raycaster sorts hits by true geometric distance and knows nothing about
// that. The triad sits at the part's origin, which for most parts is inside the
// solid, so every arrow and ring is behind the front surface and the body's
// grab consumed the pointer first. The ID buffer resolves by layer priority
// instead, which is the same rule the gizmo is drawn by.
//
// The shapes here are the PICK shapes, deliberately fatter than what
// TriadGizmo.tsx draws: a 2%-radius shaft is a pixel-hunt. The visual constants
// live here too so the two can never drift apart.

import { rotateVector, type Quat, type Vec3 } from '@/utils/transform3d'

/** On-screen size of the whole gizmo; the local units below scale to this. */
export const GIZMO_PIXELS = 90

export const ARROW_LENGTH = 1.1
export const SHAFT_RADIUS = ARROW_LENGTH * 0.02
export const HEAD_LENGTH = ARROW_LENGTH * 0.18
export const HEAD_RADIUS = ARROW_LENGTH * 0.06
export const RING_RADIUS = 0.75
export const RING_TUBE = 0.02

// Grab regions. The arrow's is a plain tube covering shaft and head; it starts
// clear of the hub so the three arrows do not fight over the pixels where they
// meet, and so a plane handle can own that corner instead.
const ARROW_PICK_RADIUS = 0.085
const ARROW_PICK_START = 0.14
export const RING_PICK_TUBE = 0.06

// The plane quads live in the corner between two arrows, inside the rings.
export const PLANE_INNER = 0.24
export const PLANE_OUTER = 0.55

const TUBE_SIDES = 6
const RING_SEGMENTS = 28

export type GizmoHandleKind = 'translate' | 'rotate' | 'plane'

/** The part-local axis a handle belongs to, as it appears in the handle key. */
export type GizmoAxisName = 'x' | 'y' | 'z'

export interface GizmoAxisDef {
  /** Suffix in the handle's entity key. */
  name: GizmoAxisName
  /** The part-local axis this handle acts on. */
  axis: Vec3
  /** Right-handed companions: `u x v = axis`. */
  u: Vec3
  v: Vec3
}

export const GIZMO_AXES: readonly GizmoAxisDef[] = [
  { name: 'x', axis: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { name: 'y', axis: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { name: 'z', axis: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
]

export function gizmoHandleKey(kind: GizmoHandleKind, axisName: string): string {
  return `gizmo:${kind}:${axisName}`
}

export interface GizmoHandleRef {
  kind: GizmoHandleKind
  /**
   * Which axis, by name. Carried alongside `axis` because a consumer that has
   * to name the handle back to the user (the drag state a dial renders from)
   * would otherwise have to match a rotated vector against GIZMO_AXES.
   */
  name: GizmoAxisName
  /**
   * Part-local; the caller rotates it into world space by the part's pose. For
   * a plane handle this is the plane's NORMAL, so `gizmo:plane:z` is the XY
   * quad -- the same convention a rotate handle uses, which is what lets one
   * dispatch serve all three kinds.
   */
  axis: Vec3
  /**
   * The axis's local `u` companion, the bearing a ring's angles are measured
   * from. Part-local like `axis`, and lifted to world by the same pose.
   */
  reference: Vec3
}

/** Null for anything that is not one of this module's keys. */
export function parseGizmoHandleKey(key: string | null | undefined): GizmoHandleRef | null {
  if (!key) return null
  const parts = key.split(':')
  if (parts.length !== 3 || parts[0] !== 'gizmo') return null
  const [, kind, name] = parts
  if (kind !== 'translate' && kind !== 'rotate' && kind !== 'plane') return null
  const def = GIZMO_AXES.find(a => a.name === name)
  if (!def) return null
  return { kind, name: def.name, axis: def.axis, reference: def.u }
}

export interface GizmoPickGeometry {
  /** Non-indexed triangles, world space, length = tris * 9. */
  positions: Float32Array
  triangleToFace: Uint32Array
  faceQueries: string[]
}

type LocalPoint = Vec3

/** Accumulates local-frame triangles, one `face` index per handle. */
class SoupBuilder {
  readonly points: LocalPoint[] = []
  readonly triangleToFace: number[] = []
  readonly faceQueries: string[] = []
  private face = -1

  beginHandle(query: string): void {
    this.face = this.faceQueries.length
    this.faceQueries.push(query)
  }

  tri(a: LocalPoint, b: LocalPoint, c: LocalPoint): void {
    this.points.push(a, b, c)
    this.triangleToFace.push(this.face)
  }

  quad(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
}

function combine(u: Vec3, v: Vec3, w: Vec3, cu: number, cv: number, cw: number): LocalPoint {
  return [
    u[0] * cu + v[0] * cv + w[0] * cw,
    u[1] * cu + v[1] * cv + w[1] * cw,
    u[2] * cu + v[2] * cv + w[2] * cw,
  ]
}

/** A capped tube along `axis`, spanning [t0, t1] of it. */
function addTube(b: SoupBuilder, def: GizmoAxisDef, t0: number, t1: number, radius: number): void {
  const { u, v, axis } = def
  const ring = (t: number, i: number): LocalPoint => {
    const a = (i / TUBE_SIDES) * Math.PI * 2
    return combine(u, v, axis, Math.cos(a) * radius, Math.sin(a) * radius, t)
  }
  const cap0 = combine(u, v, axis, 0, 0, t0)
  const cap1 = combine(u, v, axis, 0, 0, t1)
  for (let i = 0; i < TUBE_SIDES; i++) {
    b.quad(ring(t0, i), ring(t0, i + 1), ring(t1, i + 1), ring(t1, i))
    // Caps matter when the arrow is sighted close to end-on: without them the
    // grab region would be an open pipe the ray looks straight through.
    b.tri(cap0, ring(t0, i + 1), ring(t0, i))
    b.tri(cap1, ring(t1, i), ring(t1, i + 1))
  }
}

/** A torus lying in the u/v plane, normal `axis`. */
function addTorus(b: SoupBuilder, def: GizmoAxisDef, major: number, minor: number): void {
  const { u, v, axis } = def
  const at = (i: number, j: number): LocalPoint => {
    const theta = (i / RING_SEGMENTS) * Math.PI * 2
    const phi = (j / TUBE_SIDES) * Math.PI * 2
    const r = major + Math.cos(phi) * minor
    return combine(u, v, axis, Math.cos(theta) * r, Math.sin(theta) * r, Math.sin(phi) * minor)
  }
  for (let i = 0; i < RING_SEGMENTS; i++) {
    for (let j = 0; j < TUBE_SIDES; j++) {
      b.quad(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))
    }
  }
}

/**
 * The four corners of a plane handle's quad, in gizmo-local units, wound so
 * consecutive corners share an edge. TriadGizmo draws exactly these, so what
 * the user sees and what the ID buffer can resolve are one quad, not two that
 * have to be kept in step by hand.
 */
export function planeHandleCorners(def: GizmoAxisDef): [Vec3, Vec3, Vec3, Vec3] {
  const { u, v, axis } = def
  const at = (cu: number, cv: number) => combine(u, v, axis, cu, cv, 0)
  return [
    at(PLANE_INNER, PLANE_INNER),
    at(PLANE_OUTER, PLANE_INNER),
    at(PLANE_OUTER, PLANE_OUTER),
    at(PLANE_INNER, PLANE_OUTER),
  ]
}

/**
 * Every triad handle as one registration payload, posed exactly like the drawn
 * gizmo: local units scaled by `scale` (which the caller derives from the
 * camera so the gizmo keeps its pixel size), rotated into the part's frame,
 * then placed at the part's origin.
 */
export function buildGizmoPickGeometry(
  origin: Vec3,
  orientation: Quat,
  scale: number,
): GizmoPickGeometry {
  const b = new SoupBuilder()

  for (const def of GIZMO_AXES) {
    b.beginHandle(gizmoHandleKey('translate', def.name))
    addTube(b, def, ARROW_PICK_START, ARROW_LENGTH + HEAD_LENGTH, ARROW_PICK_RADIUS)
  }
  for (const def of GIZMO_AXES) {
    b.beginHandle(gizmoHandleKey('rotate', def.name))
    addTorus(b, def, RING_RADIUS, RING_PICK_TUBE)
  }
  for (const def of GIZMO_AXES) {
    b.beginHandle(gizmoHandleKey('plane', def.name))
    const [p0, p1, p2, p3] = planeHandleCorners(def)
    b.quad(p0, p1, p2, p3)
  }

  const positions = new Float32Array(b.points.length * 3)
  for (let i = 0; i < b.points.length; i++) {
    const p = b.points[i]
    const w = rotateVector(orientation, [p[0] * scale, p[1] * scale, p[2] * scale])
    positions[i * 3] = origin[0] + w[0]
    positions[i * 3 + 1] = origin[1] + w[1]
    positions[i * 3 + 2] = origin[2] + w[2]
  }

  return {
    positions,
    triangleToFace: Uint32Array.from(b.triangleToFace),
    faceQueries: b.faceQueries,
  }
}
