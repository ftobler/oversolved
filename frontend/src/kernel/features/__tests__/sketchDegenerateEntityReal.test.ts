// @vitest-environment node
//
// The solve side of the size floor. A document can carry a degenerate curve
// from a load, a projection, or a solve that drove a dimension to zero. The
// sketch must name it on its warning row and keep it out of the area build, so
// it cannot take a valid neighbour's profile down. The zero-circle case also
// pins the cause of its overconstrained verdict: the Rust solve's own
// `invalid_geometry` rule marks a solved circle or arc at or under radius 0
// overconstrained before the host sees it, so the warning is what has to name
// the real cause.
//
// Runs against the real node wasm; skips when the gitignored builds are absent.

import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PartConstraint, PartDoc } from '@/types/cad'
import { setSketchSolver, setSketchTopology, solveSketch } from '../sketch'
import { initGlobalRepo } from '@/kernel/query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { runHeadless, emptyDriveDoc } from '@/drive/headlessOps'
import { featureFailure } from '@/utils/core/featureFailure'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setOccLoader } from '@/kernel/solveLocally'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()
const ready = oc && solveBytes

function sketchDoc(
  entities: Array<{ id: string; kind: string }>,
  initial: Record<string, number[]>,
  constraints: PartConstraint[] = [],
): PartDoc {
  const doc = emptyDriveDoc()
  doc.features!.push({
    id: 'sk1',
    kind: 'sketch',
    plane: '@builtin_plane_front',
    entities,
    initial,
    constraints,
  })
  return doc
}

describe.skipIf(!ready)('a degenerate solved entity is named and left out of profiles', () => {
  beforeAll(() => {
    setOccLoader(loadOcc)
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
  })
  afterAll(() => {
    setSketchSolver(null)
    setSketchTopology(null)
  })

  // The bug case: the ellipse's ends land on the circle. Before the exclusion
  // the area builder handed the writer a b = 0 or an a < b ellipse and the
  // extrude failed with `make_ellipse_edge: needs a >= b > 0`.
  it.each([
    { name: 'b = 0', ellipse: [3, 0, 2, 0, 0], circleRadius: 5 },
    { name: 'a < b', ellipse: [0, 0, 1, 3, 0], circleRadius: 3 },
  ])('an extrude builds the circle beside a $name ellipse', async ({ ellipse, circleRadius }) => {
    const doc = sketchDoc(
      [{ id: 'c1', kind: 'circle' }, { id: 'e1', kind: 'ellipse' }],
      { c1: [0, 0, circleRadius], e1: ellipse },
    )
    const run = await runHeadless({
      doc,
      steps: [{
        mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 2, operation: 'new' },
      }],
    })
    expect(run.outcome.steps[0]).toMatchObject({ ok: true })
    expect(run.solve.lastError).toBeNull()

    const sketchProblem = run.features.find(problem => problem.id === 'sk1')
    expect(sketchProblem?.message).toContain('entity e1 is degenerate')
    expect(sketchProblem?.message).toContain('left out of profiles')
    // The extrude sees the circle alone, so it is not a problem row either.
    expect(run.features.some(problem => problem.id === 'ex1')).toBe(false)
    expect(run.bodies).toContain('body_ex1')
  }, 180_000)

  // A radius dimension at zero is the end state a variable edit leaves. Sketch
  // dimensions store a number, so the loaded document carries the driven value
  // directly; the point is that the solve names the circle instead of asking
  // OCC to build a zero-radius circle.
  it('a radius dimension driven to zero names the circle and raises no OCC error', async () => {
    const doc = sketchDoc(
      [{ id: 'c1', kind: 'circle' }],
      { c1: [0, 0, 5] },
      [{ id: 'dim', kind: 'radius', target: '$c1', value: 0 }],
    )
    doc.features!.push({
      id: 'ex1',
      kind: 'extrude',
      extrude: { sketch: '$sk1', distance: 2, operation: 'new' },
    })
    // Force a settle: the document is already degenerate, so a no-op script
    // would leave the solve unrequested. A fresh point is a real edit that does
    // not touch the circle's size.
    const run = await runHeadless({
      doc,
      steps: [{
        mutation: { type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 1], entityId: 'marker' },
      }],
    })
    expect(run.solve.lastError).toBeNull()
    const sketchProblem = run.features.find(problem => problem.id === 'sk1')
    expect(sketchProblem?.message).toContain('entity c1 is degenerate')
    expect(sketchProblem?.message).toContain('radius')
    // The circle is out of the profile, so the extrude has nothing to build and
    // says so by name. Any OCC construction error would surface as an exception.
    const extrudeProblem = run.features.find(problem => problem.id === 'ex1')
    expect(extrudeProblem?.message ?? '').toContain('no closed profile')
    expect(extrudeProblem?.message ?? '').not.toContain('make_circle')
  }, 180_000)

  it('a lone zero circle names itself in the verdict instead of overconstraint', () => {
    setSketchSolver(solveBytes!)
    const out = solveSketch({
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [{ id: 'c1', kind: 'circle' }],
      initial: { c1: [0, 0, 0] },
    } as unknown as Record<string, unknown>, initGlobalRepo(), {})
    // Pinned cause: the solve classifies a non-positive solved radius as an
    // unsatisfied solve, so the status stays red. The warning carries the cause.
    expect(out.status).toBe('overconstrained')
    expect(String(out.solver_warning)).toContain('entity c1 is degenerate')
    expect(String(out.solver_warning)).toContain('radius')
    // The degenerate curve is not handed to the area builder at all.
    expect((out.topology as { surfaces?: unknown[] } | undefined)?.surfaces ?? []).toHaveLength(0)
    // The user-facing verdict is the warning, not the bare status word.
    expect(featureFailure('sk1', { sk1: out }, {}).message).toContain('entity c1 is degenerate')
  })
})
