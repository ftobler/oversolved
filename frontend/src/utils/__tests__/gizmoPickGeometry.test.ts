import { describe, it, expect } from 'vitest'
import {
  ARROW_LENGTH,
  buildGizmoPickGeometry,
  GIZMO_AXES,
  gizmoHandleKey,
  HEAD_LENGTH,
  parseGizmoHandleKey,
  RING_PICK_TUBE,
  RING_RADIUS,
} from '@/utils/gizmoPickGeometry'
import { IDENTITY_TRANSFORM, quatFromAxisAngle, rotateVector, type Quat } from '@/utils/transform3d'

const IDENTITY: Quat = [IDENTITY_TRANSFORM.qx, IDENTITY_TRANSFORM.qy, IDENTITY_TRANSFORM.qz, IDENTITY_TRANSFORM.qw]

/** Bounding box of the triangles belonging to one handle. */
function handleBounds(geom: ReturnType<typeof buildGizmoPickGeometry>, query: string) {
  const face = geom.faceQueries.indexOf(query)
  expect(face).toBeGreaterThanOrEqual(0)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let tri = 0; tri < geom.triangleToFace.length; tri++) {
    if (geom.triangleToFace[tri] !== face) continue
    for (let v = 0; v < 3; v++) {
      for (let c = 0; c < 3; c++) {
        const value = geom.positions[tri * 9 + v * 3 + c]
        if (value < min[c]) min[c] = value
        if (value > max[c]) max[c] = value
      }
    }
  }
  return { min, max }
}

describe('parseGizmoHandleKey', () => {
  it('round-trips every handle key the builder emits', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    expect(geom.faceQueries).toHaveLength(6)
    for (const query of geom.faceQueries) {
      const ref = parseGizmoHandleKey(query)
      expect(ref).not.toBeNull()
      expect(gizmoHandleKey(ref!.kind, GIZMO_AXES.find(a => a.axis.every((c, i) => c === ref!.axis[i]))!.name))
        .toBe(query)
    }
  })

  it('rejects keys from every other layer', () => {
    // The dispatcher parses whatever the ID buffer hands it; a face query or a
    // part-editor handle key must not be mistaken for a grab.
    for (const key of ['face@part/0/face/3', 'fhandle:f1:distance', 'gizmo:scale:x', 'gizmo:translate:w', 'gizmo', '', null, undefined]) {
      expect(parseGizmoHandleKey(key)).toBeNull()
    }
  })
})

describe('buildGizmoPickGeometry', () => {
  it('emits whole triangles with one face index each', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    expect(geom.positions.length % 9).toBe(0)
    expect(geom.triangleToFace.length).toBe(geom.positions.length / 9)
    // Every declared handle actually carries triangles, or it would be drawn
    // as a grab target that no pixel can ever resolve to.
    for (let face = 0; face < geom.faceQueries.length; face++) {
      expect([...geom.triangleToFace]).toContain(face)
    }
  })

  it('puts each arrow along its own axis, reaching the drawn tip', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const tip = ARROW_LENGTH + HEAD_LENGTH
    const { min, max } = handleBounds(geom, gizmoHandleKey('translate', 'x'))
    expect(max[0]).toBeCloseTo(tip, 6)
    expect(min[0]).toBeGreaterThan(0)  // clear of the hub the three arrows share
    // The other two extents are only the pick tube's radius.
    expect(max[1]).toBeLessThan(0.2)
    expect(max[2]).toBeLessThan(0.2)
  })

  it('puts each ring in the plane normal to its own axis', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const { min, max } = handleBounds(geom, gizmoHandleKey('rotate', 'z'))
    const outer = RING_RADIUS + RING_PICK_TUBE
    expect(max[0]).toBeCloseTo(outer, 6)
    expect(max[1]).toBeCloseTo(outer, 6)
    expect(min[0]).toBeCloseTo(-outer, 6)
    // Flat against Z: only the pick tube gives it any thickness, and the
    // low-poly cross-section keeps it just inside that.
    const thickness = Math.max(max[2], -min[2])
    expect(thickness).toBeGreaterThan(RING_PICK_TUBE / 2)
    expect(thickness).toBeLessThanOrEqual(RING_PICK_TUBE)
  })

  it('scales and translates with the gizmo pose', () => {
    const origin: [number, number, number] = [10, -3, 2]
    const geom = buildGizmoPickGeometry(origin, IDENTITY, 4)
    const { max } = handleBounds(geom, gizmoHandleKey('translate', 'x'))
    expect(max[0]).toBeCloseTo(origin[0] + (ARROW_LENGTH + HEAD_LENGTH) * 4, 5)
  })

  it('turns with the part: a quarter turn about Z sends the X arrow up +Y', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
    const geom = buildGizmoPickGeometry([0, 0, 0], q, 1)
    const { max } = handleBounds(geom, gizmoHandleKey('translate', 'x'))
    expect(max[1]).toBeCloseTo(ARROW_LENGTH + HEAD_LENGTH, 6)
    expect(max[0]).toBeLessThan(0.2)
    // The axis the dispatcher reports is the local one; the viewport lifts it
    // through the same pose, which must land on the same world direction.
    const world = rotateVector(q, parseGizmoHandleKey(gizmoHandleKey('translate', 'x'))!.axis)
    expect(world[1]).toBeCloseTo(1, 6)
  })
})
