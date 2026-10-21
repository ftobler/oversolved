// @vitest-environment node
//
// The mutation catalog's runtime twin of the type-level field check, plus the
// two examples the `mutations` tool advertises: they must run green through the
// real kernel, because an example that does not is worse than no example.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { validateMutation, MUTATION_CATALOG, HIDDEN_MUTATION_TYPES, mutationInfoOf } from '../mutationCatalog'
import type { Mutation } from '@/types/cad'
import { mutationCatalogPayload } from '../mutationCatalogPayload'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
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

describe('mutation catalog', () => {
  it('covers exactly the handler table', () => {
    expect(Object.keys(MUTATION_CATALOG).sort()).toEqual(Object.keys(mutationHandlers).sort())
  })

  it('summarizes every visible entry and types every field', () => {
    for (const type of Object.keys(MUTATION_CATALOG) as Mutation['type'][]) {
      const info = mutationInfoOf(type)
      if (info.hidden !== true) expect(info.summary.trim().length).toBeGreaterThan(0)
      for (const field of Object.values(info.fields)) {
        expect(typeof field.type).toBe('string')
        expect(typeof field.required).toBe('boolean')
      }
    }
  })

  it('hides exactly the internal plumbing from the listing', () => {
    expect([...HIDDEN_MUTATION_TYPES].sort()).toEqual([
      'edit_session', 'move_entity', 'move_vertex', 'move_vertex_with_constraint',
      'preview_commit', 'remove_dangling_content', 'resize_circle', 'set_rollback',
    ])
    const payload = mutationCatalogPayload()
    const listed = Object.values(payload.families).flat().map(entry => entry.type)
    const visible = (Object.keys(MUTATION_CATALOG) as Mutation['type'][])
      .filter(type => mutationInfoOf(type).hidden !== true)
    expect(new Set(listed)).toEqual(new Set(visible))
    for (const entry of Object.values(payload.families).flat()) {
      expect(entry.fields.insertAt).toBeUndefined()
      expect(entry.fields.solvedGeometry).toBeUndefined()
    }
    expect(listed).not.toContain('edit_session')
  })

  it('validates every example step', () => {
    for (const example of MUTATION_EXAMPLES) {
      for (const step of example.steps) {
        if (!('mutation' in step)) continue
        expect(validateMutation(step.mutation)).toMatchObject({ ok: true })
      }
    }
  })
})

describe.skipIf(!oc)('mutation catalog examples (real OCC + Rust solver)', () => {
  it('builds the box example at volume 12000', async () => {
    const example = MUTATION_EXAMPLES.find(entry => entry.name === 'box')
    expect(example).toBeDefined()
    const result = await runHeadless({ doc: seedBuiltins({ version: 1, kind: 'part', features: [] }), steps: example!.steps })
    expect(result.ok).toBe(true)
    const measure = await measureHeadless(result.doc!)
    expect(measure).not.toBeNull()
    expect(measure!.volume).toBeCloseTo(12000, 6)
    expect(measure!.bodies).toBe(1)
  }, 120_000)

  it('builds the filleted-box example at the measured volume and area', async () => {
    const example = MUTATION_EXAMPLES.find(entry => entry.name === 'filleted-box')
    expect(example).toBeDefined()
    const result = await runHeadless({ doc: seedBuiltins({ version: 1, kind: 'part', features: [] }), steps: example!.steps })
    expect(result.ok).toBe(true)
    const measure = await measureHeadless(result.doc!)
    expect(measure).not.toBeNull()
    expect(measure!.volume).toBeCloseTo(11922.743, 3)
    expect(measure!.area).toBeCloseTo(3733.044, 3)
  }, 120_000)
})
