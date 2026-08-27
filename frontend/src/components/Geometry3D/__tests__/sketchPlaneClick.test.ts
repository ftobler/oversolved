import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { projectCursorToSketchPlane } from '../dragMathPlane'
import { worldToSketchLocalPure } from '../coordTransform'

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

function perspectiveCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
  cam.position.set(10, 10, 30)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

function quatFromAxis(axis: [number, number, number], angle: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), angle)
}

describe('projectCursorToSketchPlane', () => {
  it('a centre-screen ray on an identity-transform sketch hits local (0,0)', () => {
    const g = makeGroup([0, 0, 0])
    const cam = orthoCamera()
    const pt = projectCursorToSketchPlane(cam, g, { x: 0, y: 0 })
    expect(pt).not.toBeNull()
    const local = worldToSketchLocalPure([pt!.x, pt!.y, pt!.z], [0, 0, 0], [0, 0, 0, 1])
    expect(local[0]).toBeCloseTo(0, 5)
    expect(local[1]).toBeCloseTo(0, 5)
    expect(local[2]).toBeCloseTo(0, 5)
  })

  it('an off-centre ray hits the plane at the unprojected cursor position', () => {
    const g = makeGroup([0, 0, 0])
    const cam = orthoCamera()  // -10..10 frustum: NDC (0.5,0.5) -> world (5,5)
    const pt = projectCursorToSketchPlane(cam, g, { x: 0.5, y: 0.5 })
    expect(pt).not.toBeNull()
    expect(pt!.x).toBeCloseTo(5, 4)
    expect(pt!.y).toBeCloseTo(5, 4)
    const local = worldToSketchLocalPure([pt!.x, pt!.y, pt!.z], [0, 0, 0], [0, 0, 0, 1])
    expect(local[0]).toBeCloseTo(5, 4)
    expect(local[1]).toBeCloseTo(5, 4)
  })

  it('a rotated sketch group still resolves in its own local frame', () => {
    // Rotate 90 deg about X (Top plane); use a perspective camera so the cursor
    // ray is not parallel to the plane. Pick a local 2D point, place it in
    // world space through the group transform, then project back: the resolved
    // local point must round-trip to where it started.
    const q = quatFromAxis([1, 0, 0], Math.PI / 2)
    const g = makeGroup([0, 0, 0], q)
    const cam = perspectiveCamera()
    const L: [number, number] = [2, 3]
    const worldVec = new THREE.Vector3(L[0], L[1], 0).applyQuaternion(q)
    const ndc = worldVec.clone().project(cam)

    const pt = projectCursorToSketchPlane(cam, g, { x: ndc.x, y: ndc.y })
    expect(pt).not.toBeNull()
    const local = worldToSketchLocalPure(
      [pt!.x, pt!.y, pt!.z],
      [0, 0, 0],
      [q.x, q.y, q.z, q.w],
    )
    expect(local[2]).toBeCloseTo(0, 4)
    expect(local[0]).toBeCloseTo(L[0], 4)
    expect(local[1]).toBeCloseTo(L[1], 4)
  })

  it('an offset sketch group resolves relative to its own origin', () => {
    // The plane is z=0 but the sketch frame origin sits at world (0,0,5). The
    // document origin (world 0,0,0) therefore maps to local (0,0,-5), NOT [0,0].
    // This is the geometric statement of the whole bug.
    const g = makeGroup([0, 0, 5])
    const cam = orthoCamera()
    const pt = projectCursorToSketchPlane(cam, g, { x: 0, y: 0 })
    expect(pt).not.toBeNull()
    const local = worldToSketchLocalPure([pt!.x, pt!.y, pt!.z], [0, 0, 5], [0, 0, 0, 1])
    expect(local[0]).toBeCloseTo(0, 4)
    expect(local[1]).toBeCloseTo(0, 4)
    expect(local[2]).toBeCloseTo(0, 4)
    // The document origin, in this frame, is at (0,0,-5).
    const docOriginLocal = worldToSketchLocalPure([0, 0, 0], [0, 0, 5], [0, 0, 0, 1])
    expect(docOriginLocal[2]).toBeCloseTo(-5, 4)
  })

  it('a ray parallel to the plane returns null', () => {
    // Rotate 90 deg about X so the local XY plane is the world XZ plane (normal
    // along world Y); an ortho camera looking down -Z has a ray with no Y travel,
    // so it is parallel to that plane. Offset the ray to y=5 so it is parallel
    // but not coincident (a coincident ray returns its origin instead of null).
    const q = quatFromAxis([1, 0, 0], Math.PI / 2)
    const g = makeGroup([0, 0, 0], q)
    const cam = orthoCamera()
    const pt = projectCursorToSketchPlane(cam, g, { x: 0, y: 0.5 })
    expect(pt).toBeNull()
  })

  it('a degenerate group scale does not produce a non-finite point', () => {
    const g = makeGroup([0, 0, 0])
    g.scale.set(0, 0, 0)
    g.updateMatrixWorld(true)
    const cam = orthoCamera()
    const pt = projectCursorToSketchPlane(cam, g, { x: 0.3, y: -0.2 })
    // Either the projection fails (null) or every component is finite: never NaN.
    expect(pt === null || (Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z))).toBe(true)
  })
})
