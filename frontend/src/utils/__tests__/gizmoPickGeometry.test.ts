import { describe, it, expect } from 'vitest'
import {
  ARROW_HEAD_PICK_RADIUS,
  ARROW_LENGTH,
  ARROW_PICK_START,
  buildGizmoPickGeometry,
  GIZMO_AXES,
  GIZMO_PIXELS,
  gizmoHandleKey,
  HEAD_LENGTH,
  HEAD_RADIUS,
  parseGizmoHandleKey,
  PICK_LINE_PX,
  PLANE_BASE_INNER,
  PLANE_BASE_OUTER,
  PLANE_HANDLE_SCALE,
  PLANE_INNER,
  PLANE_OUTER,
  PLANE_OUTLINE_MARGIN,
  planeHandleCorners,
  planeHandleOutline,
  RING_PICK_TUBE,
  RING_RADIUS,
  RING_TUBE,
  SHAFT_RADIUS,
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

/** Every vertex of the triangles belonging to one handle. */
function handlePoints(geom: ReturnType<typeof buildGizmoPickGeometry>, query: string): [number, number, number][] {
  const face = geom.faceQueries.indexOf(query)
  expect(face).toBeGreaterThanOrEqual(0)
  const out: [number, number, number][] = []
  for (let tri = 0; tri < geom.triangleToFace.length; tri++) {
    if (geom.triangleToFace[tri] !== face) continue
    for (let v = 0; v < 3; v++) {
      const base = tri * 9 + v * 3
      out.push([geom.positions[base], geom.positions[base + 1], geom.positions[base + 2]])
    }
  }
  return out
}

/** Local units are GIZMO_PIXELS pixels each, so a local length is this many pixels. */
function toPixels(local: number): number {
  return local * GIZMO_PIXELS
}

describe('parseGizmoHandleKey', () => {
  it('round-trips every handle key the builder emits', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    expect(geom.faceQueries).toHaveLength(9)  // 3 arrows, 3 rings, 3 planes
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

  it('lays each plane quad flat in its own plane, clear of arrows and rings', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const { min, max } = handleBounds(geom, gizmoHandleKey('plane', 'z'))
    // `gizmo:plane:z` is the XY quad: keyed by its normal, like a ring.
    expect(min[2]).toBeCloseTo(0, 6)
    expect(max[2]).toBeCloseTo(0, 6)
    expect(min[0]).toBeCloseTo(PLANE_INNER, 6)
    expect(max[0]).toBeCloseTo(PLANE_OUTER, 6)
    // Outside the arrow tube's radius, inside the ring.
    expect(PLANE_INNER).toBeGreaterThan(0.1)
    expect(PLANE_OUTER).toBeLessThan(RING_RADIUS)
  })

  it('sizes the plane quad at the handle scale, grown about its own centre', () => {
    // Pins the rule the enlargement was made under: the side is exactly
    // PLANE_HANDLE_SCALE of the span it started from, and the centre does not
    // move, so the growth is symmetric rather than pushed outward.
    const side = PLANE_OUTER - PLANE_INNER
    expect(side).toBeCloseTo((PLANE_BASE_OUTER - PLANE_BASE_INNER) * PLANE_HANDLE_SCALE, 9)
    expect(PLANE_HANDLE_SCALE).toBeCloseTo(1.2, 9)
    expect((PLANE_INNER + PLANE_OUTER) / 2).toBeCloseTo((PLANE_BASE_INNER + PLANE_BASE_OUTER) / 2, 9)

    // Both edges move, by the same amount and in opposite directions. This is
    // what separates growing in place from scaling about the origin, which would
    // have left PLANE_INNER >= its base and put the whole increase on the outer
    // edge, closest to the rings.
    const grew = PLANE_OUTER - PLANE_BASE_OUTER
    expect(grew).toBeGreaterThan(0)
    expect(PLANE_BASE_INNER - PLANE_INNER).toBeCloseTo(grew, 9)
    expect(PLANE_OUTER).toBeLessThan(PLANE_BASE_OUTER * PLANE_HANDLE_SCALE)
  })

  it('draws and registers the same quad', () => {
    // TriadGizmo builds its mesh from planeHandleCorners; if the pick soup were
    // built from anything else the visible quad and the grab region could drift.
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const corners = planeHandleCorners(GIZMO_AXES[2])
    const { min, max } = handleBounds(geom, gizmoHandleKey('plane', 'z'))
    for (let c = 0; c < 3; c++) {
      expect(min[c]).toBeCloseTo(Math.min(...corners.map(p => p[c])), 6)
      expect(max[c]).toBeCloseTo(Math.max(...corners.map(p => p[c])), 6)
    }
  })

  it('scales and translates with the gizmo pose', () => {
    const origin: [number, number, number] = [10, -3, 2]
    const geom = buildGizmoPickGeometry(origin, IDENTITY, 4)
    const { max } = handleBounds(geom, gizmoHandleKey('translate', 'x'))
    expect(max[0]).toBeCloseTo(origin[0] + (ARROW_LENGTH + HEAD_LENGTH) * 4, 5)
  })

  // The grab regions used to be 3-4x the drawn line, which bought no reach the
  // resolver's 17 px window was not already giving and made two handles fight
  // over the same pixels. These pin the rule, not the numbers: a pick line is
  // about as wide as the line the user is aiming at.
  it('picks the arrow shaft at the width it is drawn, not a multiple of it', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    // Shaft only. The arrowhead has its own, deliberately wider tube: it is a
    // solid target rather than a line.
    const shaft = handlePoints(geom, gizmoHandleKey('translate', 'x'))
      .filter(p => p[0] < ARROW_LENGTH - HEAD_LENGTH)
    const half = Math.max(...shaft.map(p => Math.max(Math.abs(p[1]), Math.abs(p[2]))))
    expect(half).toBeLessThanOrEqual(SHAFT_RADIUS)
    // Wide enough to always rasterize, narrow enough to still be a hairline.
    expect(toPixels(2 * half)).toBeGreaterThanOrEqual(PICK_LINE_PX)
    expect(toPixels(2 * half)).toBeLessThan(2 * PICK_LINE_PX)
  })

  it('picks the ring at the width it is drawn, not a multiple of it', () => {
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const radii = handlePoints(geom, gizmoHandleKey('rotate', 'z')).map(p => Math.hypot(p[0], p[1]))
    const tube = (Math.max(...radii) - Math.min(...radii)) / 2
    expect(tube).toBeLessThanOrEqual(RING_TUBE)
    expect(toPixels(2 * tube)).toBeGreaterThanOrEqual(PICK_LINE_PX)
    expect(toPixels(2 * tube)).toBeLessThan(2 * PICK_LINE_PX)
  })

  it('keeps the arrowhead grabbable over the cone the user can see', () => {
    // Thinning the shaft must not thin the head with it: the head is the part
    // of the arrow a user aims at the middle of.
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const pts = handlePoints(geom, gizmoHandleKey('translate', 'x'))
    const widest = pts.reduce((best, p) => (Math.abs(p[1]) > Math.abs(best[1]) ? p : best))
    expect(Math.abs(widest[1])).toBeCloseTo(ARROW_HEAD_PICK_RADIUS, 6)
    expect(ARROW_HEAD_PICK_RADIUS).toBeLessThanOrEqual(HEAD_RADIUS)  // never wider than drawn
    // And it sits over the drawn cone, which TriadGizmo centres on ARROW_LENGTH.
    expect(widest[0]).toBeGreaterThanOrEqual(ARROW_LENGTH - HEAD_LENGTH / 2 - 1e-6)
    expect(widest[0]).toBeLessThanOrEqual(ARROW_LENGTH + HEAD_LENGTH / 2 + 1e-6)
  })

  it('leaves the hub free and keeps the arrows off each other', () => {
    // ARROW_PICK_START exists so the three arrows do not share the pixels where
    // they meet. With hairline tubes an arrow reaches |y|,|z| <= its radius, so
    // no arrow can enter the slab another arrow's start reserves.
    const geom = buildGizmoPickGeometry([0, 0, 0], IDENTITY, 1)
    const pts = handlePoints(geom, gizmoHandleKey('translate', 'x'))
    expect(Math.min(...pts.map(p => p[0]))).toBeCloseTo(ARROW_PICK_START, 6)
    const offAxis = Math.max(...pts.map(p => Math.max(Math.abs(p[1]), Math.abs(p[2]))))
    expect(offAxis).toBeLessThan(ARROW_PICK_START)
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

describe('planeHandleOutline', () => {
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

  it('closes the ring', () => {
    for (const def of GIZMO_AXES) {
      const ring = planeHandleOutline(def)
      expect(ring).toHaveLength(5)
      expect(ring[4]).toEqual(ring[0])
    }
  })

  it('encloses the quad on all four sides', () => {
    for (const def of GIZMO_AXES) {
      const quad = planeHandleCorners(def)
      const ring = planeHandleOutline(def)
      // Per basis direction, not per world component: only in the handle's own
      // u/v frame does "outside on all four sides" mean anything.
      for (const basis of [def.u, def.v]) {
        const quadCoords = quad.map(p => dot(p, basis))
        const ringCoords = ring.map(p => dot(p, basis))
        expect(Math.min(...ringCoords)).toBeLessThan(Math.min(...quadCoords))
        expect(Math.max(...ringCoords)).toBeGreaterThan(Math.max(...quadCoords))
      }
    }
  })

  it('stands off by exactly the margin', () => {
    for (const def of GIZMO_AXES) {
      const ring = planeHandleOutline(def)
      for (const basis of [def.u, def.v]) {
        const coords = ring.map(p => dot(p, basis))
        expect(Math.min(...coords)).toBeCloseTo(PLANE_INNER - PLANE_OUTLINE_MARGIN, 9)
        expect(Math.max(...coords)).toBeCloseTo(PLANE_OUTER + PLANE_OUTLINE_MARGIN, 9)
      }
    }
  })

  it('derives the margin from the quad rather than a free constant', () => {
    // Pins the relationship, not the value: resizing the plane handle must
    // carry the halo with it.
    expect(PLANE_OUTLINE_MARGIN).toBeCloseTo((PLANE_OUTER - PLANE_INNER) * 0.2, 9)
    expect(PLANE_OUTLINE_MARGIN).toBeGreaterThan(0)
    // Still tucked inside the ring it shares the gizmo with.
    expect(PLANE_OUTER + PLANE_OUTLINE_MARGIN).toBeLessThan(RING_RADIUS)
  })

  it('lies flat in each handle plane, off that handle u/v companions', () => {
    for (const def of GIZMO_AXES) {
      for (const p of planeHandleOutline(def)) {
        expect(dot(p, def.axis)).toBeCloseTo(0, 9)  // no component along the normal
        // And it is reachable from u and v alone: reconstructing from the two
        // projections must return the point, which no other basis would do.
        const cu = dot(p, def.u)
        const cv = dot(p, def.v)
        for (let c = 0; c < 3; c++) {
          expect(def.u[c] * cu + def.v[c] * cv).toBeCloseTo(p[c], 9)
        }
      }
    }
  })
})
