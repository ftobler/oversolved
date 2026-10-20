// @vitest-environment node
//
// The translation corpus against the real kernel: build each case through
// measureLocally (the compareHeadless path), compare against its reference at
// the reference's tolerance, and prove a perturbed reference fails on the
// measure that moved. Skips when OCC.js or the Rust sketch solver is absent;
// under a KERNEL_PROVISIONED job the guard turns that skip into a failure.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { listTranslationCases, type TranslationCase } from '../corpus'
import { runTranslationCase } from '../run'

const oc = await loadOcc()
const solveBytes = loadSolver()
const cases = listTranslationCases()

const provisionedJob = !!process.env.KERNEL_PROVISIONED

function rowsText(run: Awaited<ReturnType<typeof runTranslationCase>>): string {
  return run.rows
    .map((row) => `${row.measure}: ours=${JSON.stringify(row.ours)} theirs=${JSON.stringify(row.theirs)} within=${row.within} enforced=${row.enforced}`)
    .join('; ')
}

describe('translations provisioning guard', () => {
  it.runIf(provisionedJob)('has the kernel provisioning the corpus needs', () => {
    expect(oc, 'oc: OCC.js absent - run `npm run occ:install` or `just install-occ`').toBeTruthy()
    expect(solveBytes, 'solveBytes: Rust sketch solver WASM absent - run `just wasm`').toBeTruthy()
  })

  it('has the seed case', () => {
    expect(cases.map((c) => c.name)).toContain('01-cylinder')
  })
})

const ready = oc !== null && solveBytes !== null

describe.skipIf(!ready)('translation corpus (real OCC)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  for (const translationCase of cases) {
    it(translationCase.name, { timeout: 120_000 }, async () => {
      const run = await runTranslationCase(translationCase)
      expect(run.pass, rowsText(run)).toBe(true)
      expect(run.measures.bodies).toBe(translationCase.reference.bodies)
    })
  }

  it('fails only the volume row when the reference volume moves by 1e-3 relative', async () => {
    const seed = cases.find((c) => c.name === '01-cylinder') as TranslationCase
    const perturbed: TranslationCase = {
      ...seed,
      reference: { ...seed.reference, volume: seed.reference.volume * (1 + 1e-3) },
    }
    const run = await runTranslationCase(perturbed)
    expect(run.pass).toBe(false)
    const volume = run.rows.find((row) => row.measure === 'volume')
    expect(volume).toMatchObject({ within: false, enforced: true })
    for (const row of run.rows) {
      if (row.measure === 'volume') continue
      expect(row.within, `${row.measure}: ${rowsText(run)}`).toBe(true)
    }
  })
})
