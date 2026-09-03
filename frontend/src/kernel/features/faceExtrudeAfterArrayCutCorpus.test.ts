// @vitest-environment node
//
// Corpus regression for bugreports/20260902_2256_face_not_extruding.md.
//
// The user picked one of the pocket walls a circular array of cut tools left in
// the cylinder and extruded it; the feature failed, and whether it failed
// changed with the array count. The pick is a face of the SURVIVING body that
// inherited its construction UUID from the consumed tool body -- and the
// consumed body was still fully registered in the repo carrying that same UUID,
// so the resolver's UUID tier refused the pick with "collision by construction"
// instead of resolving it. The build loop now evicts a body that leaves the
// store mid-build (see clearConsumedBodyAncestry).
//
// The fixture is the bug-report AST verbatim, minus the origin/datum-plane
// features the builder supplies itself. Array count is varied around the
// reported value because the report ties the failure to it.
//
// Skips when OCC.js or the Rust solver is absent (mirrors the other real
// corpus tests).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import corpus from './__fixtures__/faceExtrudeAfterArrayCut.json'
const oc = await loadOcc()
const solveBytes = loadSolver()

// Identifiers preserved verbatim from the fixture.
const ARRAY = 'WlujpF0qBTE8m31DjT3ftNfT'
const CUT = 'WiX1LqiIKPCzclGQHqNuVK9_'
const FACE_EXTRUDE = 'U9r4BTz3QTVHLLlOe3PGl2BO'
const TARGET_BODY = 'body_n5fZFV21_P-zHwbXGC-I_BKG'

// The outward normal of the picked pocket wall (the `cls_zp` flat face on the
// cylinder body). The array rotates its instances, but the picked face is the
// one the source instance cut, so the normal is the same at every count -- an
// extrude that resolved a DIFFERENT pocket wall would push along a rotated
// normal and fail this. Compared to 6 decimals: the coordinates come from the
// Rust sketch solver's converged state, and the pocket walls are 72-180 degrees
// apart here, so 6 separates them with room for solver tolerances to move.
const PICKED_FACE_NORMAL = [-0.8214498774108969, 0.5702807193844297, 0]

function expectPickedWallExtrude(res: Record<string, unknown>): void {
  expect(res.exception ?? '').toBe('')
  expect(res.status).toBe('ok')
  expect(res.body_id).toBe(TARGET_BODY)

  // The editing handle pushes along the picked face's own normal, so it pins
  // WHICH face resolved, not just that something did.
  const handle = res.handle as { direction: number[] }
  expect(handle.direction[0]).toBeCloseTo(PICKED_FACE_NORMAL[0], 6)
  expect(handle.direction[1]).toBeCloseTo(PICKED_FACE_NORMAL[1], 6)
  expect(handle.direction[2]).toBeCloseTo(PICKED_FACE_NORMAL[2], 6)
}

function specWithCount(count: number): Record<string, unknown> {
  const spec = JSON.parse(JSON.stringify(corpus)) as Record<string, unknown>
  const features = spec.features as Array<Record<string, unknown>>
  const array = features.find(f => f.id === ARRAY)!
  ;(array.circular_array as Record<string, unknown>).count = count
  return spec
}

describe.skipIf(!oc || !solveBytes)('extrude a face left by an array cut (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  for (const count of [2, 3, 4, 5]) {
    it(`extrudes the picked pocket wall with ${count} array instances`, () => {
      const result = h.run(specWithCount(count))

      // Everything the pick depends on has to stand first, or a green extrude
      // below would be green for the wrong reason.
      expect(h.res(result, ARRAY).status).toBe('ok')
      expect(h.res(result, CUT).status).toBe('ok')

      expectPickedWallExtrude(h.res(result, FACE_EXTRUDE))
    })
  }

  it('resolves the same pick on an incremental rebuild off the clean prefix', () => {
    // The reported flow is adding the extrude to a document whose boolean is
    // already built, so the prefix is restored from the boolean's checkpoint and
    // the solve loop never re-runs its eviction. What the pick resolves against
    // is then the persisted `repo_snapshot` alone.
    const spec = specWithCount(3)
    const first = h.run(spec)
    expectPickedWallExtrude(h.res(first, FACE_EXTRUDE))

    const again = h.run(spec, { prevState: first._build_state })
    expectPickedWallExtrude(h.res(again, FACE_EXTRUDE))
  })
})
