// @vitest-environment node
//
// The compound draw tools must author a constraint set the solver reads as
// independent: a freshly drawn shape that already carries a flagged
// (superfluous) constraint shows up as "broken" the moment it lands. The
// center rectangle used to write a midpoint on BOTH diagonals; the rectangle
// is a parallelogram, whose diagonals bisect each other, so the second one
// was redundant and flagged (bugreports/20261107_1255_center_rectangle.md).
//
// Runs against the real node wasm; skips when the gitignored pkg-node build is
// absent (run `just wasm`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { initGlobalRepo } from '../../query'
import { emptyDriveDoc } from '@/drive/headlessOps'
import { applyAddSketch } from '@/utils/yamlMutations/featureAdmin'
import { applyAddRect, applyAddCenterRect, applyAddNgon } from '@/utils/yamlMutations/sketch'
import { featureById } from '@/testing/featureAccess'
import type { PartDoc } from '@/types/cad'

const solveBytes = loadSolver()

function sketchDoc(author: (doc: PartDoc) => void): PartDoc {
  const doc = emptyDriveDoc()
  applyAddSketch(doc, 'sk1', 'sketch 1', '@builtin_plane_top')
  author(doc)
  return doc
}

function solveSk1(doc: PartDoc) {
  const feature = featureById(doc, 'sk1', 'sketch')
  return solveSketch(feature as unknown as Record<string, unknown>, initGlobalRepo(), {})
}

const flagged = (out: ReturnType<typeof solveSk1>): string[] =>
  Object.entries(out.constraints ?? {})
    .filter(([, c]) => c.superfluous || c.culprit)
    .map(([id]) => id)

describe.skipIf(!solveBytes)('compound draw tools author no redundant constraint', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })
  afterAll(() => resetSketchSolver())

  it('a center rectangle pinned to the origin flags nothing', () => {
    // The report's exact gesture: center snapped onto the origin.
    const doc = sketchDoc((d) => applyAddCenterRect(d, 'sk1', [0, 0], [14.93, 24.66], '@builtin_origin'))
    const out = solveSk1(doc)
    expect(flagged(out)).toEqual([])
    expect(out.status).not.toBe('overconstrained')
  })

  it('a free center rectangle flags nothing and authors one diagonal midpoint', () => {
    const doc = sketchDoc((d) => applyAddCenterRect(d, 'sk1', [3, -2], [8, 5]))
    expect(flagged(solveSk1(doc))).toEqual([])
    const sk = featureById(doc, 'sk1', 'sketch')
    expect((sk.constraints ?? []).filter((c) => c.kind === 'midpoint')).toHaveLength(1)
  })

  it('a corner rectangle flags nothing', () => {
    const doc = sketchDoc((d) => applyAddRect(d, 'sk1', [0, 0], [10, 6], '@builtin_origin'))
    expect(flagged(solveSk1(doc))).toEqual([])
  })

  it('an n-gon flags nothing', () => {
    const doc = sketchDoc((d) => applyAddNgon(d, 'sk1', [0, 0], [5, 0], 6, null, '@builtin_origin'))
    expect(flagged(solveSk1(doc))).toEqual([])
  })
})
