// Regenerate the action-matrix baseline (src/testing/actionMatrix/baseline.json).
// Runs the full sweep, with the real kernel when OCC.js and the Rust solver are
// provisioned (the fake scheduler otherwise; a command's status cannot depend
// on the scheduler, but the real run also exercises every solve path) and
// writes the rows one per line for review.
//
// Run from frontend/:
//   npm run regen:action-matrix
// Then review the git diff: every moved row is a command whose behavior on a
// document, target or command changed.
//
// vite-node is the runner (not the strip-types loader regenCorpus uses) because
// the command table reads import.meta.env, which plain Node does not define.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '@/kernel/features/sketch'
import { createRealSolveScheduler } from '@/hooks/__tests__/realSolveScheduler'
import { serializeBaseline } from '@/testing/actionMatrix/baseline'
import { corpusDocs, FULL_MAX_TARGETS } from '@/testing/actionMatrix/corpus'
import { PART_COMMANDS, fakeMatrixSolver, runMatrix, type MatrixSolver } from '@/testing/actionMatrix/runner'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = path.resolve(__dirname, '../src/testing/actionMatrix/baseline.json')

const oc = await loadOcc()
const solveBytes = loadSolver()
const useReal = !!oc && !!solveBytes
if (useReal) {
  resetSketchSolver()
  setSketchSolver(solveBytes)
  // The same wiring src/test-setup.ts installs for the suites: the Rust
  // topology builder, not the TS fallback, so the sweep solves what the tests
  // solve.
  setSketchTopology(loadTopology())
}

console.log(`[regen] full sweep with the ${useReal ? 'real kernel' : 'fake scheduler'}`)
const sweep = { docs: corpusDocs(), maxTargetsPerDoc: FULL_MAX_TARGETS }
const started = Date.now()
const rows = await runMatrix(sweep, {
  createSolver: (): MatrixSolver => useReal
    ? { scheduler: createRealSolveScheduler(), settle: () => undefined }
    : fakeMatrixSolver(),
  onDocStart: async (doc) => {
    if (useReal) setSolveLocalsForTest(async () => oc)
    console.log(`[regen] ${doc.label}`)
  },
})
if (useReal) {
  setSolveLocalsForTest(null)
  resetSketchSolver()
}

const baseline = serializeBaseline(rows, {
  docs: sweep.docs.length,
  maxTargetsPerDoc: sweep.maxTargetsPerDoc,
  commands: PART_COMMANDS.length,
})
writeFileSync(BASELINE_PATH, baseline)
console.log(`[regen] wrote ${rows.length} rows to ${path.relative(path.resolve(__dirname, '..'), BASELINE_PATH)} in ${Date.now() - started} ms`)
