// @vitest-environment node
//
// The two examples the `mutations` tool advertises must run green through the
// real kernel, because an example that does not is worse than no example.
// Split from mutationCatalog.test.ts, which keeps the pure catalog checks and
// runs on an unprovisioned checkout.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { runHeadless, measureHeadless, seedBuiltins, selectHeadless } from '../headlessOps'
import { runReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'
import { createDriveJournal } from '../journal'
import type { ScriptStep } from '../scriptRunner'
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
if (oc) {
  setOccLoader(loadOcc)
  setSketchSolver(loadSolver())
  setSketchTopology(loadTopology())
}

describe.skipIf(!oc)('mutation catalog examples (real OCC + Rust solver)', () => {
  // The examples are run the way the `mutations` tool's consumer runs them: a
  // `run` on a fresh seeded document installs the drive journal, so the id
  // source is seeded from that document and the ancestry queries the fillet
  // example carries resolve to the same edges they were produced from.
  function exampleRun(steps: readonly ScriptStep[]) {
    const doc = seedBuiltins({ version: 1, kind: 'part', features: [] })
    return runHeadless({ doc, steps, journal: createDriveJournal(doc) })
  }

  it('builds the box example at volume 12000', async () => {
    const example = MUTATION_EXAMPLES.find(entry => entry.name === 'box')
    expect(example).toBeDefined()
    const result = await exampleRun(example!.steps)
    expect(result.ok).toBe(true)
    const measure = await measureHeadless(result.doc!)
    expect(measure).not.toBeNull()
    expect(measure!.measures.volume).toBeCloseTo(12000, 6)
    expect(measure!.measures.bodies).toBe(1)
  }, 120_000)

  it('builds the filleted-box example at the measured volume and area', async () => {
    const example = MUTATION_EXAMPLES.find(entry => entry.name === 'filleted-box')
    expect(example).toBeDefined()
    const result = await exampleRun(example!.steps)
    expect(result.ok).toBe(true)
    const measure = await measureHeadless(result.doc!)
    expect(measure).not.toBeNull()
    expect(measure!.measures.volume).toBeCloseTo(11922.743, 3)
    expect(measure!.measures.area).toBeCloseTo(3733.044, 3)
  }, 120_000)

  it('lists only live bodies in the run summary after a boolean consumes a tool', async () => {
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 } },
      { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'operation', value: 'new' } },
      { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk2', p0: [5, 0], p1: [15, 10] } },
      { mutation: { type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 10 } },
      { mutation: { type: 'set_extrude_field', featureId: 'ex2', field: 'operation', value: 'new' } },
      { mutation: { type: 'add_boolean', featureId: 'bo1' } },
      { mutation: { type: 'set_boolean_field', featureId: 'bo1', field: 'target', value: 'body_ex1' } },
      { mutation: { type: 'add_boolean_tool', featureId: 'bo1', tool: 'body_ex2' } },
    ]
    const result = await exampleRun(steps)
    expect(result.ok).toBe(true)
    // The write-back drops the consumed tool's colour entry, so part_style
    // describes the live body set the same solve reported.
    expect(result.doc!.part_style).not.toHaveProperty('body_ex2')
    expect(result.doc!.part_style).toHaveProperty('body_ex1')
    expect(result.bodies).toContain('body_ex1')
    expect(result.bodies).not.toContain('body_ex2')

    const reply = runReply(result, false, new DocHandleStore())
    expect(reply.summary).toContain('bodies: body_ex1')
    expect(reply.summary).not.toContain('body_ex2')
  }, 120_000)

  it('pins the filleted-box edge queries to a select run on the box', async () => {
    // The example carries the queries `select` produced rather than the select
    // step, so this re-runs select on the same box doc and compares, pinning
    // that the carried strings really came from the engine.
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await exampleRun(box.steps)
    expect(built.ok).toBe(true)
    const selected = await selectHeadless(built.doc!, { kind: 'edge', where: { parallel: [0, 1, 0] } })
    expect(selected).not.toBeNull()
    const fillet = MUTATION_EXAMPLES.find(entry => entry.name === 'filleted-box')!
    const carried: string[] = []
    for (const step of fillet.steps) {
      if (!('mutation' in step)) continue
      const mutation = step.mutation as { edgeQuery?: string; edges?: string[] }
      if (mutation.edgeQuery !== undefined) carried.push(mutation.edgeQuery)
      if (mutation.edges !== undefined) carried.push(...mutation.edges)
    }
    expect(carried).toHaveLength(4)
    expect(selected!.queries).toEqual(carried)
  }, 120_000)
})
