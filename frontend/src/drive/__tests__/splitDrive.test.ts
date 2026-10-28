// @vitest-environment node
//
// The split feature over the drive surface: the Ex021 practice script in one
// `run` (sketch, extrude, plane, split), the boundary refusals with their fixes,
// and the catalog/schema presence an MCP caller reads. Real kernel where
// provisioned.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

const EX021_VOLUME = 500 - (Math.PI * 2.5 * 2.5 * 10) / 2

/** Square plus a central circle on Top, extruded as one holed block, then split. */
function ex021Steps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [5, 5, 2.5] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 }),
    m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } }),
    m({ type: 'add_split', featureId: 'sp1', bodies: ['@ex1'], plane: '@pl1', keep: 'above' }),
  ]
}

describe('the split mutation catalog', () => {
  it('lists the four mutations', () => {
    for (const type of ['add_split', 'set_split_field', 'add_split_body', 'remove_split_body'] as const) {
      expect(mutationInfoOf(type).summary.length).toBeGreaterThan(0)
    }
  })

  it('states the side rule on add_split and set_split_field', () => {
    for (const type of ['add_split', 'set_split_field'] as const) {
      const note = mutationInfoOf(type).note ?? ''
      expect(note, type).toContain('above')
      expect(note, type).toContain('below')
      expect(note, type).toContain('both')
      expect(note, type).toContain('OUTWARD')
    }
  })

  it('publishes split in the part-document schema', () => {
    expect(PART_DOC_SCHEMA_JSON).toContain('"split"')
    expect(PART_DOC_SCHEMA_JSON).toContain('"above"')
  })
})

describe('split boundary refusals', () => {
  function refusal(raw: Record<string, unknown>): string {
    // A document lets the plane check name the valid planes; without one the
    // boundary can only judge the value's shape.
    const result = validateMutation(raw, { doc: emptyDriveDoc() })
    if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`)
    return result.error.message
  }

  it('refuses an unknown keep side, listing the three values', () => {
    const message = refusal({ type: 'add_split', featureId: 'sp1', keep: 'top' })
    expect(message).toContain('"above"')
    expect(message).toContain('"below"')
    expect(message).toContain('"both"')
  })

  it('refuses a plane name that is not a plane, listing the valid ones', () => {
    const message = refusal({ type: 'add_split', featureId: 'sp1', plane: 'top' })
    expect(message).toContain('@builtin_plane_top')
    expect(message).toContain('case-sensitive')
  })

  it('refuses bodies that are not a list', () => {
    expect(refusal({ type: 'add_split', featureId: 'sp1', bodies: '@ex1' })).toContain('bodies')
  })

  it('refuses an unknown set_split_field field', () => {
    expect(refusal({ type: 'set_split_field', featureId: 'sp1', field: 'side', value: 'above' }))
      .toContain('side')
  })
})

describe.skipIf(!ready)('the Ex021 split script (real OCC + Rust solver)', () => {
  it('builds the holed block and keeps the top half in one run', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: ex021Steps() })
    expect(result.outcome.ok).toBe(true)
    expect(result.features).toEqual([])
    for (const step of result.outcome.steps) expect(step.ok, `${step.id}: ${step.error?.message ?? ''}`).toBe(true)
    expect(result.bodies).toEqual(['body_ex1'])

    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.measures.volume).toBeCloseTo(EX021_VOLUME, 4)
  }, 240_000)

  it('refuses a keep side it cannot name, without changing the document', async () => {
    const steps = ex021Steps()
    steps[steps.length - 1] = m({ type: 'add_split', featureId: 'sp1', bodies: ['@ex1'], plane: '@pl1', keep: 'top' })
    const result = await runHeadless({ doc: emptyDriveDoc(), steps })
    expect(result.outcome.ok).toBe(false)
    const split = result.outcome.steps[result.outcome.steps.length - 1]
    expect(split.ok).toBe(false)
    expect(split.error?.message).toContain('"both"')
  }, 240_000)
})
