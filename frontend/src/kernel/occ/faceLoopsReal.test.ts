// @vitest-environment node
//
// Gated real-OCC parity gate for faceLoops.ts (phase 2e): the face-profile loop
// extraction (extrude/revolve from an existing planar face). Builds the same box
// + cylinder as the now-removed gen_faceloops_fixture.py, extracts the loops
// + plane of the same sorted face indices, and asserts parity (coords within
// 1e-6; the box gives 4-line loops, the cylinder cap a full-circle arc loop).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot;
// its generator (gen_faceloops_fixture.py) was deleted with the Python kernel in
// phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { makeBox, makeCylinder, type Vec3 } from './primitives'
import { extractFaceLoops } from './faceLoops'
import fixture from './__fixtures__/faceLoops.json'
import type { OccModule, OccShape } from './occTypes'

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
