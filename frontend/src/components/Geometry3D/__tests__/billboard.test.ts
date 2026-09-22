import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyWorldBillboard } from '@/components/Geometry3D/billboard'

// A quaternion can be written two ways (q and -q) for the same rotation, so
// compare after pinning the sign to the expected one.
function expectQuatEqual(actual: THREE.Quaternion, expected: THREE.Quaternion): void {
  const sign = actual.dot(expected) < 0 ? -1 : 1
  expect(actual.x * sign).toBeCloseTo(expected.x, 6)
  expect(actual.y * sign).toBeCloseTo(expected.y, 6)
  expect(actual.z * sign).toBeCloseTo(expected.z, 6)
  expect(actual.w * sign).toBeCloseTo(expected.w, 6)
}

function worldQuat(obj: THREE.Object3D): THREE.Quaternion {
  const q = new THREE.Quaternion()
  obj.getWorldQuaternion(q)
  return q
}

function cameraWithQuat(q: THREE.Quaternion): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera()
  camera.quaternion.copy(q)
  return camera
}

describe('applyWorldBillboard', () => {
  it('gives the object the camera quaternion under an identity parent', () => {
    const group = new THREE.Group()
    const obj = new THREE.Object3D()
    group.add(obj)
    const camera = cameraWithQuat(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 1.1)))

    applyWorldBillboard(obj, camera)

    // Identity parent means local and world agree, and both are the camera.
    expectQuatEqual(obj.quaternion, camera.quaternion)
    expectQuatEqual(worldQuat(obj), camera.quaternion)
  })

  it('keeps the object world-facing under a parent rotated 90 deg about Y', () => {
    const group = new THREE.Group()
    group.rotation.set(0, Math.PI / 2, 0)
    const obj = new THREE.Object3D()
    group.add(obj)
    const camera = cameraWithQuat(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.4, -0.6)))

    applyWorldBillboard(obj, camera)

    const world = worldQuat(obj)
    expectQuatEqual(world, camera.quaternion)

    // The bug this guards: blindly copying the camera into the local slot
    // leaves the parent's 90 deg turn in the world pose.
    const parentWorld = new THREE.Quaternion()
    group.getWorldQuaternion(parentWorld)
    const cameraTimesParent = camera.quaternion.clone().multiply(parentWorld)
    expect(Math.abs(world.dot(cameraTimesParent))).toBeLessThan(1 - 1e-6)
  })

  it('is idempotent: a second call leaves the world orientation unchanged', () => {
    const group = new THREE.Group()
    group.rotation.set(0, Math.PI / 2, 0)
    const obj = new THREE.Object3D()
    group.add(obj)
    const camera = cameraWithQuat(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0.9, 0.15)))

    applyWorldBillboard(obj, camera)
    const afterFirst = worldQuat(obj)
    applyWorldBillboard(obj, camera)
    const afterSecond = worldQuat(obj)

    expectQuatEqual(afterSecond, afterFirst)
    expectQuatEqual(afterSecond, camera.quaternion)
  })

  it('orients a parentless object at the camera quaternion', () => {
    const obj = new THREE.Object3D()
    const camera = cameraWithQuat(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3)))

    applyWorldBillboard(obj, camera)

    expectQuatEqual(worldQuat(obj), camera.quaternion)
  })
})
