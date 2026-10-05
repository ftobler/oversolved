import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildSketchWorldPlane, projectCursorToSketchPlane } from '../dragMathPlane'

/**
 * Verifies the math-plane recipe (#266 drag-math-plane-audit):
 *   1. Construct a THREE.Plane from a sketch group's world transform.
 *   2. Project an NDC cursor onto that plane via Ray.intersectPlane.
 *
 * No invisible mesh, no Raycaster.intersectObject. Pure math; pinned by
 * the regression test `noDragPlaneMeshes.test.ts`.
 */

function makeGroup(position: [number, number, number], quat?: THREE.Quaternion): THREE.Group {
  const g = new THREE.Group()
  g.position.fromArray(position)
  if (quat) g.quaternion.copy(quat)
  g.updateMatrixWorld(true)
  return g
}

function orthoCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
  cam.position.set(0, 0, 50)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

describe('buildSketchWorldPlane', () => {
  it('returns a Z-aligned plane through the origin for an unrotated group at origin', () => {
    const g = makeGroup([0, 0, 0])
    const plane = buildSketchWorldPlane(g)
    expect(plane.normal.x).toBeCloseTo(0, 6)
    expect(plane.normal.y).toBeCloseTo(0, 6)
    expect(Math.abs(plane.normal.z)).toBeCloseTo(1, 6)
    // distanceToPoint at origin is 0.
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(0, 6)
  })

  it('rotates with the group quaternion (Top plane = XZ in world)', () => {
    // Rotate -90deg around X so the local Z axis points along world +Y.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
    const g = makeGroup([0, 0, 0], q)
    const plane = buildSketchWorldPlane(g)
    expect(plane.normal.x).toBeCloseTo(0, 6)
    expect(plane.normal.y).toBeCloseTo(1, 6)
    expect(plane.normal.z).toBeCloseTo(0, 6)
  })

  it('translates with the group position', () => {
    const g = makeGroup([3, 4, 5])
    const plane = buildSketchWorldPlane(g)
    // A Z-aligned plane through (3, 4, 5) has constant -5.
    expect(plane.distanceToPoint(new THREE.Vector3(3, 4, 5))).toBeCloseTo(0, 6)
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 5))).toBeCloseTo(0, 6)
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(-5, 6)
  })
})

describe('projectCursorToSketchPlane', () => {
  it('maps NDC origin to the world origin for an axis-aligned ortho camera', () => {
    const g = makeGroup([0, 0, 0])
    const cam = orthoCamera()
    const pt = projectCursorToSketchPlane(cam, g, { x: 0, y: 0 })
    expect(pt).not.toBeNull()
    expect(pt!.x).toBeCloseTo(0, 5)
    expect(pt!.y).toBeCloseTo(0, 5)
    expect(pt!.z).toBeCloseTo(0, 5)
  })

  it('maps NDC corners to the ortho frustum corners', () => {
    const g = makeGroup([0, 0, 0])
    const cam = orthoCamera()  // -10..10 x, -10..10 y
    const tr = projectCursorToSketchPlane(cam, g, { x: 1, y: 1 })
    const bl = projectCursorToSketchPlane(cam, g, { x: -1, y: -1 })
    expect(tr!.x).toBeCloseTo(10, 5)
    expect(tr!.y).toBeCloseTo(10, 5)
    expect(bl!.x).toBeCloseTo(-10, 5)
    expect(bl!.y).toBeCloseTo(-10, 5)
  })

  it('walks the cursor across the plane linearly as NDC sweeps', () => {
    const g = makeGroup([0, 0, 0])
    const cam = orthoCamera()
    let prev: THREE.Vector3 | null = null
    const points: number[] = []
    for (let i = 0; i <= 10; i++) {
      const ndcX = -1 + (2 * i) / 10
      const pt = projectCursorToSketchPlane(cam, g, { x: ndcX, y: 0 })
      expect(pt).not.toBeNull()
      points.push(pt!.x)
      if (prev) expect(pt!.x).toBeGreaterThan(prev.x)
      prev = pt!.clone()
    }
    // Linearity: the step from i to i+1 is constant.
    const step = points[1] - points[0]
    for (let i = 2; i < points.length; i++) {
      expect(points[i] - points[i - 1]).toBeCloseTo(step, 5)
    }
  })

  it('respects translated sketch groups (drag stays on the plane)', () => {
    const g = makeGroup([0, 0, 5])  // sketch plane parallel to XY at z=5
    const cam = orthoCamera()
    const pt = projectCursorToSketchPlane(cam, g, { x: 0.5, y: 0.5 })
    expect(pt).not.toBeNull()
    expect(pt!.z).toBeCloseTo(5, 5)
  })

  it('returns null for an edge-on camera looking parallel to the plane', () => {
    const g = makeGroup([0, 0, 0])
    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
    cam.position.set(0, 0, 50)
    cam.lookAt(1, 0, 50)  // view direction (1, 0, 0): parallel to the z=0 plane
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    expect(projectCursorToSketchPlane(cam, g, { x: 0, y: 0 })).toBeNull()
  })

  it('rejects a near-parallel hit that would land unbounded from the sketch origin', () => {
    const g = makeGroup([0, 0, 0])
    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
    cam.position.set(0, 0, 50)
    // A hair off edge-on: view direction z = -1e-9. Unguarded, the intersection
    // sits ~5e10 world units away; the incidence guard must refuse it.
    cam.lookAt(1, 0, 50 - 1e-9)
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    expect(projectCursorToSketchPlane(cam, g, { x: 0, y: 0 })).toBeNull()
  })

  it('rejects a moderately near-parallel hit that lands far outside the frame', () => {
    const g = makeGroup([0, 0, 0])
    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
    cam.position.set(0, 0, 50)
    // About 0.57 degrees off edge-on: well above the exact-parallel incidence
    // guard yet still commits a point thousands of units from the sketch. The
    // far-plane bound must refuse it.
    cam.lookAt(1, 0, 50 - 0.01)
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    expect(projectCursorToSketchPlane(cam, g, { x: 0, y: 0 })).toBeNull()
  })
})
