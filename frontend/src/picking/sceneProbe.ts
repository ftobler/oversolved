// PURE LOGIC -- no three.js, no React, no GL.
//
// The scene probe is a plain, inspectable snapshot of what the viewport is
// showing: where the camera is, how big the canvas is, and which pickables its
// ID layers have registered, with their screen marks. `hitTest` ranks the
// same candidates the ID-buffer resolver would, from the same ladder data;
// `worldToScreen` / `sketchToScreen` convert coordinates through the same
// camera pose the marks were projected with. Everything here is JSON-safe.

import { pickPriorityOf } from './layerNames'
import { DEFAULT_WINDOW_SIZE, pickRadiusPx } from './screenSpaceScale'

/** Camera pose, in enough detail to project a world point for the ortho case. */
export interface ProbeCamera {
  position: [number, number, number]
  // Unit quaternion [x, y, z, w].
  orientation: [number, number, number, number]
  zoom: number
  // Column-major 4x4 projection matrix, three.js convention.
  projectionMatrix: readonly number[]
}

/**
 * The active sketch's plane transform, laid out like `PlaneTransform`: a
 * row-major 3x3 whose columns are the local x axis, local y axis and normal,
 * plus the plane origin. Null outside a sketch edit.
 */
export interface ProbePlane {
  rotation: readonly number[]
  origin: readonly number[]
}

export type ProbeMarkKind = 'point' | 'polyline' | 'polygon'

/**
 * What a publisher hands the probe: a pickable with world-space marks. The
 * screen marks are computed from these against the current camera at snapshot
 * time, so a camera move does not have to re-publish every pickable.
 */
export interface ProbePickableSource {
  pickKey: string
  entityKey: string
  layer: string
  kind: ProbeMarkKind
  points: ReadonlyArray<readonly [number, number, number]>
}

/** A pickable as published: its marks projected to CSS pixels, canvas origin. */
export interface SceneProbePickable {
  pickKey: string
  entityKey: string
  layer: string
  kind: ProbeMarkKind
  screenPoints: [number, number][]
}

/** The probe snapshot the dev bridge reads. JSON-safe, no functions. */
export interface SceneProbe {
  revision: number
  camera: ProbeCamera | null
  canvas: { width: number; height: number }
  sketchPlane: ProbePlane | null
  pickables: SceneProbePickable[]
}

/** One ordered candidate from `hitTest`, mirroring `ResolvedHit`'s ordering. */
export interface ProbeHit {
  pickKey: string
  entityKey: string
  layer: string
  kind: ProbeMarkKind
  distancePx: number
  // Index of the mark that produced the distance (a segment start for lines).
  markIndex: number
}

export interface ProbeHitOptions {
  // Square window edge in CSS pixels; the reach is its inscribed disc.
  windowSize?: number
  allowedLayers?: ReadonlySet<string>
}

const PROJECTION_EPSILON = 1e-9

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > PROJECTION_EPSILON) return false
  }
  return true
}

/** Pose equality for the store's publish-on-change guard. */
export function probeCamerasEqual(a: ProbeCamera | null, b: ProbeCamera | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return sameNumbers(a.position, b.position)
    && sameNumbers(a.orientation, b.orientation)
    && a.zoom === b.zoom
    && sameNumbers(a.projectionMatrix, b.projectionMatrix)
}

/**
 * Snapshot a three-like camera into the probe's plain pose. Structural rather
 * than typed against three.js so this module stays import-free of it; the real
 * caller is `SceneProbeDriver` inside the Canvas.
 */
export function probeCameraFrom(camera: {
  position: { x: number; y: number; z: number }
  quaternion: { x: number; y: number; z: number; w: number }
  zoom: number
  projectionMatrix: { elements: ArrayLike<number> }
}): ProbeCamera {
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    orientation: [
      camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w,
    ],
    zoom: camera.zoom,
    projectionMatrix: Array.from(camera.projectionMatrix.elements),
  }
}

/**
 * Rotate `v` by the conjugate of `q`: the world-to-camera-view rotation of a
 * unit quaternion. Active rotation with the vector part negated, written out
 * so no matrix or three.js is needed.
 */
function rotateByConjugate(
  q: readonly number[],
  vx: number, vy: number, vz: number,
): [number, number, number] {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3]
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]
}

/** Project one world point to CSS pixels, or null when it does not project. */
function projectWorldPoint(
  camera: ProbeCamera,
  canvas: { width: number; height: number },
  x: number, y: number, z: number,
): [number, number] | null {
  const [vx, vy, vz] = rotateByConjugate(
    camera.orientation, x - camera.position[0], y - camera.position[1], z - camera.position[2])
  const m = camera.projectionMatrix
  const clipX = m[0] * vx + m[4] * vy + m[8] * vz + m[12]
  const clipY = m[1] * vx + m[5] * vy + m[9] * vz + m[13]
  const clipW = m[3] * vx + m[7] * vy + m[11] * vz + m[15]
  if (!Number.isFinite(clipX) || !Number.isFinite(clipY)) return null
  if (!(clipW > 0) || !Number.isFinite(clipW)) return null
  const ndcX = clipX / clipW
  const ndcY = clipY / clipW
  return [(ndcX * 0.5 + 0.5) * canvas.width, (0.5 - ndcY * 0.5) * canvas.height]
}

function projectPoints(
  camera: ProbeCamera | null,
  canvas: { width: number; height: number },
  points: ReadonlyArray<readonly [number, number, number]>,
): ([number, number] | null)[] {
  if (!camera) return points.map(() => null)
  return points.map(([x, y, z]) => projectWorldPoint(camera, canvas, x, y, z))
}

/**
 * Project world points to CSS pixels with the probe camera; null per point
 * that does not project (behind a perspective camera). The orthographic part
 * viewport never produces null.
 */
export function worldToScreen(
  probe: SceneProbe,
  points: ReadonlyArray<readonly [number, number, number]>,
): ([number, number] | null)[] {
  return projectPoints(probe.camera, probe.canvas, points)
}

/** Transform a sketch-local 2D point into world space through the plane. */
export function sketchPointToWorld(
  plane: ProbePlane | null,
  x: number, y: number,
): [number, number, number] {
  if (!plane) return [x, y, 0]
  const r = plane.rotation
  const o = plane.origin
  return [
    (o[0] ?? 0) + x * (r[0] ?? 0) + y * (r[3] ?? 0),
    (o[1] ?? 0) + x * (r[1] ?? 0) + y * (r[4] ?? 0),
    (o[2] ?? 0) + x * (r[2] ?? 0) + y * (r[5] ?? 0),
  ]
}

/**
 * Project sketch-local 2D points through the probe's active sketch plane and
 * camera to CSS pixels. With no active plane the sketch frame is the world XY
 * plane at z=0, which is what a plain sketch renders in.
 */
export function sketchToScreen(
  probe: SceneProbe,
  points: ReadonlyArray<readonly [number, number]>,
): ([number, number] | null)[] {
  const camera = probe.camera
  if (!camera) return points.map(() => null)
  return points.map(([x, y]) => {
    const [wx, wy, wz] = sketchPointToWorld(probe.sketchPlane, x, y)
    return projectWorldPoint(camera, probe.canvas, wx, wy, wz)
  })
}

export interface ProbeBuildInput {
  revision: number
  camera: ProbeCamera | null
  canvas: { width: number; height: number }
  sketchPlane: ProbePlane | null
  pickables: ReadonlyArray<ProbePickableSource>
}

/** Assemble the JSON-safe snapshot: every source projected through the camera. */
export function buildSceneProbe(input: ProbeBuildInput): SceneProbe {
  return {
    revision: input.revision,
    camera: input.camera,
    canvas: { width: input.canvas.width, height: input.canvas.height },
    sketchPlane: input.sketchPlane,
    pickables: input.pickables.map(src => ({
      pickKey: src.pickKey,
      entityKey: src.entityKey,
      layer: src.layer,
      kind: src.kind,
      screenPoints: projectPoints(input.camera, input.canvas, src.points)
        .filter((p): p is [number, number] => p !== null),
    })),
  }
}

/** Distance from (px, py) to the segment a-b, in the same units as the input. */
export function pointToSegmentDistance(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Even-odd ray cast; a degenerate ring is never "inside". */
export function pointInPolygon(
  px: number, py: number,
  points: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (points.length < 3) return false
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1]
    const xj = points[j][0], yj = points[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Distance from the cursor to a pickable's nearest mark, with the index of
 * that mark. A point is its own distance; a polyline is its nearest segment;
 * a polygon is 0 inside its ring and the nearest edge distance outside.
 */
export function nearestMarkDistance(
  x: number, y: number,
  pickable: Pick<SceneProbePickable, 'kind' | 'screenPoints'>,
): { distance: number; markIndex: number } | null {
  const pts = pickable.screenPoints
  if (pts.length === 0) return null
  if (pickable.kind === 'point') {
    let best = Infinity
    let bestIndex = 0
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - x, pts[i][1] - y)
      if (d < best) { best = d; bestIndex = i }
    }
    return { distance: best, markIndex: bestIndex }
  }
  if (pickable.kind === 'polygon' && pointInPolygon(x, y, pts)) {
    return { distance: 0, markIndex: 0 }
  }
  // A polyline has n-1 segments; a polygon closes with its last edge.
  const segments = pickable.kind === 'polygon' ? pts.length : pts.length - 1
  let best = Infinity
  let bestIndex = 0
  for (let i = 0; i < segments; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const d = pointToSegmentDistance(x, y, a[0], a[1], b[0], b[1])
    if (d < best) { best = d; bestIndex = i }
  }
  return { distance: best, markIndex: bestIndex }
}

/**
 * The probe's pick: every candidate within the shared pick radius, ordered by
 * layer priority descending, then distance ascending, then the mark index,
 * then publication order. That is `IdResolver.resolvePixelWindowAll`'s
 * (priority, distance, scan, mark order) ranking with the probe's mark index
 * standing in for the pixel scan; the tie behaviour is pinned by tests.
 *
 * No de-duplication of co-located marks: the real resolver returns one
 * candidate per registered mark, and so does this.
 */
export function hitTest(
  probe: SceneProbe, x: number, y: number, opts?: ProbeHitOptions,
): ProbeHit[] {
  const radius = pickRadiusPx(opts?.windowSize ?? DEFAULT_WINDOW_SIZE)
  const candidates: Array<ProbeHit & { order: number }> = []
  for (let order = 0; order < probe.pickables.length; order++) {
    const pickable = probe.pickables[order]
    if (opts?.allowedLayers && !opts.allowedLayers.has(pickable.layer)) continue
    const nearest = nearestMarkDistance(x, y, pickable)
    if (!nearest || nearest.distance > radius) continue
    candidates.push({
      pickKey: pickable.pickKey,
      entityKey: pickable.entityKey,
      layer: pickable.layer,
      kind: pickable.kind,
      distancePx: nearest.distance,
      markIndex: nearest.markIndex,
      order,
    })
  }
  candidates.sort((a, b) =>
    (pickPriorityOf(b.layer) - pickPriorityOf(a.layer))
    || (a.distancePx - b.distancePx)
    || (a.markIndex - b.markIndex)
    || (a.order - b.order))
  return candidates.map(({ order: _order, ...hit }) => hit)
}
