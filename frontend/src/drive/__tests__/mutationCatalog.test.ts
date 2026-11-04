// @vitest-environment node
//
// The mutation catalog's runtime twin of the type-level field check. The two
// examples the `mutations` tool advertises need the real kernel and live in
// mutationCatalogReal.test.ts.

import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import {
  validateMutation,
  MUTATION_CATALOG,
  MUTATION_FAMILY,
  HIDDEN_MUTATION_TYPES,
  FIELD_SETTER_KIND,
  mutationInfoOf,
} from '../mutationCatalog'
import { featureFieldNames, featureParamsSchema, PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'
import { ENTITY_BY_KIND, ENTITY_PARAM_LAYOUT } from '@/registry/entityRegistry'
import type { EntityKind, Mutation } from '@/types/cad'
import { MUTATION_FAMILIES, mutationCatalogPayload } from '../mutationCatalogPayload'
import { MUTATION_EXAMPLES } from '../mutationExamples'



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
        const mutation = step.mutation as { edgeQuery?: string; edges?: string[] }
        for (const query of [mutation.edgeQuery, ...(mutation.edges ?? [])]) {
          if (query !== undefined) expect(query).not.toMatch(positional)
        }
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
      expect(info.note).toContain('required fields are sketch, diameter, depth_mode')
      expect(info.note).toContain('depth is required only for a blind hole')
      expect(info.note).toContain('stores no depth')
      expect(info.note).toContain('optional fields are direction, target, thread, style, cb_diameter, cb_depth, cs_angle')
      expect(info.note).toContain('all optional in an `add_hole` payload')
      expect(info.note).toContain('blind or through_all')
      // The one spelling difference an author hits: a hole's sketch ref is
      // feature-level, unlike the profile consumers' `$<sketchId>` form.
      expect(info.note).toContain('@<sketchId>')
      expect(info.note).toContain('$<sketchId>')
      expect(info.note).toContain('points and circles')
      expect(info.note).toContain('own radius')
      expect(info.note).toContain('empty value clears')
    }
  })

  it('names the face-query form a sketch plane accepts', () => {
    for (const type of ['add_sketch', 'set_feature_plane'] as const) {
      const note = mutationInfoOf(type).fields.plane.note
      expect(note).toBeDefined()
      expect(note).toContain('@<planeId>')
      expect(note).toContain('bare plane name')
      expect(note).toContain('face query from `select`')
      expect(note).toContain('places the sketch on that face')
    }
  })

  it('requires the revolve axis in the document schema', () => {
    expect(featureParamsSchema('revolve')!.required).toContain('axis')
  })

  it('requires a hole depth only for a blind hole', () => {
    const params = featureParamsSchema('hole')!
    expect(params.required).toEqual(expect.arrayContaining(['sketch', 'diameter', 'depth_mode']))
    expect(params.required).not.toContain('depth')
    const conditional = (params.allOf as Array<Record<string, unknown>>)[0]
    expect(conditional.if).toBeDefined()
    expect((conditional.then as { required: string[] }).required).toEqual(['depth'])
  })

  it('lets add_hole carry exactly the fields set_hole_field can set', () => {
    // One call must be able to create the same configured hole six setters
    // would build, so the payload follows the hole schema rather than a
    // second, shorter list.
    const holeFields = featureFieldNames('hole')
    const fields = mutationInfoOf('add_hole').fields
    for (const name of holeFields) expect(fields[name], name).toBeDefined()
    const extra = Object.keys(fields).filter(
      (name) => !holeFields.includes(name) && name !== 'featureId' && name !== 'label' && name !== 'insertAt',
    )
    expect(extra).toEqual([])
    for (const name of holeFields) expect(fields[name].required, name).toBe(false)
  })

  it('lets add_extrude carry every field the extrude schema defines', () => {
    // The value rules loop the schema fields, so the catalog row has to publish
    // every one too. `sketch` is spelled `sketchQuery` in an add payload.
    const schema = featureParamsSchema('extrude')!
    const schemaFields = Object.keys(schema.properties as Record<string, unknown>)
    const fields = mutationInfoOf('add_extrude').fields
    for (const name of schemaFields) {
      const inlineName = name === 'sketch' ? 'sketchQuery' : name
      expect(fields[inlineName], name).toBeDefined()
    }
    const extras = Object.keys(fields).filter(
      (name) => !['featureId', 'label', 'insertAt'].includes(name)
        && name !== 'sketchQuery' && !schemaFields.includes(name),
    )
    expect(extras).toEqual([])
  })

  it('names the params slot order of every add_entity kind from the entity registry', () => {
    const note = mutationInfoOf('add_entity').fields.params.note
    expect(note).toBeDefined()
    // Generated from ENTITY_PARAM_LAYOUT, so an added kind or a moved slot fails
    // here rather than leaving the catalog stale.
    for (const kind of Object.keys(ENTITY_PARAM_LAYOUT) as EntityKind[]) {
      expect(note).toContain(`${kind} [${ENTITY_PARAM_LAYOUT[kind].join(', ')}]`)
      expect(ENTITY_BY_KIND.get(kind)?.paramCount, kind).toBe(ENTITY_PARAM_LAYOUT[kind].length)
    }
    // The two facts the tally asked for: the layout and the angle convention.
    expect(note).toContain('arc [cx, cy, r, a0_deg, a1_deg]')
    expect(note).toContain('degrees')
    expect(note).toContain('counter-clockwise')
    // The other add_entity row shares the same generated note.
    expect(mutationInfoOf('add_entity_with_constraint').fields.params.note).toBe(note)
  })

  it('names fit_spline on both add rows and its 2..64 point range', () => {
    for (const type of ['add_entity', 'add_entity_with_constraint'] as const) {
      expect(mutationInfoOf(type).fields.kind.note, type).toContain('fit_spline')
      // The registry layout is the two-point minimum; the note has to say the
      // block is variable or a script sends a 64-point spline with no clue why
      // the slot list looked short.
      expect(mutationInfoOf(type).fields.params.note, type).toContain('2..64 fit points')
    }
  })

  it('emits the schema enum members of every setter kind', () => {
    const notes = new Set<string>()
    for (const [type, kind] of Object.entries(FIELD_SETTER_KIND)) {
      const value = mutationInfoOf(type as Mutation['type']).fields.value
      expect(value.note, type).toBeDefined()
      const params = featureParamsSchema(kind)
      const entry = params === null ? null : params.properties as Record<string, { enum?: unknown[] }>
      const enums = Object.entries(entry ?? {})
        .filter(([, property]) => Array.isArray(property.enum))
        .map(([name, property]) => `${name}: ${property.enum!.join('|')}`)
      if (enums.length === 0) {
        expect(value.note, type).not.toContain('Enum fields')
        continue
      }
      notes.add(value.note!)
      for (const members of enums) expect(value.note, type).toContain(members)
    }
    // The four the plan called out, generated from the schema rather than typed.
    const joined = [...notes].join('\n')
    expect(joined).toContain('operation: add|cut|new')
    expect(joined).toContain('operation: new|replace')
    expect(joined).toContain('operation: union|subtract|intersect')
    expect(joined).toContain('direction: normal|reverse|symmetric')
    expect(joined).toContain('termination: blind|up_to')
  })

  it('explains which way hole.direction drills, from the schema description', () => {
    // The enum members alone do not say that a face sketch's `normal` points
    // out of the body; the schema sentence rides the generated note.
    const note = mutationInfoOf('set_hole_field').fields.value.note
    expect(note).toContain('direction: normal|reverse')
    expect(note).toContain('usually wants reverse')
    const add = mutationInfoOf('add_hole').note
    expect(add).toContain('usually wants `reverse`')
    expect(add).toContain('misses every site')
  })

  it('publishes the plane definition shape from the same schema the resource serves', () => {
    const entry = Object.values(mutationCatalogPayload().families).flat().find(row => row.type === 'add_plane')
    expect(entry!.fields.definition.shape).toEqual(featureParamsSchema('plane'))
    // The definition in the served resource is that same object, not a second
    // hand-kept copy of the published contract.
    const schema = JSON.parse(PART_DOC_SCHEMA_JSON) as {
      properties: { features: { items: { oneOf: Array<Record<string, unknown>> } } }
    }
    const plane = schema.properties.features.items.oneOf.find(
      variant => (variant.properties as Record<string, { const?: string }>).kind?.const === 'plane',
    )
    expect(plane).toBeDefined()
    expect((plane!.properties as Record<string, unknown>).definition).toEqual(entry!.fields.definition.shape)
  })

  it('documents the bulk fillet form and the array split into bodies', () => {
    const fillet = mutationInfoOf('add_fillet')
    expect(fillet.fields.edges).toBeDefined()
    expect(fillet.fields.radius).toBeDefined()
    expect(fillet.note).toContain('edges')
    expect(fillet.note).toContain('radius')
    expect(fillet.note).toContain('same step')

    for (const type of ['add_pattern', 'set_pattern_field'] as const) {
      const note = mutationInfoOf(type).note
      expect(note, type).toBeDefined()
      expect(note, type).toContain('disjoint')
      expect(note, type).toContain('_1')
    }
  })

  it('pins case-sensitive plane refs and the face-query form', () => {
    for (const type of ['add_sketch', 'set_feature_plane'] as const) {
      const note = mutationInfoOf(type).note
      expect(note, type).toBeDefined()
      expect(note, type).toContain('case-sensitive')
      expect(note, type).toContain('@builtin_plane_front')
      expect(note, type).toContain('?" face query')
      expect(note, type).toContain('never silently')
      // The cause is now named at the kernel too, not only at this boundary.
      expect(note, type).toContain('does not resolve fails the sketch')
      expect(note, type).toContain('reorder')
    }
  })

  it('points add_sketch, set_feature_plane and add_plane at the frames in the reply', () => {
    for (const type of ['add_sketch', 'set_feature_plane', 'add_plane'] as const) {
      expect(mutationInfoOf(type).note, type).toContain('`frames`')
    }
    expect(mutationInfoOf('add_sketch').fields.plane.note).toContain('frames')
    for (const mode of ['offset', 'three_point', 'plane_point', 'line_angle', 'on_face', 'on_face_edge_angle', 'edge_point', 'origin_rotation']) {
      expect(mutationInfoOf('add_plane').note, mode).toContain(mode)
    }
  })

  it('documents the add_rect id order and the sketch target forms', () => {
    expect(mutationInfoOf('add_rect').summary).toContain('bottom, right, top, left')

    const deleteTargets = mutationInfoOf('delete').fields.targets.note
    expect(deleteTargets).toBeDefined()
    expect(deleteTargets).toContain('entity:<sketchId>:<entityId>')
    expect(deleteTargets).toContain('delete_feature')

    const toggleTargets = mutationInfoOf('toggle_construction').fields.targets.note
    expect(toggleTargets).toBeDefined()
    expect(toggleTargets).toContain('entity:<sketchId>:<entityId>')
  })

  it('takes the revolve axis in the add call and never calls it the plane axis', () => {
    const info = mutationInfoOf('add_revolve')
    expect(info.fields.axis).toBeDefined()
    expect(info.fields.axis.required).toBe(true)
    expect(info.note).toContain('required')
    expect(info.summary).not.toContain('plane axis')
    expect(info.fields.axis.note).toContain('@<sketchId>/<entityId>')
  })

  it('points a revolve or sweep that must cut at the setter, since only extrude adds with an operation', () => {
    expect(mutationInfoOf('add_revolve').note).toContain('set_revolve_field')
    expect(mutationInfoOf('add_sweep').note).toContain('set_sweep_field')
    expect(mutationInfoOf('add_revolve').fields.operation).toBeUndefined()
  })

  it('explains how to sweep sections that sit on other planes', () => {
    const add = mutationInfoOf('add_sweep')
    expect(add.note).toContain('add_sweep_profile')
    expect(add.note).toContain('multisection')
    expect(add.note).toContain('pierced by the path')
    // The setter's field list is generated from the schema, so the opt-in field
    // is offered there without a second hand-kept list.
    expect(mutationInfoOf('set_sweep_field').fields.field.note).toContain('multisection')
  })

  it('says a variable must sit before its users and how the index is counted', () => {
    const info = mutationInfoOf('add_variable')
    expect(info.fields.insertAt).toBeDefined()
    expect(info.fields.insertAt.internal).toBe(true)
    expect(info.note).toContain('defined after this feature')
    expect(info.note).toContain('precede')
    expect(info.note).toContain('count the seeded')
    expect(info.note).toContain('plane rows')
    expect(mutationInfoOf('reorder_features').note).toContain('seeded plane rows')
  })

  it('pins the transform composition order to what the code does', () => {
    for (const type of ['add_transform', 'set_transform_field'] as const) {
      const note = mutationInfoOf(type).note
      expect(note).toBeDefined()
      expect(note).toContain('scale first, then rotation, then translation')
    }
  })

  it('states that delete_feature leaves dependents behind', () => {
    const summary = mutationInfoOf('delete_feature').summary
    expect(summary).toContain('dependents stay')
    expect(summary).toContain('missing input')
  })

  it('documents the center-rect corner, the transform axis pair and the revolve axis ref', () => {
    const center = mutationInfoOf('add_center_rect').note
    expect(center).toContain('half-diagonal')
    expect(center).toContain('2x2')
    expect(center).toContain('centre point')

    for (const type of ['add_transform', 'set_transform_field'] as const) {
      const note = mutationInfoOf(type).note
      expect(note).toBeDefined()
      expect(note).toContain('rotation_axis')
      expect(note).toContain('rotation_axis_origin')
      expect(note).toContain('rotation_axis_direction')
      expect(note).toContain('single axis')
      expect(note).toContain('degrees')
    }

    for (const type of ['add_revolve', 'set_revolve_field'] as const) {
      const note = mutationInfoOf(type).note
      expect(note).toBeDefined()
      expect(note).toContain('@<sketchId>/<entityId>')
      expect(note).toContain('$<sketchId>')
    }
  })
})
