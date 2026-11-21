// @vitest-environment node
//
// The catalog and boundary half of selector picks on every body-pick field: the
// field table in drive/selectionAids must match the rows clients read, and a
// selector that reaches the value rules without a solve must be refused by name
// instead of stored. The real-kernel half (selectorPickFieldsReal.test.ts)
// proves the drive resolves each kind of field to the same document a pasted
// query builds.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { MUTATION_CATALOG, validateMutation, setterFieldNames, type MutationInfo } from '../mutationCatalog'
import type { Mutation } from '@/types/cad'
import { SELECTION_AIDS, selectorSetterNote, selectionAidFor, usesSelectionAid } from '../selectionAids'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { seedBuiltins } from '../headlessOps'

const SELECTOR_MARK = '{selector}'

function catalogRow(type: string): MutationInfo | undefined {
  return (MUTATION_CATALOG as Record<string, MutationInfo | undefined>)[type]
}

// A field note is what a client reads on the row; the marker is the promise
// that the field takes the selector spelling.
function catalogSelectorFields(): string[] {
  const fields: string[] = []
  for (const [type, row] of Object.entries(MUTATION_CATALOG) as Array<[string, MutationInfo]>) {
    for (const [field, info] of Object.entries(row.fields)) {
      if (info.note?.includes(SELECTOR_MARK)) fields.push(`${type}.${field}`)
    }
  }
  return fields.sort()
}

// The add rows' table fields: a setter is handled by the row note below because
// its value field is one entry for every field the setter may name. A nested
// path contributes its top key once, which is the field row clients read.
function tableAddFields(): string[] {
  const fields = new Set<string>()
  for (const [type, aids] of Object.entries(SELECTION_AIDS)) {
    for (const aid of aids) {
      if (aid.field === undefined) fields.add(`${type}.${aid.path[0]}`)
    }
  }
  return [...fields].sort()
}

function setterAidTypes(): string[] {
  return Object.entries(SELECTION_AIDS)
    .filter(([, aids]) => aids.some(aid => aid.field !== undefined))
    .map(([type]) => type)
    .sort()
}

function setterNoteTypes(): string[] {
  return (Object.entries(MUTATION_CATALOG) as Array<[string, MutationInfo]>)
    .filter(([type, row]) => type.startsWith('set_') && row.note?.includes(SELECTOR_MARK) === true)
    .map(([type]) => type)
    .sort()
}

describe('the selector field table and the catalog cannot diverge', () => {
  it('names exactly the table fields in the add rows', () => {
    expect(catalogSelectorFields()).toEqual(tableAddFields())
  })

  it('puts the selector sentence on exactly the setter rows the table covers', () => {
    expect(setterNoteTypes()).toEqual(setterAidTypes())
  })

  it('names every covered setter field in its row note', () => {
    for (const type of setterAidTypes()) {
      const row = catalogRow(type)!
      const note = row.note ?? ''
      const setterFields = setterFieldNames(type as Mutation['type']) ?? []
      for (const aid of SELECTION_AIDS[type]) {
        if (aid.field === undefined) continue
        expect(setterFields, `${type}.${aid.field}`).toContain(aid.field)
        expect(note, `${type}.${aid.field}`).toContain(`\`${aid.field}\``)
      }
    }
  })

  it('generates the setter sentence from the same table', () => {
    for (const type of setterAidTypes()) {
      const note = selectorSetterNote(type)
      expect(note).toContain(SELECTOR_MARK)
      for (const aid of SELECTION_AIDS[type]) {
        if (aid.field === undefined) continue
        expect(note, `${type}.${aid.field}`).toContain(`\`${aid.field}\``)
      }
    }
  })

  it('knows a selector on every covered field when deciding whether a step needs a solve', () => {
    const selector = { selector: { kind: 'face' } }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['add_delete_face', { type: 'add_delete_face', faces: [selector] }],
      ['add_move_face', { type: 'add_move_face', faces: [selector] }],
      ['add_instance_pattern', { type: 'add_instance_pattern', targets: [selector] }],
      ['add_wrap', { type: 'add_wrap', target: selector }],
      ['add_extrude', { type: 'add_extrude', up_to: selector }],
      ['add_revolve', { type: 'add_revolve', axis: selector }],
      ['add_mirror', { type: 'add_mirror', plane: selector }],
      ['add_split', { type: 'add_split', plane: selector }],
      ['add_plane', { type: 'add_plane', definition: { mode: 'on_face', face: selector } }],
      ['add_helix', { type: 'add_helix', reference: selector }],
      ['add_linear_pattern', { type: 'add_linear_pattern', direction_query: selector }],
      ['add_circular_pattern', { type: 'add_circular_pattern', axis: selector }],
      ['add_curve_pattern', { type: 'add_curve_pattern', normal_ref: selector }],
      ['add_transform', { type: 'add_transform', translation_from: selector }],
      ['add_shell_face', { type: 'add_shell_face', faceQuery: selector }],
      ['add_delete_face_ref', { type: 'add_delete_face_ref', faceQuery: selector }],
      ['set_wrap_field', { type: 'set_wrap_field', field: 'target', value: selector }],
      ['set_extrude_field', { type: 'set_extrude_field', field: 'up_to', value: selector }],
      ['set_move_face_field', { type: 'set_move_face_field', field: 'faces', value: [selector] }],
      ['set_plane_definition_field', { type: 'set_plane_definition_field', field: 'face', value: selector }],
      ['set_transform_field', { type: 'set_transform_field', field: 'rotation_axis', value: selector }],
    ]
    for (const [label, step] of cases) expect(usesSelectionAid(step), label).toBe(true)
    // A name that is not a covered field still passes through untouched.
    expect(usesSelectionAid({ type: 'set_wrap_field', field: 'height', value: selector })).toBe(false)
    expect(selectionAidFor('set_wrap_field', 'target')).toBeDefined()
    expect(selectionAidFor('set_wrap_field', 'height')).toBeUndefined()
  })
})

describe('an unresolved selector is refused by name at the value rules', () => {
  const selector = { selector: { kind: 'face' } }
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['add_delete_face faces', { type: 'add_delete_face', featureId: 'df1', faces: [selector] }, 'add_delete_face faces[0]'],
    ['add_move_face faces', { type: 'add_move_face', featureId: 'mf1', faces: [selector] }, 'add_move_face faces[0]'],
    ['add_wrap target', { type: 'add_wrap', featureId: 'wr1', sketchQuery: '$sk1', target: selector }, 'add_wrap target'],
    ['add_extrude up_to', {
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1,
      termination: 'up_to', up_to: selector,
    }, 'add_extrude up_to'],
    ['add_revolve axis', { type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 90, axis: selector }, 'add_revolve axis'],
    ['add_helix reference', { type: 'add_helix', featureId: 'he1', reference: selector }, 'add_helix reference'],
    ['add_plane definition face', {
      type: 'add_plane', featureId: 'pl1', definition: { mode: 'on_face', face: selector },
    }, 'add_plane definition.face'],
    ['set_wrap_field target', { type: 'set_wrap_field', featureId: 'wr1', field: 'target', value: selector }, 'set_wrap_field target'],
    ['set_instance_pattern_field targets', {
      type: 'set_instance_pattern_field', featureId: 'ip1', field: 'targets', value: [selector],
    }, 'set_instance_pattern_field targets[0]'],
  ]

  it.each(cases)('%s refuses the selector and names the field', (_label, mutation, field) => {
    const refused = validateMutation(mutation)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe('invalid-mutation')
    expect(refused.error.message).toContain('{selector}')
    expect(refused.error.message).toContain('solved parts')
    expect(refused.error.message).toContain(field)
  })

  it('corrects a predicate placed at the selector root on a newly covered field', () => {
    const refused = validateMutation({
      type: 'add_wrap', featureId: 'wr1', sketchQuery: '$sk1',
      target: { selector: { type: 'flatface' } },
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.message).toContain('add_wrap target: selector has unknown key "type"')
    expect(refused.error.message).toContain('a selector is {from?, kind, where}')
    expect(refused.error.message).toContain('{selector: {kind: "face", where: {type: "flatface"}}}')
  })
})

describe('no applier stores a selector object', () => {
  it('refuses an unresolved selector at the add and setter handlers', () => {
    const doc = seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
    const selector = { selector: { kind: 'face' } }
    expect(() => mutationHandlers.add_wrap(doc, {
      type: 'add_wrap', featureId: 'wr1', sketchQuery: '$sk1', target: selector,
    })).toThrow(/\{selector\}/)
    expect(() => mutationHandlers.add_delete_face(doc, {
      type: 'add_delete_face', featureId: 'df1', faces: [selector],
    })).toThrow(/\{selector\}/)
    expect(() => mutationHandlers.add_move_face(doc, {
      type: 'add_move_face', featureId: 'mf1', faces: [selector],
    })).toThrow(/\{selector\}/)
    expect(() => mutationHandlers.set_wrap_field(doc, {
      type: 'set_wrap_field', featureId: 'wr1', field: 'target', value: selector,
    })).toThrow(/\{selector\}/)
    expect(doc.features?.some(feature => ['wr1', 'df1', 'mf1'].includes(feature.id))).toBe(false)
  })
})
