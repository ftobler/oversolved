// @vitest-environment node
//
// The 2026-11-22 move-face regression through the drive path. The report
// document stores four live side-wall UUIDs and a legacy bottom-cap UUID; the
// user opened it, saw a silently wrong body and no warning. An empty script is
// the "inspect this document" run: it must settle the stored document cleanly
// and measure the 23 x 39 x 29 box (26013 mm3, 6 faces, 12 edges).
//
// Real kernel, gated like the other drive suites.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runHeadless } from '../headlessOps'
import { nonSketchProblems } from './buildProblems'
import { loadPartDocText } from '@/persistence/docSchema'
import type { PartDoc } from '@/types/cad'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const MOVE_ID = 'Pqa8cKOIZ02jshDxVx8typkI'
const PART_ID = 'body_ItndFzj0p5ptXDPqsLWTaKPm'

const RECIPE = readFileSync(
  join(process.cwd(), 'regressions', 'move-face-legacy-cap', 'recipe.yaml'),
  'utf8',
)

describe.skipIf(!ready)('move-face legacy cap drive path (real OCC + Rust solver)', () => {
  it('an empty script settles the stored report document into the 26013 box', async () => {
    const loaded = loadPartDocText(RECIPE)
    if (!loaded.ok) throw new Error(`the report recipe did not load: ${loaded.error.field}`)
    const result = await runHeadless({ doc: loaded.doc as PartDoc, steps: [] })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.bodies).toEqual([PART_ID])
    const measures = await result.part.featureMeasures()
    const row = measures?.find((entry) => entry.id === MOVE_ID)
    expect(row, 'the move_face checkpoint is measured').toBeDefined()
    expect(row!.volume).toBeCloseTo(26013, 4)
    const part = row!.parts?.[PART_ID]
    expect(part?.faces).toBe(6)
    expect(part?.edges).toBe(12)
  }, 120000)
})
