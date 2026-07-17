// @vitest-environment node
//
// Gated real-OCC test for the Stage 1 construction-name minting in
// prismLineage.ts (query-naming-by-construction.md). Extrudes a controlled unit
// square and asserts the produced face/edge construction UUIDs are exactly the
// symbolic values `constructionName.ts` mints, are collision-free, and recompute
// identically on an independent rebuild (the load-bearing determinism).
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { extrudeProfileWithLineage } from './prismLineage'
import type { PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'
import type { OccModule } from './occTypes'
import type { Vec3 } from './primitives'
import { mintFaceUuid, sideFacePath, capFacePath } from '../constructionName'

const oc = await loadOcc()

const XY: PlaneLike = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  normal: [0, 0, 1],
}

// A 10x10 square with one line entity per side.
function squareLoops(): LoopEdge[][] {
  const corners: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  const loop: LoopEdge[] = corners.map((start, i) => ({
    kind: 'line',
    id: `l${i}`,
    start,
    end: corners[(i + 1) % corners.length],
  }))
  return [loop]
}

const CREATED_BY = 'extrude1'
const SKETCH_ID = 'sk1'

describe.skipIf(!oc)('construction-name minting (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function build() {
    const scope = new DisposeScope()
    try {
      const r = extrudeProfileWithLineage(
        occ,
        scope,
        squareLoops(),
        XY,
        [0, 0, 1] as Vec3,
        5,
        SKETCH_ID,
        CREATED_BY,
      )
      return {
        faceNames: { ...r.faceNames },
        edgeNames: { ...r.edgeNames },
        faceAncestry: { ...r.faceAncestry },
        edgeAncestry: { ...r.edgeAncestry },
      }
    } finally {
      scope.dispose()
    }
  }

  it('mints one construction UUID per face, exactly the symbolic values', () => {
    const { faceNames, faceAncestry } = build()
    const uuids = Object.values(faceNames)
    // A box has 6 faces: 4 sides + 2 caps.
    expect(uuids.length).toBe(6)
    // Collision-free within a build.
    expect(new Set(uuids).size).toBe(6)

    const expectedSides = ['l0', 'l1', 'l2', 'l3'].map((e) =>
      mintFaceUuid(sideFacePath(CREATED_BY, `${SKETCH_ID}/${e}`)),
    )
    const expectedCaps = [
      mintFaceUuid(capFacePath(CREATED_BY, 'start')),
      mintFaceUuid(capFacePath(CREATED_BY, 'end')),
    ]
    for (const u of [...expectedSides, ...expectedCaps]) {
      expect(uuids).toContain(u)
    }

    // Side faces carry the generating profile entity as ancestral fallback;
    // caps carry an empty ancestral list.
    for (let i = 0; i < 4; i++) {
      expect(faceAncestry[expectedSides[i]]).toEqual([`@${SKETCH_ID}/l${i}`])
    }
    for (const cap of expectedCaps) expect(faceAncestry[cap]).toEqual([])
  })

  it('derives collision-free edge UUIDs from face adjacency', () => {
    const { edgeNames } = build()
    const uuids = Object.values(edgeNames)
    // A box has 12 edges; each is a distinct face pair.
    expect(uuids.length).toBe(12)
    expect(new Set(uuids).size).toBe(12)
    for (const u of uuids) expect(u.startsWith('e_')).toBe(true)
  })

  it('recomputes identical UUIDs on an independent rebuild', () => {
    const a = build()
    const b = build()
    // The gh keys are geometry-derived and identical across identical builds,
    // and the UUID values are symbolic, so both maps match exactly.
    expect(new Set(Object.values(a.faceNames))).toEqual(new Set(Object.values(b.faceNames)))
    expect(new Set(Object.values(a.edgeNames))).toEqual(new Set(Object.values(b.edgeNames)))
    expect(a.faceAncestry).toEqual(b.faceAncestry)
  })
})
