// @vitest-environment node
//
// The catalog and schema notes the 2026-10-24 practice round found missing or
// wrong (plan mcp-practice-fixups-3, item F). Each note is generated where the
// rest of the catalog's notes are, so these pin the sentences a client reads.

import { describe, it, expect } from 'vitest'
import { MUTATION_CATALOG, mutationInfoOf } from '../mutationCatalog'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import type { Mutation, SketchFeature } from '@/types/cad'
import { featureParamsSchema } from '@/persistence/partDocSchema'
import { runHeadless, emptyDriveDoc } from '../headlessOps'

// Every note text of every row: the row note plus each field note.
function allNotes(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [type, row] of Object.entries(MUTATION_CATALOG) as Array<[string, { note?: string; fields: Record<string, { note?: string }> }]>) {
    if (row.note !== undefined) out.push([type, row.note])
    for (const [field, info] of Object.entries(row.fields)) {
      if (info.note !== undefined) out.push([`${type}.${field}`, info.note])
    }
  }
  return out
}

describe('F1: constraint kinds named in notes', () => {
  it('lists exactly the registry kinds on add_constraint', () => {
    const note = mutationInfoOf('add_constraint').fields.kind.note!
    const listed = /one of: ([^.]+)\./.exec(note)![1].split(', ')
    expect(listed).toEqual([...CONSTRAINT_BY_KIND.keys()])
  })

  it('names no constraint kind the validator refuses', () => {
    // A backticked word right after "kind" or a "constraint kind ... e.g." phrase
    // is a constraint kind the note recommends.
    for (const [where, note] of allNotes()) {
      if (!/constraint/i.test(note)) continue
      for (const match of note.matchAll(/`([a-z_]+)`/g)) {
        const word = match[1]
        if (/kind|dimension|take/.test(note.slice(Math.max(0, match.index! - 40), match.index!))) {
          expect(CONSTRAINT_BY_KIND.has(word), `${where}: ${word}`).toBe(true)
        }
      }
    }
  })
})

describe('F3: variables are named by label', () => {
  it('says so on both variable rows and in the expression schema', () => {
    for (const type of ['add_variable', 'set_variable_field'] as const) {
      expect(mutationInfoOf(type).note, type).toContain('by the variable feature\'s `label`')
    }
    const schema = featureParamsSchema('extrude') as { properties: Record<string, { description?: string }> }
    expect(schema.properties.distance.description).toContain('`label`')
  })
})

describe('F4: symmetric extrude distance', () => {
  it('names distance as the total on both extrude rows', () => {
    for (const type of ['add_extrude', 'set_extrude_field'] as const) {
      expect(mutationInfoOf(type).note, type).toContain('`distance` as the TOTAL length, half on each side')
    }
  })
})

describe('up-to termination on both extrude rows', () => {
  it('names termination and up_to, and how up_to names a plane or face', () => {
    for (const type of ['add_extrude', 'set_extrude_field'] as const) {
      const note = mutationInfoOf(type).note!
      expect(note, type).toContain('`termination: up_to`')
      expect(note, type).toContain('`up_to`')
      expect(note, type).toContain('@<planeId>')
      expect(note, type).toContain('face query from `select`')
      expect(note, type).toContain('used blind distance')
      expect(note, type).toContain('up_to has no target')
      expect(note, type).toContain('read only when')
    }
  })

  it('keeps the add-time solve warning on the add row only', () => {
    expect(mutationInfoOf('add_extrude').note).toContain('add joined nothing')
    expect(mutationInfoOf('set_extrude_field').note).not.toContain('add joined nothing')
  })

  it('offers both fields inline on add_extrude', () => {
    const add = mutationInfoOf('add_extrude')
    expect(add.fields.termination).toBeDefined()
    expect(add.fields.up_to).toBeDefined()
    expect(add.fields.termination.required).toBe(false)
    expect(add.fields.up_to.required).toBe(false)
    expect(add.fields.up_to.note).toContain('@body_ex1/face/<n>')
    expect(add.fields.up_to.note).toContain('otherwise it is ignored')
    expect(add.fields.up_to.note).toContain('null or empty value clears it')
  })

  it('carries termination and up_to from the inline add into the document', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [{
        mutation: {
          type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10,
          termination: 'up_to', up_to: '@builtin_plane_front',
        },
      }],
    })
    const feature = result.doc!.features!.find(entry => entry.id === 'ex1')
    expect(feature).toMatchObject({
      kind: 'extrude',
      extrude: { termination: 'up_to', up_to: '@builtin_plane_front' },
    })
  })
})

describe('F7: merge_target spelling', () => {
  it('names the bare body id and the delta row field on every merge_target row', () => {
    for (const type of ['add_extrude', 'set_extrude_field', 'set_revolve_field'] as const) {
      const note = mutationInfoOf(type).note!
      expect(note, type).toContain('bare body id')
      expect(note, type).toContain('`body`')
    }
  })
})

describe('F12: face-sketch frame on the first read', () => {
  it('the add_sketch row and its plane field name the centroid origin and the frames map', () => {
    const row = mutationInfoOf('add_sketch')
    for (const text of [row.note!, row.fields.plane.note!]) {
      expect(text).toContain('origin = face centroid')
      expect(text).toContain('`frames`')
    }
  })
})

describe('F5: add_center_rect created ids', () => {
  it('documents the order the mutation actually creates', async () => {
    expect(mutationInfoOf('add_center_rect').note).toContain('bottom, right, top, left')
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [5, 3] } },
      ],
    })
    const ids = result.outcome.steps[1].createdIds
    const sketch = result.doc!.features!.find(feature => feature.id === 'sk1') as SketchFeature
    const entityIds = ids.filter(id => sketch.entities!.some(entity => entity.id === id))
    expect(entityIds).toHaveLength(5)
    const [bottom, right, top, left, centre] = entityIds.map(id => sketch.initial![id])
    expect([bottom[1], bottom[3]]).toEqual([-3, -3])
    expect([right[0], right[2]]).toEqual([5, 5])
    expect([top[1], top[3]]).toEqual([3, 3])
    expect([left[0], left[2]]).toEqual([-5, -5])
    expect(centre).toEqual([0, 0])
  })
})

describe('F2: apply_offset side', () => {
  it('states the side relative to the loop', () => {
    const note = mutationInfoOf('apply_offset' as Mutation['type']).note!
    expect(note).toContain('out of the region')
    expect(note).toContain('whatever the winding')
    expect(note).toContain('open selection')
  })
})
