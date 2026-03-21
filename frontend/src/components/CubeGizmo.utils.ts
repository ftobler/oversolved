import * as THREE from 'three'

export const GIZMO_SIZE = 128
export const GIZMO_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  width: GIZMO_SIZE,
  height: GIZMO_SIZE,
  pointerEvents: 'auto',
  cursor: 'default',
}

// ── Cube geometry ─────────────────────────────────────────────────────────────

const CV = [
  new THREE.Vector3(-1, -1, -1), // 0
  new THREE.Vector3( 1, -1, -1), // 1
  new THREE.Vector3( 1,  1, -1), // 2
  new THREE.Vector3(-1,  1, -1), // 3
  new THREE.Vector3(-1, -1,  1), // 4
  new THREE.Vector3( 1, -1,  1), // 5
  new THREE.Vector3( 1,  1,  1), // 6
  new THREE.Vector3(-1,  1,  1), // 7
]

const CUBE_FACES = [
  { verts: [4,5,6,7], label: 'Front',  normal: new THREE.Vector3( 0,  0,  1), fill: 'rgba(100,160,220,0.30)' },
  { verts: [1,0,3,2], label: 'Back',   normal: new THREE.Vector3( 0,  0, -1), fill: 'rgba( 80,120,180,0.30)' },
  { verts: [5,1,2,6], label: 'Right',  normal: new THREE.Vector3( 1,  0,  0), fill: 'rgba(220,100,100,0.30)' },
  { verts: [0,4,7,3], label: 'Left',   normal: new THREE.Vector3(-1,  0,  0), fill: 'rgba(160, 70, 70,0.30)' },
  { verts: [7,6,2,3], label: 'Top',    normal: new THREE.Vector3( 0,  1,  0), fill: 'rgba(100,200,120,0.30)' },
  { verts: [0,1,5,4], label: 'Bottom', normal: new THREE.Vector3( 0, -1,  0), fill: 'rgba( 70,150, 90,0.30)' },
]

const CUBE_EDGES: [number, number][] = [
  [0,1],[1,2],[2,3],[3,0],
  [4,5],[5,6],[6,7],[7,4],
  [0,4],[1,5],[2,6],[3,7],
]

// ── Types ─────────────────────────────────────────────────────────────────────

export type Pv = { sx: number; sy: number; z: number }
export type Hit = { type: 'vertex' | 'edge' | 'face'; index: number; snapDir: THREE.Vector3 }

// ── Helpers ───────────────────────────────────────────────────────────────────

function pointInPoly(px: number, py: number, poly: Pv[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].sx, yi = poly[i].sy, xj = poly[j].sx, yj = poly[j].sy
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function projectVerts(camera: THREE.Camera, W: number, H: number): Pv[] {
  const cx = W / 2, cy = H / 2, s = W * 0.27
  const q = camera.quaternion.clone().invert()
  return CV.map(v => {
    const t = v.clone().applyQuaternion(q)
    return { sx: cx + t.x * s, sy: cy - t.y * s, z: t.z }
  })
}

export function computeGizmoHit(mx: number, my: number, pv: Pv[], camera: THREE.Camera): Hit | null {
  const W = GIZMO_SIZE
  const q = camera.quaternion.clone().invert()
  const VR = W * 0.10, ER = W * 0.07

  for (let i = 0; i < pv.length; i++)
    if (Math.hypot(mx - pv[i].sx, my - pv[i].sy) < VR)
      return { type: 'vertex', index: i, snapDir: CV[i].clone().normalize() }

  for (let ei = 0; ei < CUBE_EDGES.length; ei++) {
    const [a, b] = CUBE_EDGES[ei]
    if (distToSeg(mx, my, pv[a].sx, pv[a].sy, pv[b].sx, pv[b].sy) < ER)
      return { type: 'edge', index: ei, snapDir: CV[a].clone().add(CV[b]).normalize() }
  }

  const frontFaces = CUBE_FACES
    .map((f, i) => ({ f, i, nz: f.normal.clone().applyQuaternion(q).z }))
    .filter(x => x.nz > 0)
    .sort((a, b) => b.nz - a.nz)

  for (const { f, i } of frontFaces)
    if (pointInPoly(mx, my, f.verts.map(vi => pv[vi])))
      return { type: 'face', index: i, snapDir: f.normal.clone() }

  return null
}

export function drawCubeGizmo(canvas: HTMLCanvasElement, camera: THREE.Camera, hover: Hit | null): Pv[] {
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
  const pv = projectVerts(camera, W, H)
  const q = camera.quaternion.clone().invert()

  const faces = CUBE_FACES.map((f, i) => ({
    ...f, i,
    nz: f.normal.clone().applyQuaternion(q).z,
    pts: f.verts.map(vi => pv[vi]),
    cz: f.verts.reduce((s, vi) => s + pv[vi].z, 0) / f.verts.length,
  })).sort((a, b) => a.cz - b.cz)

  // Faces — semi-transparent, back-face culled
  for (const face of faces) {
    if (face.nz <= 0) continue
    ctx.beginPath()
    face.pts.forEach((p, j) => j ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy))
    ctx.closePath()
    ctx.fillStyle = hover?.type === 'face' && hover.index === face.i
      ? 'rgba(255,255,255,0.45)'
      : face.fill
    ctx.fill()
  }

  // Edges — front edges opaque, back edges faded
  for (let ei = 0; ei < CUBE_EDGES.length; ei++) {
    const [a, b] = CUBE_EDGES[ei]
    const pa = pv[a], pb = pv[b]
    const front = (pa.z + pb.z) / 2 > 0
    const hov = hover?.type === 'edge' && hover.index === ei
    ctx.beginPath()
    ctx.moveTo(pa.sx, pa.sy)
    ctx.lineTo(pb.sx, pb.sy)
    ctx.strokeStyle = hov ? '#ffdd00' : '#dddddd'
    ctx.lineWidth = hov ? 2.5 : (front ? 1.5 : 1)
    ctx.globalAlpha = front ? 0.9 : 0.22
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // Labels — black text on visible faces only
  for (const face of faces) {
    if (face.nz < 0.20) continue
    const fcx = face.pts.reduce((s, p) => s + p.sx, 0) / face.pts.length
    const fcy = face.pts.reduce((s, p) => s + p.sy, 0) / face.pts.length
    ctx.globalAlpha = Math.min(1, face.nz * 2.5)
    ctx.font = `bold ${Math.round(W * 0.078 * 1.2)}px system-ui, sans-serif`
    ctx.fillStyle = '#111111'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(face.label, fcx, fcy)
  }
  ctx.globalAlpha = 1

  // Vertices — front opaque, back faded; highlight on hover
  const vr = W * 0.045
  for (let i = 0; i < pv.length; i++) {
    const p = pv[i]
    const hov = hover?.type === 'vertex' && hover.index === i
    ctx.beginPath()
    ctx.arc(p.sx, p.sy, hov ? vr * 1.8 : vr, 0, Math.PI * 2)
    ctx.fillStyle = hov ? '#ffdd00' : '#cccccc'
    ctx.globalAlpha = p.z > 0 ? 0.90 : 0.22
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()

  return pv
}
