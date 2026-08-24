import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { cameraPoseChanged, snapshotCameraPose } from '../cameraPose'

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
