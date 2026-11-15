// @vitest-environment node
//
// The freeform-neighbour pass matrix: the five `set1` picks of the 2026-11-15
// bug report x d in {+0.5, -0.5, +1, -1}, against the document in
// fixtures/moveFaceFreeform.json. This is a RATCHET: a cell that passes must
// keep passing, and a cell that starts passing updates the baseline in the same
// commit. A failing cell must refuse with a MoveFaceRefusal whose diagnosis the
// test completes with the full rung catalog, so a red cell says which rung
// could have grown the neighbour and why it did not.
//
// Every passing cell also passes the validation gate: one sound solid, the
// first-order volume oracle (area * d within 5%), a cap face on the target
// surface, and a naming source for every grown neighbour (the extension map's
// neighbour carries a live face UUID). The volume oracle itself runs inside
// applyMoveFace for these moves; this test re-reads it so the matrix owns the
// number it ratchets.
//
// Baseline: 6 of 20 cells. Pick 1 (slot floor) passes outward because the
// widened patch is rejected by BRepCheck and the G1 strip bounds the add; its
// inward cut merges with the material outside the slot at the fillet's tangent
// footprint and the gate refuses. Pick 2 (left wall) is tangent-bounded: its
// only neighbours are the plane-sphere fillet and the floor, and every
// extension of a tangent surface leaves a kink, so rung T (move the tangent
// chain as one set) would be needed. Pick 3 (right wall, chamfered) passes both
// signs. Picks 4 and 5 are B-spline faces themselves: moving a freeform picked
// face needs the offset-surface slab, which is not in this build.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fixture from './fixtures/moveFaceFreeform.json'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { DisposeScope, withTransientScope } from '../disposeScope'
import { readBodyNames } from '../bodyNames'
import { applyMoveFace, MoveFaceRefusal } from '../moveFace'
import { faceArea } from '../primitives'
import { volumeForMeasure } from '../volume'
import { rungCatalog } from '../moveFaceRungs'
import { makeFaceIndexCache, resolveFacesByQuery } from '../../features/shared/faceResolution'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

const BODY = 'body_ESrRWmJlIltOOJE-A1VbLhzR'
const CHAMFER_ID = 'BeXVLtIhoq94L87Qll4xewnr'
const MOVED_ID = 'cHBOnYil8ViF7HhF_DAmiu3T'

type CellResult = 'pass' | 'fail'

/** The committed baseline. Update a cell in the same commit that makes it pass
 *  (and review why it was failing), never to silence a red run. */
const BASELINE: Record<string, CellResult> = {
  '1/+0.5': 'pass',
  '1/-0.5': 'fail',
  '1/+1': 'pass',
  '1/-1': 'fail',
  '2/+0.5': 'fail',
  '2/-0.5': 'fail',
  '2/+1': 'fail',
  '2/-1': 'fail',
  '3/+0.5': 'pass',
  '3/-0.5': 'pass',
  '3/+1': 'pass',
  '3/-1': 'pass',
  '4/+0.5': 'fail',
  '4/-0.5': 'fail',
  '4/+1': 'fail',
  '4/-1': 'fail',
  '5/+0.5': 'fail',
  '5/-0.5': 'fail',
  '5/+1': 'fail',
  '5/-1': 'fail',
}

const D_VALUES = [0.5, -0.5, 1, -1] as const

/** The number of solids in a shape (a shape split into siblings is invalid as
 *  one body). */
function solidCount(occ: OccModule, scope: DisposeScope, shape: OccShape): number {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_SOLID, E.TopAbs_SHAPE))
  let n = 0
  for (; exp.More(); exp.Next()) n++
  return n
}

describe.skipIf(!oc || !solveBytes || !topologyBytes)('move face across freeform neighbours: pass matrix', () => {
  if (!oc || !solveBytes || !topologyBytes) return
  const occ = oc
  const h = new SharedHarness(occ)
  let body: Body
  let live: DisposeScope
  let shape: OccShape
  let faces: OccShape[]

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
    const features = fixture.features as Record<string, unknown>[]
    const last = features.findIndex((f) => f.id === MOVED_ID)
    const result = h.run({ features: features.slice(0, last), part_style: fixture.part_style })
    const snapshot = result._build_state.checkpoints[CHAMFER_ID]?.body_store_snapshot?.[BODY]
    if (!snapshot) throw new Error('the matrix document has no body after the chamfer')
    body = snapshot
    live = new DisposeScope()
    const index = makeFaceIndexCache(occ, live, h.table)(body)
    const resolved = resolveFacesByQuery(
      occ, live, h.table, body, index,
      (fixture.picks as { query: string }[]).map((p) => p.query),
    )
    faces = (fixture.picks as { query: string }[]).map((p) => {
      const face = resolved.get(p.query)
      if (!face) throw new Error(`pick did not resolve: ${p.query}`)
      return face
    })
    shape = h.table.get<OccShape>(body.shape!)
  })

  afterAll(() => live?.dispose())

  for (let pick = 1; pick <= 5; pick++) {
    for (const d of D_VALUES) {
      const cell = `${pick}/${d > 0 ? '+' : ''}${d}`
      const expected = BASELINE[cell]
      it(`${cell} is ${expected}`, () => {
        const before = volumeForMeasure(occ, live, shape)
        let result: { capCount: number; extensions: number } | null = null
        let refusal: MoveFaceRefusal | null = null
        try {
          result = withTransientScope((scope) => {
            const res = applyMoveFace(occ, scope, shape, faces[pick - 1], d)
            const names = readBodyNames(occ, scope, shape, body)
            let extensions = 0
            for (const [, neighbour] of res.cells.extensionOf.entries()) {
              expect(names.faceNames.get(neighbour as OccSubShape)).toBeTruthy()
              extensions++
            }
            const area = faceArea(occ, scope, faces[pick - 1])
            const got = volumeForMeasure(occ, scope, res.shape) - before
            const want = area * d
            if (Math.abs(got - want) > 0.05 * Math.abs(want)) {
              throw new MoveFaceRefusal(
                `move_face: volume ${got.toFixed(3)} is outside the first-order oracle ${want.toFixed(3)}`,
              )
            }
            expect(solidCount(occ, scope, res.shape)).toBe(1)
            return { capCount: res.cells.capFaces.length, extensions }
          })
        } catch (e) {
          if (e instanceof MoveFaceRefusal) refusal = e
          else throw e
        }
        if (expected === 'pass') {
          if (refusal !== null) {
            throw new Error(
              `cell ${cell} regressed: ${refusal.message}\n` +
              `rungs tried: ${rungCatalog(occ)}`,
            )
          }
          expect(result).not.toBeNull()
          expect(result!.capCount).toBeGreaterThan(0)
          expect(result!.extensions).toBeGreaterThan(0)
        } else {
          expect(result, `cell ${cell} now passes: update the baseline in the same commit`).toBeNull()
          expect(refusal).toBeInstanceOf(MoveFaceRefusal)
          // Name every rung for a red cell, even when the refusal is a guard
          // that stopped before any extension.
          expect(
            `${refusal!.message} | rungs: ${rungCatalog(occ)}`,
            `cell ${cell} must name every rung`,
          ).toMatch(/rung 1.*rung 2.*rung 3.*rung 4/s)
        }
      }, 300_000)
    }
  }
})
