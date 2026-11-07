import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { makeSketch, makeDoc } from '@/utils/core/testFixture'
import type { PartDoc } from '@/types/cad'
import { featureById } from '@/testing/featureAccess'

const sketch1 = (doc: PartDoc) => featureById(doc, 'S1', 'sketch')
const sketch2 = (doc: PartDoc) => featureById(doc, 'S2', 'sketch')
const sketch3 = (doc: PartDoc) => featureById(doc, 'S3', 'sketch')
const extrude = (doc: PartDoc) => featureById(doc, 'EX', 'extrude').extrude
const revolve = (doc: PartDoc) => featureById(doc, 'RV', 'revolve').revolve
const fillet = (doc: PartDoc) => featureById(doc, 'FL', 'fillet').fillet
const chamfer = (doc: PartDoc) => featureById(doc, 'CH', 'chamfer').chamfer
const boolean = (doc: PartDoc) => featureById(doc, 'BL', 'boolean').boolean
const pattern = (doc: PartDoc) => featureById(doc, 'PT', 'pattern').pattern
const delBody = (doc: PartDoc) => featureById(doc, 'DB', 'delete_body').delete_body
const transform = (doc: PartDoc) => featureById(doc, 'TR', 'transform').transform

// The exhaustive suite proves the handler TABLE has a key for every Mutation
// variant, but never invokes a single handler -- so the arrow bodies (which
// forward each mutation's fields, in order, to the matching apply* function)
// were uncovered. A transposed argument or a renamed field would slip through.
// This suite dispatches every handler and asserts the forwarded effect.

function sketchDoc(): PartDoc {
  return makeDoc(
    makeSketch('S1', {
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
        { id: 'c1', kind: 'circle' },
        { id: 'ml', kind: 'line' },
        { id: 'pt', kind: 'point' },
      ],
      constraints: [
        { id: 'k1', kind: 'length', target: '$l1', value: 10 },
      ],
      initial: {
        l1: [0, 0, 10, 0],
        l2: [0, 5, 10, 5],
        c1: [4, 4, 2],
        ml: [0, -1, 0, 9],
        pt: [7, 1],
      },
    }),
  )
}

function feature(doc: PartDoc, id: string) {
  return doc.features?.find(f => f.id === id)
}

describe('mutationHandlers forward sketch mutations', () => {
  it('move_vertex writes the dragged endpoint into initial', () => {
    const doc = sketchDoc()
    mutationHandlers.move_vertex(doc, {
      type: 'move_vertex', featureId: 'S1', entityId: 'l1', vertexKey: 'start', to: [2, 3],
    })
    expect(sketch1(doc).initial!.l1.slice(0, 2)).toEqual([2, 3])
  })

  it('move_vertex_with_constraint moves and adds the snap constraint', () => {
    const doc = sketchDoc()
    mutationHandlers.move_vertex_with_constraint(doc, {
      type: 'move_vertex_with_constraint', featureId: 'S1', entityId: 'l1', vertexKey: 'end',
      to: [9, 0], constraintKind: 'coincident', snapVertexId: 'vertex:S1:l2:start',
    })
    const cs = sketch1(doc).constraints!
    expect(cs.some(c => c.kind === 'coincident')).toBe(true)
  })

  it('move_entity translates by delta', () => {
    const doc = sketchDoc()
    const before = sketch1(doc).initial!.l1.slice()
    mutationHandlers.move_entity(doc, {
      type: 'move_entity', featureId: 'S1', entityId: 'l1', delta: [1, 1],
    })
    expect(sketch1(doc).initial!.l1[0]).toBe(before[0] + 1)
  })

  it('add_constraint appends a constraint', () => {
    const doc = sketchDoc()
    mutationHandlers.add_constraint(doc, {
      type: 'add_constraint', featureId: 'S1', kind: 'horizontal', targets: ['$l1'],
    })
    expect(sketch1(doc).constraints!.some(c => c.kind === 'horizontal')).toBe(true)
  })

  it('set_constraint_value updates the value', () => {
    const doc = sketchDoc()
    mutationHandlers.set_constraint_value(doc, {
      type: 'set_constraint_value', featureId: 'S1', constraintId: 'k1', value: 42,
    })
    expect(sketch1(doc).constraints!.find(c => c.id === 'k1')!.value).toBe(42)
  })

  it('set_constraint_pos updates the label position', () => {
    const doc = sketchDoc()
    mutationHandlers.set_constraint_pos(doc, {
      type: 'set_constraint_pos', featureId: 'S1', constraintId: 'k1', pos: [3, 4],
    })
    expect(sketch1(doc).constraints!.find(c => c.id === 'k1')!.pos).toEqual([3, 4])
  })

  it('set_constraint_sign sets the orientation sign (normalized to +/-1)', () => {
    const doc = sketchDoc()
    mutationHandlers.set_constraint_sign(doc, {
      type: 'set_constraint_sign', featureId: 'S1', constraintId: 'k1', sign: -3,
    })
    expect(sketch1(doc).constraints!.find(c => c.id === 'k1')!.sign).toBe(-1)
  })

  it('add_entity appends an entity with the given id', () => {
    const doc = sketchDoc()
    mutationHandlers.add_entity(doc, {
      type: 'add_entity', featureId: 'S1', kind: 'circle', params: [1, 1, 3], entityId: 'newC',
    })
    expect(sketch1(doc).entities!.some(e => e.id === 'newC')).toBe(true)
  })

  it('add_entity_with_constraint appends an entity', () => {
    const doc = sketchDoc()
    const before = sketch1(doc).entities!.length
    mutationHandlers.add_entity_with_constraint(doc, {
      type: 'add_entity_with_constraint', featureId: 'S1', kind: 'line', params: [0, 0, 5, 5],
      vertexKey: 'start', constraintKind: 'coincident', snapVertexId: 'vertex:S1:l1:end', entityId: 'wl',
    })
    expect(sketch1(doc).entities!.length).toBe(before + 1)
  })

  it('add_projected_entity appends a source-carrying entity', () => {
    const doc = sketchDoc()
    mutationHandlers.add_projected_entity(doc, {
      type: 'add_projected_entity', featureId: 'S1', kind: 'line', source: '@ex1/edge/1',
    })
    expect(sketch1(doc).entities!.some(e => e.source === '@ex1/edge/1')).toBe(true)
  })

  it('add_rect / add_center_rect / add_ngon add geometry', () => {
    const doc = sketchDoc()
    const n0 = sketch1(doc).entities!.length
    mutationHandlers.add_rect(doc, { type: 'add_rect', featureId: 'S1', p0: [0, 0], p1: [4, 4] })
    const beforeCentre = new Set(sketch1(doc).entities!.map(e => e.id))
    mutationHandlers.add_center_rect(doc, { type: 'add_center_rect', featureId: 'S1', center: [0, 0], corner: [2, 2] })
    const centre = sketch1(doc).entities!.find(e => e.kind === 'point' && !beforeCentre.has(e.id))
    // The helper centre point is an ordinary point with no construction flag,
    // so a whole-sketch hole drills one bore at the rectangle's centre.
    expect(centre).toBeDefined()
    expect(centre!.construction).toBeUndefined()
    mutationHandlers.add_ngon(doc, { type: 'add_ngon', featureId: 'S1', center: [0, 0], corner: [3, 0], sides: 6 })
    expect(sketch1(doc).entities!.length).toBeGreaterThan(n0)
  })

  it('apply_offset clones the source entities', () => {
    const doc = sketchDoc()
    const n0 = sketch1(doc).entities!.length
    mutationHandlers.apply_offset(doc, { type: 'apply_offset', featureId: 'S1', sourceIds: ['l1'], distance: 2 })
    expect(sketch1(doc).entities!.length).toBeGreaterThan(n0)
  })

  it('toggle_construction flips the construction flag', () => {
    const doc = sketchDoc()
    mutationHandlers.toggle_construction(doc, { type: 'toggle_construction', targets: ['entity:S1:l1'] })
    expect(sketch1(doc).entities!.find(e => e.id === 'l1')!.construction).toBe(true)
  })

  it('set_feature_plane updates the sketch plane', () => {
    const doc = sketchDoc()
    mutationHandlers.set_feature_plane(doc, { type: 'set_feature_plane', featureId: 'S1', plane: '@builtin_plane_top' })
    expect(sketch1(doc).plane).toBe('@builtin_plane_top')
  })

  it('delete removes the targeted entity', () => {
    const doc = sketchDoc()
    mutationHandlers.delete(doc, { type: 'delete', targets: ['entity:S1:l2'] })
    expect(sketch1(doc).entities!.some(e => e.id === 'l2')).toBe(false)
  })
})

describe('mutationHandlers forward feature-creation + field + child mutations', () => {
  it('extrude: add, set field, add/remove profile', () => {
    const doc = sketchDoc()
    mutationHandlers.add_extrude(doc, { type: 'add_extrude', featureId: 'EX', sketchQuery: '@S1/area1', distance: 5 })
    expect(feature(doc, 'EX')!.kind).toBe('extrude')
    mutationHandlers.set_extrude_field(doc, { type: 'set_extrude_field', featureId: 'EX', field: 'distance', value: 9 })
    expect(extrude(doc)!.distance).toBe(9)
    mutationHandlers.add_extrude_profile(doc, { type: 'add_extrude_profile', featureId: 'EX', sketchQuery: '@S1/area2' })
    mutationHandlers.remove_extrude_profile(doc, { type: 'remove_extrude_profile', featureId: 'EX', index: 0 })
    expect(extrude(doc)).toBeDefined()
  })

  it('revolve: add, set field, add/remove profile', () => {
    const doc = sketchDoc()
    mutationHandlers.add_revolve(doc, { type: 'add_revolve', featureId: 'RV', sketchQuery: '@S1/area1', angle: 90, axis: '@S1/ax' })
    mutationHandlers.set_revolve_field(doc, { type: 'set_revolve_field', featureId: 'RV', field: 'angle', value: 180 })
    mutationHandlers.add_revolve_profile(doc, { type: 'add_revolve_profile', featureId: 'RV', sketchQuery: '@S1/area2' })
    mutationHandlers.remove_revolve_profile(doc, { type: 'remove_revolve_profile', featureId: 'RV', index: 0 })
    expect(revolve(doc)!.angle).toBe(180)
  })

  it('revolve / sweep carry their setter fields inline', () => {
    const doc = sketchDoc()
    mutationHandlers.add_revolve(doc, {
      type: 'add_revolve', featureId: 'RV', sketchQuery: '@S1/area1', angle: 360, axis: '@S1/ax',
      direction: 'reverse', operation: 'cut', merge_target: 'body_ex1',
    })
    expect(revolve(doc)).toMatchObject({
      direction: 'reverse', operation: 'cut', merge_target: 'body_ex1',
    })
    mutationHandlers.add_sweep(doc, {
      type: 'add_sweep', featureId: 'SW', sketchQuery: '@S1/area1', pathQuery: '@S1/l1',
      transition: 'round', multisection: true, operation: 'cut', merge_target: 'body_ex2',
    })
    expect(featureById(doc, 'SW', 'sweep').sweep).toMatchObject({
      transition: 'round', multisection: true, operation: 'cut', merge_target: 'body_ex2',
    })
    // An absent key leaves the def the plain add wrote.
    mutationHandlers.add_revolve(doc, {
      type: 'add_revolve', featureId: 'RV2', sketchQuery: '@S1/area1', angle: 90, axis: '@S1/ax',
    })
    expect(featureById(doc, 'RV2', 'revolve').revolve).not.toHaveProperty('operation')
  })

  it('sweep: add, set field, add/remove profile and path', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sweep(doc, { type: 'add_sweep', featureId: 'SW', sketchQuery: '@S1/area1', pathQuery: '@S1/l1' })
    mutationHandlers.set_sweep_field(doc, { type: 'set_sweep_field', featureId: 'SW', field: 'operation', value: 'cut' })
    mutationHandlers.add_sweep_profile(doc, { type: 'add_sweep_profile', featureId: 'SW', sketchQuery: '@S1/area2' })
    mutationHandlers.remove_sweep_profile(doc, { type: 'remove_sweep_profile', featureId: 'SW', index: 0 })
    mutationHandlers.add_sweep_path(doc, { type: 'add_sweep_path', featureId: 'SW', pathQuery: '@S1/l2' })
    mutationHandlers.remove_sweep_path(doc, { type: 'remove_sweep_path', featureId: 'SW', index: 0 })
    expect(featureById(doc, 'SW', 'sweep').kind).toBe('sweep')
  })

  it('fillet: add, set field, add/remove edge', () => {
    const doc = sketchDoc()
    mutationHandlers.add_fillet(doc, { type: 'add_fillet', featureId: 'FL' })
    mutationHandlers.set_fillet_field(doc, { type: 'set_fillet_field', featureId: 'FL', field: 'radius', value: 2 })
    mutationHandlers.add_fillet_edge(doc, { type: 'add_fillet_edge', featureId: 'FL', edgeQuery: '@ex/edge/1' })
    expect(fillet(doc)!.edges).toContain('@ex/edge/1')
    mutationHandlers.remove_fillet_edge(doc, { type: 'remove_fillet_edge', featureId: 'FL', index: 0 })
    expect(fillet(doc)!.edges).toHaveLength(0)
  })

  it('fillet: add carries the whole edge set and radius in one call', () => {
    const doc = sketchDoc()
    mutationHandlers.add_fillet(doc, {
      type: 'add_fillet', featureId: 'FL', edges: ['@ex/edge/1', '@ex/edge/2'], radius: 0.125,
    })
    const feature = fillet(doc)!
    expect(feature.edges).toEqual(['@ex/edge/1', '@ex/edge/2'])
    expect(feature.radius).toBe(0.125)
  })

  it('chamfer: add, set field, add/remove edge', () => {
    const doc = sketchDoc()
    mutationHandlers.add_chamfer(doc, { type: 'add_chamfer', featureId: 'CH' })
    mutationHandlers.set_chamfer_field(doc, { type: 'set_chamfer_field', featureId: 'CH', field: 'distance', value: 1 })
    mutationHandlers.add_chamfer_edge(doc, { type: 'add_chamfer_edge', featureId: 'CH', edgeQuery: '@ex/edge/2' })
    mutationHandlers.remove_chamfer_edge(doc, { type: 'remove_chamfer_edge', featureId: 'CH', index: 0 })
    expect(chamfer(doc)).toBeDefined()
  })

  it('boolean: add, set field, add/remove tool', () => {
    const doc = sketchDoc()
    mutationHandlers.add_boolean(doc, { type: 'add_boolean', featureId: 'BL' })
    mutationHandlers.set_boolean_field(doc, { type: 'set_boolean_field', featureId: 'BL', field: 'operation', value: 'cut' })
    mutationHandlers.add_boolean_tool(doc, { type: 'add_boolean_tool', featureId: 'BL', tool: '@body_2' })
    expect(boolean(doc)!.tools).toContain('@body_2')
    mutationHandlers.remove_boolean_tool(doc, { type: 'remove_boolean_tool', featureId: 'BL', tool: '@body_2' })
    expect(boolean(doc)!.tools).toHaveLength(0)
  })

  it('boolean carries keep_tools and clearance inline', () => {
    const doc = sketchDoc()
    mutationHandlers.add_boolean(doc, {
      type: 'add_boolean', featureId: 'BL', operation: 'subtract', target: 'body_1',
      tools: ['body_2'], keep_tools: true, clearance: 0.2,
    })
    expect(boolean(doc)).toMatchObject({
      operation: 'subtract', target: 'body_1', tools: ['body_2'], keep_tools: true, clearance: 0.2,
    })
  })

  it('pattern (linear + circular): add and set field', () => {
    const doc = sketchDoc()
    mutationHandlers.add_pattern(doc, { type: 'add_pattern', featureId: 'PT' })
    mutationHandlers.set_pattern_field(doc, { type: 'set_pattern_field', featureId: 'PT', field: 'count', value: 4 })
    expect(pattern(doc)!.count).toBe(4)
    mutationHandlers.set_pattern_field(doc, { type: 'set_pattern_field', featureId: 'PT', field: 'mode', value: 'circular' })
    expect(pattern(doc)!.mode).toBe('circular')
  })

  it('hole / transform / mirror / variable / delete_body: add and set field', () => {
    const doc = sketchDoc()
    mutationHandlers.add_hole(doc, { type: 'add_hole', featureId: 'HO' })
    mutationHandlers.set_hole_field(doc, { type: 'set_hole_field', featureId: 'HO', field: 'diameter', value: 3 })
    // A configured hole in one call: the same fields a setter would write.
    mutationHandlers.add_hole(doc, {
      type: 'add_hole', featureId: 'HO2', label: 'Counterbore', sketch: '@S1', diameter: 4,
      depth_mode: 'blind', depth: 10, direction: 'normal', target: '@body_1',
      style: 'counterbore', cb_diameter: 8, cb_depth: 3, tip: 'drill_point', tip_angle: 135,
      thread: { designation: 'M5x0.8', nominal: 5, pitch: 0.8 }, thread_depth: 7,
    })
    const configured = featureById(doc, 'HO2', 'hole') as { hole: Record<string, unknown>; label?: string }
    expect(configured.label).toBe('Counterbore')
    expect(configured.hole).toMatchObject({
      sketch: '@S1', diameter: 4, depth_mode: 'blind', depth: 10, direction: 'normal',
      target: '@body_1', style: 'counterbore', cb_diameter: 8, cb_depth: 3,
      tip: 'drill_point', tip_angle: 135,
      thread: { designation: 'M5x0.8', nominal: 5, pitch: 0.8 }, thread_depth: 7,
    })
    mutationHandlers.add_transform(doc, { type: 'add_transform', featureId: 'TR' })
    mutationHandlers.set_transform_field(doc, { type: 'set_transform_field', featureId: 'TR', field: 'operation', value: 'new' })
    mutationHandlers.add_mirror(doc, { type: 'add_mirror', featureId: 'MI' })
    mutationHandlers.set_mirror_field(doc, { type: 'set_mirror_field', featureId: 'MI', field: 'plane', value: '@builtin_plane_top' })
    mutationHandlers.add_variable(doc, { type: 'add_variable', featureId: 'VR' })
    mutationHandlers.set_variable_field(doc, { type: 'set_variable_field', featureId: 'VR', field: 'value', value: '2*3' })
    mutationHandlers.add_delete_body(doc, { type: 'add_delete_body', featureId: 'DB', bodies: ['@body_1'] })
    mutationHandlers.add_delete_body_ref(doc, { type: 'add_delete_body_ref', featureId: 'DB', bodyQuery: '@body_2' })
    expect(delBody(doc)!.bodies).toEqual(['@body_1', '@body_2'])
    mutationHandlers.remove_delete_body_ref(doc, { type: 'remove_delete_body_ref', featureId: 'DB', index: 0 })
    expect(delBody(doc)!.bodies).toEqual(['@body_2'])
    expect(['HO', 'TR', 'MI', 'VR', 'DB'].every(id => !!feature(doc, id))).toBe(true)
  })

  it('transform carries bodies, operation, translation and rotation inline', () => {
    const doc = sketchDoc()
    mutationHandlers.add_transform(doc, {
      type: 'add_transform', featureId: 'TR', bodies: ['body_1'], operation: 'replace',
      translation: [0, 0, 5], rotation_angle: 90,
    })
    expect(transform(doc)).toMatchObject({
      bodies: ['body_1'], operation: 'replace', translation: [0, 0, 5], rotation_angle: 90, scale: 1,
    })
    // An empty bodies list is legal, and the body toggle still edits it later.
    mutationHandlers.add_transform(doc, { type: 'add_transform', featureId: 'TR2', bodies: [] })
    const second = featureById(doc, 'TR2', 'transform').transform
    expect(second.bodies).toEqual([])
    mutationHandlers.add_transform_body(doc, { type: 'add_transform_body', featureId: 'TR2', bodyQuery: 'body_2' })
    expect(second.bodies).toEqual(['body_2'])
  })

  it('one inline add lands the same def as the add plus setters', () => {
    const revolveOne = sketchDoc()
    mutationHandlers.add_revolve(revolveOne, {
      type: 'add_revolve', featureId: 'RV', sketchQuery: '@S1/area1', angle: 360, axis: '@S1/ax',
      direction: 'reverse', operation: 'cut', merge_target: 'body_1',
    })
    const revolveMany = sketchDoc()
    mutationHandlers.add_revolve(revolveMany, {
      type: 'add_revolve', featureId: 'RV', sketchQuery: '@S1/area1', angle: 360, axis: '@S1/ax',
    })
    for (const [field, value] of [
      ['direction', 'reverse'], ['operation', 'cut'], ['merge_target', 'body_1'],
    ] as const) {
      mutationHandlers.set_revolve_field(revolveMany, {
        type: 'set_revolve_field', featureId: 'RV', field, value,
      })
    }
    expect(revolve(revolveOne)).toEqual(revolve(revolveMany))

    const sweepOne = sketchDoc()
    mutationHandlers.add_sweep(sweepOne, {
      type: 'add_sweep', featureId: 'SW', sketchQuery: '@S1/area1', pathQuery: '@S1/l1',
      transition: 'round', multisection: true, operation: 'cut', merge_target: 'body_2',
    })
    const sweepMany = sketchDoc()
    mutationHandlers.add_sweep(sweepMany, {
      type: 'add_sweep', featureId: 'SW', sketchQuery: '@S1/area1', pathQuery: '@S1/l1',
    })
    for (const [field, value] of [
      ['transition', 'round'], ['multisection', true], ['operation', 'cut'], ['merge_target', 'body_2'],
    ] as const) {
      mutationHandlers.set_sweep_field(sweepMany, {
        type: 'set_sweep_field', featureId: 'SW', field, value,
      })
    }
    expect(featureById(sweepOne, 'SW', 'sweep').sweep).toEqual(featureById(sweepMany, 'SW', 'sweep').sweep)

    const transformOne = sketchDoc()
    mutationHandlers.add_transform(transformOne, {
      type: 'add_transform', featureId: 'TR', bodies: ['body_1'], operation: 'replace',
      translation: [0, 0, 5], rotation_angle: 90,
    })
    const transformMany = sketchDoc()
    mutationHandlers.add_transform(transformMany, { type: 'add_transform', featureId: 'TR' })
    for (const [field, value] of [
      ['bodies', ['body_1']], ['operation', 'replace'], ['translation', [0, 0, 5]], ['rotation_angle', 90],
    ] as const) {
      mutationHandlers.set_transform_field(transformMany, {
        type: 'set_transform_field', featureId: 'TR', field, value,
      })
    }
    expect(transform(transformOne)).toEqual(transform(transformMany))

    const booleanOne = sketchDoc()
    mutationHandlers.add_boolean(booleanOne, {
      type: 'add_boolean', featureId: 'BL', operation: 'subtract', target: 'body_1',
      tools: ['body_2'], keep_tools: true, clearance: 0.2,
    })
    const booleanMany = sketchDoc()
    mutationHandlers.add_boolean(booleanMany, { type: 'add_boolean', featureId: 'BL' })
    for (const [field, value] of [
      ['operation', 'subtract'], ['target', 'body_1'], ['tools', ['body_2']],
      ['keep_tools', true], ['clearance', 0.2],
    ] as const) {
      mutationHandlers.set_boolean_field(booleanMany, {
        type: 'set_boolean_field', featureId: 'BL', field, value,
      })
    }
    expect(boolean(booleanOne)).toEqual(boolean(booleanMany))
  })

  it('add_import_step appends an import feature', () => {
    const doc = sketchDoc()
    mutationHandlers.add_import_step(doc, { type: 'add_import_step', featureId: 'IM', fileId: 'f1', label: 'Imported' })
    expect(featureById(doc, 'IM', 'import_step').kind).toBe('import_step')
  })

  it('add_import_step carries an authored scale onto the feature', () => {
    // The inch-document import path stores 1/25.4 here so the millimetre STEP
    // lands at inch numbers; the leaf solver reads it off the feature.
    const doc = sketchDoc()
    mutationHandlers.add_import_step(doc, { type: 'add_import_step', featureId: 'IM', fileId: 'f1', scale: 1 / 25.4 })
    expect(featureById(doc, 'IM', 'import_step').scale).toBeCloseTo(1 / 25.4, 12)
  })

  it('delete_body handlers do not crash on a legacy singular-body doc', () => {
    // A pre-pluralization delete_body carries `body` and no `bodies`; the
    // handlers seed the list from that pick (so it survives) instead of throwing
    // on indexOf/splice or dropping it.
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'DB', kind: 'delete_body', delete_body: { body: '@body_1' } }],
    } as unknown as PartDoc
    expect(() => {
      mutationHandlers.add_delete_body_ref(doc, { type: 'add_delete_body_ref', featureId: 'DB', bodyQuery: '@body_2' })
    }).not.toThrow()
    expect(delBody(doc)!.bodies).toEqual(['@body_1', '@body_2'])
    expect(() => {
      mutationHandlers.remove_delete_body_ref(doc, { type: 'remove_delete_body_ref', featureId: 'DB', index: 0 })
    }).not.toThrow()
    expect(delBody(doc)!.bodies).toEqual(['@body_2'])
  })

  it('transform handlers do not crash on a legacy singular-body doc', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'TR', kind: 'transform', transform: { body: '@body_1', operation: 'new' } }],
    } as unknown as PartDoc
    expect(() => {
      mutationHandlers.add_transform_body(doc, { type: 'add_transform_body', featureId: 'TR', bodyQuery: '@body_2' })
    }).not.toThrow()
    expect(transform(doc)!.bodies).toEqual(['@body_1', '@body_2'])
  })
})

describe('mutationHandlers forward doc-level + part-style mutations', () => {
  it('add_sketch / add_plane and their field/visibility ops', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S2', label: 'Sketch 2' })
    expect(sketch2(doc).kind).toBe('sketch')
    mutationHandlers.add_plane(doc, { type: 'add_plane', featureId: 'PL', label: 'Plane' })
    mutationHandlers.set_plane_definition_field(doc, { type: 'set_plane_definition_field', featureId: 'PL', field: 'offset', value: 5 })
    expect(featureById(doc, 'PL', 'plane').kind).toBe('plane')
    mutationHandlers.toggle_plane_visibility(doc, { type: 'toggle_plane_visibility' })
    mutationHandlers.toggle_sketch_plane_visibility(doc, { type: 'toggle_sketch_plane_visibility' })
    mutationHandlers.set_feature_visibility(doc, { type: 'set_feature_visibility', featureId: 'S1', visible: false })
    expect(sketch1(doc).visible).toBe(false)
  })

  it('add_sketch carries an optional plane query', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S2', label: 'Sketch 2', plane: '@builtin_plane_top' })
    expect(sketch2(doc).plane).toBe('@builtin_plane_top')
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S3' })
    expect(sketch3(doc).plane).toBeUndefined()
  })

  it('rename_feature / set_feature_suppression', () => {
    const doc = sketchDoc()
    mutationHandlers.rename_feature(doc, { type: 'rename_feature', featureId: 'S1', label: 'Renamed' })
    expect(sketch1(doc).label).toBe('Renamed')
    mutationHandlers.set_feature_suppression(doc, { type: 'set_feature_suppression', featureId: 'S1', suppressed: true })
    expect(sketch1(doc).suppressed).toBe(true)
  })

  it('reorder_features / reorder_pick_field are dispatched', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S2' })
    expect(() => {
      mutationHandlers.reorder_features(doc, { type: 'reorder_features', featureId: 'S2', toIndex: 0 })
      mutationHandlers.reorder_pick_field(doc, { type: 'reorder_pick_field', featureId: 'S1', field: 'edges', fromIndex: 0, toIndex: 1 })
    }).not.toThrow()
  })

  it('part-style: rename, color, material, visibility', () => {
    const doc = sketchDoc()
    mutationHandlers.rename_part(doc, { type: 'rename_part', bodyId: '@body_1', name: 'Widget' })
    mutationHandlers.set_part_color(doc, { type: 'set_part_color', bodyId: '@body_1', color: '#ff0000' })
    mutationHandlers.set_part_transparency(doc, { type: 'set_part_transparency', bodyId: '@body_1', transparency: 0.5 })
    mutationHandlers.set_part_metalness(doc, { type: 'set_part_metalness', bodyId: '@body_1', metalness: 0.2 })
    mutationHandlers.set_part_roughness(doc, { type: 'set_part_roughness', bodyId: '@body_1', roughness: 0.3 })
    mutationHandlers.set_part_transmission(doc, { type: 'set_part_transmission', bodyId: '@body_1', transmission: 0.1 })
    mutationHandlers.set_body_visibility(doc, { type: 'set_body_visibility', bodyId: '@body_1', visible: false })
    const ps = doc.part_style!['@body_1']
    expect(ps).toMatchObject({ name: 'Widget', color: '#ff0000', visible: false })
  })

  it('delete_feature removes the feature', () => {
    const doc = sketchDoc()
    mutationHandlers.delete_feature(doc, { type: 'delete_feature', featureId: 'S1' })
    expect(feature(doc, 'S1')).toBeUndefined()
  })

  it('remove_dangling_content removes the flagged entities and constraints', () => {
    const doc = sketchDoc()
    // Only source-carrying (projected) entities are eligible for removal.
    sketch1(doc).entities!.push({ id: 'proj', kind: 'line', source: '?edge;x' })
    mutationHandlers.remove_dangling_content(doc, {
      type: 'remove_dangling_content',
      features: {
        S1: { entities: ['proj'], constraints: ['k1'] },
      },
    })
    const f = sketch1(doc)
    expect(f.entities!.some(e => e.id === 'proj')).toBe(false)
    expect(f.entities!.some(e => e.id === 'l1')).toBe(true)
    expect(f.constraints!.some(c => c.id === 'k1')).toBe(false)
  })

  it('edit_session is a no-op marker', () => {
    const doc = sketchDoc()
    const before = JSON.stringify(doc)
    mutationHandlers.edit_session(doc, { type: 'edit_session', featureId: 'S1' })
    expect(JSON.stringify(doc)).toBe(before)
  })
})
