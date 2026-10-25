// @vitest-environment node
//
// The reply fields the CLI and MCP server share: the features a solve did not
// finish cleanly, the empty-script "inspect this document" solve, and the
// measure reply carrying the same list. Real kernel, gated like the other
// drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { HOLE_ALL_SITES_MISS, HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

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
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

const ready = oc && solveBytes

describe.skipIf(!ready)('headless feature problems (real OCC + Rust solver)', () => {
  it('reports an empty list for a clean box, and does not list an underconstrained sketch', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    // The box's sketch IS underconstrained: a normal sketch state, not a
    // problem, so the list above must stay empty while the outcome exists.
    expect(result.part.solveOutcomes().sk1?.status).toBe('underconstrained')
  }, 120_000)

  it('lists a failed hole with its kernel message and does not flip ok', async () => {
    const result = await runHeadless({ doc: emptyDoc(), steps: HOLE_ON_LINE_SKETCH })
    expect(result.ok).toBe(true)
    expect(result.solve.lastError).toBeNull()
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(result.features[0].message).toMatch(/has no point/)
  }, 120_000)

  it('lists an ok-with-warning hole and keeps the warning text', async () => {
    const result = await runHeadless({ doc: emptyDoc(), steps: HOLE_ALL_SITES_MISS })
    expect(result.ok).toBe(true)
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'ok' })
    expect(result.features[0].message).toMatch(/none of the 1 drill site\(s\) intersect/)
  }, 120_000)

  it('keeps a dependent extrude after its sketch is deleted and names the missing input', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [...box.steps, { mutation: { type: 'delete_feature', featureId: 'sk1' } }],
    })
    // delete_feature removes the named row only; the dependent stays and fails.
    expect(result.doc?.features?.map(feature => feature.id)).not.toContain('sk1')
    expect(result.doc?.features?.map(feature => feature.id)).toContain('ex1')
    const problem = result.features.find(feature => feature.id === 'ex1')
    expect(problem).toBeDefined()
    expect(problem!.message).toContain('sketch not found: sk1')
  }, 120_000)

  it('builds a through_all hole with no stored depth and cuts all the way through', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [5, 5, 2], entityId: 'c1' } },
        { mutation: { type: 'add_hole', featureId: 'h1', sketch: '@sk2', diameter: 4, depth_mode: 'through_all' } },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    const hole = result.doc?.features?.find(feature => feature.id === 'h1')
    if (hole?.kind !== 'hole') throw new Error('unreachable')
    expect(hole.hole).not.toHaveProperty('depth')
    // The Front plane's normal points into the box, so the resolved side is
    // the authored one, and the reply says which way the hole went.
    expect(result.featureDeltas?.find(row => row.id === 'h1')?.direction).toBe('normal')
    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    // 10x10x10 box minus a 4 mm bore through the 10 mm height.
    expect(measured!.measures.volume).toBeCloseTo(1000 - Math.PI * 2 * 2 * 10, 2)
  }, 120_000)

  it('names a variable defined later and builds after reorder_features moves it up', async () => {
    // Build the box first, then author the forward reference directly: a fresh
    // full solve is what has to report the forward reference, while an
    // incremental solve that never re-reaches ex1 would keep its old result.
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const doc = base.doc!
    const ex1 = doc.features!.find(feature => feature.id === 'ex1')
    if (ex1?.kind !== 'extrude') throw new Error('unreachable')
    ex1.extrude.distance = 'width+50'
    doc.features!.push({
      id: 'width', kind: 'variable', label: 'width', variable: { expression: '100' },
    })

    const built = await runHeadless({ doc, docId: 'forward-ref', steps: [] })
    const forward = built.features.find(feature => feature.id === 'ex1')
    expect(forward).toBeDefined()
    expect(forward!.message).toBe(
      "distance: variable 'width' is defined after this feature (at index 2); "
      + 'move it up with reorder_features',
    )

    // The solver sees only user features, so its N is 2. reorder_features counts
    // the seeded plane rows and clamps a smaller index to the first user slot.
    const reordered = await runHeadless({
      doc: built.doc!,
      docId: 'forward-reordered',
      steps: [{ mutation: { type: 'reorder_features', featureId: 'width', toIndex: 2 } }],
    })
    expect(reordered.ok).toBe(true)
    expect(reordered.features).toEqual([])
    expect(reordered.part.solveOutcomes().ex1.status).toBe('ok')
  }, 120_000)

  it('builds an add_revolve that carries its axis inline', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'line', params: [0, -5, 0, 15], entityId: 'ax' } },
        {
          mutation: {
            type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk1', angle: 90, axis: '@sk2/ax',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    expect(result.part.solveOutcomes().rev1.status).toBe('ok')
  }, 120_000)

  it('refuses a revolve axis that cuts through the profile interior', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'line', params: [-5, 5, 15, 5], entityId: 'ax' } },
        {
          mutation: {
            type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk1', angle: 90, axis: '@sk2/ax',
          },
        },
      ],
    })
    const problem = result.features.find(feature => feature.id === 'rev1')
    expect(problem).toBeDefined()
    expect(problem!.message).toContain('the axis crosses profile area sk1')
    expect(problem!.message).toContain('may touch the profile but not cut through it')
  }, 120_000)

  it('solves a passed document once when the script is empty', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const inspected = await runHeadless({ doc: built.doc!, steps: [] })
    expect(inspected.ok).toBe(true)
    expect(inspected.outcome.steps).toEqual([])
    expect(inspected.solve.generation).toBeGreaterThan(0)
    expect(typeof inspected.docHash).toBe('string')
    expect(inspected.features).toEqual([])
  }, 120_000)

  it('measure returns the same feature list as run', async () => {
    const clean = await runHeadless({ doc: emptyDoc(), steps: HOLE_ON_LINE_SKETCH })
    const measured = await measureHeadless(clean.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.features).toHaveLength(1)
    expect(measured!.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(measured!.features[0].message).toMatch(/has no point/)
  }, 120_000)
})
