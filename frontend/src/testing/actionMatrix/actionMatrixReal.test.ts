// @vitest-environment node
//
// The action matrix against the real kernel: the same rows as the fake-suite
// smoke gate, replayed through solveLocally so every command's mutation goes
// through the actual OCC + Rust pipeline. A command's status cannot depend on
// the scheduler (it is decided by the registry and the session result), so the
// same committed baseline compares both ways; a kernel crash surfaces as a
// thrown solve error, not a row.
//
// With ACTION_MATRIX_FULL=1 this file also replays the whole corpus sweep
// (`just action-matrix`, the main gate): the real kernel where installed, the
// fake scheduler otherwise, always compared exactly against the baseline so a
// vanished row or a new command fails rather than being silently skipped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { createRealSolveScheduler } from '@/hooks/__tests__/realSolveScheduler'
import baselineFile from './baseline.json'
import { compareMatrix, toBaselineRows, type MatrixBaselineFile } from './baseline'
import { corpusDocs, REAL_SMOKE_DOC_LABELS, SMOKE_MAX_TARGETS, FULL_MAX_TARGETS, type CorpusDoc } from './corpus'
import { expectedBaselineRows, fakeMatrixSolver, runMatrix, type MatrixSolver, type MatrixSweep } from './runner'

const oc = await loadOcc()
const solveBytes = loadSolver()
const full = process.env.ACTION_MATRIX_FULL === '1'
const baselineRows = toBaselineRows((baselineFile as MatrixBaselineFile).rows)

function realSolver(): MatrixSolver {
  return { scheduler: createRealSolveScheduler(), settle: () => undefined }
}

function smokeSweep(): MatrixSweep {
  const all = corpusDocs()
  const docs: CorpusDoc[] = REAL_SMOKE_DOC_LABELS.map(label => {
    const doc = all.find(entry => entry.label === label)
    if (!doc) throw new Error(`smoke doc '${label}' is not in the corpus`)
    return doc
  })
  return { docs, maxTargetsPerDoc: SMOKE_MAX_TARGETS }
}

describe.skipIf(!oc || !solveBytes)('the action-matrix smoke gate (real kernel)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('replays the smoke slice without a deviation', { timeout: 300_000 }, async () => {
    const sweep = smokeSweep()
    expect(baselineRows.length, 'baseline is empty; run npm run regen:action-matrix').toBeGreaterThan(0)
    const current = await runMatrix(sweep, {
      createSolver: realSolver,
      // Each document starts from a cold cross-solve cache; the docs carry no
      // id of their own, so solveLocally's own switch guard would never fire.
      onDocStart: async () => { setSolveLocalsForTest(async () => oc) },
    })
    const expected = expectedBaselineRows(sweep, baselineRows)
    expect(expected.length).toBe(current.length)
    expect(compareMatrix(expected, current)).toEqual([])
  })
})

// One test per document: the sweep is minutes long, so per-document tests keep
// each unit bounded, give per-document failure output, and let the worker's
// event loop breathe between them (a single 10-minute test starved vitest's
// worker RPC and ended the run with an unhandled onTaskUpdate timeout).
describe.runIf(full)('the action-matrix full sweep', () => {
  const useReal = !!oc && !!solveBytes

  beforeAll(() => {
    if (useReal) {
      resetSketchSolver()
      setSketchSolver(solveBytes)
    }
    console.log(`[action-matrix] full sweep over ${corpusDocs().length} documents with the ${useReal ? 'real kernel' : 'fake scheduler'}`)
  })

  afterAll(() => setSolveLocalsForTest(null))

  it.each(corpusDocs().map(doc => [doc.label, doc] as const))(
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
