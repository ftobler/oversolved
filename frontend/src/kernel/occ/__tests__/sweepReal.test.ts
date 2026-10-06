// @vitest-environment node
//
// Gated real-OCC parity gate for sweepProfileWithLineage (the sweep leaf's brep
// producer). Rebuilds the same spine edges (line/arc) as the frozen golden sweep
// fixture via the TS adapters, sweeps the same square profile, and asserts the
// produced solid volume + profile-entity token attribution.
//
// Same conversion as the extrude gate (see prismLineageReal.test.ts): the
// geom-hash face_lineage/edge_lineage output was removed, so we build with a
// createdBy and compare the token attribution on the surviving construction-name
// ancestry maps. faceAncestry matches the golden face_lineage multiset; edgeAncestry
// is a SUBSET (seam edges of curved lateral faces get no edge UUID).
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../booleans'
import { sweepProfileWithLineage } from '../prismLineage'
import { makeLineEdge, makeArcEdge, type Vec3 } from '../primitives'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import type { OccModule, OccShape } from '../occTypes'
import fixture from '../__fixtures__/sweep.json'

const oc = await loadOcc()

// Local point-based arc builder for the parity fixtures. This test pins the
// brep producer (sweepProfileWithLineage), not arc resolution, and its fixture
// arcs are well-conditioned (a clean 90-degree arc), so reconstructing the
// minor arc from the three world points is fine here. Production spine arcs are
// built from exact angle data via buildArcEdge (see collectPathEdges), not this.
function fixtureArcEdge(
  occ: OccModule,
  scope: DisposeScope,
  center: number[],
  start: number[],
  end: number[],
  radius: number,
): OccShape {
  const v0 = [start[0] - center[0], start[1] - center[1], start[2] - center[2]]
  const v1 = [end[0] - center[0], end[1] - center[1], end[2] - center[2]]
  const cross: Vec3 = [
    v0[1] * v1[2] - v0[2] * v1[1],
    v0[2] * v1[0] - v0[0] * v1[2],
    v0[0] * v1[1] - v0[1] * v1[0],
  ]
  const crossMag = Math.hypot(cross[0], cross[1], cross[2])
  const dot = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]
  const minorAngle = Math.atan2(crossMag, dot)
  const normal: Vec3 = [cross[0] / crossMag, cross[1] / crossMag, cross[2] / crossMag]
  return makeArcEdge(occ, scope, center as Vec3, normal, v0 as Vec3, radius, 0.0, minorAngle)
}

type Lineage = Record<string, string[]>
type Segment = { kind: string; start: number[]; end: number[]; center?: number[]; radius?: number }
type Case = {
  name: string
  loops: LoopEdge[][]
  plane: PlaneLike
  segments: Segment[]
  sketch_id: string
  flat: boolean
  volume: number
  face_lineage: Lineage
  edge_lineage: Lineage
}
const fx = fixture as unknown as { cases: Case[] }

/** Sorted multiset of the NON-EMPTY sorted token-lists (key-independent view). */
function tokenMultiset(d: Lineage): string[] {
  return Object.values(d)
    .filter((v) => v.length > 0)
    .map((v) => JSON.stringify([...v].sort()))
    .sort()
}

describe.skipIf(!oc)('sweepProfileWithLineage (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: solid volume + face/edge token attribution match Python`, () => {
      const scope = new DisposeScope()
      try {
        const spine: OccShape[] = c.segments.map((seg) =>
          seg.kind === 'arc'
            ? fixtureArcEdge(occ, scope, seg.center as number[], seg.start, seg.end, seg.radius as number)
            : makeLineEdge(occ, scope, seg.start as Vec3, seg.end as Vec3),
        )
        const { solid, faceAncestry, edgeAncestry } = sweepProfileWithLineage(
          occ,
          scope,
          c.loops,
          c.plane,
          spine,
          c.sketch_id,
          'feat',
        )
        expect(volumeOf(occ, scope, solid)).toBeCloseTo(c.volume, 3)
        // Distinct token-lists: the name layer keys faces by UUID, so one profile
        // entity swept into two lateral faces (an L-spine) dedupes to one entry.
        expect(new Set(tokenMultiset(faceAncestry))).toEqual(new Set(tokenMultiset(c.face_lineage)))
        // Subset only: seam edges of curved lateral faces get no edge UUID.
        const goldenEdges = new Set(tokenMultiset(c.edge_lineage))
        for (const t of tokenMultiset(edgeAncestry)) expect(goldenEdges.has(t)).toBe(true)
      } finally {
        scope.dispose()
      }
    })
  }
})
