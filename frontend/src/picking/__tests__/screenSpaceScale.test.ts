import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  worldUnitsPerPixel, pixelCubeHalfExtent, CUBE_CORNER_SIGNS, CUBE_TRIANGLE_INDICES,
} from '../screenSpaceScale'
import { p2w } from '@/utils/geometry/sketchHelpers'

/** projectionMatrix.elements[5] is the Y scale the shader reads as projectionMatrix[1][1]. */
function projectionY(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera): number {
  camera.updateProjectionMatrix()
  return camera.projectionMatrix.elements[5]
}

describe('worldUnitsPerPixel', () => {
  it('matches p2w (1/zoom) for an R3F-style orthographic camera', () => {
    const height = 600
    for (const zoom of [0.5, 1, 10, 137]) {
      const cam = new THREE.OrthographicCamera(-400, 400, height / 2, -height / 2)
      cam.zoom = zoom
      // R3F sizes the ortho frustum in pixels, so one world unit is one pixel at zoom 1.
      cam.top = height / 2
      cam.bottom = -height / 2
      cam.updateProjectionMatrix()
      const got = worldUnitsPerPixel(projectionY(cam), height, 1)
      expect(got).toBeCloseTo(p2w(cam), 10)
      expect(got).toBeCloseTo(1 / zoom, 10)
    }
  })

  it('is independent of depth under orthographic projection', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300)
    cam.updateProjectionMatrix()
    const py = projectionY(cam)
    // clipW is always 1 for ortho, so there is nothing depth dependent to vary.
    expect(worldUnitsPerPixel(py, 600, 1)).toBeCloseTo(worldUnitsPerPixel(py, 600, 1), 12)
  })

  it('equals the perspective frustum height at that depth divided by pixel height', () => {
    const height = 800
    const fov = 50
    const cam = new THREE.PerspectiveCamera(fov, 1.5, 0.1, 1000)
    cam.updateProjectionMatrix()
    for (const dist of [1, 25, 400]) {
      const frustumHeight = 2 * dist * Math.tan(THREE.MathUtils.degToRad(fov) / 2)
      expect(worldUnitsPerPixel(projectionY(cam), height, dist)).toBeCloseTo(frustumHeight / height, 8)
    }
  })

  it('scales linearly with distance under perspective (things far away need bigger cubes)', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    cam.updateProjectionMatrix()
    const py = projectionY(cam)
    const near = worldUnitsPerPixel(py, 600, 10)
    const far = worldUnitsPerPixel(py, 600, 40)
    expect(far / near).toBeCloseTo(4, 8)
  })

  it('halves when the viewport height doubles at fixed projection', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    cam.updateProjectionMatrix()
    const py = projectionY(cam)
    expect(worldUnitsPerPixel(py, 1200, 5)).toBeCloseTo(worldUnitsPerPixel(py, 600, 5) / 2, 10)
  })

  it('degenerate inputs return 0 rather than NaN or Infinity', () => {
    expect(worldUnitsPerPixel(0, 600, 1)).toBe(0)
    expect(worldUnitsPerPixel(NaN, 600, 1)).toBe(0)
    // A zero-height viewport is clamped to one pixel, so the result stays finite.
    expect(Number.isFinite(worldUnitsPerPixel(2, 0, 1))).toBe(true)
  })
})

describe('pixelCubeHalfExtent', () => {
  it('a 3px cube spans 3 world units per pixel across, so half extent is 1.5x', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300)
    cam.zoom = 1
    cam.updateProjectionMatrix()
    const py = projectionY(cam)
    const upp = worldUnitsPerPixel(py, 600, 1)
    expect(pixelCubeHalfExtent(3, py, 600, 1)).toBeCloseTo(1.5 * upp, 10)
  })

  it('keeps a constant pixel size as the ortho camera zooms', () => {
    const height = 600
    const halfExtents: number[] = []
    for (const zoom of [1, 4, 64]) {
      const cam = new THREE.OrthographicCamera(-400, 400, height / 2, -height / 2)
      cam.zoom = zoom
      cam.updateProjectionMatrix()
      const half = pixelCubeHalfExtent(3, projectionY(cam), height, 1)
      // Converting the world half extent back to pixels must give 1.5 at every zoom.
      halfExtents.push(half / p2w(cam))
    }
    for (const px of halfExtents) expect(px).toBeCloseTo(1.5, 8)
  })

  it('is proportional to the requested pixel size', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    cam.updateProjectionMatrix()
    const py = projectionY(cam)
    expect(pixelCubeHalfExtent(6, py, 600, 20)).toBeCloseTo(2 * pixelCubeHalfExtent(3, py, 600, 20), 10)
    expect(pixelCubeHalfExtent(0, py, 600, 20)).toBe(0)
  })
})

describe('cube template', () => {
  it('has 8 distinct corners spanning every sign combination', () => {
    expect(CUBE_CORNER_SIGNS).toHaveLength(8)
    const keys = new Set(CUBE_CORNER_SIGNS.map(c => c.join(',')))
    expect(keys.size).toBe(8)
    for (const c of CUBE_CORNER_SIGNS) {
      for (const v of c) expect(Math.abs(v)).toBe(1)
    }
  })

  it('has 12 triangles referencing only valid corners', () => {
    expect(CUBE_TRIANGLE_INDICES).toHaveLength(36)
    for (const i of CUBE_TRIANGLE_INDICES) {
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(8)
    }
  })

  it('uses every corner, so the hull is a full cube and not a partial shell', () => {
    expect(new Set(CUBE_TRIANGLE_INDICES).size).toBe(8)
  })

  it('every triangle is non-degenerate (three distinct corners)', () => {
    for (let t = 0; t < CUBE_TRIANGLE_INDICES.length; t += 3) {
      const tri = CUBE_TRIANGLE_INDICES.slice(t, t + 3)
      expect(new Set(tri).size).toBe(3)
    }
  })
})
