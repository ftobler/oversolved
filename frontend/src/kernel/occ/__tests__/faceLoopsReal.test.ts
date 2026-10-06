// @vitest-environment node
//
// Gated real-OCC parity gate for faceLoops.ts: the face-profile loop
// extraction (extrude/revolve from an existing planar face). Builds the same box
// + cylinder as the frozen golden fixture, extracts the loops
// + plane of the same sorted face indices, and asserts parity (coords within
// 1e-6; the box gives 4-line loops, the cylinder cap a full-circle arc loop).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  makeBox, makeBoxAt, makeCylinder, makeEllipseEdge, makeWire, makeFaceFromWire, makePrism,
  faceArea, faceSurfaceType, type Vec3,
} from '../primitives'
import { extractFaceLoops, extractOccFace } from '../faceLoops'
import { booleanWithDiff, countSubShapes } from '../booleans'
import { sketchLoopsToFace } from '../prismLineage'
import fixture from '../__fixtures__/faceLoops.json'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

const TOL = 1e-6

function expectClose(actual: unknown, expected: unknown, path = ''): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - expected), `${path}: ${actual} != ${expected}`).toBeLessThanOrEqual(TOL)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: array`).toBe(true)
    const a = actual as unknown[]
    expect(a.length, `${path}: len`).toBe(expected.length)
    expected.forEach((e, i) => expectClose(a[i], e, `${path}[${i}]`))
    return
  }
  if (expected !== null && typeof expected === 'object') {
    const eo = expected as Record<string, unknown>
    const ao = actual as Record<string, unknown>
    expect(Object.keys(ao).sort(), `${path}: keys`).toEqual(Object.keys(eo).sort())
    for (const k of Object.keys(eo)) expectClose(ao[k], eo[k], `${path}.${k}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

type Frame = { origin: number[]; x_axis: number[]; y_axis: number[]; normal: number[] }
type Case = {
  shape: 'box' | 'cyl'
  face_index: number
  loops: Record<string, unknown>[][]
  plane: Frame
}
type Fixture = {
  box: [number, number, number]
  cyl: { center: Vec3; axis: Vec3; radius: number; height: number }
  cases: Case[]
}
const fx = fixture as unknown as Fixture

describe.skipIf(!oc)('extractFaceLoops (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.shape}[${c.face_index}] loops + plane parity`, () => {
      const scope = new DisposeScope()
      try {
        let shape: OccShape
        if (c.shape === 'box') {
          shape = makeBox(occ, scope, fx.box[0], fx.box[1], fx.box[2])
        } else {
          shape = makeCylinder(occ, scope, fx.cyl.center, fx.cyl.axis, fx.cyl.radius, fx.cyl.height)
        }
        const { loops, plane } = extractFaceLoops(occ, scope, shape, c.face_index)
        expectClose(loops, c.loops, 'loops')
        expectClose(plane as unknown as Record<string, unknown>, c.plane, 'plane')
      } finally {
        scope.dispose()
      }
    })
  }
})

describe.skipIf(!oc)('partial-arc winding (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  // A vertical cylinder sunk into a block that breaks out of one side wall
  // leaves a pocket floor bounded by one wall line plus ONE circular arc. The
  // cylinder center's offset from that wall decides whether the floor arc is
  // the major segment (>180 deg) or the minor one -- exactly the arcs whose
  // winding cannot be guessed from the endpoint pair and must come from the
  // pcurve parameter span sign. Mis-winding rebuilds the complementary arc:
  // the wire still closes, so only geometry (span + rebuilt area) tells.
  const W = 20
  const L = 20
  const H = 10
  const R = 8
  const D = 3  // center offset from the broken-out wall x = 0

  function pocketFloor(scope: DisposeScope, cx: number): {
    arcLoops: Record<string, unknown>[][]
    rebuiltAreas: number[]
  } {
    const block = makeBoxAt(occ, scope, [0, 0, 0], W, L, H)
    const tool = makeCylinder(occ, scope, [cx, L / 2, -1], [0, 0, 1], R, H / 2 + 1)
    const { shape } = booleanWithDiff(occ, scope, block, tool, 'cut')
    const E = occ.TopAbs_ShapeEnum
    const nFaces = countSubShapes(occ, scope, shape, E.TopAbs_FACE)
    // The pocket floor AND the matching through-bottom opening are planar
    // faces bounded by the same wall line + circular arc, so both qualify.
    const arcLoops: Record<string, unknown>[][] = []
    const rebuiltAreas: number[] = []
    for (let i = 0; i < nFaces; i++) {
      if (faceSurfaceType(occ, scope, extractOccFace(occ, scope, shape, i)) !== 'flatface') continue
      const { loops, plane } = extractFaceLoops(occ, scope, shape, i)
      for (const loop of loops) {
        if (!loop.some((e) => (e as Record<string, unknown>).kind === 'arc')) continue
        arcLoops.push(loop as Record<string, unknown>[])
        // Round-trip through the extrude profile builder, which reconstructs
        // the curve exactly from (angles, ccw): prismLineage buildArcEdge.
        rebuiltAreas.push(faceArea(occ, scope, sketchLoopsToFace(occ, scope, loops, plane)))
      }
    }
    return { arcLoops, rebuiltAreas }
  }

  // The sweep buildArcEdge reconstructs from an emitted arc dict (degrees).
  function emittedSweepDeg(e: Record<string, unknown>): number {
    const a0 = e.angle_start_deg as number
    const a1 = e.angle_end_deg as number
    return (e.ccw as boolean)
      ? ((a1 - a0 + 360) % 360)
      : -(((a0 - a1 + 360) % 360))
  }

  // Block footprint minus the circular segment of `sweepDeg` on radius R.
  function expectedFloorArea(sweepDeg: number): number {
    const rad = (sweepDeg * Math.PI) / 180
    return W * L - ((R * R) / 2) * (rad - Math.sin(rad))
  }

  // Close-enough set match: areas come back in arbitrary face order.
  function expectAreaSet(areas: number[], expected: number[]): void {
    const sortNums = (xs: number[]) => [...xs].sort((a, b) => a - b)
    const got = sortNums(areas)
    const want = sortNums(expected)
    expect(got.length).toBe(want.length)
    got.forEach((g, i) => expect(g).toBeCloseTo(want[i], 4))
  }

  it('a >180 deg pocket-floor arc keeps its true span and round-trips', () => {
    const scope = new DisposeScope()
    try {
      const { arcLoops, rebuiltAreas } = pocketFloor(scope, D)
      expect(arcLoops.length).toBe(2)
      const major = 360 - (2 * Math.acos(D / R) * 180) / Math.PI
      for (const loop of arcLoops) {
        const arc = loop.find((e) => (e as Record<string, unknown>).kind === 'arc')
        expect(Math.abs(emittedSweepDeg(arc as Record<string, unknown>))).toBeCloseTo(major, 4)
      }
      // One face is the pocket floor (the circular-segment patch), the other
      // the matching through-bottom opening (footprint minus the segment).
      expectAreaSet(rebuiltAreas, [expectedFloorArea(major), 400 - expectedFloorArea(major)])
    } finally {
      scope.dispose()
    }
  })

  it('a <180 deg pocket-floor arc stays unchanged (regression guard)', () => {
    const scope = new DisposeScope()
    try {
      const { arcLoops, rebuiltAreas } = pocketFloor(scope, -D)
      expect(arcLoops.length).toBe(2)
      const minor = (2 * Math.acos(D / R) * 180) / Math.PI
      for (const loop of arcLoops) {
        const arc = loop.find((e) => (e as Record<string, unknown>).kind === 'arc')
        expect(Math.abs(emittedSweepDeg(arc as Record<string, unknown>))).toBeCloseTo(minor, 4)
      }
      expectAreaSet(rebuiltAreas, [expectedFloorArea(minor), 400 - expectedFloorArea(minor)])
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!oc)('elliptical face boundary (H23 fix)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('tessellates an elliptical pcurve into a multi-segment loop', () => {
    const scope = new DisposeScope()
    try {
      const center: Vec3 = [0, 0, 0]
      const normal: Vec3 = [0, 0, 1]
      const xAxis: Vec3 = [1, 0, 0]
      const a = 5  // major
      const b = 3  // minor
      const ellipse = makeEllipseEdge(occ, scope, center, normal, xAxis, a, b)
      const wire = makeWire(occ, scope, [ellipse])
      const face = makeFaceFromWire(occ, scope, wire)
      const solid = makePrism(occ, scope, face, [0, 0, 1], 1)
      const { loops } = extractFaceLoops(occ, scope, solid, 0)
      expect(loops.length).toBe(1)
      expect(loops[0].length).toBeGreaterThan(1)
    } finally {
      scope.dispose()
    }
  })
})
