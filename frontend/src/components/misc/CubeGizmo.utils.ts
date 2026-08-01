import * as THREE from 'three'

export const GIZMO_SIZE = 140
export const GIZMO_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  width: GIZMO_SIZE,
  height: GIZMO_SIZE,
  pointerEvents: 'auto',
  cursor: 'default',
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
export type Hit = { type: 'vertex' | 'edge' | 'face'; index: number; snapDir: THREE.Vector3 }

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

function project(v: THREE.Vector3, q: THREE.Quaternion, cx: number, cy: number, s: number): Pv {
  const t = v.clone().applyQuaternion(q)
  return { sx: cx + t.x * s, sy: cy - t.y * s, z: t.z }
}

function getPolys(q: THREE.Quaternion, W: number, H: number): GizmoPoly[] {
  const cx = W / 2, cy = H / 2, s = W * 0.27

  // 1. Inset points for each face
  const faceInsetPoints = CUBE_FACES.map(f => {
    const center = f.normal.clone()
    return f.verts.map(vi => {
      const v = CV[vi].clone()
      return v.add(center.clone().sub(v).multiplyScalar(BEVEL_INSET))
    })
  })

  const polys: GizmoPoly[] = []

  // Faces (chamfered, each corner cut to form an octagon)
  CUBE_FACES.forEach((f, fi) => {
    const center = f.normal.clone()
    const raw = faceInsetPoints[fi].map(p => {
      return p.clone().add(center.clone().sub(p).multiplyScalar(EXTRA_INSET))
    })
    // Build 8-point polygon: on each edge place two points inset from the ends
    const chamfered: THREE.Vector3[] = []
    const n = raw.length
    for (let i = 0; i < n; i++) {
      const a = raw[i]
      const b = raw[(i + 1) % n]
      chamfered.push(a.clone().lerp(b, CHAMFER))
      chamfered.push(b.clone().lerp(a, CHAMFER))
    }
    const pts = chamfered.map(p => project(p, q, cx, cy, s))
    const nz = f.normal.clone().applyQuaternion(q).z
    polys.push({
      type: 'face',
      index: fi,
      pts,
      cz: pts.reduce((sum, p) => sum + p.z, 0) / pts.length,
      nz,
      snapDir: f.normal.clone(),
      fill: COLOR_FACE,
      label: f.label,
      axes: FACE_AXES[fi]
    })
  })

  // Edges
  CUBE_EDGES.forEach(([v1, v2], ei) => {
    const adjFaces = CUBE_FACES.map((f, i) => ({ f, i })).filter(x => x.f.verts.includes(v1) && x.f.verts.includes(v2))
    if (adjFaces.length !== 2) return

    const f0 = adjFaces[0].i, f1 = adjFaces[1].i
    const p0_v1 = faceInsetPoints[f0][CUBE_FACES[f0].verts.indexOf(v1)]
    const p0_v2 = faceInsetPoints[f0][CUBE_FACES[f0].verts.indexOf(v2)]
    const p1_v2 = faceInsetPoints[f1][CUBE_FACES[f1].verts.indexOf(v2)]
    const p1_v1 = faceInsetPoints[f1][CUBE_FACES[f1].verts.indexOf(v1)]

    // Trim to chamfer boundary so edge meets the face octagon exactly
    const chamfered = [
      p0_v1.clone().lerp(p0_v2, CHAMFER),
      p0_v2.clone().lerp(p0_v1, CHAMFER),
      p1_v2.clone().lerp(p1_v1, CHAMFER),
      p1_v1.clone().lerp(p1_v2, CHAMFER),
    ]
    const edgeCenter = chamfered[0].clone().add(chamfered[1]).add(chamfered[2]).add(chamfered[3]).multiplyScalar(0.25)

    const pts = chamfered.map(p => {
      const p2 = p.clone().add(edgeCenter.clone().sub(p).multiplyScalar(EXTRA_INSET))
      return project(p2, q, cx, cy, s)
    })
    const normal = CV[v1].clone().add(CV[v2]).normalize()
    const nz = normal.clone().applyQuaternion(q).z

    polys.push({
      type: 'edge',
      index: ei,
      pts,
      cz: pts.reduce((sum, p) => sum + p.z, 0) / pts.length,
      nz,
      snapDir: normal,
      fill: COLOR_EDGE
    })
  })

  // Vertices (hexagon meeting chamfered face corners)
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
        vPrev, vNext
      }
    })

    // Order as a hexagon: for each adjacent-face pair, connect their chamfer points on the shared edge
    const hexPts: THREE.Vector3[] = []
    for (let i = 0; i < faceData.length; i++) {
      const d0 = faceData[i]
      const d1 = faceData[(i + 1) % faceData.length]
      const sharedV = d0.vPrev === d1.vPrev || d0.vPrev === d1.vNext ? d0.vPrev : d0.vNext
      hexPts.push(d0.vPrev === sharedV ? d0.cpPrev : d0.cpNext)
      hexPts.push(d1.vPrev === sharedV ? d1.cpPrev : d1.cpNext)
    }
    const pts = hexPts.map(p => project(p, q, cx, cy, s))
    const normal = v.clone().normalize()
    const nz = normal.clone().applyQuaternion(q).z

    polys.push({
      type: 'vertex',
      index: vi,
      pts,
      cz: pts.reduce((sum, p) => sum + p.z, 0) / pts.length,
      nz,
      snapDir: normal,
      fill: COLOR_VERT
    })
  })

  return polys.sort((a, b) => a.cz - b.cz)
}

export function computeGizmoHit(mx: number, my: number, _pv: Pv[], camera: THREE.Camera): Hit | null {
  const W = GIZMO_SIZE, H = GIZMO_SIZE
  const q = camera.quaternion.clone().invert()

  const polys = getPolys(q, W, H)
  // Check from front to back
  for (let i = polys.length - 1; i >= 0; i--) {
    const poly = polys[i]
    if (poly.nz < -0.1) continue  // Back-face cull roughly
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
  // first. SceneController drives this from useFrame on a frameloop="always"
  // Canvas, so a font arriving late is picked up by the next frame on its own
  // and the cube self-corrects within ~16ms. onFontReady exists so that
  // guarantee does not silently depend on the caller: a demand-rendered or
  // one-shot caller passes an invalidate and gets the same repaint.
  ensureGizmoLabelFont(onFontReady)

  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== GIZMO_SIZE * dpr) {
    canvas.width = GIZMO_SIZE * dpr
    canvas.height = GIZMO_SIZE * dpr
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.scale(dpr, dpr)

  const W = GIZMO_SIZE, H = GIZMO_SIZE
  const q = camera.quaternion.clone().invert()
  const s = W * 0.27
  const polys = getPolys(q, W, H)

  for (const poly of polys) {
    if (poly.nz < 0) continue  // Back-face cull

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

      const ux = poly.axes.x.clone().applyQuaternion(q)
      const uy = poly.axes.y.clone().applyQuaternion(q)

      // We want the text to be flat. ux and uy are the projected basis vectors.
      // Canvas transform: [ m11 m12 m21 m22 dx dy ]
      // m11 = ux.x * s, m12 = -ux.y * s (because Y is inverted in project)
      // m21 = uy.x * s, m22 = -uy.y * s

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

  ctx.restore()

  // Return original vertices for any other legacy use, though projectVerts might be better
  const cx = W / 2, cy = H / 2
  return CV.map(v => project(v, q, cx, cy, s))
}

