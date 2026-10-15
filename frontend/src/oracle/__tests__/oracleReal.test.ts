// @vitest-environment node
//
// The reference-oracle suite: builds every case in `frontend/oracle/` through
// the real loader and kernel, measures volume/area/centroid/bbox with OCC
// GProp and Bnd_Box, round-trips the part through STEP and re-measures, and
// compares against the closed-form values in each expected.json with the
// shared 1e-6 comparator (occ/measureTolerance.ts). Cases with an `edit`
// block additionally edit an upstream dimension, rebuild, and assert the
// downstream feature still lands on the same faces (counts and measures).
//
// The suite is also the report generator: the final test renders docs/oracle.md
// from the run and fails when the committed file is stale, like
// commandDocs.test.ts. Regenerate with `npm run docs:oracle`. Skips when
// OCC.js is absent, like every *Real suite; under a KERNEL_PROVISIONED job the
// guard below turns that skip into a failure.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { ORACLE_DOC_PATH, listOracleCases, type OracleCase } from '../corpus'
import { runOracleCase, type CaseRun } from '../run'
import { renderOracleReport, type CaseReport } from '../report'
import type { OccModule } from '@/kernel/occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()
const cases = listOracleCases()

// Set only by the CI jobs that provision OCC.js and the WASM builds; see
// KERNEL_PROVISIONED in ci-github.yaml / ci-gitea.yaml.
const provisionedJob = !!process.env.KERNEL_PROVISIONED
const UPDATE = process.env.UPDATE_ORACLE_DOCS === '1'

// One case is a full document build plus a STEP write/read and a fresh edited
// rebuild; the local default (5 s) is far too tight and the CI timeout sits in
// the same range, so every case carries its own allowance.
const CASE_TIMEOUT_MS = 120_000

function toReport(oracleCase: OracleCase, run: CaseRun): CaseReport {
  return {
    name: oracleCase.name,
    expected: oracleCase.expected,
    live: run.live,
    step: run.step,
    edited: run.edited === null ? null : { live: run.edited.measures, step: run.edited.stepMeasures },
    ok: run.issues.length === 0,
  }
}

describe('oracle provisioning guard', () => {
  // A KERNEL_PROVISIONED job installs OCC.js and the Rust WASM builds, so a
  // skip there is a broken job, not a convenience. Locally an unprovisioned
  // checkout skips the suite, like every *Real suite.
  it.runIf(provisionedJob)('has the kernel provisioning the corpus needs', () => {
    expect(oc, 'oc: OCC.js absent - run `npm run occ:install` or `just install-occ`').toBeTruthy()
    expect(solveBytes, 'solveBytes: Rust sketch solver WASM absent - run `just wasm`').toBeTruthy()
  })

  it('has at least 30 analytic cases', () => {
    expect(cases.length, 'the oracle corpus lost cases').toBeGreaterThanOrEqual(30)
  })
})

const ready = oc !== null && solveBytes !== null
const reports: CaseReport[] = []

describe.skipIf(!ready)('reference oracle (real OCC)', () => {
  let occ: OccModule

  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards the suite')
    occ = oc
    resetSketchSolver()
    setSketchSolver(solveBytes)
    // Drive the production solve entry with the node-loaded OCC module.
    setSolveLocalsForTest(async () => oc)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  for (const oracleCase of cases) {
    it(
      oracleCase.name,
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const run = await runOracleCase(occ, oracleCase)
        reports.push(toReport(oracleCase, run))
        expect(run.issues, run.issues.join('; ')).toEqual([])
      },
    )
  }

  it(
    'docs/oracle.md matches the run',
    { timeout: 30_000 },
    () => {
      // A case that crashed before pushing leaves the report short, and a
      // shortened report must not be compared or written as if complete.
      expect(reports).toHaveLength(cases.length)
      const rendered = renderOracleReport(reports)
      if (UPDATE) {
        expect(reports.every((r) => r.ok), 'refusing to write a failing report').toBe(true)
        writeFileSync(ORACLE_DOC_PATH, rendered)
      }
      expect(readFileSync(ORACLE_DOC_PATH, 'utf8')).toBe(rendered)
    },
  )
})
