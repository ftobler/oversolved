// Parameterized undo/redo round-trip through the REAL mutation handlers.
//
// Under snapshot undo the doc-equality half of a round-trip is near-mechanical:
// any handler that neither throws nor mutates the shared pre-doc in place
// round-trips. Its value is a no-throw + immutability smoke suite over the
// handlers that used to have no undo coverage at all. The side-effecting
// mutations (delete_feature, move_*, set_rollback) get dedicated assertions
// below because their side effects are what a regression can silently break.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()
// The mocked solver writes into this record, so the optimistic prune
// handleMutation does synchronously is observable to the test.
let solveResults: Record<string, SketchData> = {}

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    ownerUsername: null, loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
    permission: 'owner', isCloudDoc: false,
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults,
    setSolveResults: (r: Record<string, SketchData>) => { solveResults = r },
    bodies: {}, pickBodies: {}, pickStateReady: false,
    solving: false, solveError: null, setSolveError: vi.fn(),
    solveResult: null, featureTimings: {}, reSolve, validation: null,
  }),
}))

// ─── Doc builders ───

const emptyDoc = (): PartDoc => ({ oversolved: 1, kind: 'part', features: [] } as unknown as PartDoc)

const sketchDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'sk1',
    kind: 'sketch',
    entities: [
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
    ],
    initial: { l1: [0, 0, 10, 0], l2: [0, 5, 10, 5] },
    constraints: [{ id: 'c1', kind: 'horizontal', target: '$l1' }],
  }],
} as unknown as PartDoc)

const extrudeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'ex1', kind: 'extrude', label: 'Ext',
    extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' },
  }],
} as unknown as PartDoc)

const revolveDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'rv1', kind: 'revolve', label: 'Rev',
    revolve: { sketch: ['@sk1'], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] },
  }],
} as unknown as PartDoc)

const sweepDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'sw1', kind: 'sweep', label: 'Sweep',
    sweep: { sketch: [], path: [] },
  }],
} as unknown as PartDoc)

const filletDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'f1', kind: 'fillet', label: 'Fillet',
    fillet: { edges: ['?e1', '?e2'], radius: 1 },
  }],
} as unknown as PartDoc)

const chamferDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'ch1', kind: 'chamfer', label: 'Chamfer',
    chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 },
  }],
} as unknown as PartDoc)

const booleanDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'b1', kind: 'boolean', label: 'Boolean',
    boolean: { operation: 'union', target: '', tools: ['@t1'] },
  }],
} as unknown as PartDoc)

const arrayDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'a1', kind: 'array', label: 'Array',
    array: { mode: 'linear', count_x: 2, pitch_x: 20, operation: 'add', include_source: true },
  }],
} as unknown as PartDoc)

const circularArrayDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'ca1', kind: 'circular_array', label: 'Circular Array',
    circular_array: { count: 4, operation: 'add', include_source: true },
  }],
} as unknown as PartDoc)

const holeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'h1', kind: 'hole', label: 'Hole',
    hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' },
  }],
} as unknown as PartDoc)

const transformDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 't1', kind: 'transform', label: 'Transform',
    transform: { bodies: ['@b1', '@b2'], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
  }],
} as unknown as PartDoc)

const mirrorDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'm1', kind: 'mirror', label: 'Mirror',
    mirror: { body: '', plane: '', keep_original: true, merge: true },
  }],
} as unknown as PartDoc)

const variableDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'v1', kind: 'variable', label: 'v1',
    variable: { expression: '0' },
  }],
} as unknown as PartDoc)

const partStyleDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  part_style: { b1: { name: 'part 1', color: '#ff0000' } },
  features: [],
} as unknown as PartDoc)

const planeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'Top', kind: 'plane',
    definition: { mode: 'offset', plane: '@builtin_plane_front' },
  }],
} as unknown as PartDoc)

const treeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane' },
    { id: 'Front', kind: 'plane' },
    { id: 'Right', kind: 'plane' },
    { id: 'f1', kind: 'sketch', label: 'first' },
    { id: 'f2', kind: 'sketch', label: 'second' },
  ],
} as unknown as PartDoc)

const deleteBodyDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [
    { id: 'ex1', kind: 'extrude', label: 'Ext' },
    { id: 'db1', kind: 'delete_body', label: 'Delete Body', delete_body: { bodies: ['@b1', '@b2'] } },
  ],
} as unknown as PartDoc)

// The remove-by-index handlers need a non-empty list to splice, while the
// plain sweepDoc/chamferDoc start empty; these feed the remove round-trips.
const sweepPopulatedDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'sw1', kind: 'sweep', label: 'Sweep',
    sweep: { sketch: ['@sk1'], path: ['@path1'] },
  }],
} as unknown as PartDoc)

const chamferPopulatedDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'ch1', kind: 'chamfer', label: 'Chamfer',
    chamfer: { edges: ['?e1'], distance: 1, kind: 'distance', angle: 45 },
  }],
} as unknown as PartDoc)

// A projected entity (source-carrying) and a superfluous constraint, the two
// things remove_dangling_content is eligible to clean up.
const danglingDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{
    id: 'sk1', kind: 'sketch',
    entities: [
      { id: 'l1', kind: 'line' },
      { id: 'proj1', kind: 'line', source: '?edge;x' },
    ],
    constraints: [{ id: 'c_super', kind: 'horizontal', target: '$l1' }],
  }],
} as unknown as PartDoc)

// ─── Round-trip table ───

interface RoundTripCase {
  name: string
  makeDoc: () => PartDoc
  mutation: Mutation
}

// One (or more) member per handler family. Every case must produce a real doc
// change: an idempotent mutation with a same-value payload would be skipped by
// the no-op guard and the undo would pop nothing.
const ROUND_TRIPS: RoundTripCase[] = [
  // sketch
  { name: 'sketch add_entity', makeDoc: sketchDoc, mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [1, 1, 2, 2], entityId: 'l3' } as Mutation },
  { name: 'sketch add_constraint', makeDoc: sketchDoc, mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l1:end', 'vertex:sk1:l2:start'] } as Mutation },
  { name: 'sketch set_constraint_value', makeDoc: sketchDoc, mutation: { type: 'set_constraint_value', featureId: 'sk1', constraintId: 'c1', value: 5 } as Mutation },
  { name: 'sketch set_constraint_pos', makeDoc: sketchDoc, mutation: { type: 'set_constraint_pos', featureId: 'sk1', constraintId: 'c1', pos: [1, 2] } as Mutation },
  { name: 'sketch set_constraint_sign', makeDoc: sketchDoc, mutation: { type: 'set_constraint_sign', featureId: 'sk1', constraintId: 'c1', sign: -1 } as Mutation },
  { name: 'sketch delete', makeDoc: sketchDoc, mutation: { type: 'delete', targets: ['entity:sk1:l2'] } as Mutation },
  { name: 'sketch toggle_construction', makeDoc: sketchDoc, mutation: { type: 'toggle_construction', targets: ['entity:sk1:l2'] } as Mutation },
  { name: 'sketch add_rect', makeDoc: sketchDoc, mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [5, 5] } as Mutation },
  { name: 'sketch add_center_rect', makeDoc: sketchDoc, mutation: { type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [5, 5] } as Mutation },
  { name: 'sketch add_ngon', makeDoc: sketchDoc, mutation: { type: 'add_ngon', featureId: 'sk1', center: [0, 0], corner: [10, 0], sides: 6 } as Mutation },
  { name: 'sketch apply_offset', makeDoc: sketchDoc, mutation: { type: 'apply_offset', featureId: 'sk1', sourceIds: ['l1'], distance: 2 } as Mutation },
  { name: 'sketch add_projected_entity', makeDoc: sketchDoc, mutation: { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?edge;line', entityId: 'p1' } as Mutation },
  { name: 'sketch add_entity_with_constraint', makeDoc: sketchDoc, mutation: { type: 'add_entity_with_constraint', featureId: 'sk1', kind: 'line', params: [1, 1, 2, 2], vertexKey: 'start', snapVertexId: 'vertex:sk1:l1:end', constraintKind: 'coincident', entityId: 'l3' } as Mutation },

  // extrude
  { name: 'extrude add_extrude', makeDoc: emptyDoc, mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10 } as Mutation },
  { name: 'extrude set_extrude_field', makeDoc: extrudeDoc, mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 30 } as Mutation },
  { name: 'extrude add_extrude_profile', makeDoc: extrudeDoc, mutation: { type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '@sk3' } as Mutation },
  { name: 'extrude remove_extrude_profile', makeDoc: extrudeDoc, mutation: { type: 'remove_extrude_profile', featureId: 'ex1', index: 0 } as Mutation },

  // revolve
  { name: 'revolve add_revolve', makeDoc: emptyDoc, mutation: { type: 'add_revolve', featureId: 'rv1', label: 'Rev', sketchQuery: '@sk1', angle: 180 } as Mutation },
  { name: 'revolve set_revolve_field', makeDoc: revolveDoc, mutation: { type: 'set_revolve_field', featureId: 'rv1', field: 'angle', value: 120 } as Mutation },
  { name: 'revolve add_revolve_profile', makeDoc: revolveDoc, mutation: { type: 'add_revolve_profile', featureId: 'rv1', sketchQuery: '@sk2' } as Mutation },
  { name: 'revolve remove_revolve_profile', makeDoc: revolveDoc, mutation: { type: 'remove_revolve_profile', featureId: 'rv1', index: 0 } as Mutation },

  // sweep
  { name: 'sweep add_sweep', makeDoc: emptyDoc, mutation: { type: 'add_sweep', featureId: 'sw1', label: 'Sweep', sketchQuery: '@sk1', pathQuery: '@path1' } as Mutation },
  { name: 'sweep set_sweep_field', makeDoc: sweepDoc, mutation: { type: 'set_sweep_field', featureId: 'sw1', field: 'sketch', value: '@sk1' } as Mutation },
  { name: 'sweep add_sweep_profile', makeDoc: sweepPopulatedDoc, mutation: { type: 'add_sweep_profile', featureId: 'sw1', sketchQuery: '@sk2' } as Mutation },
  { name: 'sweep remove_sweep_profile', makeDoc: sweepPopulatedDoc, mutation: { type: 'remove_sweep_profile', featureId: 'sw1', index: 0 } as Mutation },
  { name: 'sweep add_sweep_path', makeDoc: sweepPopulatedDoc, mutation: { type: 'add_sweep_path', featureId: 'sw1', pathQuery: '@path2' } as Mutation },
  { name: 'sweep remove_sweep_path', makeDoc: sweepPopulatedDoc, mutation: { type: 'remove_sweep_path', featureId: 'sw1', index: 0 } as Mutation },

  // fillet
  { name: 'fillet add_fillet', makeDoc: emptyDoc, mutation: { type: 'add_fillet', featureId: 'f1', label: 'Fillet' } as Mutation },
  { name: 'fillet set_fillet_field', makeDoc: filletDoc, mutation: { type: 'set_fillet_field', featureId: 'f1', field: 'radius', value: 3 } as Mutation },
  { name: 'fillet add_fillet_edge', makeDoc: filletDoc, mutation: { type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?e3' } as Mutation },
  { name: 'fillet remove_fillet_edge', makeDoc: filletDoc, mutation: { type: 'remove_fillet_edge', featureId: 'f1', index: 0 } as Mutation },

  // chamfer
  { name: 'chamfer add_chamfer', makeDoc: emptyDoc, mutation: { type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer' } as Mutation },
  { name: 'chamfer set_chamfer_field', makeDoc: chamferDoc, mutation: { type: 'set_chamfer_field', featureId: 'ch1', field: 'distance', value: 5 } as Mutation },
  { name: 'chamfer add_chamfer_edge', makeDoc: chamferDoc, mutation: { type: 'add_chamfer_edge', featureId: 'ch1', edgeQuery: '?e1' } as Mutation },
  { name: 'chamfer remove_chamfer_edge', makeDoc: chamferPopulatedDoc, mutation: { type: 'remove_chamfer_edge', featureId: 'ch1', index: 0 } as Mutation },

  // boolean
  { name: 'boolean add_boolean', makeDoc: emptyDoc, mutation: { type: 'add_boolean', featureId: 'b1', label: 'Boolean' } as Mutation },
  { name: 'boolean set_boolean_field', makeDoc: booleanDoc, mutation: { type: 'set_boolean_field', featureId: 'b1', field: 'operation', value: 'subtract' } as Mutation },
  { name: 'boolean add_boolean_tool', makeDoc: booleanDoc, mutation: { type: 'add_boolean_tool', featureId: 'b1', tool: '@t2' } as Mutation },
  { name: 'boolean remove_boolean_tool', makeDoc: booleanDoc, mutation: { type: 'remove_boolean_tool', featureId: 'b1', tool: '@t1' } as Mutation },

  // array
  { name: 'array add_array', makeDoc: emptyDoc, mutation: { type: 'add_array', featureId: 'a1', label: 'Array' } as Mutation },
  { name: 'array set_array_field', makeDoc: arrayDoc, mutation: { type: 'set_array_field', featureId: 'a1', field: 'count_x', value: 5 } as Mutation },
  { name: 'array add_circular_array', makeDoc: emptyDoc, mutation: { type: 'add_circular_array', featureId: 'ca1', label: 'Circular Array' } as Mutation },
  { name: 'array set_circular_array_field', makeDoc: circularArrayDoc, mutation: { type: 'set_circular_array_field', featureId: 'ca1', field: 'count', value: 8 } as Mutation },

  // hole
  { name: 'hole add_hole', makeDoc: emptyDoc, mutation: { type: 'add_hole', featureId: 'h1', label: 'Hole' } as Mutation },
  { name: 'hole set_hole_field', makeDoc: holeDoc, mutation: { type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 15 } as Mutation },

  // transform
  { name: 'transform add_transform', makeDoc: emptyDoc, mutation: { type: 'add_transform', featureId: 't1', label: 'Transform' } as Mutation },
  { name: 'transform set_transform_field', makeDoc: transformDoc, mutation: { type: 'set_transform_field', featureId: 't1', field: 'scale', value: 2 } as Mutation },
  { name: 'transform add_transform_body', makeDoc: transformDoc, mutation: { type: 'add_transform_body', featureId: 't1', bodyQuery: '@b3' } as Mutation },
  { name: 'transform remove_transform_body', makeDoc: transformDoc, mutation: { type: 'remove_transform_body', featureId: 't1', index: 0 } as Mutation },

  // mirror
  { name: 'mirror add_mirror', makeDoc: emptyDoc, mutation: { type: 'add_mirror', featureId: 'm1', label: 'Mirror' } as Mutation },
  { name: 'mirror set_mirror_field', makeDoc: mirrorDoc, mutation: { type: 'set_mirror_field', featureId: 'm1', field: 'plane', value: '@top' } as Mutation },

  // variable
  { name: 'variable add_variable', makeDoc: emptyDoc, mutation: { type: 'add_variable', featureId: 'v1', label: 'v1' } as Mutation },
  { name: 'variable set_variable_field', makeDoc: variableDoc, mutation: { type: 'set_variable_field', featureId: 'v1', field: 'expression', value: '42' } as Mutation },

  // part style
  { name: 'part-style set_part_color', makeDoc: partStyleDoc, mutation: { type: 'set_part_color', bodyId: 'b1', color: '#00ff00' } as Mutation },
  { name: 'part-style set_part_transparency', makeDoc: partStyleDoc, mutation: { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 } as Mutation },
  { name: 'part-style set_part_metalness', makeDoc: partStyleDoc, mutation: { type: 'set_part_metalness', bodyId: 'b1', metalness: 0.5 } as Mutation },
  { name: 'part-style set_part_roughness', makeDoc: partStyleDoc, mutation: { type: 'set_part_roughness', bodyId: 'b1', roughness: 0.3 } as Mutation },
  { name: 'part-style set_part_transmission', makeDoc: partStyleDoc, mutation: { type: 'set_part_transmission', bodyId: 'b1', transmission: 0.2 } as Mutation },
  { name: 'part-style rename_part', makeDoc: partStyleDoc, mutation: { type: 'rename_part', bodyId: 'b1', name: 'renamed' } as Mutation },
  { name: 'part-style set_body_visibility', makeDoc: partStyleDoc, mutation: { type: 'set_body_visibility', bodyId: 'b1', visible: false } as Mutation },

  // tree ops
  { name: 'tree add_sketch', makeDoc: emptyDoc, mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Sketch 2' } as Mutation },
  { name: 'tree add_plane', makeDoc: emptyDoc, mutation: { type: 'add_plane', featureId: 'pl1', label: 'Plane 1' } as Mutation },
  { name: 'tree set_plane_definition_field', makeDoc: planeDoc, mutation: { type: 'set_plane_definition_field', featureId: 'Top', field: 'offset', value: 15 } as Mutation },
  { name: 'tree rename_feature', makeDoc: treeDoc, mutation: { type: 'rename_feature', featureId: 'f1', label: 'renamed' } as Mutation },
  { name: 'tree set_feature_plane', makeDoc: treeDoc, mutation: { type: 'set_feature_plane', featureId: 'f1', plane: 'Front' } as Mutation },
  { name: 'tree set_feature_visibility', makeDoc: treeDoc, mutation: { type: 'set_feature_visibility', featureId: 'f1', visible: false } as Mutation },
  { name: 'tree set_feature_suppression', makeDoc: treeDoc, mutation: { type: 'set_feature_suppression', featureId: 'f1', suppressed: true } as Mutation },
  { name: 'tree reorder_features', makeDoc: treeDoc, mutation: { type: 'reorder_features', featureId: 'f2', toIndex: 4 } as Mutation },
  { name: 'tree reorder_pick_field', makeDoc: filletDoc, mutation: { type: 'reorder_pick_field', featureId: 'f1', field: 'edges', fromIndex: 0, toIndex: 1 } as Mutation },
  { name: 'tree toggle_sketch_plane_visibility', makeDoc: sketchDoc, mutation: { type: 'toggle_sketch_plane_visibility' } as Mutation },
  { name: 'tree toggle_plane_visibility', makeDoc: planeDoc, mutation: { type: 'toggle_plane_visibility' } as Mutation },

  // delete body
  { name: 'delete-body add_delete_body', makeDoc: emptyDoc, mutation: { type: 'add_delete_body', featureId: 'db1', bodies: ['@b1'], label: 'Delete Body' } as Mutation },
  { name: 'delete-body add_delete_body_ref', makeDoc: deleteBodyDoc, mutation: { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: '@b3' } as Mutation },
  { name: 'delete-body remove_delete_body_ref', makeDoc: deleteBodyDoc, mutation: { type: 'remove_delete_body_ref', featureId: 'db1', index: 0 } as Mutation },

  // import
  { name: 'import add_import_step', makeDoc: emptyDoc, mutation: { type: 'add_import_step', featureId: 'imp1', label: 'part' } as Mutation },

  // dangling content cleanup: removes the projected entity and its constraint
  { name: 'cleanup remove_dangling_content', makeDoc: danglingDoc, mutation: { type: 'remove_dangling_content', features: { sk1: { entities: ['proj1'], constraints: ['c_super'] } } } as Mutation },
]

describe.each(ROUND_TRIPS)('round-trip: $name', ({ makeDoc, mutation }) => {
  it('forward, undo and redo each land on the expected doc', () => {
    docRef.current = makeDoc()
    solveResults = {}
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))
    const before = structuredClone(docRef.current)

    act(() => { result.current.handleMutation(mutation) })
    // The handler must actually change the doc: a silent no-op here would push
    // a dead entry and the undo below would pop nothing.
    const forward = structuredClone(docRef.current)
    expect(JSON.stringify(forward)).not.toBe(JSON.stringify(before))
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe(mutation.type)

    act(() => { result.current.handleUndo() })
    expect(JSON.stringify(docRef.current)).toBe(JSON.stringify(before))
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
    // The counterpart entry carries the same label, so redo round-trips it.
    expect(result.current.redoStack[0].mutation.type).toBe(mutation.type)

    act(() => { result.current.handleRedo() })
    expect(JSON.stringify(docRef.current)).toBe(JSON.stringify(forward))
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })
})

// ─── Side-effecting mutations ───

describe('round-trip side effects', () => {
  beforeEach(() => {
    docRef.current = null
    solveResults = {}
    reSolve.mockReset()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    usePartEditorStore.getState().setPickBoundary(null)
  })

  it('delete_feature prunes solveResults forward and the undo restores the record for the doc', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }] },
        { id: 'ex1', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    // The undo's re-solve repopulates the record for the features it solves,
    // which is what the real solver does after restoring the deleted feature.
    reSolve.mockImplementation((d: PartDoc) => {
      const next: Record<string, SketchData> = {}
      for (const f of d.features ?? []) {
        if (f.kind === 'sketch') next[f.id] = { status: 'ok', solved: {} }
      }
      solveResults = next
    })
    solveResults = { sk1: { status: 'ok', solved: {} } }
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'sk1' } as Mutation) })
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['ex1'])
    expect(result.current.solveResults.sk1).toBeUndefined()

    act(() => { result.current.handleUndo() })
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['sk1', 'ex1'])
    // The record came back with the restored doc: same feature id, solved geometry.
    expect(result.current.solveResults.sk1).toEqual({ status: 'ok', solved: {} })

    act(() => { result.current.handleRedo() })
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['ex1'])
    expect(result.current.solveResults.sk1).toBeUndefined()
  })

  it('a restorable mutation forwards _restoreSolveResults to the re-solve', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }] },
      ],
    } as unknown as PartDoc
    // The solveResultsRef must already hold the entry for the deleted feature
    // before the mutation, or pruneSolveResults has nothing to restore.
    solveResults = { sk1: { status: 'ok', solved: {} } }
    reSolve.mockClear()
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'sk1' } as Mutation) })

    // handleMutation prunes the entry optimistically and hands the snapshot to
    // the re-solve so a failing solve can repopulate it (the stale-scene guard).
    expect(reSolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ _restoreSolveResults: { sk1: { status: 'ok', solved: {} } } }),
    )
  })

  it('move_vertex adopts the drag frame and undo restores the pre-drag spec', () => {
    docRef.current = sketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))
    const pre = structuredClone(docRef.current)

    act(() => {
      result.current.handleMutation({
        type: 'move_vertex', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1],
        solvedGeometry: { l1: [1, 1, 10, 0], l2: [0.5, 5.5, 10, 5] },
      } as Mutation)
    })

    const sk = docRef.current!.features![0] as { initial: Record<string, number[]> }
    // The frame adopted for every entity, then the dragged vertex teleported.
    expect(sk.initial.l1).toEqual([1, 1, 10, 0])
    expect(sk.initial.l2).toEqual([0.5, 5.5, 10, 5])
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleUndo() })
    const restored = docRef.current!.features![0] as { initial: Record<string, number[]> }
    expect(restored.initial).toEqual((pre.features![0] as { initial: Record<string, number[]> }).initial)
  })

  it('move_vertex_with_constraint adds the snap constraint and undo drops it with the frame', () => {
    docRef.current = sketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => {
      result.current.handleMutation({
        type: 'move_vertex_with_constraint', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1],
        constraintKind: 'coincident', snapEntityRef: 'entity:sk1:l2',
        solvedGeometry: { l1: [1, 1, 10, 0], l2: [0.5, 5.5, 10, 5] },
      } as Mutation)
    })

    const sk = docRef.current!.features![0] as { initial: Record<string, number[]>; constraints: unknown[] }
    expect(sk.initial.l1).toEqual([1, 1, 10, 0])
    expect(sk.constraints).toHaveLength(2)  // horizontal + the snap constraint

    act(() => { result.current.handleUndo() })
    const restored = docRef.current!.features![0] as { initial: Record<string, number[]>; constraints: unknown[] }
    expect(restored.constraints).toHaveLength(1)
    expect(restored.initial.l1).toEqual([0, 0, 10, 0])
  })

  it('move_entity adopts the drag frame without applying the delta on top', () => {
    docRef.current = sketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => {
      result.current.handleMutation({
        type: 'move_entity', featureId: 'sk1', entityId: 'l1', delta: [5, 0],
        solvedGeometry: { l1: [5, 0, 15, 0], l2: [5, 5, 15, 5] },
      } as Mutation)
    })

    const sk = docRef.current!.features![0] as { initial: Record<string, number[]> }
    expect(sk.initial.l1).toEqual([5, 0, 15, 0])
    expect(sk.initial.l2).toEqual([5, 5, 15, 5])

    act(() => { result.current.handleUndo() })
    const restored = docRef.current!.features![0] as { initial: Record<string, number[]> }
    expect(restored.initial.l1).toEqual([0, 0, 10, 0])
  })

  it('set_rollback round-trips doc.rollback against the store-derived restore', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    usePartEditorStore.getState().setRollbackPosition(1)
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 1 }) })
    expect(docRef.current!.rollback).toBe(1)

    act(() => { result.current.handleUndo() })
    // The pre doc carried no rollback, so the undo parks the bar at the end of
    // the feature list it restored.
    expect('rollback' in docRef.current!).toBe(false)
    expect(usePartEditorStore.getState().rollbackPosition).toBe(3)
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.handleRedo() })
    expect(docRef.current!.rollback).toBe(1)
    expect(usePartEditorStore.getState().rollbackPosition).toBe(1)
  })
})

// ─── Retained-snapshot stash across the undo boundary ───

describe('undo/redo restore of the pruned-solve-result stash', () => {
  beforeEach(() => {
    docRef.current = null
    solveResults = {}
    reSolve.mockReset()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    usePartEditorStore.getState().setPickBoundary(null)
  })

  it('the undo re-solve receives the retained snapshot as _restoreSolveResults', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', label: 'Ext' }],
    } as unknown as PartDoc
    solveResults = { ex1: { status: 'ok', solved: {} } }
    reSolve.mockClear()
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex1' } as Mutation) })
    // The forward delete path is unchanged: the direct restorable is handed to
    // the delete's own re-solve.
    expect(reSolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ _restoreSolveResults: { ex1: { status: 'ok', solved: {} } } }),
    )

    reSolve.mockClear()
    act(() => { result.current.handleUndo() })
    // The undo re-solve gets the retained snapshot too (the wrapper reads the
    // stash), so a failing undo re-solve can re-render the feature.
    expect(reSolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ _restoreSolveResults: { ex1: { status: 'ok', solved: {} } } }),
    )

    reSolve.mockClear()
    act(() => { result.current.handleRedo() })
    // Redo restores the post-delete doc, which lacks ex1: the stash entry is
    // filtered out and nothing is passed.
    expect(reSolve.mock.calls[0][1]).toBeUndefined()
  })

  it('a stale stash entry is not handed to an undo whose entry doc lacks the feature', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude' },
        { id: 'ex3', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    solveResults = {
      ex1: { status: 'ok', solved: {} },
      ex2: { status: 'ok', solved: {} },
      ex3: { status: 'ok', solved: {} },
    }
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex2' } as Mutation) })
    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex3' } as Mutation) })

    reSolve.mockClear()
    act(() => { result.current.handleUndo() })
    // The undo restores the pre-delete doc [ex1, ex3]; the retained ex2 entry
    // is dropped because the entry doc lacks ex2.
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['ex1', 'ex3'])
    expect(reSolve.mock.calls[0][1]).toEqual({ _restoreSolveResults: { ex3: { status: 'ok', solved: {} } } })
  })
})
