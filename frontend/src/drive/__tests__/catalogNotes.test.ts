// @vitest-environment node
//
// The catalog and schema notes the 2026-10-24 practice round found missing or
// wrong (plan mcp-practice-fixups-3, item F). Each note is generated where the
// rest of the catalog's notes are, so these pin the sentences a client reads.

import { describe, it, expect } from 'vitest'
import { MUTATION_CATALOG, mutationInfoOf, FIELD_SETTER_KIND } from '../mutationCatalog'
import { ASSEMBLY_MUTATION_CATALOG } from '../assemblyMutationCatalog'
import { MATE_KINDS, mateParams } from '@/utils/mateKinds'
import type { MateKind } from '@/types/cad'
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
      expect(note, type).toContain("viewport's `@<bodyId>/face/<n>` fallback")
      expect(note, type).toContain('fails the feature instead of falling back')
      expect(note, type).toContain('sketch point ref')
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
    expect(add.fields.up_to.note).toContain('@<bodyId>/face/<n>')
    expect(add.fields.up_to.note).toContain("viewport's `@<bodyId>/face/<n>` fallback")
    expect(add.fields.up_to.note).toContain('sketch point ref')
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

// Batch B docs findings: the sentences a client reads when it sends an empty
// value or draws a profile whose loops cross.
describe('batch B: the empty clear and the profile fill rule', () => {
  it('names the hole target as the field an empty value clears', () => {
    for (const type of ['add_hole', 'set_hole_field'] as const) {
      const note = mutationInfoOf(type).note!
      expect(note, type).toContain('empty value clears the `target` pick')
      expect(note, type).toContain('stored verbatim')
      expect(note, type).toContain('refuses an empty value instead of silently reverting')
    }
    // The value note names exactly the fields the value table clears, so it
    // cannot promise a clear the boundary refuses.
    for (const [type, field] of [['set_hole_field', 'target'], ['set_extrude_field', 'up_to']] as const) {
      expect(mutationInfoOf(type).fields.value.note, type)
        .toContain(`An empty value clears \`${field}\``)
    }
    expect(mutationInfoOf('set_mirror_field').fields.value.note)
      .toContain('it is the clear of no field of this kind')
  })

  it('says an all-circle hole sketch never reads diameter', () => {
    for (const type of ['add_hole', 'set_hole_field'] as const) {
      expect(mutationInfoOf(type).note!, type).toContain('all circles never reads `diameter`')
    }
    expect(mutationInfoOf('add_hole').fields.target.note).toContain('An empty string means absent')
  })

  it('states the even/odd fill rule on every profile field', () => {
    const notes = allNotes().filter(([where]) => where.endsWith('.sketchQuery'))
    expect(notes.length).toBeGreaterThan(3)
    for (const [where, note] of notes) {
      expect(note, where).toContain('nested inside another is a hole')
      expect(note, where).toContain('cross each other are filled as their union')
      expect(note, where).toContain('no warning')
    }
  })
})

// Review of the batch B notes: the plane definition setter's value note first
// repeated the feature-setter sentence "a null value clears the field (the key
// is deleted)". The wire refuses null for that mutation and no applier path
// deletes a definition key, so the note now says what happens.
describe('batch B review: the plane definition note', () => {
  it('says a null is refused and that the mutation cannot delete a field', () => {
    const note = mutationInfoOf('set_plane_definition_field').fields.value.note!
    expect(note).toContain('An empty value is refused')
    expect(note).toContain('A null value is refused too')
    expect(note).toContain('cannot delete a plane definition field')
    expect(note).not.toContain('null value clears the field')
    expect(note).not.toContain('the key is deleted')
  })

  // "null clears any field" over-promises: the boundary admits null even on a
  // required field and the setter deletes it, so the sentence is scoped to the
  // optional fields where the clear is also the documented contract.
  it('scopes every null-clear sentence to optional fields', () => {
    for (const type of ['add_hole', 'set_hole_field'] as const) {
      expect(mutationInfoOf(type).note!, type).toContain('null clears an optional field the same way')
    }
    for (const type of Object.keys(FIELD_SETTER_KIND) as Mutation['type'][]) {
      if (type === 'set_plane_definition_field') continue
      const note = mutationInfoOf(type).fields.value.note ?? ''
      expect(note, type).toContain('A null value clears an optional field (the key is deleted)')
      expect(note, type).not.toContain('null value clears the field')
    }
  })

  // 'An empty string means absent' is wording for the add_hole payload field;
  // the setter's value note must not read as if "" names a missing field key
  // on every field.
  it('keeps the add-only empty-absent sentence off the setter value note', () => {
    expect(mutationInfoOf('add_hole').fields.target.note).toContain('An empty string means absent')
    expect(mutationInfoOf('set_hole_field').fields.value.note).not.toContain('An empty string means absent')
  })
})

// Ex019: the widened mouth is one field for both styles, so the note says there
// is no `cs_diameter` rather than leaving the cb_/cs_ prefix pair to guess from.
describe('Ex019: the hole note names the mouth field once', () => {
  it('states that no cs_diameter exists on both hole rows', () => {
    for (const type of ['add_hole', 'set_hole_field'] as const) {
      expect(mutationInfoOf(type).note!, type).toContain('there is no `cs_diameter`')
    }
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

// Ex017: the shell note mapped CadQuery's signed thickness and stopped there,
// which reads as "same result". Our wall joins sharp (OCC intersection join) and
// CadQuery's shell defaults to kind="arc", so an outward shell of a sharp part
// differs by the edge rounds. The note has to name the join it builds.
describe('Ex017: the shell note names the join', () => {
  it('states the sharp join, the arc-join difference, and the arc fallback', () => {
    for (const type of ['add_shell', 'set_shell_field'] as const) {
      const note = mutationInfoOf(type).note!
      expect(note, type).toContain('sharp')
      expect(note, type).toContain('intersection join')
      expect(note, type).toContain('arc')
      expect(note, type).toContain('kind="arc"')
      // The sign mapping stays, but it no longer reads as an equivalence.
      expect(note, type).toContain('positive -> `outward`')
      expect(note, type).toContain('negative -> `inward`')
      expect(note, type).not.toContain('same result')
      expect(note, type).not.toContain('the same volume')
    }
  })

  it('names the arc join only as the fallback the kernel actually uses', () => {
    // applyShellWithLineage tries GeomAbs_Intersection first and GeomAbs_Arc
    // only after that build fails, so the note must not read as a choice.
    for (const type of ['add_shell', 'set_shell_field'] as const) {
      const note = mutationInfoOf(type).note!
      expect(note, type).toContain('only when the sharp build refuses')
    }
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

// The assembly catalog's mate notes are hand-written prose against mateParams.
// The claims cannot be regenerated mechanically (kinds reading the same list
// share one clause), so the claims are parsed and DERIVED: every clause's
// subject kinds must list exactly the params mateParams gives them, and every
// kind must be covered, so the next parameter-table change fails here instead
// of leaving the prose behind.
function mateParamClaims(note: string): Array<[string[], string[]]> {
  const intro = '(see mateParams): '
  const last = 'copy_rotation reads ratio'
  const start = note.indexOf(intro)
  const end = note.indexOf(last)
  expect(start, 'MATE_PARAM_NOTE intro').toBeGreaterThanOrEqual(0)
  expect(end, 'MATE_PARAM_NOTE last clause').toBeGreaterThan(start)
  return note
    .slice(start + intro.length, end + last.length)
    .split('; ')
    .map(clause => {
      const parsed = /^(.*) reads? (.*)$/.exec(clause)
      expect(parsed, `MATE_PARAM_NOTE clause "${clause}"`).not.toBeNull()
      const [, subjects, listed] = parsed!
      return [subjects.split(' and '), listed === 'none' ? [] : listed.split(', ')] as [string[], string[]]
    })
}

describe('assembly catalog: mate param claims', () => {
  it('states exactly the mateParams table in every note that shares MATE_PARAM_NOTE', () => {
    for (const type of ['add_mate', 'update_mate'] as const) {
      const claims = mateParamClaims(ASSEMBLY_MUTATION_CATALOG[type].note!)
      const covered = new Set(claims.flatMap(([kinds]) => kinds))
      expect([...covered].sort(), type).toEqual([...MATE_KINDS].sort())
      for (const [kinds, params] of claims) {
        for (const kind of kinds) {
          expect(params, `${type} note claim for ${kind}`).toEqual([...mateParams(kind as MateKind)])
        }
      }
    }
  })

  it('names exactly the flip-less kinds as the ones capture cannot measure', () => {
    // captureMateOrientationPatch returns null exactly for a kind whose params
    // exclude flip, which is the prose claim the capture note makes.
    const captureNothing = MATE_KINDS.filter(kind => !mateParams(kind).includes('flip'))
    for (const type of ['add_mate', 'set_mate_ref'] as const) {
      const note = ASSEMBLY_MUTATION_CATALOG[type].fields.capture.note!
      const listed = /no authored orientation \(([^)]+)\) captures nothing/.exec(note)
      expect(listed, type).not.toBeNull()
      expect(listed![1].split(', '), type).toEqual(captureNothing)
    }
  })
})
