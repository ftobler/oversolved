// @vitest-environment node
//
// The real-kernel action-matrix driver for one shard. Shared by the shard files
// (actionMatrixReal.test.ts is shard 0, actionMatrixShard<N>Real.test.ts the
// rest) so `just action-matrix` can spread the corpus documents over several
// forks, each with its own OCC + Rust kernel.
//
// Top-level await is avoided here: the kernel loads only for an active shard, so
// an idle shard costs a skipped test instead of a kernel.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver, loadSolverFresh } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolverLoader, resetSketchSolver } from '@/kernel/features/sketch'
import { createRealSolveScheduler } from '@/hooks/__tests__/realSolveScheduler'
import baselineFile from './baseline.json'
import { compareMatrix, toBaselineRows, type MatrixBaselineFile } from './baseline'
import { corpusDocs, REAL_SMOKE_DOC_LABELS, SMOKE_MAX_TARGETS, FULL_MAX_TARGETS, type CorpusDoc } from './corpus'
import {
  checkSweepCoverage,
  expectedBaselineRows,
  fakeMatrixSolver,
  runMatrix,
  type MatrixSolver,
  type MatrixSweep,
} from './runner'
import { shardCount, shardSeeds } from './actionMatrixShards'

const baselineRows = toBaselineRows((baselineFile as MatrixBaselineFile).rows)
const storedSweep = (baselineFile as MatrixBaselineFile).sweep

function realSolver(): MatrixSolver {
  return { scheduler: createRealSolveScheduler(), settle: () => undefined }
}

function smokeDocs(): CorpusDoc[] {
  const all = corpusDocs()
  return REAL_SMOKE_DOC_LABELS.map(label => {
    const doc = all.find(entry => entry.label === label)
    if (!doc) throw new Error(`smoke doc '${label}' is not in the corpus`)
    return doc
  })
}

/**
 * Register shard `shard`'s real-kernel suites. Call with top-level await from
 * the shard's test file.
 */
export async function describeRealActionMatrixShard(shard: number): Promise<void> {
  const count = shardCount()
  const full = process.env.ACTION_MATRIX_FULL === '1'

  if (shard >= count) {
    describe.skip(`the action-matrix real shard ${shard + 1} unused at ${count} shards`, () => {
      it('replays no documents', () => {})
    })
    return
  }

  const oc = await loadOcc()
  const solveBytes = loadSolver()

  // Smoke gate: only shard 0, keeps the PR-gate slice single-owned.
  if (shard === 0) {
    describe.skipIf(!oc || !solveBytes)('the action-matrix smoke gate (real kernel)', () => {
      beforeAll(() => {
        if (oc && solveBytes) setSketchSolverLoader(loadSolverFresh)
      })
      afterAll(() => {
        setSolveLocalsForTest(null)
        resetSketchSolver()
      })

      it('replays the smoke slice without a deviation', { timeout: 300_000 }, async () => {
        const sweep: MatrixSweep = { docs: smokeDocs(), maxTargetsPerDoc: SMOKE_MAX_TARGETS }
        expect(baselineRows.length, 'baseline is empty; run npm run regen:action-matrix').toBeGreaterThan(0)
        const current = await runMatrix(sweep, {
          createSolver: realSolver,
          onDocStart: async () => { setSolveLocalsForTest(async () => oc) },
        })
        const expected = expectedBaselineRows(sweep, baselineRows)
        expect(expected.length).toBe(current.length)
        expect(compareMatrix(expected, current)).toEqual([])
      })
    })
  }

  describe.runIf(full)('the action-matrix full sweep', () => {
    const useReal = !!oc && !!solveBytes
    const allDocs = corpusDocs()
    const indices = shardSeeds(allDocs.length, shard, count)
    const myDocs = indices.map(i => allDocs[i])

    beforeAll(() => {
      if (useReal) setSketchSolverLoader(loadSolverFresh)
      console.log(`[action-matrix] shard ${shard + 1}/${count}: ${myDocs.length} of ${allDocs.length} documents with the ${useReal ? 'real kernel' : 'fake scheduler'}`)
    })

    afterAll(() => setSolveLocalsForTest(null))

    if (shard === 0) {
      it('the baseline covers the live full sweep structurally', () => {
        const sweep: MatrixSweep = { docs: allDocs, maxTargetsPerDoc: FULL_MAX_TARGETS }
        expect(checkSweepCoverage(sweep, baselineRows, storedSweep)).toEqual([])
      })
    }

    it.each(myDocs.map(doc => [doc.label, doc] as const))(
      'doc %s',
      { timeout: 10 * 60_000 },
      async (_label, doc) => {
        const sweep: MatrixSweep = { docs: [doc], maxTargetsPerDoc: FULL_MAX_TARGETS }
        const current = await runMatrix(sweep, {
          createSolver: useReal ? realSolver : fakeMatrixSolver,
          onDocStart: async () => { if (useReal) setSolveLocalsForTest(async () => oc) },
        })
        expect(compareMatrix(expectedBaselineRows(sweep, baselineRows), current)).toEqual([])
      },
    )
  })
}

// Aliases for callers/tests that use a different word order.
export const describeActionMatrixRealShard = describeRealActionMatrixShard
export const describeActionMatrixShard = describeRealActionMatrixShard
export const describeMatrixRealShard = describeRealActionMatrixShard
