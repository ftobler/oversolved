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
// The shapes here are the PICK shapes. They are deliberately THIN: the ID
// resolver already scans a window around the cursor and returns the nearest
// entity within its inscribed disc -- 8 CSS px in every direction, at any
// device pixel ratio (IdResolver.ts, IdPipeline's DEFAULT_WINDOW_SIZE) -- so
// grab tolerance is provided once, in pixel space, for every layer. Fattening the geometry on
// top of that buys no reach and costs precision, because fat volumes from two
// different handles overlap and the winner is then decided by which triangle
// happened to rasterize last rather than by where the user aimed. The visual
// constants live here too so the two can never drift apart.

import { rotateVector, type Quat, type Vec3 } from '@/utils/transform3d'

/** On-screen size of the whole gizmo; the local units below scale to this. */
export const GIZMO_PIXELS = 90

export const ARROW_LENGTH = 1.1
export const SHAFT_RADIUS = ARROW_LENGTH * 0.02
export const HEAD_LENGTH = ARROW_LENGTH * 0.18
// One source for the drawn head base and its grab cylinder, exported under the
// two names consumers know (HEAD_RADIUS, ARROW_HEAD_PICK_RADIUS) so they cannot
// drift apart.
const HEAD_RADIUS_UNITS = ARROW_LENGTH * 0.06
export const HEAD_RADIUS = HEAD_RADIUS_UNITS
export const RING_RADIUS = 0.75
export const RING_TUBE = 0.02

// The plane quads live in the corner between two arrows, inside the rings.
// These are the span the handle had before it was enlarged; the shipped span is
// derived from them below.
export const PLANE_BASE_INNER = 0.24
export const PLANE_BASE_OUTER = 0.55

/**
 * How much bigger the plane grabber is than the span above. Applied about the
 * quad's OWN CENTRE, not about the origin, because the handle is boxed in at
 * both ends: inward by the arrow shafts (PLANE_INNER has to stay a full snap
 * window clear of ARROW_PICK_RADIUS, pinned in
 * picking/__tests__/gizmoHandleWins.test.ts) and
 * outward by the rings (PLANE_OUTER plus its outline has to stay under
 * RING_RADIUS). Scaling about the origin would spend the whole increase on the
 * outer edge and drag the centre out with it, moving the target away from where
 * the user already aims; growing in place splits the cost between the two edges
 * and leaves the centre put.
 *
 * Note the quad's far CORNER sits at PLANE_OUTER * sqrt(2), which is outside
 * RING_RADIUS at any size this handle has ever had. The ring is not what guards
 * that corner, so do not read the bound above as a diagonal clearance.
 */
export const PLANE_HANDLE_SCALE = 1.2

const PLANE_CENTER = (PLANE_BASE_INNER + PLANE_BASE_OUTER) / 2
const PLANE_HALF_SPAN = ((PLANE_BASE_OUTER - PLANE_BASE_INNER) / 2) * PLANE_HANDLE_SCALE

export const PLANE_INNER = PLANE_CENTER - PLANE_HALF_SPAN
export const PLANE_OUTER = PLANE_CENTER + PLANE_HALF_SPAN

const TUBE_SIDES = 6
const RING_SEGMENTS = 28

/**
 * Circumradius of a pick tube that rasterizes at least `px` pixels wide, seen
 * from any angle.
 *
 * Derivation, so the next reader can re-derive rather than trust a number:
 * GizmoPickLayer scales this soup by `GIZMO_PIXELS * p2w(camera)`, and `p2w` is
 * world units per screen pixel, so one local unit is exactly GIZMO_PIXELS (90)
 * pixels on screen at any zoom -- a local length L renders at L * 90 px.
 * `addTube`/`addTorus` give the tube a regular TUBE_SIDES-gon cross-section of
 * circumradius r, whose NARROWEST silhouette is across the flats, 2r*cos(pi/n).
 * So the worst-case rasterized width is 2r*cos(pi/n)*GIZMO_PIXELS pixels, and
 * this inverts that.
 */
function pickTubeRadius(px: number): number {
  return px / (2 * Math.cos(Math.PI / TUBE_SIDES) * GIZMO_PIXELS)
}

/**
 * The width every line-shaped grab region is drawn at in the ID buffer. Not 1:
 * a band narrower than a pixel can slip between pixel centres and vanish from
 * the buffer for a whole stretch of its length, so 1.5 buys a continuous run
 * with margin. Still under half the drawn shaft (2 * SHAFT_RADIUS * 90 = 4 px).
 */
export const PICK_LINE_PX = 1.5

// Grab regions. The arrow's is a hairline tube running the length of the shaft,
// starting clear of the hub so the three arrows do not fight over the pixels
// where they meet, and so a plane handle can own that corner instead.
export const ARROW_PICK_RADIUS = pickTubeRadius(PICK_LINE_PX)
export const ARROW_PICK_START = 0.14
export const RING_PICK_TUBE = pickTubeRadius(PICK_LINE_PX)

/**
 * The head is the one part of the triad that is a solid target rather than a
 * line, so its grab region is the drawn cone's own base radius: a user aiming
 * at the middle of a visible arrowhead should hit it without leaning on the
 * resolver's snap. A cylinder over the cone's span is never wider than the cone
 * is at its base, so this still never exceeds what is drawn.
 */
export const ARROW_HEAD_PICK_RADIUS = HEAD_RADIUS_UNITS

export type GizmoHandleKind = 'translate' | 'rotate' | 'plane'

/** The part-local axis a handle belongs to, as it appears in the handle key. */
export type GizmoAxisName = 'x' | 'y' | 'z'

export interface GizmoAxisDef {
  // Suffix in the handle's entity key.
  name: GizmoAxisName
  // The part-local axis this handle acts on.
  axis: Vec3
  // Right-handed companions: `u x v = axis`.
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
  // Non-indexed triangles, world space, length = tris * 9.
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
 * How far the drag emphasis outline stands off the quad it surrounds. A
 * fraction of the quad's own span rather than a free number, so the halo keeps
 * its proportion if the plane handle is ever resized: a fifth of the side reads
 * as clearly detached without touching the arrows the quad sits between.
 */
export const PLANE_OUTLINE_MARGIN = (PLANE_OUTER - PLANE_INNER) * 0.2

/**
 * The plane handle's emphasis outline: the quad's corner ring pushed outward by
 * PLANE_OUTLINE_MARGIN on all four sides, and closed by repeating the first
 * corner so a consumer can draw it as one polyline. Same `u`/`v` basis as the
 * quad, so the outline lies in the handle's plane whatever the axis.
 */
export function planeHandleOutline(def: GizmoAxisDef): [Vec3, Vec3, Vec3, Vec3, Vec3] {
  const { u, v, axis } = def
  const lo = PLANE_INNER - PLANE_OUTLINE_MARGIN
  const hi = PLANE_OUTER + PLANE_OUTLINE_MARGIN
  const at = (cu: number, cv: number) => combine(u, v, axis, cu, cv, 0)
  return [at(lo, lo), at(hi, lo), at(hi, hi), at(lo, hi), at(lo, lo)]
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
    // Second tube, same handle: TriadGizmo centres the cone on ARROW_LENGTH, so
    // this is the span the user sees a solid arrowhead over.
    addTube(b, def, ARROW_LENGTH - HEAD_LENGTH / 2, ARROW_LENGTH + HEAD_LENGTH / 2, ARROW_HEAD_PICK_RADIUS)
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
