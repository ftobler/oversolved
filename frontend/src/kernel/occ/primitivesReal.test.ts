// @vitest-environment node
//
// Real-OCC verification of the make-a-body primitives + geometry readers.
// Skips when opencascade.js is not installed (npm run occ:install). Builds box,
// cylinder, and extruded-square solids, reads per-face centroid/normal/surface
// type/area, and asserts the topology + the face-normal sign convention that
// must match Python. Everything routes through the HandleTable; the body is
// released at the end and the table asserted leak-free.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { DisposeScope } from './disposeScope'
import { buildBox, buildCylinder, buildExtrudedProfile } from './shapes'
import {
  faceCentroid,
  faceNormal,
  faceArea,
  faceSurfaceType,
  type SurfaceType,
  type Vec3,
} from './primitives'
import type { OccModule, OccShape } from './occTypes'

const oc = await loadOcc()

interface FaceInfo {
  centroid: Vec3
  normal: Vec3
  area: number
  surfaceType: SurfaceType
}

function readFaces(occ: OccModule, solid: OccShape): FaceInfo[] {
  const scope = new DisposeScope()
  try {
    const E = occ.TopAbs_ShapeEnum
    const exp = scope.track(new occ.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
    const out: FaceInfo[] = []
    for (; exp.More(); exp.Next()) {
      const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
      out.push({
        centroid: faceCentroid(occ, scope, f),
        normal: faceNormal(occ, scope, f),
        area: faceArea(occ, scope, f),
        surfaceType: faceSurfaceType(occ, scope, f),
      })
    }
    return out
  } finally {
    scope.dispose()
  }
}

const roundV = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e6) / 1e6) as Vec3

describe.skipIf(!oc)('make-a-body primitives (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('builds a box with 6 planar faces and outward normals', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5, owner: 'box' })
    const faces = readFaces(occ, table.get(h))

    expect(faces).toHaveLength(6)
    expect(faces.every((f) => f.surfaceType === 'flatface')).toBe(true)

    const normals = new Set(faces.map((f) => JSON.stringify(roundV(f.normal))))
    expect(normals).toEqual(
      new Set(
        ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as Vec3[]).map((n) =>
          JSON.stringify(roundV(n)),
        ),
      ),
    )
    // surface area of a 10x10x5 box = 2(100 + 50 + 50)
    const total = faces.reduce((s, f) => s + f.area, 0)
    expect(total).toBeCloseTo(400, 6)

    table.release(h)
    table.assertNoLeaks()
  })

  it('builds a cylinder: 2 planar caps + 1 cylindrical wall', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildCylinder(occ, table, {
      center: [0, 0, 0],
      axis: [0, 0, 1],
      radius: 3,
      height: 10,
      owner: 'cyl',
    })
    const faces = readFaces(occ, table.get(h))
    expect(faces).toHaveLength(3)
    expect(faces.filter((f) => f.surfaceType === 'flatface')).toHaveLength(2)
    expect(faces.filter((f) => f.surfaceType === 'cylinderface')).toHaveLength(1)

    const wall = faces.find((f) => f.surfaceType === 'cylinderface')!
    expect(wall.area).toBeCloseTo(2 * Math.PI * 3 * 10, 4)
    const cap = faces.find((f) => f.surfaceType === 'flatface')!
    expect(cap.area).toBeCloseTo(Math.PI * 9, 4)

    table.release(h)
    table.assertNoLeaks()
  })

  it('builds an extruded square equivalent to a box', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildExtrudedProfile(occ, table, {
      loop: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      direction: [0, 0, 1],
      distance: 5,
      owner: 'ex',
    })
    const faces = readFaces(occ, table.get(h))
    expect(faces).toHaveLength(6)
    expect(faces.every((f) => f.surfaceType === 'flatface')).toBe(true)
    const total = faces.reduce((s, f) => s + f.area, 0)
    expect(total).toBeCloseTo(400, 6)
    table.release(h)
    table.assertNoLeaks()
  })

  it('stays leak-free across a 50-iteration build/evict loop', () => {
    const table = new HandleTable({ finalizerGuard: false })
    for (let i = 0; i < 50; i++) {
      const h = buildBox(occ, table, { dx: 3, dy: 4, dz: 5, owner: `b${i}` })
      readFaces(occ, table.get(h))
      table.release(h)
    }
    expect(table.liveCount()).toBe(0)
    table.assertNoLeaks()
  })
})
