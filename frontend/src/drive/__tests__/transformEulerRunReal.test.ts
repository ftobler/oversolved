// @vitest-environment node
//
// The MCP `run` regression for transform.rotation_euler: a stored angle of 0
// (what add_transform seeds) beside the triple is a named feature failure, and
// clearing it with a null setter then solves to the same place as the three
// chained world-axis transforms. Both the setter and the inline add paths are
// covered because add_transform now fronts every setter field.
//
// The real kernel is used here (the reply's feature delta and body summary are
// what the practice run reads), so the file skips without OCC and the Rust WASM.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { runReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'
import type { FeatureDelta } from '../featureDeltas'

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
const ready = oc && solveBytes

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
const clone = (doc: PartDoc): PartDoc => structuredClone(doc)

function bodySummary(reply: Record<string, unknown>): string {
  const summary = String(reply.summary ?? '')
  return summary.split('bodies: ')[1] ?? ''
}

function findDelta(rows: FeatureDelta[] | null, id: string): FeatureDelta {
  const row = (rows ?? []).find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`no feature delta for ${id}`)
  return row
}

describe.skipIf(!ready)('transform.rotation_euler through run (real OCC + Rust solver)', () => {
  it('refuses a seeded angle of 0 beside the triple and still solves the box', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = (await runHeadless({ doc: emptyDoc(), steps: box.steps })).doc!
    const conflict = await runHeadless({
      doc: clone(base),
      steps: [
        step({ type: 'add_transform', featureId: 'trE', bodies: ['@body_ex1'], operation: 'replace' }),
        step({ type: 'set_transform_field', featureId: 'trE', field: 'rotation_euler', value: [10, 20, 300] }),
      ],
    })
    const problem = conflict.features.find(candidate => candidate.id === 'trE')
    expect(problem).toBeDefined()
    expect(problem!.status).not.toBe('ok')
    expect(problem!.message).toContain('rotation_euler')
    expect(problem!.message).toContain('rotation_angle')
    // The rest of the document still solved: the box is the live body.
    expect(conflict.bodies).toContain('body_ex1')
  }, 240_000)

  it('clears the seeded angle with null, then matches the chained workaround', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = (await runHeadless({ doc: emptyDoc(), steps: box.steps })).doc!

    const euler = await runHeadless({
      doc: clone(base),
      steps: [
        step({ type: 'add_transform', featureId: 'trE', bodies: ['@body_ex1'], operation: 'replace' }),
        step({ type: 'set_transform_field', featureId: 'trE', field: 'rotation_angle', value: null }),
        step({ type: 'set_transform_field', featureId: 'trE', field: 'rotation_euler', value: [10, 20, 300] }),
      ],
      featureDeltas: 'all',
    })
    expect(euler.ok).toBe(true)
    expect(euler.features).toEqual([])
    expect(euler.outcome.steps.every(step => step.ok)).toBe(true)

    const chain = await runHeadless({
      doc: clone(base),
      steps: [
        step({
          type: 'add_transform', featureId: 'trX', bodies: ['@body_ex1'], operation: 'replace',
          rotation_angle: 10, rotation_axis_origin: [0, 0, 0], rotation_axis_direction: [1, 0, 0],
        }),
        step({
          type: 'add_transform', featureId: 'trY', bodies: ['@body_ex1'], operation: 'replace',
          rotation_angle: 20, rotation_axis_origin: [0, 0, 0], rotation_axis_direction: [0, 1, 0],
        }),
        step({
          type: 'add_transform', featureId: 'trZ', bodies: ['@body_ex1'], operation: 'replace',
          rotation_angle: 300, rotation_axis_origin: [0, 0, 0], rotation_axis_direction: [0, 0, 1],
        }),
      ],
      featureDeltas: 'all',
    })
    expect(chain.ok).toBe(true)
    expect(chain.features).toEqual([])

    const eulerReply = runReply(euler, false, new DocHandleStore())
    const chainReply = runReply(chain, false, new DocHandleStore())
    expect(bodySummary(eulerReply)).toBe(bodySummary(chainReply))
    expect(bodySummary(eulerReply)).toContain('body_ex1')
    expect('frames' in eulerReply).toBe('frames' in chainReply)

    const eulerRow = findDelta(euler.featureDeltas, 'trE')
    const chainRow = findDelta(chain.featureDeltas, 'trZ')
    expect(eulerRow.body).toBe('body_ex1')
    expect(eulerRow.volume).toBeCloseTo(chainRow.volume, 6)
    expect(eulerRow.bbox).not.toBeNull()
    expect(chainRow.bbox).not.toBeNull()
    for (let i = 0; i < 6; i++) {
      expect(eulerRow.bbox![i], `bbox[${i}]`).toBeCloseTo(chainRow.bbox![i], 6)
    }
  }, 300_000)

  it('takes the triple in one inline add, with the seeded angle cleared in the same call', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = (await runHeadless({ doc: emptyDoc(), steps: box.steps })).doc!
    const inline = await runHeadless({
      doc: clone(base),
      steps: [
        step({
          type: 'add_transform', featureId: 'trI', bodies: ['@body_ex1'], operation: 'replace',
          rotation_euler: [10, 20, 300],
        }),
      ],
      featureDeltas: 'all',
    })
    expect(inline.ok).toBe(true)
    expect(inline.features).toEqual([])
    const feature = inline.doc!.features!.find(candidate => candidate.id === 'trI') as unknown as {
      transform: Record<string, unknown>
    }
    expect(feature.transform.rotation_euler).toEqual([10, 20, 300])
    expect('rotation_angle' in feature.transform).toBe(false)

    const euler = await runHeadless({
      doc: clone(base),
      steps: [
        step({ type: 'add_transform', featureId: 'trE', bodies: ['@body_ex1'], operation: 'replace' }),
        step({ type: 'set_transform_field', featureId: 'trE', field: 'rotation_angle', value: null }),
        step({ type: 'set_transform_field', featureId: 'trE', field: 'rotation_euler', value: [10, 20, 300] }),
      ],
      featureDeltas: 'all',
    })
    const inlineRow = findDelta(inline.featureDeltas, 'trI')
    const setterRow = findDelta(euler.featureDeltas, 'trE')
    expect(inlineRow.volume).toBeCloseTo(setterRow.volume, 6)
    expect(inlineRow.bbox).not.toBeNull()
    expect(setterRow.bbox).not.toBeNull()
    for (let i = 0; i < 6; i++) {
      expect(inlineRow.bbox![i], `bbox[${i}]`).toBeCloseTo(setterRow.bbox![i], 6)
    }
  }, 300_000)
})
