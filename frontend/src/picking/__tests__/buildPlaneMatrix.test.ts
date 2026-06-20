import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import type { PlaneTransform } from '@/types/cad'
import { buildPlaneMatrix } from '@/picking/idRegistrationUtils'

// buildPlaneMatrix turns a PlaneTransform (row-major 3x3 basis rows + origin)
// into a THREE.Matrix4 that maps plane-local coords to world: the basis rows
// become the matrix columns, so local +X -> x_axis, +Y -> y_axis, +Z -> normal,
// with the origin as translation. We assert through point application rather
// than raw element order so the test states intent, not storage layout.
const local = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}

describe('buildPlaneMatrix', () => {
  it('returns the identity matrix when no transform is given', () => {
    expect(buildPlaneMatrix(undefined).equals(new THREE.Matrix4())).toBe(true)
  })

  it('places the origin as the translation (local origin -> world origin)', () => {
    const pt: PlaneTransform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [5, 6, 7] }
    const m = buildPlaneMatrix(pt)
    expect(local(m, 0, 0, 0)).toEqual([5, 6, 7])
    // Identity rotation: local +X stays world +X, offset by the origin.
    expect(local(m, 1, 0, 0)).toEqual([6, 6, 7])
  })

  it('maps the local axes onto the plane basis rows', () => {
    // Plane rotated 90 deg about Z: x_axis -> world +Y, y_axis -> world -X,
    // normal -> world +Z. Rows of the row-major matrix are those basis vectors.
    const pt: PlaneTransform = {
      rotation: [0, 1, 0, -1, 0, 0, 0, 0, 1],
      origin: [0, 0, 0],
    }
    const m = buildPlaneMatrix(pt)
    const close = (got: number[], want: number[]) => got.forEach((g, i) => expect(g).toBeCloseTo(want[i], 9))
    close(local(m, 1, 0, 0), [0, 1, 0])  // local +X -> x_axis
    close(local(m, 0, 1, 0), [-1, 0, 0])  // local +Y -> y_axis
    close(local(m, 0, 0, 1), [0, 0, 1])  // local +Z -> normal
  })

  it('defaults missing origin components to zero', () => {
    const pt: PlaneTransform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [] }
    expect(local(buildPlaneMatrix(pt), 0, 0, 0)).toEqual([0, 0, 0])
  })
})
