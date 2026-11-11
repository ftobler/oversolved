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
import { applySetPlaneDefinitionField } from '@/utils/yamlMutations/featureAdmin'
import { applySetHoleField } from '@/utils/yamlMutations/featureDefs'
import { FIELD_SETTER_KIND } from '../mutationCatalog'
import { EMPTY_REF_CLEARS } from '../mutationValues'
import { sketchAt } from '@/testing/featureAccess'
import { Repository } from '@/kernel/query'
import { collectExtrudeLoops } from '@/kernel/features/faceProfile'

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

function refusal(raw: unknown, doc: PartDoc | null = null, fileIds?: ReadonlySet<string>) {
  const result = validateMutation(raw, { doc, ...(fileIds === undefined ? {} : { fileIds }) })
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
    ['add_text', { type: 'add_text', featureId: 'sk1', text: 'Hi', size: 0 }],
    ['add_entity_with_constraint', {
      type: 'add_entity_with_constraint', featureId: 'sk1', kind: 'arc', params: [0, 0, 1, 0, 90, 180],
      vertexKey: 'start', constraintKind: 'coincident',
    }],
    ['add_projected_entity', { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '' }],
    ['add_rect', { type: 'add_rect', featureId: 'sk1', p0: [0], p1: [1, 1] }],
    ['add_center_rect', { type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [1] }],
    ['add_ngon', { type: 'add_ngon', featureId: 'sk1', center: [0, 0], corner: [1, 1], sides: 2 }],
    ['add_three_point_arc', { type: 'add_three_point_arc', featureId: 'sk1', start: [0], through: [1, 1], end: [2, 0] }],
    ['apply_offset', { type: 'apply_offset', featureId: 'sk1', sourceIds: [], distance: 2 }],
    ['mirror_entities', { type: 'mirror_entities', featureId: 'sk1', sourceIds: [], line: 'l1' }],
    ['fillet_corners', { type: 'fillet_corners', featureId: 'sk1', radius: 0,
      corners: [{ a: 'l1', aVertex: 'end', b: 'l2', bVertex: 'start' }] }],
    ['pattern_entities', { type: 'pattern_entities', featureId: 'sk1', sourceIds: ['l1'], mode: 'linear', count: 1, pitch: 5 }],
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
    ['add_boolean', { type: 'add_boolean', featureId: 'bo1', keep_tools: 'yes' }],
    ['set_extrude_field', { type: 'set_extrude_field', featureId: 'ex1', field: 'operation', value: 'copy' }],
    ['add_extrude_profile', { type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '' }],
    ['remove_extrude_profile', { type: 'remove_extrude_profile', featureId: 'ex1', index: -1 }],
    ['add_revolve', { type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 0, axis: '@sk1/ax' }],
    ['add_revolve', { type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 90, axis: '@sk1/ax', operation: 'subtract' }],
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
    ['import_dxf', { type: 'import_dxf', featureId: 'sk1', content: '' }],
    ['import_dxf', {
      type: 'import_dxf',
      featureId: 'sk1',
      content: '0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nBLOCK\n0\nENDSEC\n0\nEOF\n',
    }],
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
    ['add_shell', { type: 'add_shell', featureId: 'sh1', join: 'round' }],
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
    ['add_pattern', { type: 'add_pattern', featureId: 'pt1', mode: 'polar' }],
    ['add_pattern', { type: 'add_pattern', featureId: 'pt2', subject: 'body', operation: 'cut' }],
    ['set_pattern_field', { type: 'set_pattern_field', featureId: 'pt1', field: 'mode', value: 'polar' }],
    ['set_pattern_field', { type: 'set_pattern_field', featureId: 'pt1', field: 'operation', value: 'cut' }],
    ['add_delete_body', { type: 'add_delete_body', featureId: 'db1', bodies: [''] }],
    ['add_delete_body_ref', { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: '' }],
    ['remove_delete_body_ref', { type: 'remove_delete_body_ref', featureId: 'db1', index: -1 }],
    ['set_hole_field', { type: 'set_hole_field', featureId: 'ho1', field: 'sketch', value: '' }],
    ['add_hole', { type: 'add_hole', featureId: 'ho1', style: 'spotface' }],
    ['add_transform', { type: 'add_transform', featureId: 'tr1', operation: 'copy' }],
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
    ['set_length_unit', { type: 'set_length_unit', unit: 'in' }],
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

  // Null on a required field used to pass: the applier deleted the key and the
  // extrude quietly built 1 deep. Only optional fields take the clear.
  it('refuses null on a required field by name', () => {
    const error = refusal({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: null })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('"distance" is required')
    expect(refusal({ type: 'set_fillet_field', featureId: 'f1', field: 'radius', value: null }).message)
      .toContain('"radius" is required')
  })

  it('still clears an optional or only conditionally required field with null', () => {
    expect(validateMutation({ type: 'set_extrude_field', featureId: 'ex1', field: 'up_to', value: null }))
      .toMatchObject({ ok: true })
    expect(validateMutation({ type: 'set_hole_field', featureId: 'h1', field: 'depth', value: null }))
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
    const sketch = sketchAt(doc)
    sketch.entities = [
      ...(sketch.entities ?? []),
      { id: 'c9', kind: 'circle' },
      { id: 'lz', kind: 'line' },
    ]
    sketch.initial = { ...sketch.initial, c9: [0, 0, 3], lz: [4, 4, 4, 4] }
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

  // A source on the axis is its own image (the seam of a half profile), so it
  // rides along with real sources; only a step that would add nothing at all
  // is refused.
  function axisDoc(): PartDoc {
    const doc = sketchDoc()
    const sketch = sketchAt(doc)
    sketch.entities = [
      ...(sketch.entities ?? []),
      { id: 'ax', kind: 'line', construction: true },
      { id: 'on', kind: 'line' },
      { id: 'arc', kind: 'arc' },
    ]
    // `arc` is centred on the axis x=0 and sweeps symmetrically across it.
    sketch.initial = { ...sketch.initial, ax: [0, 0, 0, 10], on: [0, 2, 0, 6], arc: [0, 3, 1, 45, 135] }
    return doc
  }

  it('refuses a step whose every source mirrors to itself: there is nothing to add', () => {
    const error = refusal({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['on', 'arc'], line: 'ax' }, axisDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('every source mirrors to itself')
  })

  it('accepts a source on the axis next to one that does mirror', () => {
    expect(validateMutation({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1', 'on'], line: 'ax' }, { doc: axisDoc() }))
      .toMatchObject({ ok: true })
  })

  it('accepts a normal line and a construction line as the axis', () => {
    const withAxis = sketchDoc()
    const sketch = sketchAt(withAxis)
    sketch.entities = [
      ...(sketch.entities ?? []),
      { id: 'ax', kind: 'line', construction: true },
      { id: 'l2', kind: 'line' },
    ]
    sketch.initial = {
      ...sketch.initial,
      ax: [0, -5, 0, 5],
      l2: [2, 2, 2, 7],
    }
    expect(validateMutation({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['l1', 'l2'], line: 'ax' }, { doc: withAxis }))
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

describe('add_plane: the parent ref crosses the same plane vocabulary', () => {
  function planeDoc(): PartDoc {
    const doc = seededDoc()
    doc.features = [
      ...(doc.features ?? []),
      { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } },
    ] as PartDoc['features']
    return doc
  }

  // A plane id in the document passes this boundary check even when the log
  // defines it after the plane that references it: features solve in order, so
  // that is a solve-later exception, not a working forward reference.
  it('accepts a bare name, a builtin ref, a plane id and a face query on a parent mode', () => {
    for (const plane of ['Top', '@builtin_plane_top', 'pl1', '@pl1', '?15,4,9;@cls_yp:flatface']) {
      expect(validateMutation(
        { type: 'add_plane', featureId: 'pl2', definition: { mode: 'offset', plane, offset: 1 } },
        { doc: planeDoc() },
      ), plane).toMatchObject({ ok: true })
    }
  })

  it('refuses an unknown name and a lowercase spelling at the step, naming the valid planes', () => {
    for (const plane of ['Nope', 'top']) {
      const error = refusal(
        { type: 'add_plane', featureId: 'pl2', definition: { mode: 'offset', plane } },
        planeDoc(),
      )
      expect(error.code).toBe('invalid-mutation')
      expect(error.message).toContain(`"${plane}"`)
      expect(error.message).toContain('@builtin_plane_top')
      expect(error.message).toContain('case-sensitive')
    }
  })

  it('refuses an empty parent on a parent mode', () => {
    const error = refusal(
      { type: 'add_plane', featureId: 'pl2', definition: { mode: 'offset', plane: '' } },
      planeDoc(),
    )
    expect(error.message).toContain('non-empty reference')
  })

  it('leaves a stray plane on a mode that ignores it alone', () => {
    // The solver never reads `plane` on on_face, so a value refused on offset
    // must not start failing a write that solves.
    expect(validateMutation(
      { type: 'add_plane', featureId: 'pl2', definition: { mode: 'on_face', face: '?face', plane: 'Nope' } },
      { doc: planeDoc() },
    )).toMatchObject({ ok: true })
  })

  it('accepts an unknown plane when no document is supplied, because only the shape is knowable', () => {
    expect(validateMutation(
      { type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: 'Nope' } },
    )).toMatchObject({ ok: true })
  })

  it('checks a parent the definition carries before any mode is chosen', () => {
    const error = refusal({ type: 'add_plane', featureId: 'pl2', definition: { plane: 'Nope' } }, planeDoc())
    expect(error.message).toContain('@builtin_plane_front')
  })

  it('refuses the setter value the same way and accepts the legal spellings', () => {
    const bad = refusal(
      { type: 'set_plane_definition_field', featureId: 'pl1', field: 'plane', value: 'Nope' },
      planeDoc(),
    )
    expect(bad.message).toContain('@builtin_plane_front')
    expect(validateMutation(
      { type: 'set_plane_definition_field', featureId: 'pl1', field: 'plane', value: 'Top' },
      { doc: planeDoc() },
    )).toMatchObject({ ok: true })
  })

  it('skips the parent vocabulary when the stored definition uses a mode that ignores plane', () => {
    const doc = seededDoc()
    doc.features = [
      ...(doc.features ?? []),
      { id: 'plF', kind: 'plane', definition: { mode: 'on_face', face: '?face' } },
    ] as PartDoc['features']
    expect(validateMutation(
      { type: 'set_plane_definition_field', featureId: 'plF', field: 'plane', value: 'Nope' },
      { doc },
    )).toMatchObject({ ok: true })
  })

  it('checks a setter value when the stored definition has no mode yet', () => {
    const doc = seededDoc()
    doc.features = [...(doc.features ?? []), { id: 'plE', kind: 'plane' }] as PartDoc['features']
    const error = refusal(
      { type: 'set_plane_definition_field', featureId: 'plE', field: 'plane', value: 'Nope' },
      doc,
    )
    expect(error.message).toContain('@builtin_plane_front')
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

describe('finding: edge pick lists take inline selectors', () => {
  // The headless drive resolves a selector before the value rules, so the
  // selector form is a pick entry here rather than a plain-string list. A
  // surface with no solved body set refuses it by name instead of calling it a
  // malformed string list.
  it('recognises a selector entry in a fillet list and names the solved-body requirement', () => {
    const error = refusal({
      type: 'add_fillet', featureId: 'fi1',
      edges: [{ selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } }],
      radius: 1,
    })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('edges[0]')
    expect(error.message).toContain('solved bodies')
    expect(error.message).not.toContain('list of reference strings')
  })

  it('refuses a malformed selector entry on add_fillet, naming the entry', () => {
    const error = refusal({
      type: 'add_fillet', featureId: 'fi1', edges: [{ selector: 'nope' }], radius: 1,
    })
    expect(error.message).toContain('edges[0]')
    expect(error.message).toContain('{selector: <a select selector>}')
  })

  it('mirrors both cases on add_chamfer', () => {
    const selector = refusal({
      type: 'add_chamfer', featureId: 'ch1',
      edges: [{ selector: { kind: 'edge', where: { parallel: [0, 0, 1] } } }],
      distance: 1,
    })
    expect(selector.message).toContain('edges[0]')
    expect(selector.message).toContain('solved bodies')
    const malformed = refusal({
      type: 'add_chamfer', featureId: 'ch1', edges: [{ selector: 'nope' }], distance: 1,
    })
    expect(malformed.message).toContain('edges[0]')
    expect(malformed.message).toContain('{selector: <a select selector>}')
  })

  it('still refuses a non-pick object on both rows, naming the entry', () => {
    for (const [type, extra] of [
      ['add_fillet', { radius: 1 }],
      ['add_chamfer', { distance: 1 }],
    ] as const) {
      const error = refusal({ type, featureId: 'f1', edges: [{ foo: 1 }], ...extra })
      expect(error.code, type).toBe('invalid-mutation')
      expect(error.message, type).toContain('edges[0]')
      expect(error.message, type).toContain('{selector: <a select selector>}')
    }
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

describe('one profile and path ref grammar', () => {
  const FORMS = [
    '$sk1',
    '@sk1',
    'entity:sk1:l1',
    'vertex:sk1:l1:start',
    '@sk1/l1',
    '@body_ex1/face/2',
    '?15,4,9;@sk1/l1',
  ]

  it('accepts every leaf form on the inline adds and the profile/path rows', () => {
    const calls = (form: string): Array<Record<string, unknown>> => [
      { type: 'add_extrude', featureId: 'ex1', sketchQuery: form, distance: 5 },
      { type: 'add_revolve', featureId: 'rv1', sketchQuery: form, angle: 90, axis: '@sk1/ax' },
      { type: 'add_sweep', featureId: 'sw1', sketchQuery: form, pathQuery: '$path' },
      { type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk1', pathQuery: form },
      { type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: form },
      { type: 'add_revolve_profile', featureId: 'rv1', sketchQuery: form },
      { type: 'add_sweep_profile', featureId: 'sw1', sketchQuery: form },
      { type: 'add_sweep_path', featureId: 'sw1', pathQuery: form },
    ]
    for (const form of FORMS) {
      for (const call of calls(form)) {
        expect(validateMutation(call), `${String(call.type)} ${form}`).toMatchObject({ ok: true })
      }
    }
  })

  it('leaves the closed-loop refusal to the leaf after the boundary admits entity:', () => {
    // The boundary only knows the ref shape. A lone line is a valid pick there;
    // the extrude leaf is the layer that names the missing area.
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: 'entity:sk1:l1', distance: 5,
    })).toMatchObject({ ok: true })
    const repo = new Repository()
    repo.register('_pt_sk1', {
      origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
    })
    repo.register('_topo_sk1', {
      edges: [{ entity_id: 'l1', kind: 'line', start: [0, 0], end: [10, 0] }],
      surfaces: [],
    })
    expect(() => collectExtrudeLoops(
      null as never, null as never, null as never, 'entity:sk1:l1', repo, {},
    )).toThrow(/bounds no closed area/)
  })

  it('refuses malformed forms with every accepted spelling', () => {
    for (const form of ['entity:sk1', 'entity::l1', 'sk1', 'entity:sk1:l1 extra', '']) {
      const error = refusal({ type: 'add_extrude', featureId: 'ex1', sketchQuery: form, distance: 5 })
      expect(error.code, form).toBe('invalid-mutation')
      for (const spelling of ['$<sketchId>', '@<sketchId>', 'entity:<sketchId>:<entityId>', 'vertex:<sketchId>:<entityId>:<vertexKey>', '?']) {
        expect(error.message, `${form}: ${spelling}`).toContain(spelling)
      }
    }
  })
})

describe('reproduction: the inline add payloads the practice runs needed', () => {
  it('accepts each of the three one-step calls', () => {
    const calls: Array<Record<string, unknown>> = [
      { type: 'add_revolve', featureId: 'rv2', sketchQuery: '$sk1', angle: 360, axis: '@sk1/ax', operation: 'cut' },
      { type: 'add_transform', featureId: 't1', bodies: ['body_ex1'], operation: 'replace', translation: [0, 0, 5] },
      {
        type: 'add_boolean', featureId: 'b1', operation: 'subtract', target: 'body_ex1',
        tools: ['body_ex1_1'], keep_tools: true,
      },
    ]
    for (const call of calls) expect(validateMutation(call), JSON.stringify(call)).toMatchObject({ ok: true })
  })

  it('keeps the negative angle refused and names direction: "reverse"', () => {
    const error = refusal({ type: 'add_revolve', featureId: 'rv3', sketchQuery: '$sk1', angle: -180, axis: '@sk1/ax' })
    expect(error.message).toContain('direction')
    expect(error.message).toContain('reverse')
  })
})

describe('finding: the revolve angle is a positive magnitude', () => {
  it('refuses a negative angle and names direction: "reverse"', () => {
    const error = refusal({ type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: -180, axis: '@sk1/ax' })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('direction')
    expect(error.message).toContain('reverse')
    expect(error.message).toContain('-180')
  })

  it('gives set_revolve_field the same route', () => {
    const error = refusal({ type: 'set_revolve_field', featureId: 'rv1', field: 'angle', value: -90 })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('direction')
    expect(error.message).toContain('reverse')
  })

  it('accepts the inline operation and keep_tools spellings', () => {
    expect(validateMutation({
      type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 360, axis: '@sk1/ax', operation: 'cut',
    })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_boolean', featureId: 'bo1', keep_tools: true, clearance: 0.2,
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

describe('a circle is not a hole drill site', () => {
  function sketchWithPointAndCircle(): PartDoc {
    return seedBuiltins({
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }, { id: 'c1', kind: 'circle' }],
        initial: { p1: [0, 0], c1: [0, 0, 3] },
        constraints: [],
      }],
    })
  }

  it('refuses an entity or vertex add_hole sketch ref naming a circle, naming the extrude cut', () => {
    const doc = sketchWithPointAndCircle()
    for (const sketch of ['entity:sk1:c1', 'vertex:sk1:c1:center']) {
      const error = refusal({ type: 'add_hole', featureId: 'ho1', sketch, diameter: 4, depth_mode: 'through_all' }, doc)
      expect(error.code, sketch).toBe('invalid-mutation')
      expect(error.message, sketch).toContain("'c1' of sketch sk1 is a circle, which is not a drill site")
      expect(error.message, sketch).toContain('extrude cut')
    }
  })

  it('refuses the same circle through the sketch setter', () => {
    const error = refusal({
      type: 'set_hole_field', featureId: 'ho1', field: 'sketch', value: 'entity:sk1:c1',
    }, sketchWithPointAndCircle())
    expect(error.message).toContain('extrude cut')
  })

  it('accepts a point pick, a whole-sketch ref and a doc-unaware check', () => {
    // A whole-sketch ref is legal: the kernel drills its points and ignores its
    // circles. With no document the boundary only knows the ref's shape.
    const doc = sketchWithPointAndCircle()
    expect(validateMutation({
      type: 'add_hole', featureId: 'ho1', sketch: 'entity:sk1:p1', diameter: 4, depth_mode: 'through_all',
    }, { doc })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_hole', featureId: 'ho1', sketch: '@sk1', diameter: 4, depth_mode: 'through_all',
    }, { doc })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_hole', featureId: 'ho1', sketch: 'entity:sk1:c1', diameter: 4, depth_mode: 'through_all',
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
    'origin', 'rotation_axis', 'rotation_angle',
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
      // origin_rotation's settable spellings: a ref for the origin, a letter
      // for the axis, plain degrees for the angle.
      ['origin', '@sk1/p1'], ['rotation_axis', 'x'], ['rotation_angle', 45],
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

// origin_rotation is the one plane mode whose origin and axis arrive in two
// spellings (ref or coordinates). The drive boundary checks the shape and
// keeps the setter scalar-only; the kernel half (the required pair, the
// unresolvable origin) is pinned at run level in planeRunTests.
describe('origin_rotation: the new mode crosses the boundary in its scalar spellings', () => {
  const legal = (definition: Record<string, unknown>) =>
    validateMutation({ type: 'add_plane', featureId: 'pl1', definition })

  it('accepts the ref spelling and the coordinate spelling of origin and axis', () => {
    expect(legal({ mode: 'origin_rotation', origin: '@sk1/p1', rotation_axis: 'z', rotation_angle: 45 })).toMatchObject({ ok: true })
    expect(legal({ mode: 'origin_rotation', origin: [4, 5, 6], rotation_axis: [0, 1, 0], rotation_angle: 45 })).toMatchObject({ ok: true })
  })

  it('refuses a misspelled mode and names origin_rotation among the legal ones', () => {
    const error = refusal({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'origin_rotate' } })
    expect(error.message).toContain('origin_rotate')
    expect(error.message).toContain('origin_rotation')
  })

  it('refuses an unknown definition field by name', () => {
    const error = refusal({
      type: 'add_plane',
      featureId: 'pl1',
      definition: { mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: 'z', rotation_about: 45 },
    })
    expect(error.message).toContain('rotation_about')
    expect(error.message).toContain('no field')
  })

  it('refuses an empty origin ref instead of defaulting the plane somewhere', () => {
    const error = refusal({
      type: 'add_plane',
      featureId: 'pl1',
      definition: { mode: 'origin_rotation', origin: '', rotation_axis: 'z', rotation_angle: 45 },
    })
    expect(error.message).toContain('origin')
  })

  it('keeps the setter scalar-only, so the vector spellings stay in the definition', () => {
    const origin = refusal({ type: 'set_plane_definition_field', featureId: 'pl1', field: 'origin', value: [1, 2, 3] })
    expect(origin.message).toContain('must be scalar, got array')
    const axis = refusal({ type: 'set_plane_definition_field', featureId: 'pl1', field: 'rotation_axis', value: [0, 0, 1] })
    expect(axis.message).toContain('must be scalar, got array')
  })

  it('carries the mode and its fields in the add_plane note the client reads', () => {
    const note = mutationInfoOf('add_plane').note ?? ''
    expect(note).toContain('origin_rotation')
    expect(note).toContain('rotation_axis')
    expect(note).toContain('rotation_angle')
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

  it('accepts the drill-point tip and an angle expression, refuses an unknown tip', () => {
    for (const [field, value] of [['tip', 'drill_point'], ['tip', 'flat'], ['tip_angle', 135], ['tip_angle', '2*59']] as const) {
      expect(validateMutation({ type: 'set_hole_field', featureId: 'ho1', field, value }), field)
        .toMatchObject({ ok: true })
    }
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'tip', value: 'ball' }).message)
      .toContain('drill_point')
    expect(refusal({ type: 'add_hole', featureId: 'ho1', tip: 'ball' }).code).toBe('invalid-mutation')
  })

  it('accepts a tapped thread_depth as a number, an expression or a null clear', () => {
    for (const value of [15, 'depth * 0.75', null]) {
      expect(validateMutation({ type: 'set_hole_field', featureId: 'ho1', field: 'thread_depth', value }), String(value))
        .toMatchObject({ ok: true })
    }
    expect(validateMutation({ type: 'add_hole', featureId: 'ho1', thread_depth: 15 })).toMatchObject({ ok: true })
    expect(refusal({ type: 'set_hole_field', featureId: 'ho1', field: 'thread_depth', value: '' }).code)
      .toBe('invalid-mutation')
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

describe('through_all is a cut termination at the drive boundary', () => {
  it('accepts through_all with operation cut', () => {
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1,
      operation: 'cut', termination: 'through_all',
    })).toMatchObject({ ok: true })
  })

  it('refuses add, new and an absent operation (which reads as add) by name', () => {
    for (const operation of ['add', 'new', undefined]) {
      const raw = {
        type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1,
        termination: 'through_all', ...(operation === undefined ? {} : { operation }),
      }
      const error = refusal(raw)
      expect(error.code).toBe('invalid-mutation')
      expect(error.message).toContain('through_all')
      expect(error.message).toContain('cut')
      expect(error.message).toContain(`"${operation ?? 'add'}"`)
    }
  })

  it('leaves the setter free so the kernel reports a switched feature', () => {
    // A set_extrude_field switch must reach the solve: the kernel names it as a
    // feature exception instead of the boundary refusing a legal field value.
    expect(validateMutation({
      type: 'set_extrude_field', featureId: 'ex1', field: 'termination', value: 'through_all',
    })).toMatchObject({ ok: true })
  })
})

describe('add_three_point_arc values', () => {
  it('refuses a start that is not a point, naming the field', () => {
    const error = refusal({
      type: 'add_three_point_arc', featureId: 'sk1', start: [0], through: [1, 1], end: [2, 0],
    }, sketchDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('start')
    expect(error.message).toContain('2 finite numbers')
  })

  it('refuses a missing through, naming the field', () => {
    const error = refusal({
      type: 'add_three_point_arc', featureId: 'sk1', start: [0, 0], end: [2, 0],
    }, sketchDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('through')
  })

  it('refuses a non-string ref, naming the field', () => {
    const error = refusal({
      type: 'add_three_point_arc', featureId: 'sk1', start: [0, 0], through: [1, 1], end: [2, 0], startRef: 7,
    }, sketchDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('startRef')
    expect(error.message).toContain('string')
  })

  it('refuses an authored entityId the sketch already holds', () => {
    const error = refusal({
      type: 'add_three_point_arc', featureId: 'sk1', start: [0, 0], through: [1, 1], end: [2, 0], entityId: 'l1',
    }, sketchDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('entity id "l1"')
    expect(error.message).toContain('already exists')
  })

  it('accepts a proper arc with and without refs', () => {
    expect(validateMutation({
      type: 'add_three_point_arc', featureId: 'sk1', start: [2, 0], through: [1, 1], end: [0, 0],
      startRef: 'vertex:sk1:l1:end', endRef: 'vertex:sk1:l1:start', entityId: 'a1',
    }, { doc: sketchDoc() })).toMatchObject({ ok: true })
  })
})

describe('the compound sketch adds take an authored id block', () => {
  it('accepts a block of the right length with ids the sketch does not hold', () => {
    expect(validateMutation({
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 6],
      entityIds: ['b', 'r', 't', 'l'],
    }, { doc: sketchDoc() })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [1, 1],
      entityIds: ['b', 'r', 't', 'l', 'c'],
    }, { doc: sketchDoc() })).toMatchObject({ ok: true })
    expect(validateMutation({
      type: 'add_ngon', featureId: 'sk1', center: [0, 0], corner: [1, 1], sides: 6,
      entityIds: ['a', 'b', 'c', 'd', 'e', 'f', 'circ'],
    }, { doc: sketchDoc() })).toMatchObject({ ok: true })
  })

  it('refuses a wrong length by field name, with the expected block', () => {
    for (const [raw, expected] of [
      [{ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1], entityIds: ['a', 'b'] }, 'exactly 4'],
      [{ type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [1, 1], entityIds: ['a'] }, 'exactly 5'],
      [{ type: 'add_ngon', featureId: 'sk1', center: [0, 0], corner: [1, 1], sides: 5, entityIds: ['a'] }, 'exactly 6'],
    ] as const) {
      const error = refusal(raw, sketchDoc())
      expect(error.message).toContain('entityIds')
      expect(error.message).toContain(expected)
    }
  })

  it('refuses an id the sketch already holds and a repeated id', () => {
    const taken = refusal({
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1], entityIds: ['l1', 'r', 't', 'l'],
    }, sketchDoc())
    expect(taken.message).toContain('entityIds')
    expect(taken.message).toContain('"l1"')
    expect(taken.message).toContain('already exists')

    const repeated = refusal({
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1], entityIds: ['a', 'a', 't', 'l'],
    }, sketchDoc())
    expect(repeated.message).toContain('entityIds')
    expect(repeated.message).toContain('repeats')
  })

  it('refuses an id a ref cannot address and one that names a constraint', () => {
    const unsafe = refusal({
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1], entityIds: ['a/b', 'r', 't', 'l'],
    }, sketchDoc())
    expect(unsafe.message).toContain('ref-safe')

    const withConstraint = sketchDoc()
    const sketch = withConstraint.features![0] as { constraints?: unknown[] }
    sketch.constraints = [{ id: 'c9', kind: 'horizontal', target: '$l1' }]
    const clash = refusal({
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [1, 1], entityIds: ['c9', 'r', 't', 'l'],
    }, withConstraint)
    expect(clash.message).toContain('entityIds')
    expect(clash.message).toContain('constraint id "c9"')
  })
})

describe('the positive twin of a seeded script still validates', () => {
  it('accepts a normal box script step by step', async () => {
    const steps: Array<{ mutation: Mutation }> = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
      { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 12 } },
    ]
    const result = await runHeadless({ doc: seededDoc(), steps })
    expect(result.outcome.steps.map(step => step.ok)).toEqual([true, true, true, true])
  })
})

describe('import_dxf takes exactly one of content or file', () => {
  const TEXT = '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n5\n21\n0\n0\nENDSEC\n0\nEOF\n'

  function check(raw: Record<string, unknown>, fileIds?: ReadonlySet<string>) {
    return validateMutation(raw, {
      doc: sketchDoc(),
      ...(fileIds === undefined ? {} : { fileIds }),
    })
  }

  it('accepts inline content and keeps it as the field', () => {
    const raw = { type: 'import_dxf', featureId: 'sk1', content: TEXT }
    expect(check(raw)).toEqual({ ok: true, mutation: raw })
  })

  it('accepts a file id the run supplied, untouched for the runner to resolve', () => {
    const raw = { type: 'import_dxf', featureId: 'sk1', file: 'rack' }
    expect(check(raw, new Set(['rack']))).toEqual({ ok: true, mutation: raw })
  })

  it('refuses both spellings by name', () => {
    const error = refusal({ type: 'import_dxf', featureId: 'sk1', content: TEXT, file: 'rack' })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('exactly one of content or file')
  })

  it('refuses neither spelling, naming both and the run files map', () => {
    const error = refusal({ type: 'import_dxf', featureId: 'sk1' })
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain('content')
    expect(error.message).toContain('file')
    expect(error.message).toContain("files map")
  })

  it('refuses a file id the call did not supply, listing the available ones', () => {
    const error = refusal({ type: 'import_dxf', featureId: 'sk1', file: 'rack' }, sketchDoc())
    expect(error.code).toBe('invalid-mutation')
    expect(error.message).toContain("run's files map")
    expect(error.message).toContain('files argument')
    const unknown = validateMutation(
      { type: 'import_dxf', featureId: 'sk1', file: 'rack' },
      { doc: sketchDoc(), fileIds: new Set(['other']) },
    )
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown-target' } })
    if (unknown.ok) return
    expect(unknown.error.message).toContain('"rack"')
    expect(unknown.error.message).toContain('available: other')
  })

  it('refuses an empty file id and keeps the empty content refusal', () => {
    expect(refusal({ type: 'import_dxf', featureId: 'sk1', file: '' }, sketchDoc(), new Set(['rack'])).message)
      .toContain('non-empty files id')
    expect(refusal({ type: 'import_dxf', featureId: 'sk1', content: '' }).message)
      .toContain('content must be the DXF file text')
  })

  it('refuses an inline file the parser does not support', () => {
    const bad = '0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nBLOCK\n0\nENDSEC\n0\nEOF\n'
    expect(refusal({ type: 'import_dxf', featureId: 'sk1', content: bad }).message).toContain('INSERT')
  })
})

describe('extrude taper refusals', () => {
  function extrudeDoc(extrude: Record<string, unknown>): PartDoc {
    return seedBuiltins({
      version: 1, kind: 'part',
      features: [{
        id: 'ex1', kind: 'extrude',
        extrude: { sketch: '@sk1', distance: 10, ...extrude },
      }],
    })
  }

  it('refuses a taper magnitude of 90 degrees or more', () => {
    for (const taper of [90, -90, 95]) {
      const error = refusal({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, taper })
      expect(error.message, String(taper)).toContain('|taper| < 90')
    }
  })

  it('refuses a taper with direction symmetric on the add', () => {
    const error = refusal({
      type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5,
      taper: 10, direction: 'symmetric',
    })
    expect(error.message).toContain('taper')
    expect(error.message).toContain('direction symmetric')
  })

  it('refuses a taper with up_to and through_all on the add', () => {
    for (const termination of ['up_to', 'through_all']) {
      const error = refusal({
        type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5,
        taper: 10, termination,
      })
      expect(error.message, termination).toContain('taper')
      expect(error.message, termination).toContain(termination)
    }
  })

  it('refuses setting a taper on a symmetric, up_to or through_all extrude', () => {
    const symmetric = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'taper', value: 10 },
      extrudeDoc({ direction: 'symmetric' }),
    )
    expect(symmetric.message).toContain('direction is symmetric')
    for (const termination of ['up_to', 'through_all']) {
      const error = refusal(
        { type: 'set_extrude_field', featureId: 'ex1', field: 'taper', value: 10 },
        extrudeDoc({ termination }),
      )
      expect(error.message, termination).toContain(termination)
      expect(error.message, termination).toContain('blind')
    }
  })

  it('refuses switching direction or termination under an authored taper', () => {
    const direction = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'direction', value: 'symmetric' },
      extrudeDoc({ taper: 15 }),
    )
    expect(direction.message).toContain('symmetric')
    expect(direction.message).toContain('taper')
    for (const termination of ['up_to', 'through_all']) {
      const error = refusal(
        { type: 'set_extrude_field', featureId: 'ex1', field: 'termination', value: termination },
        extrudeDoc({ taper: 15 }),
      )
      expect(error.message, termination).toContain('taper')
      expect(error.message, termination).toContain(termination)
    }
  })

  it('accepts a taper on a blind normal extrude and clears it', () => {
    expect(validateMutation(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'taper', value: 15 },
      { doc: extrudeDoc({}) },
    )).toMatchObject({ ok: true })
    expect(validateMutation(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'taper', value: null },
      { doc: extrudeDoc({ taper: 15 }) },
    )).toMatchObject({ ok: true })
  })

  it('round-trips the setter and the inline add through the drive', async () => {
    const setter = await runHeadless({
      doc: extrudeDoc({}),
      steps: [{ mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'taper', value: 15 } }],
    })
    const edited = setter.doc?.features?.find(feature => feature.id === 'ex1')
    if (edited?.kind !== 'extrude') throw new Error('the setter step stored no extrude')
    expect(edited.extrude.taper).toBe(15)

    const added = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [{
        mutation: {
          type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10, taper: 15,
        },
      }],
    })
    const inline = added.doc?.features?.find(feature => feature.id === 'ex2')
    if (inline?.kind !== 'extrude') throw new Error('the add step stored no extrude')
    expect(inline.extrude.taper).toBe(15)
  })
})

describe('extrude up_to_next and the surface emboss', () => {
  function extrudeDoc(extrude: Record<string, unknown>): PartDoc {
    return seedBuiltins({
      version: 1, kind: 'part',
      features: [{
        id: 'ex1', kind: 'extrude',
        extrude: { sketch: '@sk1', distance: 10, ...extrude },
      }],
    })
  }

  it('accepts up_to_next with or without an up_to that it ignores', () => {
    for (const upTo of [undefined, '@builtin_plane_top']) {
      expect(validateMutation({
        type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
        termination: 'up_to_next', ...(upTo === undefined ? {} : { up_to: upTo }),
      })).toMatchObject({ ok: true })
    }
  })

  it('accepts a numeric or expression up_to_offset and refuses a non-finite one', () => {
    expect(validateMutation({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to_offset: 'wall/2',
    })).toMatchObject({ ok: true })
    const error = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to_offset: Number.POSITIVE_INFINITY,
    })
    expect(error.message).toContain('up_to_offset')
  })

  it('refuses surface mode without a non-zero offset, a face mode or one-sided work', () => {
    const zero = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to_start: 'surface', up_to_offset: 0,
    })
    expect(zero.message).toContain('up_to_start')
    expect(zero.message).toContain('up_to_offset')

    const blind = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'blind', up_to_start: 'surface', up_to_offset: 0.5,
    })
    expect(blind.message).toContain('up_to_start')
    expect(blind.message).toContain('termination')

    const symmetric = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to_start: 'surface', up_to_offset: 0.5, direction: 'symmetric',
    })
    expect(symmetric.message).toContain('up_to_start')
    expect(symmetric.message).toContain('direction')

    const tapered = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to_start: 'surface', up_to_offset: 0.5, taper: 10,
    })
    expect(tapered.message).toContain('taper')

    const datum = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      termination: 'up_to', up_to_start: 'surface', up_to_offset: 0.5,
      up_to: '@builtin_plane_top',
    })
    expect(datum.message).toContain('up_to_start')
    expect(datum.message).toContain('datum plane')
  })

  it('refuses a taper with up_to_next on the add and on a termination switch', () => {
    const added = refusal({
      type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 10,
      taper: 10, termination: 'up_to_next',
    })
    expect(added.message).toContain('up_to_next')
    const switched = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'termination', value: 'up_to_next' },
      extrudeDoc({ taper: 15 }),
    )
    expect(switched.message).toContain('up_to_next')
    const authored = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'taper', value: 10 },
      extrudeDoc({ termination: 'up_to_next' }),
    )
    expect(authored.message).toContain('up_to_next')
  })

  it('holds the surface toggle to the stored offset, direction and taper', () => {
    const ok = validateMutation(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'up_to_start', value: 'surface' },
      { doc: extrudeDoc({ termination: 'up_to', up_to: '@pl1', up_to_offset: 0.5 }) },
    )
    expect(ok).toMatchObject({ ok: true })

    const noOffset = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'up_to_start', value: 'surface' },
      extrudeDoc({ termination: 'up_to', up_to: '@pl1' }),
    )
    expect(noOffset.message).toContain('up_to_offset')

    const zeroOffset = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'up_to_offset', value: 0 },
      extrudeDoc({ termination: 'up_to', up_to: '@pl1', up_to_start: 'surface', up_to_offset: 0.5 }),
    )
    expect(zeroOffset.message).toContain('up_to_start')

    const symmetric = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'direction', value: 'symmetric' },
      extrudeDoc({ termination: 'up_to', up_to: '@pl1', up_to_start: 'surface', up_to_offset: 0.5 }),
    )
    expect(symmetric.message).toContain('up_to_start')

    const datum = refusal(
      { type: 'set_extrude_field', featureId: 'ex1', field: 'up_to', value: '@builtin_plane_top' },
      extrudeDoc({ termination: 'up_to', up_to: '@pl1', up_to_start: 'surface', up_to_offset: 0.5 }),
    )
    expect(datum.message).toContain('up_to_start')
    expect(datum.message).toContain('datum plane')
  })

  it('round-trips up_to_next and the surface fields through the drive', async () => {
    const added = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [{
        mutation: {
          type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk1', distance: 1,
          termination: 'up_to_next', up_to_offset: 0.5, up_to_start: 'surface',
        },
      }],
    })
    const feature = added.doc?.features?.find(f => f.id === 'ex2')
    if (feature?.kind !== 'extrude') throw new Error('the add step stored no extrude')
    expect(feature.extrude.termination).toBe('up_to_next')
    expect(feature.extrude.up_to_offset).toBe(0.5)
    expect(feature.extrude.up_to_start).toBe('surface')

    const cleared = await runHeadless({
      doc: added.doc!,
      steps: [{ mutation: { type: 'set_extrude_field', featureId: 'ex2', field: 'up_to_start', value: null } }],
    })
    const edited = cleared.doc?.features?.find(f => f.id === 'ex2')
    if (edited?.kind !== 'extrude') throw new Error('the setter step stored no extrude')
    expect(edited.extrude.up_to_start).toBeUndefined()
  })
})
