// @vitest-environment node
//
// The regression corpus against the real kernel: one `it` per case. Each case
// is built once (`buildAndMeasureLocally`), its per-feature statuses, measures
// and optional per-body snapshot are compared with `checks.json`, and a failure
// names the row as `<case>/<check>: ours=... expected=...`.
//
// Same guard as every *Real suite: skips when OCC.js or the pkg-node solver is
// absent, fails a KERNEL_PROVISIONED job instead, and skips on Node < 22.6 (the
// leg that cannot run the kernel pipeline). A `severity: soft` case warns;
// `REGRESSION_SOFT=1` downgrades every case the same way.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { partSpecFromText } from '@/utils/partExport'
import { listRegressionCases, type RegressionCase } from '../corpus'
import {
  issueLines,
  recipeFeatureIds,
  regressionFailureIsSoft,
  runRegressionCase,
  type RegressionBuild,
} from '../run'

const oc = await loadOcc()
const solveBytes = loadSolver()
const cases = listRegressionCases()

// The solve child and the Node entries rely on --experimental-strip-types; the
// package still allows Node 20, where the corpus cannot build at all.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
const provisionedJob = !!process.env.KERNEL_PROVISIONED
const softAll = process.env.REGRESSION_SOFT === '1'

describe('regressions provisioning guard', () => {
  it.runIf(provisionedJob)('has the kernel provisioning the corpus needs', () => {
    expect(oc, 'oc: OCC.js absent - run `npm run occ:install` or `just install-occ`').toBeTruthy()
    expect(solveBytes, 'solveBytes: Rust sketch solver WASM absent - run `just wasm`').toBeTruthy()
    expect(stripTypes, 'Node < 22.6 cannot run the kernel pipeline').toBe(true)
  })

  it('has a case to build', () => {
    expect(cases.length).toBeGreaterThan(0)
  })
})

const ready = oc !== null && solveBytes !== null && stripTypes

function copyWith(c: RegressionCase, checks: RegressionCase['checks']): RegressionCase {
  return { ...c, checks }
}

function featureWithExpected(run: RegressionBuild, featureIds: readonly string[], status: string): string | undefined {
  return featureIds.find((id) => run.statuses[id] === status)
}

describe.skipIf(!ready)('regression corpus (real OCC)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  for (const regressionCase of cases) {
    it(regressionCase.name, { timeout: 120_000 }, async () => {
      const run = await runRegressionCase(regressionCase)
      const lines = issueLines(regressionCase.name, run.issues)
      if (lines.length === 0) return
      const message = lines.join('\n')
      if (regressionFailureIsSoft(regressionCase.checks.severity, softAll)) {
        console.warn(`[regression] ${regressionCase.name} (${regressionCase.checks.severity}):\n${message}`)
        return
      }
      expect(lines, message).toEqual([])
    })
  }

  it('fails on the volume row when a case volume moves by 1%', async () => {
    const seed = cases.find((c) => c.name === 'two-rings') as RegressionCase
    const expected = seed.checks.measures.volume
    expect(expected, 'two-rings must pin a volume').toBeDefined()
    const shifted = copyWith(seed, {
      ...seed.checks,
      measures: { ...seed.checks.measures, volume: (expected as number) * 1.01 },
    })
    const run = await runRegressionCase(shifted)
    expect(run.pass).toBe(false)
    expect(run.issues.map((issue) => issue.check)).toContain('volume')
    // The snapshot is unchanged by the shift, so the failure is the moved
    // measure and not a muddy second signal.
    expect(run.issues.every((issue) => issue.check === 'volume')).toBe(true)
  })

  it('pins a known exception: it passes while the feature errors', async () => {
    // two-rings pins its legacy `origin`/`plane` features as exceptions. The
    // ordinary case test already proves the pass; assert the pin explicitly so
    // a change that starts reporting `ok` is the failure this test describes.
    const pinned = cases.find((c) => c.name === 'two-rings') as RegressionCase
    const except = pinned.checks.features.except ?? {}
    const id = Object.keys(except).find((featureId) => except[featureId] === 'exception')
    expect(id, 'two-rings must pin an expected exception').toBeDefined()
    const run = await runRegressionCase(pinned)
    expect(run.statuses[id as string]).not.toBe('ok')
    expect(run.issues.map((issue) => issue.check)).not.toContain(`features/${id}`)
  })

  it('fails when a feature pinned as exception starts succeeding', async () => {
    const seed = cases.find((c) => c.name === 'two-rings') as RegressionCase
    const doc = partSpecFromText(seed.recipe)
    const featureIds = recipeFeatureIds(doc)
    const build = await runRegressionCase(seed)
    const okId = featureWithExpected(build, featureIds, 'ok')
    expect(okId, 'two-rings must have a feature that solves ok').toBeDefined()
    const pinned = copyWith(seed, {
      ...seed.checks,
      features: {
        ...seed.checks.features,
        except: { ...(seed.checks.features.except ?? {}), [okId as string]: 'exception' },
      },
    })
    const run = await runRegressionCase(pinned)
    expect(run.pass).toBe(false)
    expect(run.issues.map((issue) => issue.check)).toContain(`features/${okId}`)
  })
})
