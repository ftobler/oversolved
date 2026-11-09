// @vitest-environment node
//
// The authoring probe must not refuse a tangent at an arc-to-arc joint. Two
// arcs joined by a coincident already share one point; tangency there is a
// direction condition and adds rank, so the probe has to read it as a real
// constraint rather than as a duplicate of the joint.
//
// Runs against the real node wasm; skips when the gitignored pkg-node build is
// absent (run `just wasm`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { probeRedundantConstraint, setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { emptyDriveDoc } from '@/drive/headlessOps'
import { applyAddSketch } from '@/utils/yamlMutations/featureAdmin'
import { applyAddConstraint } from '@/utils/yamlMutations/sketch'
import { featureById } from '@/testing/featureAccess'
import type { PartDoc, SketchFeature } from '@/types/cad'

const solveBytes = loadSolver()

function arcSketch(second: number[]): PartDoc {
  const doc = emptyDriveDoc()
  applyAddSketch(doc, 'sk1', 'sketch 1', '@builtin_plane_top')
  const feature = featureById(doc, 'sk1', 'sketch') as SketchFeature
  feature.entities = [{ id: 'a1', kind: 'arc' }, { id: 'a2', kind: 'arc' }]
  // a1 ends at (0,2). a2 starts there too, either tangent to a1 (its centre on
  // the same radial, (0,1)) or visibly off it.
  feature.initial = { a1: [0, 0, 2, 0, 90], a2: second }
  applyAddConstraint(doc, 'sk1', 'coincident', ['vertex:sk1:a1:end', 'vertex:sk1:a2:start'])
  applyAddConstraint(doc, 'sk1', 'tangent', ['entity:sk1:a1', 'entity:sk1:a2'])
  return doc
}

function draftTangentId(doc: PartDoc): string {
  const feature = featureById(doc, 'sk1', 'sketch') as SketchFeature
  const tangent = (feature.constraints ?? []).filter(c => c.kind === 'tangent')
  expect(tangent).toHaveLength(1)
  return tangent[0].id
}

describe.skipIf(!solveBytes)('probeRedundantConstraint at an arc joint', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })
  afterAll(() => resetSketchSolver())

  it('accepts a tangent between already tangent arcs', () => {
    const doc = arcSketch([0, 1, 1, 90, 180])
    const feature = featureById(doc, 'sk1', 'sketch') as SketchFeature
    expect(probeRedundantConstraint(feature, draftTangentId(doc))).toBe(false)
  })

  it('accepts a tangent between arcs joined but not yet tangent', () => {
    const doc = arcSketch([1, 1, Math.SQRT2, 135, 225])
    const feature = featureById(doc, 'sk1', 'sketch') as SketchFeature
    expect(probeRedundantConstraint(feature, draftTangentId(doc))).toBe(false)
  })
})
