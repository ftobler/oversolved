// @vitest-environment node
//
// Gated real-OCC parity gate for sweepProfileWithLineage (phase 2f, the sweep
// leaf's brep producer). Rebuilds the same spine edges (line/arc) as
// tests/wasm_harness/gen_sweep_fixture.py via the TS adapters, sweeps the same
// square profile, and asserts the produced solid volume + face/edge lineage.
//
// edge_lineage is asserted EXACTLY for every case. face_lineage is asserted
// EXACTLY for the line spines (all-flat faces, geom hashes agree) and by sorted
// token-multiset for the arc spine (curved lateral faces -> geom-hash key
// divergence, as in extrude/revolve).
//
// Skips when opencascade.js is absent. Regenerate:
//   .venv/bin/python tests/wasm_harness/gen_sweep_fixture.py

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { sweepProfileWithLineage } from './prismLineage'
import { makeLineEdge, type Vec3 } from './primitives'
import { worldArcEdge } from '../features/sweep'
import type { PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'
import type { OccModule, OccShape } from './occTypes'
import fixture from './__fixtures__/sweep.json'

const oc = await loadOcc()

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

function sortLineage(d: Lineage): Lineage {
  const out: Lineage = {}
  for (const [k, v] of Object.entries(d)) out[k] = [...v].sort()
  return out
}

function tokenMultiset(d: Lineage): string[] {
  return Object.values(d)
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
    it(`${c.name}: solid volume + face/edge lineage match Python`, () => {
      const scope = new DisposeScope()
      try {
        const spine: OccShape[] = c.segments.map((seg) =>
          seg.kind === 'arc'
            ? worldArcEdge(occ, scope, seg.center as number[], seg.start, seg.end, seg.radius as number)
            : makeLineEdge(occ, scope, seg.start as Vec3, seg.end as Vec3),
        )
        const { solid, faceLineage, edgeLineage } = sweepProfileWithLineage(
          occ,
          scope,
          c.loops,
          c.plane,
          spine,
          c.sketch_id,
        )
        expect(volumeOf(occ, scope, solid)).toBeCloseTo(c.volume, 3)
        if (c.flat) {
          // Line spines yield all-flat faces + line/circle edges: analytic geom
          // hashes agree cross-language, so both maps are exact parity checks.
          expect(sortLineage(edgeLineage)).toEqual(c.edge_lineage)
          expect(sortLineage(faceLineage)).toEqual(c.face_lineage)
        } else {
          // Curved spine: lateral faces AND the swept corner edges carry
          // OCC-build-dependent geom hashes, so compare token-multisets only.
          expect(tokenMultiset(edgeLineage)).toEqual(tokenMultiset(c.edge_lineage))
          expect(tokenMultiset(faceLineage)).toEqual(tokenMultiset(c.face_lineage))
        }
      } finally {
        scope.dispose()
      }
    })
  }
})
