// @vitest-environment node
//
// The reported end-to-end defect at the feature level: one picked rim edge of
// the sphere-minus-slot must build ONE fillet face and ONE chamfer face, with no
// "continue along the tangent chain" note, and the stored picks must resolve.
//
// It builds the checked-in regression document
// (`regressions/sphere-slot-seam-split`), which stores the picks a user would
// set today; the kernel folds each split rim back into one edge before the
// modifier reads it.

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { solveLocally, setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { partSpecFromText } from '@/utils/partExport'
import { selectByPredicate } from '@/kernel/select/select'
import type { FeaturePartsResult, PartResult } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

const FILLET = 'ZlL7SEuteb9Fc2bVVZWzVK_9'
const CHAMFER = 'u3HOk8NICNMY8q6r6SftohCS'
const RECIPE = new URL('../../../../regressions/sphere-slot-seam-split/recipe.yaml', import.meta.url)

describe.skipIf(!oc || !solveBytes)('the re-seated seam at the blend level', () => {
  let response: Awaited<ReturnType<typeof solveLocally>> = null

  // Built on first use, not in `beforeAll`: the suite's `beforeEach` installs
  // the Rust topology loader, and a solve in `beforeAll` runs before it.
  async function build() {
    if (response !== null) return response
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    response = await solveLocally(partSpecFromText(readFileSync(RECIPE, 'utf8')))
    return response
  }

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  function parts(res: Awaited<ReturnType<typeof solveLocally>>): Record<string, PartResult> {
    return res!.bodies as unknown as Record<string, PartResult>
  }

  it('builds one face per modifier pick and no tangent-chain note', async () => {
    const res = await build()
    for (const id of [FILLET, CHAMFER]) {
      const row = res!.result[id] as unknown as FeaturePartsResult
      expect(row, id).toBeDefined()
      expect(row.status, `${id}: ${row.exception ?? ''}`).toBe('ok')
      // The old defect: the pick's half plus its tangent continuation, reported
      // as two edges blended.
      expect(row.solver_note ?? '', id).not.toMatch(/tangent chain/)
      expect(row.unresolved_edges ?? [], id).toEqual([])
      expect(row.failed_edges ?? [], id).toEqual([])
    }
  })

  it('select by created_by finds exactly one fillet face and one chamfer face', async () => {
    const res = await build()
    const bodyId = (res!.result[FILLET] as unknown as FeaturePartsResult).body_id!
    for (const id of [FILLET, CHAMFER]) {
      const picked = selectByPredicate(
        { from: bodyId, kind: 'face', where: { created_by: id } },
        parts(res),
      )
      expect(picked.queries, id).toHaveLength(1)
    }
  })

  it('the body has the folded topology and one seam on the sphere face', async () => {
    const res = await build()
    const bodyId = (res!.result[FILLET] as unknown as FeaturePartsResult).body_id!
    const body = parts(res)[bodyId]
    const faceQueries = body.mesh?.face_queries ?? []
    const seams = body.mesh?.face_seam_queries ?? []
    expect(faceQueries).toHaveLength(6)
    expect(body.edge_queries).toHaveLength(17)

    const sphereIndex = faceQueries.findIndex((q) => q.endsWith(':sphereface'))
    expect(sphereIndex).toBeGreaterThanOrEqual(0)
    // One seam, not the two pieces the slot used to cut it into. It keeps a
    // construction UUID of its own (the `@u|e_...` token), so a stored seam
    // pick still resolves.
    expect(seams[sphereIndex]).toHaveLength(1)
    expect(seams[sphereIndex][0]).toMatch(/@u\|e_[0-9a-f]+/)
  })
})
