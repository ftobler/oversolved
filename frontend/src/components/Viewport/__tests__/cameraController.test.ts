import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { resetView, snapToDirection, alignToPlane, alignToFace, fitToContent } from '@/components/Viewport/cameraController'
import { INITIAL_POSITION, INITIAL_ZOOM } from '@/components/Viewport/cameraConstants'
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
  it('resetView returns to the initial pose and recenters the target', () => {
    const cam = makeOrtho()
    const controls = makeControls()
    resetView(cam, controls as never, 'test')
    expect(cam.position.toArray()).toEqual(INITIAL_POSITION)
    expect(cam.zoom).toBe(INITIAL_ZOOM)
    expect(controls.target.toArray()).toEqual([0, 0, 0])
  })

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
})
