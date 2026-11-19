import * as THREE from 'three'

// The cube lives in the top GIZMO_SIZE square; the canvas runs a strip taller
// so the roll arrows arcing under the cube have room. The cube's centre stays
// the square's centre, which is what every hit-test coordinate is measured in.
export const GIZMO_SIZE = 140
export const GIZMO_ROLL_STRIP = 10
export const GIZMO_HEIGHT = GIZMO_SIZE + GIZMO_ROLL_STRIP
// The canvas also overhangs the cube square by this much left, right and
// above, so the orbit triangles and roll arcs can sit clear of the cube's
// widest silhouette. All gizmo geometry stays in cube-square coordinates; only
// the canvas edges (draw translate, pointer offset) know about the overhang.
export const GIZMO_PAD = 8
export const GIZMO_CANVAS_WIDTH = GIZMO_SIZE + 2 * GIZMO_PAD
export const GIZMO_CANVAS_HEIGHT = GIZMO_PAD + GIZMO_HEIGHT
// How far the whole widget sits below its layout slot: tuned by eye so the cube
// sits low in the corner. The slot's own floor in ViewportHud.css is sized to
// take this sink plus the roll strip, so the canvas never hangs off the frame.
export const GIZMO_SINK = 10
// How far the cube square is held in from the HUD column's right edge: tuned by
// eye with the user. Only the cube moves; the column edge stays the viewport
// inset.
export const GIZMO_INSET = 6
// Placement is the viewport HUD column's job (ViewportHud.css): the cube sits
// under the view options button in the bottom-right stack, so the widget itself
// only declares its size and that it still takes clicks -- the column around it
// is click-through.
//
// The roll strip hangs below the layout box (negative bottom margin): the
// column is bottom-anchored, so counting the strip in the layout would lift
// the cube by its height. The overhang (GIZMO_PAD) is cancelled the same way
// on the top, and on the right only down to GIZMO_INSET: the cube square then
// stops GIZMO_INSET short of the column edge instead of sitting flush with it.
// The stack's padding-bottom is what leaves room for the overhang; hit-tests
// measure from the canvas rect, so the margin moves the box and leaves every
// pointer offset alone.
export const GIZMO_STYLE: React.CSSProperties = {
  width: GIZMO_CANVAS_WIDTH,
  height: GIZMO_CANVAS_HEIGHT,
  marginTop: -GIZMO_PAD,
  marginRight: GIZMO_INSET - GIZMO_PAD,
  marginBottom: -(GIZMO_ROLL_STRIP + GIZMO_SINK),
  pointerEvents: 'auto',
  cursor: 'default',
}

// Back-face cull threshold shared by the hit-test and the draw pass. It must
// live in one place: when the two disagreed, polygons tilted just past the
// silhouette (normal z in [-0.1, 0)) were clickable but never drawn or hover
// highlighted, so the cursor promised a snap the eye could not see. The value
// is deliberately looser than a strict nz < 0: it keeps the slightly-grazing
// edge and corner polygons at the silhouette clickable, which is where a user
// aims for an axis snap.
//
// Faces do not get that slack: a face tilted just past edge-on painted as a
// sliver seen from behind, outside the front faces, while the front-facing
// edge band in front of it took every click. A face is culled the moment it
// turns away (nz <= 0); the silhouette outline now shows where the edge and
// corner bands end, which is what the slack was there to make reachable.
export const GIZMO_CULL_NZ = -0.1

export function isCulled(poly: { type: 'face' | 'edge' | 'vertex'; nz: number }): boolean {
  return poly.type === 'face' ? poly.nz <= 0 : poly.nz < GIZMO_CULL_NZ
}

// ─── Cube geometry ───

const CV = [
  new THREE.Vector3(-1, -1, -1),  // 0
  new THREE.Vector3( 1, -1, -1),  // 1
  new THREE.Vector3( 1,  1, -1),  // 2
  new THREE.Vector3(-1,  1, -1),  // 3
  new THREE.Vector3(-1, -1,  1),  // 4
  new THREE.Vector3( 1, -1,  1),  // 5
  new THREE.Vector3( 1,  1,  1),  // 6
  new THREE.Vector3(-1,  1,  1),  // 7
]

const COLOR_FACE = 'rgba(255,255,255,0.15)'
const COLOR_EDGE = 'rgba(255,255,255,0.15)'
const COLOR_VERT = 'rgba(255,255,255,0.15)'
const COLOR_HOVER = 'rgba(255,255,255,0.5)'
// The face tint, so the outline reads as part of the cube, not as a frame.
const COLOR_OUTLINE = COLOR_FACE

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly Pv[]): void {
  ctx.beginPath()
  pts.forEach((p, j) => j ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy))
  ctx.closePath()
}

const CUBE_FACES = [
  { verts: [4,5,6,7], label: 'Front',  normal: new THREE.Vector3( 0,  0,  1), fill: COLOR_FACE },
  { verts: [1,0,3,2], label: 'Back',   normal: new THREE.Vector3( 0,  0, -1), fill: COLOR_FACE },
  { verts: [5,1,2,6], label: 'Right',  normal: new THREE.Vector3( 1,  0,  0), fill: COLOR_FACE },
  { verts: [0,4,7,3], label: 'Left',   normal: new THREE.Vector3(-1,  0,  0), fill: COLOR_FACE },
  { verts: [7,6,2,3], label: 'Top',    normal: new THREE.Vector3( 0,  1,  0), fill: COLOR_FACE },
  { verts: [0,1,5,4], label: 'Bottom', normal: new THREE.Vector3( 0, -1,  0), fill: COLOR_FACE },
]

const FACE_AXES = [
  { x: new THREE.Vector3( 1,  0,  0), y: new THREE.Vector3( 0,  1,  0) },  // Front
  { x: new THREE.Vector3(-1,  0,  0), y: new THREE.Vector3( 0,  1,  0) },  // Back
  { x: new THREE.Vector3( 0,  0, -1), y: new THREE.Vector3( 0,  1,  0) },  // Right
  { x: new THREE.Vector3( 0,  0,  1), y: new THREE.Vector3( 0,  1,  0) },  // Left
  { x: new THREE.Vector3( 1,  0,  0), y: new THREE.Vector3( 0,  0, -1) },  // Top
  { x: new THREE.Vector3( 1,  0,  0), y: new THREE.Vector3( 0,  0,  1) },  // Bottom
]

const CUBE_EDGES: [number, number][] = [
  [0,1],[1,2],[2,3],[3,0],
  [4,5],[5,6],[6,7],[7,4],
  [0,4],[1,5],[2,6],[3,7],
]

const BEVEL_INSET = 0.20
const EXTRA_INSET = 0.05
const CHAMFER = 0.15

// Half-width of a drawn face in cube units, after both insets pull it in from
// the unit cube. Derived rather than written out so the label fit below cannot
// drift if the bevel is retuned.
const FACE_HALF_EXTENT = (1 - BEVEL_INSET) * (1 - EXTRA_INSET)

// ─── Face label font ───

// Roboto, to match the 3D scene text. Deliberately NOT sharing anything with
// Viewport/labelFont.ts: that module exports a WOFF *URL* for troika, which
// parses font binaries itself. Canvas `ctx.font` takes a CSS font shorthand and
// resolves through the DOM's @font-face table, so the URL is the wrong currency
// here. What the two have in common is the typeface, not the reference to it.
//
// sans-serif stays in the stack as a real fallback: the canvas paints whether
// or not Roboto ever arrives.
const LABEL_FONT_STACK = 'Roboto, sans-serif'
const LABEL_FONT_WEIGHT = 'bold'
const LABEL_FONT_SIZE = 10

export function gizmoLabelFont(sizePx: number = LABEL_FONT_SIZE): string {
  // Rounded because a shrunk size is a ratio; unrounded floats make the CSS
  // shorthand (and any test assertion on it) needlessly noisy.
  return `${LABEL_FONT_WEIGHT} ${Math.round(sizePx * 100) / 100}px ${LABEL_FONT_STACK}`
}

// Fraction of the face's inner width a label may occupy before it is shrunk.
//
// Sized against the geometry, not against one word: at 1.0 a label may touch
// the exact polygon edge, where the chamfered corners and the antialias fringe
// make it read as cramped even though it technically fits. 12% total (6% a
// side) is the smallest margin that still looks deliberate at GIZMO_SIZE.
// "Bottom" is the only one of the six names that trips this in Roboto Bold; the
// point of measuring rather than hard-coding a smaller size is that a future
// font change cannot silently reintroduce the overflow.
const LABEL_WIDTH_FRACTION = 0.88

type FontFaceSetLike = { load(font: string): Promise<unknown>; ready?: Promise<unknown> }

let labelFontRequested = false
let labelFontReady = false
const labelFontListeners = new Set<() => void>()

function markLabelFontReady(): void {
  labelFontReady = true
  for (const fn of labelFontListeners) fn()
  labelFontListeners.clear()
}

export function isGizmoLabelFontReady(): boolean {
  return labelFontReady
}

/**
 * Requests the label font once, and notifies when it is usable.
 *
 * This is not merely a paint gate, it is what makes the font exist at all.
 * Canvas text never triggers a font fetch: the browser loads a face only when
 * the DOM uses it, and `fillText` is invisible to that machinery. main.tsx
 * imports Roboto 400/500/700, but a weight nothing in the DOM happens to render
 * would still sit undownloaded forever, and the cube would silently paint in
 * the fallback with no later frame ever fixing it. Asking `document.fonts` for
 * the exact shorthand we draw with is the request that pulls the file in.
 *
 * `document.fonts` is absent under jsdom and on old browsers; there we treat
 * the font as immediately ready so the cube still draws in the fallback rather
 * than throwing or waiting forever.
 */
export function ensureGizmoLabelFont(onReady?: () => void): void {
  if (labelFontReady) {
    onReady?.()
    return
  }
  if (onReady) labelFontListeners.add(onReady)
  if (labelFontRequested) return
  labelFontRequested = true

  const fonts = (globalThis as { document?: { fonts?: FontFaceSetLike } }).document?.fonts
  if (!fonts?.load) {
    markLabelFontReady()
    return
  }
  // Resolve either way: a failed load means we keep painting the fallback,
  // which is a worse-looking cube but never a missing one.
  fonts.load(gizmoLabelFont()).then(markLabelFontReady, markLabelFontReady)
}

/** Test seam: forget the module-level load state between cases. */
export function resetGizmoLabelFontForTest(): void {
  labelFontRequested = false
  labelFontReady = false
  labelFontListeners.clear()
}

/**
 * Font size that keeps `label` inside `usableWidth`, shrinking only on
 * overflow so labels that already fit are returned untouched.
 */
export function fitLabelFontSize(measuredWidth: number, usableWidth: number): number {
  if (!(measuredWidth > 0) || !Number.isFinite(measuredWidth)) return LABEL_FONT_SIZE
  if (measuredWidth <= usableWidth) return LABEL_FONT_SIZE
  return LABEL_FONT_SIZE * (usableWidth / measuredWidth)
}

// ─── Types ───

export type Pv = { sx: number; sy: number; z: number }
// A cube hit snaps the view to a direction; a roll hit turns it about the view
// axis by `roll` radians (positive: the scene turns clockwise on screen); an
// orbit hit swings the camera ORBIT_STEP toward the screen direction
// (right, up).
export type Hit =
  | { type: 'vertex' | 'edge' | 'face'; index: number; snapDir: THREE.Vector3 }
  | { type: 'roll'; index: number; roll: number }
  | { type: 'orbit'; index: number; right: number; up: number }

// What a gizmo click asks the render loop to do with the camera: a bare vector
// is a cube snap direction, `{ roll }` a turn about the view axis, `{ orbit }`
// a fixed step of the camera round its target.
export type GizmoRequest =
  | THREE.Vector3
  | { roll: number }
  | { orbit: { right: number; up: number; angle: number } }

export function gizmoRequestFor(hit: Hit): GizmoRequest {
  if (hit.type === 'roll') return { roll: hit.roll }
  if (hit.type === 'orbit') return { orbit: { right: hit.right, up: hit.up, angle: ORBIT_STEP } }
  return hit.snapDir
}

type GizmoPoly = {
  type: 'face' | 'edge' | 'vertex'
  index: number
  pts: Pv[]
  cz: number
  nz: number  // Normal Z for back-face culling/sorting
  snapDir: THREE.Vector3
  fill: string
  label?: string
  axes?: { x: THREE.Vector3; y: THREE.Vector3 }
}

// ─── Helpers ───

function pointInPoly(px: number, py: number, poly: Pv[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].sx, yi = poly[i].sy, xj = poly[j].sx, yj = poly[j].sy
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

// Reused across every getPolys call (per frame via drawCubeGizmo, plus per
// mousemove via computeGizmoHit). The cube geometry is fixed, so its chamfered
// octagons / edge quads / vertex hexes are built once in cube-local space below
// and only rotated + projected into screen space here, never re-cloned.
const _rotVec = new THREE.Vector3()
const _projVec = new THREE.Vector3()
const _projQuat = new THREE.Quaternion()
const _labelX = new THREE.Vector3()
const _labelY = new THREE.Vector3()

type BasePoly = {
  type: 'face' | 'edge' | 'vertex'
  index: number
  pts: THREE.Vector3[]
  normal: THREE.Vector3
  snapDir: THREE.Vector3
  fill: string
  label?: string
  axes?: { x: THREE.Vector3; y: THREE.Vector3 }
}

// Builds the cube polygons in cube-local coordinates. Everything here depends
// only on the constant corner table and inset/chamfer ratios, so it runs once
// at module load instead of hundreds of times per second.
function buildBasePolys(): BasePoly[] {
  const faceInsetPoints = CUBE_FACES.map(f => {
    const center = f.normal
    return f.verts.map(vi => {
      const v = CV[vi]
      return v.clone().add(center.clone().sub(v).multiplyScalar(BEVEL_INSET))
    })
  })

  const polys: BasePoly[] = []

  CUBE_FACES.forEach((f, fi) => {
    const center = f.normal
    const raw = faceInsetPoints[fi].map(p => p.clone().add(center.clone().sub(p).multiplyScalar(EXTRA_INSET)))
    const chamfered: THREE.Vector3[] = []
    const n = raw.length
    for (let i = 0; i < n; i++) {
      const a = raw[i]
      const b = raw[(i + 1) % n]
      chamfered.push(a.clone().lerp(b, CHAMFER))
      chamfered.push(b.clone().lerp(a, CHAMFER))
    }
    polys.push({
      type: 'face',
      index: fi,
      pts: chamfered,
      normal: f.normal.clone(),
      snapDir: f.normal.clone(),
      fill: COLOR_FACE,
      label: f.label,
      axes: FACE_AXES[fi],
    })
  })

  CUBE_EDGES.forEach(([v1, v2], ei) => {
    const adjFaces = CUBE_FACES.map((f, i) => ({ f, i })).filter(x => x.f.verts.includes(v1) && x.f.verts.includes(v2))
    if (adjFaces.length !== 2) return

    const f0 = adjFaces[0].i, f1 = adjFaces[1].i
    const p0_v1 = faceInsetPoints[f0][CUBE_FACES[f0].verts.indexOf(v1)]
    const p0_v2 = faceInsetPoints[f0][CUBE_FACES[f0].verts.indexOf(v2)]
    const p1_v2 = faceInsetPoints[f1][CUBE_FACES[f1].verts.indexOf(v2)]
    const p1_v1 = faceInsetPoints[f1][CUBE_FACES[f1].verts.indexOf(v1)]

    const chamfered = [
      p0_v1.clone().lerp(p0_v2, CHAMFER),
      p0_v2.clone().lerp(p0_v1, CHAMFER),
      p1_v2.clone().lerp(p1_v1, CHAMFER),
      p1_v1.clone().lerp(p1_v2, CHAMFER),
    ]
    const edgeCenter = chamfered[0].clone().add(chamfered[1]).add(chamfered[2]).add(chamfered[3]).multiplyScalar(0.25)
    const pts = chamfered.map(p => p.clone().add(edgeCenter.clone().sub(p).multiplyScalar(EXTRA_INSET)))
    const normal = CV[v1].clone().add(CV[v2]).normalize()

    polys.push({ type: 'edge', index: ei, pts, normal, snapDir: normal, fill: COLOR_EDGE })
  })

  CV.forEach((v, vi) => {
    const adjFaces = CUBE_FACES.map((f, i) => ({ f, i })).filter(x => x.f.verts.includes(vi))

    const faceData = adjFaces.map(face => {
      const idx = face.f.verts.indexOf(vi)
      const p_vi = faceInsetPoints[face.i][idx]
      const vPrev = face.f.verts[(idx - 1 + 4) % 4]
      const vNext = face.f.verts[(idx + 1) % 4]
      return {
        cpPrev: p_vi.clone().lerp(faceInsetPoints[face.i][(idx - 1 + 4) % 4], CHAMFER),
        cpNext: p_vi.clone().lerp(faceInsetPoints[face.i][(idx + 1) % 4], CHAMFER),
        vPrev, vNext,
      }
    })

    const hexPts: THREE.Vector3[] = []
    for (let i = 0; i < faceData.length; i++) {
      const d0 = faceData[i]
      const d1 = faceData[(i + 1) % faceData.length]
      const sharedV = d0.vPrev === d1.vPrev || d0.vPrev === d1.vNext ? d0.vPrev : d0.vNext
      hexPts.push(d0.vPrev === sharedV ? d0.cpPrev : d0.cpNext)
      hexPts.push(d1.vPrev === sharedV ? d1.cpPrev : d1.cpNext)
    }
    const normal = v.clone().normalize()
    polys.push({ type: 'vertex', index: vi, pts: hexPts, normal, snapDir: normal, fill: COLOR_VERT })
  })

  return polys
}

const BASE_POLYS = buildBasePolys()

// Screen-space output buffer, one GizmoPoly (with reused Pv[] pts) per base
// poly. Reused across calls so the per-frame and per-mousemove paths stop
// allocating a fresh poly/point tree sixty-odd times a second. getPolys is only
// ever consumed synchronously (draw, then hit-test), so a shared buffer is safe.
const POLY_BUFFER: GizmoPoly[] = BASE_POLYS.map(bp => ({
  type: bp.type,
  index: bp.index,
  pts: bp.pts.map(() => ({ sx: 0, sy: 0, z: 0 })),
  cz: 0,
  nz: 0,
  snapDir: bp.snapDir,
  fill: bp.fill,
  label: bp.label,
  axes: bp.axes,
}))

const LEGACY_PV: Pv[] = CV.map(() => ({ sx: 0, sy: 0, z: 0 }))

// View of POLY_BUFFER in depth-sorted order. Kept separate from POLY_BUFFER so
// the per-frame sort reorders references here without disturbing the
// BASE_POLYS[i] <-> POLY_BUFFER[i] alignment that getPolys writes by index.
const SORTED_BUFFER: GizmoPoly[] = POLY_BUFFER.slice()

export function getPolys(q: THREE.Quaternion, W: number, H: number): GizmoPoly[] {
  const cx = W / 2, cy = H / 2, s = W * 0.27

  for (let i = 0; i < BASE_POLYS.length; i++) {
    const bp = BASE_POLYS[i]
    const out = POLY_BUFFER[i]
    out.nz = _rotVec.copy(bp.normal).applyQuaternion(q).z
    let czSum = 0
    for (let j = 0; j < bp.pts.length; j++) {
      _projVec.copy(bp.pts[j]).applyQuaternion(q)
      const p = out.pts[j]
      p.sx = cx + _projVec.x * s
      p.sy = cy - _projVec.y * s
      p.z = _projVec.z
      czSum += p.z
    }
    out.cz = czSum / bp.pts.length
  }

  // Reorder the view buffer by depth each call; POLY_BUFFER stays aligned to
  // BASE_POLYS so the next call can still write by index.
  return SORTED_BUFFER.sort((a, b) => a.cz - b.cz)
}

// ─── Silhouette outline ───

// The bevelled cube is convex, so its screen outline is the convex hull of
// every projected polygon point, front or back. The drawn faces have gaps
// between them (edges and corners only paint on hover), which leaves the
// cube's real extent to guesswork; one continuous hull stroke shows where the
// clickable edge and corner bands end. Monotone chain over reused buffers:
// it runs every frame.
const HULL_POINTS: Pv[] = POLY_BUFFER.flatMap(p => p.pts)
const HULL_OUT: Pv[] = []

function cross(o: Pv, a: Pv, b: Pv): number {
  return (a.sx - o.sx) * (b.sy - o.sy) - (a.sy - o.sy) * (b.sx - o.sx)
}

/** Convex hull of the cube as last projected by getPolys, in screen space. */
export function gizmoSilhouette(): Pv[] {
  const pts = HULL_POINTS.sort((a, b) => a.sx - b.sx || a.sy - b.sy)
  const out = HULL_OUT
  out.length = 0
  for (const p of pts) {
    while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
    out.push(p)
  }
  const lowerLen = out.length + 1
  for (let i = pts.length - 2; i >= 0; i--) {
    const p = pts[i]
    while (out.length >= lowerLen && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
    out.push(p)
  }
  out.pop()  // the last point repeats the first
  return out
}

// ─── Roll arrows ───

// Two arcs under the cube, both starting at 6 o'clock: index 0 sweeps to
// 4 o'clock (counter-clockwise on screen), index 1 to 8 o'clock (clockwise).
// A click turns the view about its axis by one ROLL_STEP in the arrow's
// sense, so the arrow shows which way the model will turn. Angles here are
// clock angles: degrees from 12 o'clock, clockwise.
export const ROLL_STEP = Math.PI / 12  // 15 degrees
const ROLL_RADIUS = 76
const ROLL_BAND_HALF = 3
const ROLL_HEAD_HALF = 7
const ROLL_HEAD_DEG = 13
const ROLL_GAP_DEG = 12  // half the gap that keeps the two arrows apart at 6 o'clock
const ROLL_SWEEP_DEG = 60
// The pick zone is fatter than the drawing: a 6px band is a thin target.
const ROLL_PICK_HALF = 9
const ROLL_PICK_SLACK_DEG = 3

type RollArrow = { index: number; roll: number; startDeg: number; endDeg: number; pts: Pv[] }

// The arcs' centre sits a little above the cube's: concentric arcs hung too
// low under the cube, and lifting them keeps the clock sense while still
// clearing the cube's largest silhouette.
const ROLL_LIFT = 6
export const ROLL_CENTER = { x: GIZMO_SIZE / 2, y: GIZMO_SIZE / 2 - ROLL_LIFT }

function clockPoint(deg: number, r: number): Pv {
  const a = deg * Math.PI / 180
  return { sx: ROLL_CENTER.x + r * Math.sin(a), sy: ROLL_CENTER.y - r * Math.cos(a), z: 0 }
}

function buildRollArrow(index: number, sense: -1 | 1): RollArrow {
  const startDeg = 180 + sense * ROLL_GAP_DEG
  const endDeg = 180 + sense * ROLL_SWEEP_DEG
  const baseDeg = endDeg - sense * ROLL_HEAD_DEG
  const steps = 8
  const outer: Pv[] = []
  const inner: Pv[] = []
  for (let i = 0; i <= steps; i++) {
    const d = startDeg + (baseDeg - startDeg) * i / steps
    outer.push(clockPoint(d, ROLL_RADIUS + ROLL_BAND_HALF))
    inner.push(clockPoint(d, ROLL_RADIUS - ROLL_BAND_HALF))
  }
  const pts = [
    ...outer,
    clockPoint(baseDeg, ROLL_RADIUS + ROLL_HEAD_HALF),
    clockPoint(endDeg, ROLL_RADIUS),
    clockPoint(baseDeg, ROLL_RADIUS - ROLL_HEAD_HALF),
    ...inner.reverse(),
  ]
  return { index, roll: sense * ROLL_STEP, startDeg, endDeg, pts }
}

// Static: the arrows are screen furniture and do not turn with the camera.
const ROLL_ARROWS: RollArrow[] = [buildRollArrow(0, -1), buildRollArrow(1, 1)]

/** The two arrow outlines in canvas px, for drawing and tests. */
export function rollArrowPolygons(): readonly Pv[][] {
  return ROLL_ARROWS.map(a => a.pts)
}

function rollHit(mx: number, my: number): Hit | null {
  const dx = mx - ROLL_CENTER.x
  const dy = my - ROLL_CENTER.y
  const r = Math.hypot(dx, dy)
  if (Math.abs(r - ROLL_RADIUS) > ROLL_PICK_HALF) return null
  const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
  for (const a of ROLL_ARROWS) {
    const lo = Math.min(a.startDeg, a.endDeg) - ROLL_PICK_SLACK_DEG
    const hi = Math.max(a.startDeg, a.endDeg) + ROLL_PICK_SLACK_DEG
    if (deg >= lo && deg <= hi) return { type: 'roll', index: a.index, roll: a.roll }
  }
  return null
}

// ─── Orbit triangles ───

// Four equilateral triangles round the cube, pointing out at 12, 3, 6 and
// 9 o'clock. A click swings the camera ORBIT_STEP toward the side it points
// to: north moves it up over the model, east to the right. They are centred
// on the cube, not on the roll arcs, so the south one sits in the arcs' gap.
export const ORBIT_STEP = Math.PI / 12  // 15 degrees
// The cube's widest silhouette reaches ~53px from its centre, so radius minus
// pick radius must stay above that; the north tip must stay on the canvas.
const ORBIT_RADIUS = 67  // centroid distance from the cube centre
const ORBIT_SIDE = 14
const ORBIT_PICK_RADIUS = 7

type OrbitTriangle = { index: number; right: number; up: number; cx: number; cy: number; pts: Pv[] }

function buildOrbitTriangle(index: number, right: number, up: number): OrbitTriangle {
  // Screen direction of the tip; canvas y runs down.
  const ux = right, uy = -up
  const cx = GIZMO_SIZE / 2 + ux * ORBIT_RADIUS
  const cy = GIZMO_SIZE / 2 + uy * ORBIT_RADIUS
  const h = ORBIT_SIDE * Math.sqrt(3) / 2
  const tip = { sx: cx + ux * h * 2 / 3, sy: cy + uy * h * 2 / 3, z: 0 }
  const bx = cx - ux * h / 3, by = cy - uy * h / 3
  const half = ORBIT_SIDE / 2
  const pts = [
    tip,
    { sx: bx - uy * half, sy: by + ux * half, z: 0 },
    { sx: bx + uy * half, sy: by - ux * half, z: 0 },
  ]
  return { index, right, up, cx, cy, pts }
}

const ORBIT_TRIANGLES: OrbitTriangle[] = [
  buildOrbitTriangle(0, 0, 1),   // north
  buildOrbitTriangle(1, 1, 0),   // east
  buildOrbitTriangle(2, 0, -1),  // south
  buildOrbitTriangle(3, -1, 0),  // west
]

/** The four triangles in canvas px (N, E, S, W), for drawing and tests. */
export function orbitTrianglePolygons(): readonly Pv[][] {
  return ORBIT_TRIANGLES.map(t => t.pts)
}

// A disc round the centroid: a 14px triangle is a small target, and the disc
// is forgiving at its corners where pointInPoly would not be.
function orbitHit(mx: number, my: number): Hit | null {
  for (const t of ORBIT_TRIANGLES) {
    if (Math.hypot(mx - t.cx, my - t.cy) <= ORBIT_PICK_RADIUS)
      return { type: 'orbit', index: t.index, right: t.right, up: t.up }
  }
  return null
}

export function computeGizmoHit(mx: number, my: number, _pv: Pv[], camera: THREE.Camera): Hit | null {
  const W = GIZMO_SIZE, H = GIZMO_SIZE
  const q = _projQuat.copy(camera.quaternion).invert()

  // The triangles and arrows sit outside the cube's largest silhouette, so
  // none of them compete with the cube for a pixel; the triangles go first so
  // the south one wins over the roll arcs' pick slack beside it.
  const orbit = orbitHit(mx, my)
  if (orbit) return orbit
  const roll = rollHit(mx, my)
  if (roll) return roll

  const polys = getPolys(q, W, H)
  // Check from front to back
  for (let i = polys.length - 1; i >= 0; i--) {
    const poly = polys[i]
    if (isCulled(poly)) continue  // Back-face cull, same rule as draw
    if (pointInPoly(mx, my, poly.pts)) {
      return { type: poly.type, index: poly.index, snapDir: poly.snapDir }
    }
  }

  return null
}

export function drawCubeGizmo(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  hover: Hit | null,
  onFontReady?: () => void,
): Pv[] {
  // Idempotent, so calling it per frame costs one boolean check after the
  // first. The cube is painted from the caller's frame callback, and the part
  // viewport draws on demand: a font arriving after the frame that requested it
  // would otherwise wait for the next unrelated change, so the caller hands in
  // its invalidate through onFontReady and the arrival asks for that repaint.
  ensureGizmoLabelFont(onFontReady)

  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== GIZMO_CANVAS_WIDTH * dpr || canvas.height !== GIZMO_CANVAS_HEIGHT * dpr) {
    canvas.width = GIZMO_CANVAS_WIDTH * dpr
    canvas.height = GIZMO_CANVAS_HEIGHT * dpr
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.translate(GIZMO_PAD, GIZMO_PAD)  // into cube-square coordinates

  const W = GIZMO_SIZE, H = GIZMO_SIZE
  const q = _projQuat.copy(camera.quaternion).invert()
  const s = W * 0.27
  const polys = getPolys(q, W, H)

  for (const poly of polys) {
    if (isCulled(poly)) continue  // Back-face cull, same rule as hit-test

    const isHover = hover?.type === poly.type && hover.index === poly.index

    ctx.beginPath()
    poly.pts.forEach((p, j) => j ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy))
    ctx.closePath()

    // Faces always visible, edges/vertices only on hover
    if (poly.type === 'face') {
      ctx.fillStyle = isHover ? 'rgba(255,255,255,0.5)' : poly.fill
      ctx.fill()
    } else if (isHover) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fill()
    }

    if (poly.type === 'face' && poly.label && poly.axes && poly.nz > 0) {
      const fcx = poly.pts.reduce((sum, p) => sum + p.sx, 0) / poly.pts.length
      const fcy = poly.pts.reduce((sum, p) => sum + p.sy, 0) / poly.pts.length

      const ux = _labelX.copy(poly.axes.x).applyQuaternion(q)
      const uy = _labelY.copy(poly.axes.y).applyQuaternion(q)

      // We want the text to be flat. ux and uy are the projected basis vectors.
      // Canvas transform: [ m11 m12 m21 m22 dx dy ]. Canvas +y is screen-down,
      // so m12/m22 negate the y component, and every term carries the fs scale:
      // m11 = ux.x*s*fs, m12 = -ux.y*s*fs, m21 = -uy.x*s*fs, m22 = uy.y*s*fs.

      ctx.save()
      ctx.translate(fcx, fcy)
      const fs = W * 0.00030  // Adjusted for better text size
      ctx.transform(
        ux.x * s * fs,
        -ux.y * s * fs,
        -uy.x * s * fs,
        uy.y * s * fs,
        0, 0)

      ctx.fillStyle = '#000'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      // Measure in the same space the glyphs are drawn in. The transform above
      // maps local units to screen by s*fs while cube units map by s, so one
      // cube unit is 1/fs local units -- which is what makes the face width
      // comparable to a px font size at all.
      ctx.font = gizmoLabelFont()
      const usable = (2 * FACE_HALF_EXTENT / fs) * LABEL_WIDTH_FRACTION
      const size = fitLabelFontSize(ctx.measureText(poly.label).width, usable)
      if (size !== LABEL_FONT_SIZE) ctx.font = gizmoLabelFont(size)

      ctx.fillText(poly.label, 0, 0)
      ctx.restore()
    }
  }

  // Stroked last so no face fill paints over it.
  tracePath(ctx, gizmoSilhouette())
  ctx.strokeStyle = COLOR_OUTLINE
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  ctx.stroke()

  for (const arrow of ROLL_ARROWS) {
    const isHover = hover?.type === 'roll' && hover.index === arrow.index
    tracePath(ctx, arrow.pts)
    ctx.fillStyle = isHover ? COLOR_HOVER : COLOR_FACE
    ctx.fill()
  }

  for (const tri of ORBIT_TRIANGLES) {
    const isHover = hover?.type === 'orbit' && hover.index === tri.index
    tracePath(ctx, tri.pts)
    ctx.fillStyle = isHover ? COLOR_HOVER : COLOR_FACE
    ctx.fill()
  }

  ctx.restore()

  // Return original vertices for any other legacy use; reused buffer so the
  // per-frame call does not allocate a fresh 8-element Pv tree.
  const cx = W / 2, cy = H / 2
  for (let i = 0; i < CV.length; i++) {
    _projVec.copy(CV[i]).applyQuaternion(q)
    const p = LEGACY_PV[i]
    p.sx = cx + _projVec.x * s
    p.sy = cy - _projVec.y * s
    p.z = _projVec.z
  }
  return LEGACY_PV
}

