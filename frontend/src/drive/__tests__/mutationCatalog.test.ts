// @vitest-environment node
//
// The mutation catalog's runtime twin of the type-level field check, plus the
// two examples the `mutations` tool advertises: they must run green through the
// real kernel, because an example that does not is worse than no example.

import { createRequire } from 'node:module'
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
import { runHeadless, measureHeadless, seedBuiltins, selectHeadless } from '../headlessOps'
import { runReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'
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
      expect(info.note).toContain('required fields are sketch, diameter, depth_mode, depth')
      expect(info.note).toContain('optional ones are direction, target, thread')
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

    for (const type of ['add_array', 'add_circular_array', 'set_array_field', 'set_circular_array_field'] as const) {
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
    }
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
    expect(measure!.measures.volume).toBeCloseTo(12000, 6)
    expect(measure!.measures.bodies).toBe(1)
  }, 120_000)

  it('builds the filleted-box example at the measured volume and area', async () => {
    const example = MUTATION_EXAMPLES.find(entry => entry.name === 'filleted-box')
    expect(example).toBeDefined()
    const result = await exampleRun(example!.steps)
    expect(result.ok).toBe(true)
    const measure = await measureHeadless(result.doc!)
    expect(measure).not.toBeNull()
    expect(measure!.measures.volume).toBeCloseTo(11922.743, 3)
    expect(measure!.measures.area).toBeCloseTo(3733.044, 3)
  }, 120_000)

  it('lists only live bodies in the run summary after a boolean consumes a tool', async () => {
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 } },
      { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'operation', value: 'new' } },
      { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk2', p0: [5, 0], p1: [15, 10] } },
      { mutation: { type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 10 } },
      { mutation: { type: 'set_extrude_field', featureId: 'ex2', field: 'operation', value: 'new' } },
      { mutation: { type: 'add_boolean', featureId: 'bo1' } },
      { mutation: { type: 'set_boolean_field', featureId: 'bo1', field: 'target', value: 'body_ex1' } },
      { mutation: { type: 'add_boolean_tool', featureId: 'bo1', tool: 'body_ex2' } },
    ]
    const result = await exampleRun(steps)
    expect(result.ok).toBe(true)
    // The write-back keeps a colour entry for the consumed tool, so the document
    // alone cannot answer "which bodies are live".
    expect(result.doc!.part_style).toHaveProperty('body_ex2')
    expect(result.bodies).toContain('body_ex1')
    expect(result.bodies).not.toContain('body_ex2')

    const reply = runReply(result, false, new DocHandleStore())
    expect(reply.summary).toContain('bodies: body_ex1')
    expect(reply.summary).not.toContain('body_ex2')
  }, 120_000)

  it('pins the filleted-box edge queries to a select run on the box', async () => {
    // The example carries the queries `select` produced rather than the select
    // step, so this re-runs select on the same box doc and compares, pinning
    // that the carried strings really came from the engine.
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await exampleRun(box.steps)
    expect(built.ok).toBe(true)
    const selected = await selectHeadless(built.doc!, { kind: 'edge', where: { parallel: [0, 1, 0] } })
    expect(selected).not.toBeNull()
    const fillet = MUTATION_EXAMPLES.find(entry => entry.name === 'filleted-box')!
    const carried: string[] = []
    for (const step of fillet.steps) {
      if (!('mutation' in step)) continue
      const mutation = step.mutation as { edgeQuery?: string; edges?: string[] }
      if (mutation.edgeQuery !== undefined) carried.push(mutation.edgeQuery)
      if (mutation.edges !== undefined) carried.push(...mutation.edges)
    }
    expect(carried).toHaveLength(4)
    expect(selected!.queries).toEqual(carried)
  }, 120_000)
})
