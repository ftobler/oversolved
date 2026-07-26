import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { snapToDirection, alignToPlane, alignToFace, fitToContent, shouldAutoFit } from '@/components/Viewport/cameraController'
import type { BodyResult } from '@/types/cad'

function makeControls() {
  return { target: new THREE.Vector3(), update: () => {} }
}

function makeOrtho() {
  const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  cam.position.set(50, 60, 100)
  cam.zoom = 7
  cam.updateProjectionMatrix()
  return cam
}

describe('cameraController', () => {
  it('snapToDirection points along the direction and preserves distance from origin', () => {
    const cam = makeOrtho()
    const dist = cam.position.length()
    snapToDirection(cam, makeControls() as never, new THREE.Vector3(0, 0, 5))
    expect(cam.position.x).toBeCloseTo(0)
    expect(cam.position.y).toBeCloseTo(0)
    expect(cam.position.z).toBeCloseTo(dist)
  })

  it('alignToPlane positions the camera for a known plane and no-ops on unknown', () => {
    const cam = makeOrtho()
    alignToPlane(cam, makeControls() as never, 'builtin_plane_top')
    // Top plane looks down +Y, distance 100.
    expect(cam.position.x).toBeCloseTo(0)
    expect(cam.position.y).toBeCloseTo(100)
    expect(cam.position.z).toBeCloseTo(0)

    const cam2 = makeOrtho()
    const before = cam2.position.toArray()
    alignToPlane(cam2, makeControls() as never, 'not_a_plane')
    expect(cam2.position.toArray()).toEqual(before)
  })

  it('alignToFace offsets along the normal from the face center and no-ops on a degenerate normal', () => {
    const cam = makeOrtho()
    const controls = makeControls()
    alignToFace(cam, controls as never, [0, 0, 1], [10, 20, 30])
    expect(cam.position.toArray()).toEqual([10, 20, 130])
    expect(controls.target.toArray()).toEqual([10, 20, 30])

    const cam2 = makeOrtho()
    const before = cam2.position.toArray()
    alignToFace(cam2, makeControls() as never, [0, 0, 0], [1, 2, 3])
    expect(cam2.position.toArray()).toEqual(before)
  })

  it('fitToContent returns false with no geometry and true once body vertices are present', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls() as never, {}, null)).toBe(false)

    const bodies: Record<string, BodyResult> = {
      a: { mesh: { vertices: new Float32Array([-10, -10, -10, 10, 10, 10]) } } as unknown as BodyResult,
    }
    const fit = fitToContent(cam, makeControls() as never, bodies, null)
    expect(fit).toBe(true)
    expect(cam.zoom).toBeGreaterThan(0)
    expect(Number.isFinite(cam.zoom)).toBe(true)
  })

  it('scene fallback measures only fitBounds-tagged meshes and is stable on repeat (no oscillation)', () => {
    const cam = makeOrtho()
    const scene = new THREE.Scene()

    // A fixed-size plane quad (what the real PlaneSurface tags). Zoom-independent.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(50, 50))
    plane.userData.fitBounds = true
    scene.add(plane)

    // An untagged screen-scaled helper: a small mesh whose world size tracks the
    // current zoom (const/zoom), exactly like markers/labels/dimensions. If the
    // fit measured this, every press would change zoom and re-measure it.
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    const syncHelper = () => { helper.scale.setScalar(400 / cam.zoom); helper.updateMatrixWorld() }
    syncHelper()
    scene.add(helper)
    scene.updateMatrixWorld(true)

    expect(fitToContent(cam, makeControls() as never, {}, scene)).toBe(true)
    const zoomAfterFirst = cam.zoom

    // Second press: the helper would have resized if it were measured. Re-sync it
    // and fit again - a stable fit lands on the same zoom (fixed point).
    syncHelper()
    expect(fitToContent(cam, makeControls() as never, {}, scene)).toBe(true)
    expect(cam.zoom).toBeCloseTo(zoomAfterFirst, 6)
  })
})

// fitToContent owns the clip planes because a fixed range cannot serve both
// ends: wide enough for a large model makes the depth-buffer resolution unit
// coarse, and Body3D's polygonOffsetUnits=1 is one such unit, so the edge/face
// separation grows into a visible penetration depth that makes small parts
// transparent. Sized to the content, neither end has to lose.
describe('fitToContent clip planes', () => {
  function boxBody(cx: number, cy: number, cz: number, half: number): Record<string, BodyResult> {
    return {
      a: {
        mesh: {
          vertices: new Float32Array([cx - half, cy - half, cz - half, cx + half, cy + half, cz + half]),
        },
      } as unknown as BodyResult,
    }
  }

  // Depth along the view axis, the axis near/far are measured on.
  function depthOf(cam: THREE.OrthographicCamera, p: [number, number, number]): number {
    cam.updateMatrixWorld()
    return -new THREE.Vector3(...p).applyMatrix4(cam.matrixWorldInverse).z
  }

  function cornersOf(cx: number, cy: number, cz: number, half: number): [number, number, number][] {
    const out: [number, number, number][] = []
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      out.push([cx + sx * half, cy + sy * half, cz + sz * half])
    }
    return out
  }

  it('keeps the range tight for a small model so the polygon offset stays invisible', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls() as never, boxBody(0, 0, 0, 10), null)).toBe(true)
    expect(cam.far - cam.near).toBeLessThanOrEqual(1500)
  })

  it('clips neither end of a model far deeper than any fixed range', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls() as never, boxBody(0, 0, 0, 10000), null)).toBe(true)
    for (const corner of cornersOf(0, 0, 0, 10000)) {
      const depth = depthOf(cam, corner)
      expect(depth).toBeGreaterThan(cam.near)
      expect(depth).toBeLessThan(cam.far)
    }
  })

  it('keeps the world origin visible when the model sits far from it', () => {
    const cam = makeOrtho()
    expect(fitToContent(cam, makeControls() as never, boxBody(0, 0, 3000, 10), null)).toBe(true)
    const originDepth = depthOf(cam, [0, 0, 0])
    expect(originDepth).toBeGreaterThan(cam.near)
    expect(originDepth).toBeLessThan(cam.far)
  })

  it('does not let the origin drag the framing away from the model', () => {
    const atOrigin = makeOrtho()
    fitToContent(atOrigin, makeControls() as never, boxBody(0, 0, 0, 10), null)

    // Same model, moved far off. The origin counts for depth only, so zoom -
    // which is decided by the lateral extents - must not change.
    const farOff = makeOrtho()
    fitToContent(farOff, makeControls() as never, boxBody(3000, 3000, 0, 10), null)
    expect(farOff.zoom).toBeCloseTo(atOrigin.zoom, 6)
  })
})

describe('shouldAutoFit', () => {
  it('fits once geometry has arrived and stops once it has succeeded', () => {
    expect(shouldAutoFit(false, 0, false)).toBe(false)  // nothing to frame yet
    expect(shouldAutoFit(false, 2, false)).toBe(true)
    expect(shouldAutoFit(true, 2, false)).toBe(false)
  })

  // The regression: a live drag tick replaces the whole `bodies` record, so an
  // auto-fit that never succeeded (zero-sized frustum, geometry not yet meshed)
  // re-armed on every tick and reframed the camera mid-gesture.
  it('never fits while a part is being manipulated', () => {
    expect(shouldAutoFit(false, 2, true)).toBe(false)
  })
})
