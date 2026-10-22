// @vitest-environment node
//
// The mutation catalog's runtime twin of the type-level field check, plus the
// two examples the `mutations` tool advertises: they must run green through the
// real kernel, because an example that does not is worse than no example.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { validateMutation, MUTATION_CATALOG, MUTATION_FAMILY, HIDDEN_MUTATION_TYPES, mutationInfoOf } from '../mutationCatalog'
import { featureFieldNames } from '@/persistence/partDocSchema'
import type { Mutation } from '@/types/cad'
import { MUTATION_FAMILIES, mutationCatalogPayload } from '../mutationCatalogPayload'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
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
      'edit_session', 'move_vertex', 'move_vertex_with_constraint',
      'preview_commit', 'remove_dangling_content', 'set_rollback',
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

  it('places every visible mutation in exactly one family', () => {
    expect(Object.keys(MUTATION_FAMILY).sort()).toEqual(Object.keys(MUTATION_CATALOG).sort())
    const payload = mutationCatalogPayload()
    expect(Object.keys(payload.families).sort()).toEqual([...MUTATION_FAMILIES].sort())
    const listed = Object.values(payload.families).flat().map(entry => entry.type)
    expect(listed).toHaveLength(new Set(listed).size)
    const visible = (Object.keys(MUTATION_CATALOG) as Mutation['type'][])
      .filter(type => mutationInfoOf(type).hidden !== true)
    expect(new Set(listed)).toEqual(new Set(visible))
  })

  it('validates every example step', () => {
    for (const example of MUTATION_EXAMPLES) {
      for (const step of example.steps) {
        if (!('mutation' in step)) continue
        expect(validateMutation(step.mutation)).toMatchObject({ ok: true })
      }
    }
  })

  it('carries select ancestry queries, never positional edge aliases', () => {
    // A positional `?<body>:edge:<n>` alias is the pattern the knowledge base
    // forbids: it points at whatever edge holds that index once the topology
    // changes. The examples must teach the ancestry strings `select` returns.
    const positional = /\?[^;]*:edge:\d+$/
    for (const example of MUTATION_EXAMPLES) {
      for (const step of example.steps) {
        if (!('mutation' in step)) continue
        const query = (step.mutation as { edgeQuery?: string }).edgeQuery
        if (query !== undefined) expect(query).not.toMatch(positional)
      }
    }
  })

  it('publishes the plane definition shape from the part-document schema', () => {
    const payload = mutationCatalogPayload()
    const entry = Object.values(payload.families).flat().find(row => row.type === 'add_plane')
    expect(entry).toBeDefined()
    const definition = entry!.fields.definition
    expect(definition.type).toBe('object')
    const shape = definition.shape as {
      properties: Record<string, { enum?: string[] }>
      additionalProperties?: boolean
    }
    expect(shape).toBeDefined()
    expect(shape.properties.mode.enum).toContain('offset')
    expect(shape.properties.plane).toBeDefined()
    expect(shape.properties.offset).toBeDefined()
    expect(shape.properties.p1).toBeDefined()
  })

  it('shapes every object or any field, or names the definition it follows', () => {
    // A new unshaped object or pass-through field is a catalog regression: the
    // catalog has to carry either the schema shape or a note saying where it is
    // defined, so an agent never has to infer the payload from prose.
    const unshaped: string[] = []
    for (const type of Object.keys(MUTATION_CATALOG) as Mutation['type'][]) {
      const info = mutationInfoOf(type)
      for (const [name, field] of Object.entries(info.fields)) {
        if (field.type !== 'object' && field.type !== 'any') continue
        const shaped = field.shape !== undefined
        const noted = field.note !== undefined && field.note.trim().length > 0
        if (!shaped && !noted) unshaped.push(`${type}.${name}`)
      }
    }
    expect(unshaped).toEqual([])
  })

  it('lists the hole fields and says what the hole sketch must name', () => {
    const holeFields = featureFieldNames('hole')
    expect(holeFields).toEqual(expect.arrayContaining(['sketch', 'diameter', 'depth_mode', 'depth']))
    for (const type of ['add_hole', 'set_hole_field'] as const) {
      const info = mutationInfoOf(type)
      expect(info.note).toBeDefined()
      for (const name of holeFields) expect(info.note).toContain(name)
      expect(info.note).toContain('points and circles')
      expect(info.note).toContain('own radius')
    }
  })
})

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
    expect(measure!.volume).toBeCloseTo(12000, 6)
    expect(measure!.bodies).toBe(1)
  }, 120_000)

  it('builds the filleted-box example at the measured volume and area', async () => {
    const example = MUTATION_EXAMPLES.find(entry => entry.name === 'filleted-box')
    expect(example).toBeDefined()
    const result = await exampleRun(example!.steps)
    expect(result.ok).toBe(true)
    const measure = await measureHeadless(result.doc!)
    expect(measure).not.toBeNull()
    expect(measure!.volume).toBeCloseTo(11922.743, 3)
    expect(measure!.area).toBeCloseTo(3733.044, 3)
  }, 120_000)
})
