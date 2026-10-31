// @vitest-environment node
//
// The value side of the drive boundary: a mutation whose field names and JSON
// types are right but whose value the field (or the document) cannot hold is a
// named refusal, not an ok with an unchanged or corrupted document. One test per
// live-practice finding keeps the reproduction pinned, and the table check
// proves every mutation type decided what its values may be.
//
// Finding 9 (an unclosed profile) is deliberately not here: it is not an input
// refusal. The extrude/revolve kernel already names it ("no closed profile
// found in the referenced sketch"); the feature-status reply is what carries
// that message to an agent (feature/mcp-feature-status.md).

import { describe, it, expect } from 'vitest'
import { MUTATION_CATALOG, MUTATION_VALUE_RULES, validateMutation, mutationInfoOf } from '../mutationCatalog'
import type { Mutation, PartDoc } from '@/types/cad'
import { ENTITY_BY_KIND } from '@/registry/entityRegistry'
import { seedBuiltins, runHeadless, emptyDriveDoc } from '../headlessOps'
import { loadPartDoc } from '@/persistence/docSchema'
import { featureParamsSchema } from '@/persistence/partDocSchema'
import { applySetPlaneDefinitionField } from '@/utils/yamlMutations/partStyle'
import { applySetHoleField } from '@/utils/yamlMutations/featureDefs'
import { FIELD_SETTER_KIND } from '../mutationCatalog'
import { EMPTY_REF_CLEARS } from '../mutationValues'

function seededDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] })
}

function sketchDoc(): PartDoc {
  return seedBuiltins({
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
    }],
  })
}

function refusal(raw: unknown, doc: PartDoc | null = null) {
  const result = validateMutation(raw, { doc })
  if (result.ok) throw new Error(`expected a refusal, got ok for ${JSON.stringify(raw)}`)
  return result.error
}

describe('value rules cover the catalog', () => {
  it('has one row per mutation type', () => {
    expect(Object.keys(MUTATION_VALUE_RULES).sort()).toEqual(Object.keys(MUTATION_CATALOG).sort())
  })

  // One wrong value per rule, so a rule that silently stops refusing fails
  // here. A row that says 'none' must have no sample: the applier owns it.
  const WRONG_VALUE_CASES: Array<[Mutation['type'], Record<string, unknown>]> = [
    ['move_entity', { type: 'move_entity', featureId: 'sk1', entityId: 'l1', delta: [1] }],
    ['resize_circle', { type: 'resize_circle', featureId: 'sk1', entityId: 'c1', radius: 0 }],
    ['add_constraint', { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['$a start'] }],
    ['set_constraint_pos', { type: 'set_constraint_pos', featureId: 'sk1', constraintId: 'c1', pos: [0] }],
    ['delete', { type: 'delete', targets: ['sk1/l1'] }],
    ['add_entity', { type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 1, 0, 90, 180] }],
    ['insert_fit_point', { type: 'insert_fit_point', featureId: 'sk1', entityId: 'sp1', index: -1, point: [0, 0] }],
    ['set_fit_spline_handle', { type: 'set_fit_spline_handle', featureId: 'sk1', entityId: 'sp1', end: 'middle', handle: [0, 0] }],
    ['add_entity_with_constraint', {
      type: 'add_entity_with_constraint', featureId: 'sk1', kind: 'arc', params: [0, 0, 1, 0, 90, 180],
      vertexKey: 'start', constraintKind: 'coincident',
    }],
    ['add_projected_entity', { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '' }],
    ['add_rect', { type: 'add_rect', featureId: 'sk1', p0: [0], p1: [1, 1] }],
    ['add_center_rect', { type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [1] }],
    ['add_ngon', { type: 'add_ngon', featureId: 'sk1', center: [0, 0], corner: [1, 1], sides: 2 }],
    ['apply_offset', { type: 'apply_offset', featureId: 'sk1', sourceIds: [], distance: 2 }],
    ['mirror_entities', { type: 'mirror_entities', featureId: 'sk1', sourceIds: [], line: 'l1' }],
    ['toggle_construction', { type: 'toggle_construction', targets: ['l1'] }],
    ['set_feature_plane', { type: 'set_feature_plane', featureId: 'sk1', plane: '' }],
    ['add_sketch', { type: 'add_sketch', featureId: 'sk1', plane: 'a plane with spaces' }],
    ['add_sketch', { type: 'add_sketch', featureId: 'sk1', plane: { selector: { kind: 'face' } } }],
    ['add_plane', { type: 'add_plane', featureId: 'p1', definition: { mode: 'nope' } }],
    ['set_plane_definition_field', { type: 'set_plane_definition_field', featureId: 'p1', field: 'mode', value: 'nope' }],
    ['add_extrude', { type: 'add_extrude', featureId: 'ex1', sketchQuery: '', distance: 5 }],
    ['add_extrude', { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, direction: 'sideways' }],
    ['add_extrude', { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'merge' }],
    ['add_extrude', { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, termination: 'touch' }],
    ['add_extrude', {
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5,
      termination: 'up_to', up_to: '$sk1',
    }],
    ['add_boolean', { type: 'add_boolean', featureId: 'bo1', operation: 'difference' }],
    ['add_boolean', { type: 'add_boolean', featureId: 'bo1', tools: [''] }],
    ['set_extrude_field', { type: 'set_extrude_field', featureId: 'ex1', field: 'operation', value: 'copy' }],
    ['add_extrude_profile', { type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '' }],
    ['remove_extrude_profile', { type: 'remove_extrude_profile', featureId: 'ex1', index: -1 }],
    ['add_revolve', { type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 0, axis: '@sk1/ax' }],
    ['set_revolve_field', { type: 'set_revolve_field', featureId: 'rv1', field: 'angle', value: 0 }],
    ['add_revolve_profile', { type: 'add_revolve_profile', featureId: 'rv1', sketchQuery: '' }],
    ['remove_revolve_profile', { type: 'remove_revolve_profile', featureId: 'rv1', index: -1 }],
    ['add_sweep', { type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk1', pathQuery: '' }],
    ['set_sweep_field', { type: 'set_sweep_field', featureId: 'sw1', field: 'operation', value: 'copy' }],
    ['add_sweep_profile', { type: 'add_sweep_profile', featureId: 'sw1', sketchQuery: '' }],
    ['remove_sweep_profile', { type: 'remove_sweep_profile', featureId: 'sw1', index: -1 }],
    ['add_sweep_path', { type: 'add_sweep_path', featureId: 'sw1', pathQuery: '' }],
    ['remove_sweep_path', { type: 'remove_sweep_path', featureId: 'sw1', index: -1 }],
    ['add_import_step', { type: 'add_import_step', featureId: 'im1', fileId: '' }],
    ['add_split', { type: 'add_split', featureId: 'sp1', keep: 'top' }],
    ['set_split_field', { type: 'set_split_field', featureId: 'sp1', field: 'keep', value: 'top' }],
    ['add_split_body', { type: 'add_split_body', featureId: 'sp1', bodyQuery: '' }],
    ['remove_split_body', { type: 'remove_split_body', featureId: 'sp1', index: -1 }],
    ['add_fillet', { type: 'add_fillet', featureId: 'fi1', edges: [''], radius: 2 }],
    ['set_fillet_field', { type: 'set_fillet_field', featureId: 'fi1', field: 'radius', value: {} }],
    ['add_chamfer', { type: 'add_chamfer', featureId: 'ch1', edges: [''], distance: 2 }],
    ['set_chamfer_field', { type: 'set_chamfer_field', featureId: 'ch1', field: 'kind', value: 'radius' }],
    ['add_fillet_edge', { type: 'add_fillet_edge', featureId: 'fi1', edgeQuery: '' }],
    ['remove_fillet_edge', { type: 'remove_fillet_edge', featureId: 'fi1', index: -1 }],
    ['add_chamfer_edge', { type: 'add_chamfer_edge', featureId: 'ch1', edgeQuery: '' }],
    ['remove_chamfer_edge', { type: 'remove_chamfer_edge', featureId: 'ch1', index: -1 }],
    ['set_shell_field', { type: 'set_shell_field', featureId: 'sh1', field: 'direction', value: 'sideways' }],
    ['add_shell', { type: 'add_shell', featureId: 'sh1', faces: [''], thickness: 1 }],
    ['add_shell', { type: 'add_shell', featureId: 'sh1', faces: [{ selector: { kind: 'face' } }], thickness: 1 }],
    ['add_shell', { type: 'add_shell', featureId: 'sh1', direction: 'sideways' }],
    ['add_shell_face', { type: 'add_shell_face', featureId: 'sh1', faceQuery: '' }],
    ['remove_shell_face', { type: 'remove_shell_face', featureId: 'sh1', index: -1 }],
    ['set_move_face_field', { type: 'set_move_face_field', featureId: 'mf1', field: 'distance', value: {} }],
    ['add_move_face_ref', { type: 'add_move_face_ref', featureId: 'mf1', faceQuery: '' }],
    ['remove_move_face_ref', { type: 'remove_move_face_ref', featureId: 'mf1', index: -1 }],
    ['add_delete_face', { type: 'add_delete_face', featureId: 'df1', faces: [''] }],
    ['add_delete_face_ref', { type: 'add_delete_face_ref', featureId: 'df1', faceQuery: '' }],
    ['remove_delete_face_ref', { type: 'remove_delete_face_ref', featureId: 'df1', index: -1 }],
    ['set_boolean_field', { type: 'set_boolean_field', featureId: 'bo1', field: 'operation', value: 'copy' }],
    ['add_boolean_tool', { type: 'add_boolean_tool', featureId: 'bo1', tool: '' }],
    ['remove_boolean_tool', { type: 'remove_boolean_tool', featureId: 'bo1', tool: '' }],
    ['set_array_field', { type: 'set_array_field', featureId: 'ar1', field: 'mode', value: 'polar' }],
    ['add_array', { type: 'add_array', featureId: 'ar1', mode: 'polar' }],
    ['add_circular_array', { type: 'add_circular_array', featureId: 'ca1', operation: 'cut' }],
    ['set_circular_array_field', { type: 'set_circular_array_field', featureId: 'ca1', field: 'operation', value: 'cut' }],
    ['add_delete_body', { type: 'add_delete_body', featureId: 'db1', bodies: [''] }],
    ['add_delete_body_ref', { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: '' }],
    ['remove_delete_body_ref', { type: 'remove_delete_body_ref', featureId: 'db1', index: -1 }],
    ['set_hole_field', { type: 'set_hole_field', featureId: 'ho1', field: 'sketch', value: '' }],
    ['add_hole', { type: 'add_hole', featureId: 'ho1', style: 'spotface' }],
    ['set_transform_field', { type: 'set_transform_field', featureId: 'tr1', field: 'operation', value: 'copy' }],
    ['add_transform_body', { type: 'add_transform_body', featureId: 'tr1', bodyQuery: '' }],
    ['remove_transform_body', { type: 'remove_transform_body', featureId: 'tr1', index: -1 }],
    ['rename_part', { type: 'rename_part', bodyId: 'b1', name: '' }],
    ['set_part_color', { type: 'set_part_color', bodyId: 'b1', color: '' }],
    ['set_part_transparency', { type: 'set_part_transparency', bodyId: 'b1', transparency: 2 }],
    ['set_part_metalness', { type: 'set_part_metalness', bodyId: 'b1', metalness: -1 }],
    ['set_part_roughness', { type: 'set_part_roughness', bodyId: 'b1', roughness: 2 }],
    ['set_part_transmission', { type: 'set_part_transmission', bodyId: 'b1', transmission: -0.5 }],
    ['add_mirror', { type: 'add_mirror', featureId: 'mi1', keep_original: 'yes' }],
    ['set_mirror_field', { type: 'set_mirror_field', featureId: 'mi1', field: 'merge', value: 'yes' }],
    ['set_variable_field', { type: 'set_variable_field', featureId: 'va1', field: 'value', value: 'three' }],
    ['add_helix', { type: 'add_helix', featureId: 'he1', reference: 'a helix with spaces' }],
    ['set_helix_field', { type: 'set_helix_field', featureId: 'he1', field: 'hand', value: 'up' }],
    ['reorder_features', { type: 'reorder_features', featureId: 'ex1', toIndex: -1 }],
    ['reorder_pick_field', { type: 'reorder_pick_field', featureId: 'ex1', field: 'sketch', fromIndex: -1, toIndex: 0 }],
  ]

  it('refuses the wrong value for every rule that owns one', () => {
    const covered = new Set(WRONG_VALUE_CASES.map(([type]) => type))
    const missing = (Object.entries(MUTATION_VALUE_RULES) as Array<[Mutation['type'], unknown]>)
      .filter(([type, rule]) => rule !== 'none' && !covered.has(type))
      .map(([type]) => type)
    expect(missing).toEqual([])
  })

  it.each(WRONG_VALUE_CASES)('%s refuses its wrong value with a naming message', (type, mutation) => {
    const error = refusal(mutation)
    expect(['invalid-mutation', 'unknown-target']).toContain(error.code)
    expect(error.message.length).toBeGreaterThan(20)
    expect(error.message).not.toBe(`mutation type "${type}" is invalid`)
  })

  // The empty-clear table is a decision, not a list: a field it names is cleared
  // by "" and must therefore be a ref the kind's schema makes optional, because
  // deleting a required key would save a document the loader refuses. Each add
  // row shares its Set object with the setter that writes the same keys, so the
  // two paths cannot drift.
  it('clears only optional ref fields, and the add row mirrors its setter', () => {
    expect(EMPTY_REF_CLEARS.add_extrude).toBe(EMPTY_REF_CLEARS.set_extrude_field)
    expect(EMPTY_REF_CLEARS.add_hole).toBe(EMPTY_REF_CLEARS.set_hole_field)
    for (const [type, fields] of Object.entries(EMPTY_REF_CLEARS)) {
      if (!type.startsWith('set_')) continue
      const kind = FIELD_SETTER_KIND[type as keyof typeof FIELD_SETTER_KIND]
      expect(kind, type).toBeDefined()
      const params = featureParamsSchema(kind)!
      const required = (params.required as string[] | undefined) ?? []
      const properties = params.properties as Record<string, Record<string, unknown>>
      for (const field of fields) {
        expect(required, `${type}.${field}`).not.toContain(field)
        expect(typeof properties[field]?.pattern, `${type}.${field}`).toBe('string')
      }
    }
  })

  it('skips the value rules on the replay path', () => {
    // An old journal the app produced must still replay, even if today's rules
    // would refuse the same value from a script.
    const arc = { type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 1, 0, 90, 180] }
    expect(validateMutation(arc, { allowInternal: true })).toMatchObject({ ok: true })
  })
})

describe('finding 1: add_entity param count', () => {
  it('refuses an arc with 6 params and names the expected shape', () => {
    const error = refusal({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 5, 0, 90, 180] })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('arc takes 5 params')
    for (const name of ['cx', 'cy', 'radius', 'angle_start_deg', 'angle_end_deg']) {
      expect(error.message).toContain(name)
    }
    expect(error.message).toContain('got 6')
  })

  it('accepts the 5-param arc', () => {
    expect(validateMutation({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 5, 0, 90] }))
      .toMatchObject({ ok: true })
  })

  it('reads every entity kind\'s arity from the registry', () => {
    // The rule prints names beside the count; the count is the registry's, so a
    // renamed or resized entity kind cannot leave the two out of step.
    for (const kind of ['line', 'circle', 'arc', 'ellipse', 'spline', 'point'] as const) {
      const count = ENTITY_BY_KIND.get(kind)?.paramCount
      expect(count, kind).toBeDefined()
      const params = Array.from({ length: count! }, (_, i) => i)
      expect(validateMutation({ type: 'add_entity', featureId: 'sk1', kind, params }), kind)
        .toMatchObject({ ok: true })
      const longer = [...params, 1]
      const result = validateMutation({ type: 'add_entity', featureId: 'sk1', kind, params: longer })
      expect(result, kind).toMatchObject({ ok: false })
      if (!result.ok) expect(result.error.message).toContain(`${kind} takes ${count} params`)
    }
  })

  it('refuses an unknown entity kind and a non-finite param', () => {
    const kind = refusal({ type: 'add_entity', featureId: 'sk1', kind: 'hexagon', params: [0, 0] })
    expect(kind.message).toContain('hexagon')
    const finite = refusal({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 'ten', 0] })
    expect(finite.message).toContain('param 2 (end_x)')
  })
})

describe('finding 2: arc angles are degrees', () => {
  it('refuses a zero-span arc and hints when the pair looks like radians', () => {
    const error = refusal({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 5, 0, 0] })
    expect(error.message).toContain('degrees')
    expect(error.message).toContain('no extent')
    expect(error.message).toContain('looks like radians')
  })

  it('does not hint outside one turn, and accepts a normal degree arc', () => {
    const wide = refusal({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 5, 400, 400] })
    expect(wide.message).not.toContain('looks like radians')
    expect(validateMutation({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, 5, 0, 90] }))
      .toMatchObject({ ok: true })
  })
})

describe('findings 3 and 4: setter values and REF fields', () => {
  it('refuses an operation outside the schema enum', () => {
    const error = refusal({
      type: 'set_transform_field', featureId: 'tr1', field: 'operation', value: 'copy',
    })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('"new"')
    expect(error.message).toContain('"replace"')
    expect(error.message).toContain('"copy"')
  })

  it('refuses an axis name where a query ref is required', () => {
    const error = refusal({
      type: 'set_transform_field', featureId: 'tr1', field: 'rotation_axis', value: 'y',
    })
    expect(error.message).toContain('@sk1/<lineId>')
    expect(error.message).toContain('direction vector')
  })

  it('refuses a feature-level $ ref and accepts the @ spelling', () => {
    const error = refusal({
      type: 'set_revolve_field', featureId: 'rv1', field: 'axis', value: '$sk1/line1',
    })
    expect(error.message).toContain('never starts with "$"')
    expect(error.message).toContain('@<featureId>/<elementId>')
    expect(validateMutation({
      type: 'set_revolve_field', featureId: 'rv1', field: 'axis', value: '@sk1/line1',
    })).toMatchObject({ ok: true })
  })

  it('keeps null as the documented clear', () => {
    expect(validateMutation({ type: 'set_transform_field', featureId: 'tr1', field: 'rotation_axis', value: null }))
      .toMatchObject({ ok: true })
  })
})

describe('finding 5: add_constraint target spelling', () => {
  it('refuses a target with a space and names the accepted forms', () => {
    const error = refusal({
      type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['$a start', 'entity:sk1:l1'],
    })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('$a start')
    expect(error.message).toContain('entity:<sketchId>:<entityId>')
    expect(error.message).toContain('vertex:<sketchId>:<entityId>:<vertexKey>')
  })

  it('refuses a bare target that is not a reference spelling', () => {
    const error = refusal({
      type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['nonsense'],
    })
    expect(error.message).toContain('names no recognised reference')
  })

  it('refuses an unknown constraint kind', () => {
    const error = refusal({
      type: 'add_constraint', featureId: 'sk1', kind: 'perpendicular', targets: ['entity:sk1:l1'],
    })
    expect(error.message).toContain('perpendicular')
    expect(error.message).toContain('coincident')
  })

  it('accepts the entity and vertex spellings', () => {
    expect(validateMutation({
      type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
      targets: ['entity:sk1:l1', 'vertex:sk1:l1:start'],
    })).toMatchObject({ ok: true })
  })
})

describe('finding: mirror_entities values', () => {
  it('refuses a non-line axis and a degenerate one, naming the line', () => {
    const doc = sketchDoc()
    doc.features[0].entities = [
      ...(doc.features[0].entities ?? []),
      { id: 'c9', kind: 'circle' },
      { id: 'lz', kind: 'line' },
    ] as PartDoc['features']
    doc.features[0].initial = { ...doc.features[0].initial, c9: [0, 0, 3], lz: [4, 4, 4, 4] } as never
    const notALine = refusal(
      { type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1'], line: 'c9' }, doc)
    expect(notALine.code).toBe('invalid-mutation')
    expect(notALine.message).toContain('c9')
    expect(notALine.message).toContain('line')

    const zeroLength = refusal(
      { type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1'], line: 'lz' }, doc)
    expect(zeroLength.code).toBe('invalid-mutation')
    expect(zeroLength.message).toContain('lz')
  })

  it('refuses an axis that is also one of the sources', () => {
    const doc = sketchDoc()
    const error = refusal({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1'], line: 'l1' }, doc)
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('mirrored')
  })

  it('refuses unknown source and axis ids', () => {
    const source = refusal({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l2'], line: 'l1' }, sketchDoc())
    expect(source.code).toBe('unknown-target')
    expect(source.message).toContain('l2')
    const axis = refusal({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1'], line: 'l1b' }, sketchDoc())
    expect(axis.code).toBe('unknown-target')
    expect(axis.message).toContain('l1b')
  })

  it('accepts a normal line and a construction line as the axis', () => {
    const withAxis = sketchDoc()
    withAxis.features[0].entities = [
      ...(withAxis.features[0].entities ?? []),
      { id: 'ax', kind: 'line', construction: true },
      { id: 'l2', kind: 'line' },
    ] as PartDoc['features']
    withAxis.features[0].initial = {
      ...withAxis.features[0].initial,
      ax: [0, -5, 0, 5],
      l2: [2, 2, 2, 7],
    } as never
    expect(validateMutation({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1', 'l2'], line: 'ax' }, withAxis))
      .toMatchObject({ ok: true })
  })
})

describe('finding: plane refs are exact, not silently replaced by XY', () => {
  it('refuses a lowercase builtin name and lists the valid planes', () => {
    const error = refusal({ type: 'add_sketch', featureId: 'sk1', plane: 'top' }, seededDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('"top"')
    expect(error.message).toContain('@builtin_plane_top')
    expect(error.message).toContain('Front')
    expect(error.message).toContain('case-sensitive')
  })

  it('accepts the seeded spellings, a plane feature and a face query', () => {
    const withPlane = seededDoc()
    withPlane.features = [
      ...(withPlane.features ?? []),
      { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } },
    ] as PartDoc['features']
    for (const plane of ['Top', '@builtin_plane_top', 'pl1', '@pl1', '?15,4,9;@cls_yp:flatface']) {
      expect(validateMutation({ type: 'add_sketch', featureId: 'sk1', plane }, { doc: withPlane }), plane)
        .toMatchObject({ ok: true })
    }
    expect(validateMutation({ type: 'set_feature_plane', featureId: 'sk1', plane: 'Front' }, { doc: withPlane }))
      .toMatchObject({ ok: true })
  })

  it('refuses an invented @ ref too', () => {
    const error = refusal({ type: 'set_feature_plane', featureId: 'sk1', plane: '@nope' }, seededDoc())
    expect(error.message).toContain('@nope')
    expect(error.message).toContain('@builtin_plane_front')
  })

  it('fails the headless run step and leaves the sketch out of the document', async () => {
    const result = await runHeadless({
      doc: seededDoc(),
      steps: [{ mutation: { type: 'add_sketch', featureId: 'sk1', plane: 'top' } }],
    })
    expect(result.outcome.steps[0]).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    expect(result.doc?.features?.map(feature => feature.id)).not.toContain('sk1')
  })
})

describe('finding: resize_circle names its target', () => {
  const circleDoc = (): PartDoc => seedBuiltins({
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [
        { id: 'c1', kind: 'circle' },
        { id: 'l1', kind: 'line' },
      ],
      initial: { c1: [0, 0, 5], l1: [0, 0, 10, 0] },
    }],
  })

  it('refuses an unknown entity id with it named', () => {
    const error = refusal({
      type: 'resize_circle', featureId: 'sk1', entityId: 'ghost', radius: 2,
    }, circleDoc())
    expect(error.code).toBe('unknown-target')
    expect(error.message).toContain('ghost')
    expect(error.message).toContain('sk1')
  })

  it('refuses a non-circle entity and a missing sketch by name', () => {
    const line = refusal({ type: 'resize_circle', featureId: 'sk1', entityId: 'l1', radius: 2 }, circleDoc())
    expect(line.message).toContain('l1')
    expect(line.message).toContain('not a circle')
    const sketch = refusal({ type: 'resize_circle', featureId: 'nope', entityId: 'c1', radius: 2 }, circleDoc())
    expect(sketch.code).toBe('unknown-target')
    expect(sketch.message).toContain('nope')
  })

  it('accepts a real circle and rejects a ghost through the headless boundary', async () => {
    expect(validateMutation({ type: 'resize_circle', featureId: 'sk1', entityId: 'c1', radius: 2 }, { doc: circleDoc() }))
      .toMatchObject({ ok: true })
    const result = await runHeadless({
      doc: circleDoc(),
      steps: [{ mutation: { type: 'resize_circle', featureId: 'sk1', entityId: 'ghost', radius: 2 } }],
    })
    expect(result.outcome.steps[0]).toMatchObject({ ok: false, error: { code: 'unknown-target' } })
  })
})

describe('finding: add_fillet takes a whole edge set', () => {
  it('accepts edges and a number or expression radius in one step', () => {
    expect(validateMutation({
      type: 'add_fillet', featureId: 'fi1', edges: ['?e1', '?e2'], radius: 0.125,
    })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_fillet', featureId: 'fi1', edges: ['?e1'], radius: 'wall / 2',
    })).toMatchObject({ ok: true })
  })

  it('refuses a non-positive radius and an empty name in the edge list', () => {
    expect(refusal({ type: 'add_fillet', featureId: 'fi1', radius: 0 }).message).toContain('positive')
    const edge = refusal({ type: 'add_fillet', featureId: 'fi1', edges: ['?e1', ''] })
    expect(edge.message).toContain('edges[1]')
  })
})

describe('finding 6: delete targets', () => {
  it.each(['l1', 'sk1/l1', '@sk1/l1'])('refuses %s as a delete target', (target) => {
    const error = refusal({ type: 'delete', targets: [target] })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('entity:<sketchId>:<entityId>')
  })

  it('refuses a well-formed target that names nothing', () => {
    const error = refusal({ type: 'delete', targets: ['entity:sk1:ghost'] }, sketchDoc())
    expect(error.code).toBe('unknown-target')
    expect(error.message).toContain('ghost')
  })

  it('accepts an existing entity through the headless boundary and changes the doc', async () => {
    const result = await runHeadless({
      doc: sketchDoc(),
      steps: [
        { mutation: { type: 'delete', targets: ['entity:sk1:l1'] } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 1], entityId: 'p1' } },
      ],
    })
    expect(result.outcome.steps.map(step => step.ok)).toEqual([true, true])
  })

  it('reports the ghost target as a step failure through the headless boundary', async () => {
    const result = await runHeadless({
      doc: sketchDoc(),
      steps: [{ mutation: { type: 'delete', targets: ['entity:sk1:ghost'] } }],
    })
    expect(result.outcome.steps[0]).toMatchObject({
      ok: false,
      error: { code: 'unknown-target' },
    })
    if (result.outcome.steps[0].error) expect(result.outcome.steps[0].error.message).toContain('ghost')
  })
})

describe('finding: toggle_construction target form', () => {
  it.each(['l1', 'sk1/l1', '@sk1/l1', 'vertex:sk1:l1:start'])('refuses %s naming the entity form', (target) => {
    const error = refusal({ type: 'toggle_construction', targets: [target] })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('entity:<sketchId>:<entityId>')
  })

  it('refuses a well-formed target that names nothing', () => {
    const error = refusal({ type: 'toggle_construction', targets: ['entity:sk1:ghost'] }, sketchDoc())
    expect(error.code).toBe('unknown-target')
    expect(error.message).toContain('ghost')
  })

  it('toggles an existing entity when the target names it', () => {
    expect(validateMutation({ type: 'toggle_construction', targets: ['entity:sk1:l1'] }, { doc: sketchDoc() }))
      .toMatchObject({ ok: true })
  })
})

describe('finding: add_revolve axis is a required pick', () => {
  it('refuses a $ ref in axis and names the feature-level form', () => {
    const error = refusal({ type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 90, axis: '$sk1' })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('"$"')
    expect(error.message).toContain('@<featureId>/<elementId>')
  })

  it('accepts an inline sketch ref or an edge query', () => {
    expect(validateMutation({
      type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 90, axis: '@sk1/ax',
    })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 90, axis: '?body:edge',
    })).toMatchObject({ ok: true })
  })
})

describe('finding 7: duplicate entity ids', () => {
  it('refuses add_entity with an id the sketch already holds', () => {
    const error = refusal({
      type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l1',
    }, sketchDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('l1')
    expect(error.message).toContain('already exists')
  })

  it('accepts a fresh id and leaves one entity per id', async () => {
    const result = await runHeadless({
      doc: sketchDoc(),
      steps: [
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l2' } },
      ],
    })
    expect(result.outcome.steps[0]).toMatchObject({ ok: true, createdIds: ['l2'] })
    const entities = result.doc?.features?.find(feature => feature.id === 'sk1')
    if (entities?.kind !== 'sketch') throw new Error('unreachable')
    expect(entities.entities?.map(entity => entity.id)).toEqual(['l1', 'l2'])
  })

  it('refuses the same duplicate through the headless boundary', async () => {
    const result = await runHeadless({
      doc: sketchDoc(),
      steps: [
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l1' } },
      ],
    })
    expect(result.outcome.steps[0]).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
  })

  it('refuses a duplicate entity id in a loaded sketch', () => {
    const loaded = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'l1', kind: 'line' }],
      }],
    }, { name: 'duplicate-entity' })
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error.field).toBe('features[0].entities[1].id')
    expect(loaded.error.message).toContain('duplicates entity id')
  })
})

describe('finding 8: hole field values', () => {
  it('refuses an empty hole sketch', () => {
    const error = refusal({
      type: 'set_hole_field', featureId: 'ho1', field: 'sketch', value: '',
    })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('non-empty reference')
  })

  it('refuses an unknown hole field and accepts a real sketch ref', () => {
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'diameterx', value: 8 }).message)
      .toContain('diameterx')
    expect(validateMutation({
      type: 'set_hole_field', featureId: 'ho1', field: 'sketch', value: '@sk1',
    })).toMatchObject({ ok: true })
  })
})

// Batch B docs finding: the note promised "an empty value clears any other
// field" while the boundary refused it for `target` (a ref) and for every enum.
// The rule is now one sentence: an empty string clears only the optional ref
// picks the value table names, and every other field refuses it.
describe('batch B: an empty value is the clear of a pick, not of any field', () => {
  it('accepts an empty target on the setter and on the inline add', () => {
    expect(validateMutation({
      type: 'set_hole_field', featureId: 'ho1', field: 'target', value: '',
    })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_hole', featureId: 'ho1', sketch: '@sk1', diameter: 4,
      depth_mode: 'through_all', target: '',
    })).toMatchObject({ ok: true })
    // The up_to twin, already accepted, keeps the same shape.
    expect(validateMutation({
      type: 'set_extrude_field', featureId: 'ex1', field: 'up_to', value: '',
    })).toMatchObject({ ok: true })
  })

  it('refuses an empty value on a field that must hold a reference, an enum member or a value', () => {
    // A ref the caller still has to name.
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'sketch', value: '' }).message)
      .toContain('non-empty reference')
    // A whitespace-only pick is not a clear either: the ref rule names it.
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'target', value: '  ' }).message)
      .toContain('non-empty reference')
    // The enums name their members instead of quietly taking the default.
    for (const [field, needle] of [['depth_mode', 'blind'], ['style', 'simple'], ['direction', 'normal']] as const) {
      expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field, value: '' }).message, field)
        .toContain(needle)
    }
    // A number-or-expression field takes a number or a real expression: a blank
    // expression would delete a key the document schema requires (diameter) or
    // silently drop a dimension (cb_diameter).
    for (const field of ['diameter', 'cb_diameter', 'cs_angle']) {
      const error = refusal({ type: 'set_hole_field', featureId: 'ho1', field, value: '' })
      expect(error.message, field).toContain('not an empty string')
    }
    expect(refusal({ type: 'add_hole', featureId: 'ho1', diameter: '' }).message)
      .toContain('not an empty string')
    expect(refusal({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: '' }).message)
      .toContain('not an empty string')
  })

  it('stores no target key when the clear runs through the drive', async () => {
    const cleared = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [{
        mutation: {
          type: 'add_hole', featureId: 'ho1', sketch: '@sk1', diameter: 4,
          depth_mode: 'through_all', target: '',
        },
      }],
    })
    const added = cleared.doc?.features?.find(feature => feature.id === 'ho1')
    if (added?.kind !== 'hole') throw new Error('the add_hole step stored no hole feature')
    expect(added.hole).toMatchObject({ diameter: 4, depth_mode: 'through_all' })
    // The empty string is the clear, so the key the solve would have to resolve
    // is simply absent and the hole drills the body its sites sit on.
    expect(added.hole).not.toHaveProperty('target')

    const setter = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        {
          mutation: {
            type: 'add_hole', featureId: 'ho2', sketch: '@sk1', diameter: 4,
            depth_mode: 'through_all', target: '@body_ex1',
          },
        },
        { mutation: { type: 'set_hole_field', featureId: 'ho2', field: 'target', value: '' } },
      ],
    })
    const edited = setter.doc?.features?.find(feature => feature.id === 'ho2')
    if (edited?.kind !== 'hole') throw new Error('the setter step lost the hole')
    expect(edited.hole).toMatchObject({ diameter: 4 })
    expect(edited.hole).not.toHaveProperty('target')
  })
})

// Review of the batch B notes: the first draft of the plane definition value
// note repeated the feature-setter sentence "a null value clears the field".
// For this mutation null is refused by the wire's scalar check for every
// definition field, and no applier path deletes a definition key, so a null is
// a refusal, not a clear. The fields are pinned one by one because the refusal
// comes from the shared scalar check while the blank refusal is per field.
describe('review: the plane definition setter cannot clear a field', () => {
  const PLANE_DEFINITION_FIELDS = [
    'mode', 'plane', 'offset', 'p1', 'p2', 'p3', 'point', 'line', 'edge', 'face', 'angle', 'rotation',
  ] as const

  it.each(PLANE_DEFINITION_FIELDS)('refuses null for %s with the scalar message', (field) => {
    const error = refusal({ type: 'set_plane_definition_field', featureId: 'p1', field, value: null })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('must be scalar, got null')
  })

  it.each(PLANE_DEFINITION_FIELDS)('refuses the empty string for %s and names the field', (field) => {
    const error = refusal({ type: 'set_plane_definition_field', featureId: 'p1', field, value: '' })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain(`field "${field}"`)
    expect(error.message).not.toContain('clears the field')
  })

  it('accepts a real value on every field', () => {
    for (const [field, value] of [
      ['mode', 'offset'], ['plane', '@builtin_plane_top'], ['offset', 5],
      ['p1', '@sk1/p1'], ['p2', '@sk1/p2'], ['p3', '@sk1/p3'], ['point', '@sk1/p1'],
      ['line', '@sk1/l1'], ['edge', '?edge'], ['face', '?face'], ['angle', 30],
      ['rotation', 'angle / 2'],
    ] as const) {
      expect(validateMutation({ type: 'set_plane_definition_field', featureId: 'p1', field, value }), field)
        .toMatchObject({ ok: true })
    }
  })

  // The blank-value sentence is one clause: the old tail said null clears the
  // field, which is not true for a required numeric field or for a plane
  // definition field, so it must not come back.
  it('states the blank refusal in one sentence, without a null-clear claim', () => {
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'diameter', value: '' }).message)
      .toBe('set_hole_field field "diameter" must be a value, not an empty string')
    expect(refusal({ type: 'set_plane_definition_field', featureId: 'p1', field: 'angle', value: '' }).message)
      .toBe('set_plane_definition_field field "angle" must be a value, not an empty string')
  })
})

// Review B1: a null-clear note may only sit on a row whose applier really
// deletes the key. Every feature setter ends at setFeatureField's delete
// branch (probed here through the hole setter); the plane definition applier
// has no such branch and writes the value verbatim, which is exactly why the
// boundary refuses null for it. The scan keeps a future verbatim row from
// claiming a clear its applier cannot perform.
describe('review B1 guard: a null-clear note needs a deleting applier', () => {
  // Deliberate bypass of the boundary: the wire refuses this null, and the
  // probe shows what the applier would persist if one ever reached it.
  it('stores a plane definition null verbatim, which is why the note refuses it', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'p1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 } }],
    }
    applySetPlaneDefinitionField(doc, 'p1', 'offset', null as unknown as string)
    const definition = (doc.features?.[0] as { definition?: Record<string, unknown> }).definition ?? {}
    expect('offset' in definition).toBe(true)
    expect(definition.offset).toBeNull()
  })

  it('deletes the key on null for a feature setter, the clear its note promises', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ho1', kind: 'hole', hole: { sketch: '@sk1', diameter: 2, depth_mode: 'blind', depth: 4 } }],
    }
    applySetHoleField(doc, 'ho1', 'depth', null)
    const hole = (doc.features?.[0] as { hole?: Record<string, unknown> }).hole ?? {}
    expect('depth' in hole).toBe(false)
  })

  // set_plane_definition_field is the only value row whose applier stores
  // verbatim (all other setter appliers delegate to setFeatureField); a new
  // verbatim row must join this list and pass the scan.
  it('promises no null clear on a row whose applier stores the value verbatim', () => {
    for (const type of ['set_plane_definition_field'] as const) {
      const row = mutationInfoOf(type)
      const notes = [row.note ?? '', ...Object.values(row.fields).map(info => info.note ?? '')].join(' ')
      expect(notes).not.toMatch(/null[^.]{0,40}clear/i)
      expect(row.fields.value.note ?? '').toContain('A null value is refused')
    }
  })
})

describe('birdhouse F2: apply_offset source ids', () => {
  it('refuses a source id that names no entity in the target sketch, naming it', () => {
    const error = refusal({
      type: 'apply_offset', featureId: 'sk1', sourceIds: ['l1', 'ghost'], distance: 2,
    }, sketchDoc())
    expect(error.code).toBe('unknown-target')
    expect(error.message).toContain('ghost')
    expect(error.message).toContain('sk1')
  })

  it('refuses an unknown sketch feature and accepts the real ids', () => {
    const missing = refusal({
      type: 'apply_offset', featureId: 'nope', sourceIds: ['l1'], distance: 2,
    }, sketchDoc())
    expect(missing.code).toBe('unknown-target')
    expect(missing.message).toContain('nope')

    expect(validateMutation({
      type: 'apply_offset', featureId: 'sk1', sourceIds: ['l1'], distance: 2,
    }, { doc: sketchDoc() })).toMatchObject({ ok: true })
  })

  it('reports the ghost id as a step failure and still offsets a real id', async () => {
    const ghost = await runHeadless({
      doc: sketchDoc(),
      steps: [{ mutation: { type: 'apply_offset', featureId: 'sk1', sourceIds: ['ghost'], distance: 2 } }],
    })
    expect(ghost.outcome.steps[0]).toMatchObject({ ok: false, error: { code: 'unknown-target' } })
    if (ghost.outcome.steps[0].error) expect(ghost.outcome.steps[0].error.message).toContain('ghost')

    const real = await runHeadless({
      doc: sketchDoc(),
      steps: [{ mutation: { type: 'apply_offset', featureId: 'sk1', sourceIds: ['l1'], distance: 2 } }],
    })
    expect(real.outcome.steps[0]).toMatchObject({ ok: true })
    // One clone entity plus the parallel constraint that ties it to the source.
    expect(real.outcome.steps[0].createdIds).toHaveLength(2)
  })
})

describe('hole styles: the new fields cross the same boundary', () => {
  it('accepts the style and its dimensions through the setter', () => {
    for (const [field, value] of [
      ['style', 'counterbore'], ['style', 'countersink'],
      ['cb_diameter', 8], ['cb_depth', 3], ['cs_angle', 82],
    ] as const) {
      expect(validateMutation({ type: 'set_hole_field', featureId: 'ho1', field, value }), field)
        .toMatchObject({ ok: true })
    }
  })

  it('refuses an unknown style through the setter', () => {
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'style', value: 'spotface' }).message)
      .toContain('simple')
  })

  it('accepts a fully configured hole in one add_hole payload', () => {
    expect(validateMutation({
      type: 'add_hole', featureId: 'ho1', label: 'Bolt hole', sketch: '@sk1', diameter: 4,
      depth_mode: 'through_all', depth: 10, direction: 'normal', target: '@body_ex1',
      style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    })).toMatchObject({ ok: true })
  })

  it('refuses a bad style in the add_hole payload', () => {
    const error = refusal({ type: 'add_hole', featureId: 'ho1', style: 'spotface' })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('simple')
  })
})

describe('finding: add_extrude carries the up-to termination inline', () => {
  it('accepts termination up_to with a plane ref', () => {
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to: '@pl1',
    })).toMatchObject({ ok: true })
  })

  it('accepts termination up_to with a face query or a body-face ref', () => {
    for (const upTo of ['?15,4,9;@u|flatface', '@body_ex1/face/2']) {
      expect(validateMutation({
        type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10,
        termination: 'up_to', up_to: upTo,
      }), upTo).toMatchObject({ ok: true })
    }
  })

  it('refuses a $ local ref and an unknown termination with the accepted spellings', () => {
    expect(refusal({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to: '$sk1',
    }).message).toContain('"$"')
    expect(refusal({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, termination: 'touch',
    }).message).toContain('blind')
  })

  it('treats a null termination and an empty or null up_to as the setter clear', () => {
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10,
      termination: null, up_to: null,
    })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10,
      termination: null, up_to: '',
    })).toMatchObject({ ok: true })
    // Both paths clear up_to with the empty string; the applier deletes the key.
    expect(validateMutation({
      type: 'set_extrude_field', featureId: 'ex1', field: 'up_to', value: '',
    })).toMatchObject({ ok: true })
    // The setter refuses an empty enum value, so the inline add does too.
    expect(refusal({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, termination: '',
    }).message).toContain('blind')
    expect(refusal({
      type: 'set_extrude_field', featureId: 'ex1', field: 'termination', value: '',
    }).message).toContain('blind')
    // The other inline fields still hold their schema values, so a blank
    // direction is refused rather than silently clearing to the default.
    expect(refusal({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, direction: '',
    }).message).toContain('normal')
  })
})

describe('the positive twin of a seeded script still validates', () => {
  it('accepts a normal box script step by step', async () => {
    const steps: Array<{ mutation: Mutation }> = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 } },
      { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 12 } },
    ]
    const result = await runHeadless({ doc: seededDoc(), steps })
    expect(result.outcome.steps.map(step => step.ok)).toEqual([true, true, true, true])
  })
})
