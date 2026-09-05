import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { cameraPoseChanged, snapshotCameraPose, createCameraPose, recordCameraPoseInto } from '../cameraPose'

// Both viewports mount Canvas orthographic, so the dolly-zoom regression this
// guards lives entirely in projectionMatrix (zoom), never in matrixWorld.
function orthoCamera(zoom: number): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
  cam.position.set(3, 4, 5)
  cam.lookAt(0, 0, 0)
  cam.zoom = zoom
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld()
  return cam
}

function perspectiveCamera(fov = 50): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(fov, 1.5, 0.1, 100)
  cam.position.set(3, 4, 5)
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld()
  return cam
}

describe('cameraPoseChanged', () => {
  it('flags an orthographic wheel-zoom that leaves matrixWorld untouched', () => {
    const base = orthoCamera(1)
    const zoomed = orthoCamera(8)
    // Sanity: the world matrix really is identical, so the former
    // matrixWorld-only check could not have seen this move.
    expect(zoomed.matrixWorld.equals(base.matrixWorld)).toBe(true)
    expect(cameraPoseChanged(snapshotCameraPose(base), zoomed)).toBe(true)
  })

  it('accepts an identical pose twice', () => {
    const cam = orthoCamera(1)
    const prev = snapshotCameraPose(cam)
    expect(cameraPoseChanged(prev, cam)).toBe(false)
    // A separately built camera with the same pose must also read unchanged,
    // proving the comparison is element-wise and not reference identity.
    expect(cameraPoseChanged(prev, orthoCamera(1))).toBe(false)
  })

  it('accepts an identical pose twice at a working-distance magnitude', () => {
    // A translation element that is not exactly float32-representable. The old
    // Float32Array snapshot rounded 103.9230484541326 by ~1.5e-6, above EPSILON,
    // so after the first orbit an unmoved camera re-read as changed every frame.
    const cam = new THREE.PerspectiveCamera(50, 1.5, 0.1, 500)
    cam.position.set(103.9230484541326, 20, 100)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const prev = snapshotCameraPose(cam)
    expect(cameraPoseChanged(prev, cam)).toBe(false)

    // A real orbit from that pose is still detected.
    const moved = new THREE.PerspectiveCamera(50, 1.5, 0.1, 500)
    moved.position.set(90, 30, 110)
    moved.lookAt(0, 0, 0)
    moved.updateProjectionMatrix()
    moved.updateMatrixWorld()
    expect(cameraPoseChanged(prev, moved)).toBe(true)
  })

  it('accepts an unchanged perspective camera', () => {
    const cam = perspectiveCamera()
    const prev = snapshotCameraPose(cam)
    expect(cameraPoseChanged(prev, perspectiveCamera())).toBe(false)
  })

  it('flags a projection change on a perspective camera too', () => {
    const base = perspectiveCamera(50)
    expect(cameraPoseChanged(snapshotCameraPose(base), perspectiveCamera(70))).toBe(true)
  })

  it('treats the first frame (null snapshot) as unchanged', () => {
    expect(cameraPoseChanged(null, orthoCamera(1))).toBe(false)
  })
})

// ─── Per-frame allocation (VP-L2) ───

// IdPickingDriver's useFrame compares the camera pose every frame. The old path
// called snapshotCameraPose (two fresh typed arrays) on each frame; now it
// copies into a reused buffer (createCameraPose + recordCameraPoseInto) so the
// camera-change check stops allocating 32 floats per frame.

describe('camera pose reuse', () => {
  it('reuses the same typed-array instances across frames', () => {
    const pose = createCameraPose()
    const cam = orthoCamera(1)
    recordCameraPoseInto(pose, cam)
    const mw = pose.matrixWorld
    const pm = pose.projectionMatrix

    // Next frame writes in place; the buffers must be the same objects.
    recordCameraPoseInto(pose, orthoCamera(2))
    expect(pose.matrixWorld).toBe(mw)
    expect(pose.projectionMatrix).toBe(pm)
  })

  it('still detects a change after in-place reuse', () => {
    const pose = createCameraPose()
    recordCameraPoseInto(pose, orthoCamera(1))
    // Same value this frame: unchanged.
    expect(cameraPoseChanged(pose, orthoCamera(1))).toBe(false)
    recordCameraPoseInto(pose, orthoCamera(1))
    // Zoom moved next frame: changed, proving the reused buffer is compared.
    expect(cameraPoseChanged(pose, orthoCamera(4))).toBe(true)
  })
})
