import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { snapToDirection, alignToPlane, alignToFace, fitToContent } from '@/components/Viewport/cameraController'
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
