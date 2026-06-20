import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { computeGizmoHit, drawCubeGizmo, GIZMO_SIZE } from '@/components/misc/CubeGizmo.utils'

// The navigation cube is pure geometry: project the 8 cube corners through the
// inverted camera quaternion, sort by depth, hit-test the mouse against the
// front-most visible polygon. None of it needs the R3F scene, so it is unit
// testable in isolation (the "delete the Viewport, logic still passes" rule).

const cameraWith = (q: THREE.Quaternion): THREE.Camera => {
  const cam = new THREE.Camera()
  cam.quaternion.copy(q)
  return cam
}

// project() in the util uses q = camera.quaternion.inverse(), s = W*0.27, and a
// Y-flip. For an identity camera the cube front face (normal +z) sits dead centre.
const C = GIZMO_SIZE / 2  // 64

describe('computeGizmoHit', () => {
  it('hits the front face at the gizmo centre for an identity camera', () => {
    const hit = computeGizmoHit(C, C, [], cameraWith(new THREE.Quaternion()))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
    // CUBE_FACES[0] is Front, normal (0,0,1).
    expect(hit!.index).toBe(0)
    expect(hit!.snapDir.x).toBeCloseTo(0)
    expect(hit!.snapDir.y).toBeCloseTo(0)
    expect(hit!.snapDir.z).toBeCloseTo(1)
  })

  it('returns the face most facing the camera for any orientation', () => {
    // Rotate the camera 90 deg about Y; the +x (Right) face swings to the front.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const hit = computeGizmoHit(C, C, [], cameraWith(q))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
    // Whatever face is hit at centre, its normal must point toward the camera
    // (positive z after the inverse-camera rotation that the util applies).
    const facing = hit!.snapDir.clone().applyQuaternion(q.clone().invert()).z
    expect(facing).toBeGreaterThan(0.5)
  })

  it('hits a corner vertex when clicking its (chamfered, inset) polygon', () => {
    // Vertex 6 (1,1,1) projects toward ~(98.56, 29.44), but the bevel/chamfer
    // insets the drawn hexagon inward; its body sits around (84, 30).
    const hit = computeGizmoHit(84, 30, [], cameraWith(new THREE.Quaternion()))
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('vertex')
    expect(hit!.index).toBe(6)
    expect(hit!.snapDir.x).toBeCloseTo(1 / Math.sqrt(3))
    expect(hit!.snapDir.y).toBeCloseTo(1 / Math.sqrt(3))
    expect(hit!.snapDir.z).toBeCloseTo(1 / Math.sqrt(3))
  })

  it('returns null when clicking empty space outside the cube', () => {
    const hit = computeGizmoHit(2, 2, [], cameraWith(new THREE.Quaternion()))
    expect(hit).toBeNull()
  })

  it('back-face culls: a face pointing away is never hit', () => {
    // The hit at centre is always a front-facing face, never the Back face (1)
    // which is culled (nz < -0.1) for the identity camera.
    const hit = computeGizmoHit(C, C, [], cameraWith(new THREE.Quaternion()))
    expect(hit!.index).not.toBe(1)
  })
})

// A minimal recording 2D context so the canvas draw path runs headless. jsdom
// has no real canvas backend, so we feed our own and assert on the calls.
function makeRecordingCanvas() {
  const calls: Array<[string, ...unknown[]]> = []
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]) }
  const ctx = {
    save: rec('save'), restore: rec('restore'), scale: rec('scale'),
    clearRect: rec('clearRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'),
    lineTo: rec('lineTo'), closePath: rec('closePath'), fill: rec('fill'),
    translate: rec('translate'), transform: rec('transform'), fillText: rec('fillText'),
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
  }
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement
  return { canvas, ctx, calls }
}

describe('drawCubeGizmo', () => {
  it('returns an empty array when the canvas has no 2d context', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
    expect(drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), null)).toEqual([])
  })

  it('draws the cube and returns the 8 projected corner vertices', () => {
    const { canvas, calls } = makeRecordingCanvas()
    const verts = drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), null)
    expect(verts).toHaveLength(8)
    // Front corner (1,1,1) -> (98.56, 29.44) under the identity camera.
    expect(verts[6].sx).toBeCloseTo(98.56)
    expect(verts[6].sy).toBeCloseTo(29.44)
    // It sized the backing store and stroked at least one path.
    expect((canvas as unknown as { width: number }).width).toBe(GIZMO_SIZE)
    expect(calls.some(c => c[0] === 'fill')).toBe(true)
    // Visible faces get their label rendered.
    expect(calls.some(c => c[0] === 'fillText' && c[1] === 'Front')).toBe(true)
  })

  // Capture the fillStyle in effect at each fill() call so we can prove the
  // bright hover colour was used for the hovered polygon.
  const drawCapturingFills = (hover: Parameters<typeof drawCubeGizmo>[2]): string[] => {
    const fills: string[] = []
    const ctx = {
      save() {}, restore() {}, scale() {}, clearRect() {}, beginPath() {},
      moveTo() {}, lineTo() {}, closePath() {}, translate() {}, transform() {},
      fillText() {},
      fill() { fills.push(this.fillStyle as string) },
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
    }
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    drawCubeGizmo(canvas, cameraWith(new THREE.Quaternion()), hover)
    return fills
  }

  it('highlights a hovered face with the bright fill', () => {
    const hover = { type: 'face' as const, index: 0, snapDir: new THREE.Vector3(0, 0, 1) }
    expect(drawCapturingFills(hover)).toContain('rgba(255,255,255,0.5)')
  })

  it('fills a hovered edge/vertex (which are otherwise invisible) only on hover', () => {
    // Front-facing vertex 6 is normally not filled; hovering it triggers the
    // non-face hover branch.
    const snapDir = new THREE.Vector3(1, 1, 1).normalize()
    const hover = { type: 'vertex' as const, index: 6, snapDir }
    expect(drawCapturingFills(hover)).toContain('rgba(255,255,255,0.5)')
  })
})
