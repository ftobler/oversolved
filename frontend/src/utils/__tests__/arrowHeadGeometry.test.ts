/**
 * The triad arrowhead is drawn as a solid triangle that spins about its own
 * axis to face the viewer. Two things must hold for that to read as an arrow
 * rather than as a loose sprite: the head has to occupy exactly the span the ID
 * buffer hit-tests, and the spin must never move the direction it points in.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  ARROW_HEAD_BASE, ARROW_HEAD_TIP, arrowHeadPositions, arrowHeadTriangle,
  cylindricalBillboardAngle, rotateAboutAxis,
} from '@/utils/arrowHeadGeometry'
import { ARROW_LENGTH, HEAD_LENGTH, HEAD_RADIUS } from '@/utils/gizmoPickGeometry'

describe('arrow head span', () => {
  // Restated from the pick side's own constants rather than shared with it, so
  // a change to either end has to be made twice on purpose.
  it('covers exactly the range gizmoPickGeometry registers as the head', () => {
    expect(ARROW_HEAD_BASE).toBeCloseTo(ARROW_LENGTH - HEAD_LENGTH / 2, 12)
    expect(ARROW_HEAD_TIP).toBeCloseTo(ARROW_LENGTH + HEAD_LENGTH / 2, 12)
  })

  it('puts the base flat across the axis and the tip on it', () => {
    const [left, tip, right] = arrowHeadTriangle()
    expect(left).toEqual([-HEAD_RADIUS, ARROW_HEAD_BASE, 0])
    expect(right).toEqual([HEAD_RADIUS, ARROW_HEAD_BASE, 0])
    expect(tip).toEqual([0, ARROW_HEAD_TIP, 0])
  })

  it('stays within the drawn head radius the pick cylinder assumes', () => {
    for (const [x, , z] of arrowHeadTriangle()) {
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(HEAD_RADIUS + 1e-12)
    }
  })

  it('emits one triangle as a flat position buffer', () => {
    const positions = arrowHeadPositions()
    expect(positions).toHaveLength(9)
    // Float32Array, so the tip only round-trips to single precision.
    expect(positions[3]).toBe(0)
    expect(positions[4]).toBeCloseTo(ARROW_HEAD_TIP, 6)
    expect(positions[5]).toBe(0)
  })
})

describe('cylindrical billboard', () => {
  it('leaves the tip on the axis whatever the camera does', () => {
    const [, tip] = arrowHeadTriangle()
    for (const camera of [
      [3, 0, 0], [0, 0, 3], [-2, 5, 1], [0.1, -7, -0.3], [4, 4, 4],
    ] as [number, number, number][]) {
      const spun = rotateAboutAxis(tip, cylindricalBillboardAngle(camera))
      expect(spun[0]).toBeCloseTo(0, 12)
      expect(spun[1]).toBeCloseTo(ARROW_HEAD_TIP, 12)
      expect(spun[2]).toBeCloseTo(0, 12)
    }
  })

  it('keeps every corner at its own height, so the head cannot tilt off axis', () => {
    const angle = cylindricalBillboardAngle([2, 9, -5])
    for (const corner of arrowHeadTriangle()) {
      expect(rotateAboutAxis(corner, angle)[1]).toBeCloseTo(corner[1], 12)
    }
  })

  it('turns the triangle face toward the camera', () => {
    // The unrotated triangle's normal is +Z; after the spin it must point at
    // the camera's off-axis bearing, which is what "presenting max area" means.
    for (const camera of [
      [3, 0, 0], [0, 2, 3], [-2, 5, 1], [1, 0, -1],
    ] as [number, number, number][]) {
      const normal = rotateAboutAxis([0, 0, 1], cylindricalBillboardAngle(camera))
      const bearing = new THREE.Vector2(camera[0], camera[2]).normalize()
      expect(normal[0]).toBeCloseTo(bearing.x, 12)
      expect(normal[2]).toBeCloseTo(bearing.y, 12)
    }
  })

  it('varies with the camera instead of holding one pose', () => {
    const angles = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]
      .map(c => cylindricalBillboardAngle(c as [number, number, number]))
    expect(new Set(angles).size).toBe(4)
  })

  it('ignores how high the camera stands, which is what a full billboard would tilt into', () => {
    const low = cylindricalBillboardAngle([2, -40, 3])
    const high = cylindricalBillboardAngle([2, 40, 3])
    expect(low).toBeCloseTo(high, 12)
  })

  it('settles on a fixed pose when sighted straight down the axis', () => {
    expect(cylindricalBillboardAngle([0, 5, 0])).toBe(0)
  })

  it('matches three.js rotation.y, so the component can assign it directly', () => {
    const angle = cylindricalBillboardAngle([3, 1, -2])
    const obj = new THREE.Object3D()
    obj.rotation.y = angle
    obj.updateMatrix()
    for (const corner of arrowHeadTriangle()) {
      const expected = new THREE.Vector3(...corner).applyMatrix4(obj.matrix)
      const actual = rotateAboutAxis(corner, angle)
      expect(actual[0]).toBeCloseTo(expected.x, 12)
      expect(actual[1]).toBeCloseTo(expected.y, 12)
      expect(actual[2]).toBeCloseTo(expected.z, 12)
    }
  })
})
