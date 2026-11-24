// @vitest-environment node
//
// The report case end to end, plus the scripted fix the plan prescribes:
// bugreports/20261123_2307_solver_accuracy.md. The sketch is fully constrained
// with a dimension at the inner arc's extreme, so it ships tilted 0.044 deg and
// `extrude 2` follows the tilted cap face. The corpus case
// (regressions/arc-extreme-x-dimension) pins the document as exported; this
// suite pins the warnings and the scripted repair:
//   delete the x distance, add `vertical` on the inner leg,
//   the weak warning and the merge-ceiling warning are gone, and extrude 2
//   still adds exactly 10.
//
// Runs against the real node wasm; skips when the gitignored builds are absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { buildAndMeasureLocally, setSolveLocalsForTest } from '@/kernel/solveLocally'
import { runHeadless } from '@/drive/headlessOps'
import { partSpecFromText } from '@/utils/partExport'

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()
const ready = oc !== null && solveBytes !== null

const RECIPE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'regressions',
  'arc-extreme-x-dimension',
  'recipe.yaml',
)
const SKETCH = 'sk1'
const SECOND = 'xUH6HOpLrnzoUULH0yU7HhLL'
const X_DIM = 'c_point_distance_x_OJPy7uYJ'
const INNER_LEG = 'eFnI-hQ5yVyNef-9'
// The quarter annulus (pi * 5 / 4) plus the two 7 x 1 arms, extruded 1, plus
// the 1 x 10 bar. Tilted, the arcs sweep 90 + 0.044038 deg: the sector adds
// (r2^2 - r1^2) / 2 * theta = 2.5 * 7.686e-4, which is the 0.0019 difference.
const FIXED_VOLUME = 27.92699081698724
const TILTED_VOLUME = 27.928904424438503

function recipeDoc(): PartDoc {
  return partSpecFromText(readFileSync(RECIPE, 'utf8')) as unknown as PartDoc
}

function withoutSecondExtrude(doc: PartDoc): PartDoc {
  return { ...doc, features: (doc.features ?? []).filter(feature => feature.id !== SECOND) }
}

async function volumeOf(doc: PartDoc): Promise<number> {
  const built = await buildAndMeasureLocally(doc as unknown as Record<string, unknown>)
  expect(built).not.toBeNull()
  return built!.measures.volume
}

/** extrude 2 adds the cap face's 1x1 face over distance 10. The delta is a
 *  difference of two OCC volume reads, whose integration error on these
 *  cylindrical solids measures ~1.5e-7 relative, so that is the width here; the
 *  plan's 1e-9 would be below the read's own noise. */
async function expectSecondExtrudeAddsTen(doc: PartDoc): Promise<void> {
  const withSecond = await volumeOf(doc)
  const without = await volumeOf(withoutSecondExtrude(doc))
  expect(Math.abs(withSecond - without - 10) / 10).toBeLessThanOrEqual(1e-6)
}

describe.skipIf(!ready)('an x distance at the arc extreme is named, and the scripted fix clears it', () => {
  beforeAll(() => {
    setSolveLocalsForTest(async () => oc)
    setSketchSolver(solveBytes ?? null)
    setSketchTopology(topologyBytes)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    setSketchSolver(null)
    setSketchTopology(null)
  })

  it('names the weak dimension and points the ceiling warning at the sketch', { timeout: 240_000 }, async () => {
    const doc = recipeDoc()
    const run = await runHeadless({ doc, steps: [] })
    expect(run.solve.lastError).toBeNull()
    // A warning row does not fail the run.
    expect(run.ok).toBe(true)

    const sketch = run.features.find(problem => problem.id === SKETCH)
    // The verdict itself is the bug: fully constrained and tilted.
    expect(sketch?.status).toBe('fully_constrained')
    // The weak warning names the dimension by kind and value, never by id.
    expect(sketch?.message).toContain('x distance 2 holds the profile only at the arc')
    expect(sketch?.message).toContain('can rotate by up to')
    expect(sketch?.message).not.toContain(X_DIM)
    expect(sketch?.message).not.toMatch(/[A-Za-z0-9_-]{16,}/)
    expect(sketch?.weak).toEqual([{ constraintId: X_DIM, moveEstimate: expect.any(Number) }])

    // The downstream merge ceiling still warns (the rows only close to ~1e-8
    // rad around the tilt), and now points at the sketch's own warning.
    const second = run.features.find(problem => problem.id === SECOND)
    expect(second?.message).toContain('merge ceiling')
    expect(second?.message).toMatch(/see the warning on sketch (\d+|'[^']+')/)
    expect(second?.message).not.toContain(SKETCH)

    // The second extrude follows the tilted cap face, and its volume is the
    // cap face's 1x1 over 10, whatever the tilt.
    await expectSecondExtrudeAddsTen(doc)
    expect(Math.abs(await volumeOf(doc) - TILTED_VOLUME)).toBeLessThanOrEqual(1e-6 * TILTED_VOLUME)
  })

  it('the scripted fix (delete the dimension, add vertical) clears both warnings', { timeout: 240_000 }, async () => {
    const fixed = await runHeadless({
      doc: recipeDoc(),
      steps: [
        { mutation: { type: 'delete', targets: [`constraint:${SKETCH}:${X_DIM}`] } },
        {
          mutation: {
            type: 'add_constraint',
            featureId: SKETCH,
            kind: 'vertical',
            targets: [`$${INNER_LEG}`],
          },
        },
      ],
    })
    expect(fixed.outcome.ok).toBe(true)
    expect(fixed.solve.lastError).toBeNull()
    expect(fixed.doc).not.toBeNull()

    // Neither the weak warning nor the merge-ceiling warning survives; the
    // sketch is a clean, fully constrained solve.
    expect(fixed.features).toEqual([])

    // The repair does not change the solid: the profile is the same shape,
    // straightened, so extrude 2 still adds exactly 10.
    const doc = fixed.doc as PartDoc
    await expectSecondExtrudeAddsTen(doc)
    expect(Math.abs(await volumeOf(doc) - FIXED_VOLUME)).toBeLessThanOrEqual(1e-6 * FIXED_VOLUME)
  })
})
