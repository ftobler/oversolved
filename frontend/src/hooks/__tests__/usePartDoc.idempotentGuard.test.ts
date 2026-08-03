// The IDEMPOTENT_MUTATION_TYPES no-op guard in handleMutation: a dispatch that
// leaves the doc byte-identical must push no undo entry, set no dirty flag and
// waste no re-solve. This pins the guard for set_rollback (a same-position
// drag) and the remove_* family (a stale out-of-range index), and confirms the
// add_* toggle family stays unguarded (a re-add is a real toggle change).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'

// The no-op guard's failLoud for a body-style mutation missing its bodyId must
// throw in dev/test but only warn in prod, and one test file cannot hold both
// behaviors of the real failLoud at once. It is mocked with a controllable
// implementation: the dev tests make it throw, the prod tests make it warn.
const { failLoudMock } = vi.hoisted(() => ({ failLoudMock: vi.fn() }))

vi.mock('@/stores/stateInvariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/stateInvariants')>()
  return { ...actual, failLoud: failLoudMock }
})

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()
const pushUndo = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: vi.fn(),
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    ownerUsername: null,
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
    cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {},
    setSolveResults: vi.fn(),
    bodies: {},
    pickBodies: {},
    solving: false,
    solveError: null,
    setSolveError: vi.fn(),
    solveResult: null,
    featureTimings: {},
    reSolve,
    validation: null,
  }),
}))

vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({
    undoStack: [],
    redoStack: [],
    suppressUndoRef: { current: false },
    pushUndo,
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    saveUndoStackSnapshot: vi.fn(),
    restoreUndoStackSnapshot: vi.fn(),
    clearUndoStackSnapshot: vi.fn(),
  }),
}))

function setDoc(doc: PartDoc) {
  docRef.current = doc
}

function makeDoc(rollback?: number): PartDoc {
  const doc: PartDoc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'ex2', kind: 'extrude' },
    ],
  }
  if (rollback !== undefined) doc.rollback = rollback
  return doc
}

function renderPartDoc() {
  return renderHookStrict(() => usePartDoc('test-uuid', 'feature', vi.fn(), { solveOnLoad: false }))
}

// One doc per remove_* handler, each with a list long enough that a valid index
// differs from the out-of-range one the guard is exercised with.
const REMOVE_CASES: { name: string; makeDoc: () => PartDoc; mutation: Mutation }[] = [
  {
    name: 'remove_extrude_profile',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_extrude_profile', featureId: 'ex1', index: 9 },
  },
  {
    name: 'remove_revolve_profile',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'rv1', kind: 'revolve', revolve: { sketch: ['@sk1'], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_revolve_profile', featureId: 'rv1', index: 9 },
  },
  {
    name: 'remove_sweep_profile',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['@sk1'], path: ['@p1'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_sweep_profile', featureId: 'sw1', index: 9 },
  },
  {
    name: 'remove_sweep_path',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['@sk1'], path: ['@p1'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_sweep_path', featureId: 'sw1', index: 9 },
  },
  {
    name: 'remove_fillet_edge',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2'], radius: 1 } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_fillet_edge', featureId: 'f1', index: 9 },
  },
  {
    name: 'remove_chamfer_edge',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'ch1', kind: 'chamfer', chamfer: { edges: ['?e1'], distance: 1, kind: 'distance', angle: 45 } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_chamfer_edge', featureId: 'ch1', index: 9 },
  },
  {
    name: 'remove_delete_body_ref',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'db1', kind: 'delete_body', delete_body: { bodies: ['@b1', '@b2'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_delete_body_ref', featureId: 'db1', index: 9 },
  },
  {
    name: 'remove_transform_body',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 't1', kind: 'transform', transform: { bodies: ['@b1', '@b2'], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_transform_body', featureId: 't1', index: 9 },
  },
  {
    name: 'remove_boolean_tool (tool not listed)',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'b1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: ['@t1'] } }] }) as unknown as PartDoc,
    mutation: { type: 'remove_boolean_tool', featureId: 'b1', tool: '@missing' },
  },
]

beforeEach(() => {
  docRef.current = null
  reSolve.mockClear()
  pushUndo.mockClear()
  failLoudMock.mockReset()
  failLoudMock.mockImplementation((msg: string) => { throw new Error(msg) })
  usePartEditorStore.setState({ rollbackPosition: null, editingFeatureId: null, pickBoundary: null })
  useUnsavedChangesStore.getState().setDirty(false)
})

describe('idempotent no-op guard', () => {
  it('set_rollback to the doc position already parked pushes nothing and stays clean', () => {
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(2)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 2 }) })

    expect(pushUndo).not.toHaveBeenCalled()
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(docRef.current!.rollback).toBe(2)
  })

  it('set_rollback to the end when the key is absent is a no-op', () => {
    setDoc(makeDoc())
    usePartEditorStore.getState().setRollbackPosition(3)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 3 }) })

    expect(pushUndo).not.toHaveBeenCalled()
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect('rollback' in docRef.current!).toBe(false)
  })

  it('set_rollback to a NEW position pushes an entry, updates the doc and re-solves', () => {
    setDoc(makeDoc(2))
    usePartEditorStore.getState().setRollbackPosition(1)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 1 }) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(docRef.current!.rollback).toBe(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
  })

  describe.each(REMOVE_CASES)('$name with an out-of-range index', ({ makeDoc, mutation }) => {
    it('pushes nothing and does not re-solve', () => {
      setDoc(makeDoc())
      const { result } = renderPartDoc()
      const before = JSON.stringify(docRef.current)

      act(() => { result.current.handleMutation(mutation) })

      expect(JSON.stringify(docRef.current)).toBe(before)
      expect(pushUndo).not.toHaveBeenCalled()
      expect(reSolve).not.toHaveBeenCalled()
      expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    })
  })

  it('a real remove at a valid index still pushes and re-solves', () => {
    setDoc({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' } }] } as unknown as PartDoc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'remove_extrude_profile', featureId: 'ex1', index: 0 }) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { extrude: { sketch: string[] } }).extrude.sketch).toEqual(['@sk2'])
  })

  it('re-adding an already-listed edge toggles it back out and still pushes', () => {
    setDoc({ version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2'], radius: 1 } }] } as unknown as PartDoc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?e1' }) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { fillet: { edges: string[] } }).fillet.edges).toEqual(['?e2'])
  })
})

// ─── No-op pins for the unpinned idempotent field setters ───

// The setter docs each already hold the value the `same` mutation writes, so a
// no-op dispatch must leave the doc byte-identical; `changed` must land exactly
// one undo entry through the real handleMutation. Each case narrows to the
// touched feature (or part_style entry), matching noOpSliceFor's scope.
const extrudeNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1'], distance: 10, direction: 'normal' } }] }) as unknown as PartDoc
const revolveNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'rv1', kind: 'revolve', revolve: { sketch: ['@sk1'], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] } }] }) as unknown as PartDoc
const sweepNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['@sk1'], path: [] } }] }) as unknown as PartDoc
const filletNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: [], radius: 1 } }] }) as unknown as PartDoc
const chamferNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'ch1', kind: 'chamfer', chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 } }] }) as unknown as PartDoc
const booleanNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'b1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: [] } }] }) as unknown as PartDoc
const arrayNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'a1', kind: 'array', array: { mode: 'linear', count_x: 2, pitch_x: 20, operation: 'add', include_source: true } }] }) as unknown as PartDoc
const circularArrayNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'ca1', kind: 'circular_array', circular_array: { count: 4, operation: 'add', include_source: true } }] }) as unknown as PartDoc
const holeNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'h1', kind: 'hole', hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' } }] }) as unknown as PartDoc
const transformNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 't1', kind: 'transform', transform: { bodies: [], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 } }] }) as unknown as PartDoc
const mirrorNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'm1', kind: 'mirror', mirror: { body: '', plane: '', keep_original: true, merge: true } }] }) as unknown as PartDoc
const variableNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'v1', kind: 'variable', variable: { expression: '0' } }] }) as unknown as PartDoc
const constraintNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch', constraints: [{ id: 'c1', kind: 'horizontal', target: '$l1', value: 5, pos: [1, 2], sign: 1 }] }] }) as unknown as PartDoc
const partStyleNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', part_style: { b1: { name: 'part 1', color: '#ff0000', transparency: 0.5, metalness: 0.5, roughness: 0.3, transmission: 0.2, visible: false } } }) as unknown as PartDoc
const treeNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch', plane: 'Front' }, { id: 'Top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 15 } }] }) as unknown as PartDoc

interface NoOpPinCase {
  name: string
  makeDoc: () => PartDoc
  same: Mutation
  changed: Mutation
}

const NO_OP_PINS: NoOpPinCase[] = [
  { name: 'set_extrude_field', makeDoc: extrudeNoopDoc, same: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 10 }, changed: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 30 } },
  { name: 'set_revolve_field', makeDoc: revolveNoopDoc, same: { type: 'set_revolve_field', featureId: 'rv1', field: 'angle', value: 360 }, changed: { type: 'set_revolve_field', featureId: 'rv1', field: 'angle', value: 120 } },
  { name: 'set_sweep_field', makeDoc: sweepNoopDoc, same: { type: 'set_sweep_field', featureId: 'sw1', field: 'sketch', value: ['@sk1'] }, changed: { type: 'set_sweep_field', featureId: 'sw1', field: 'sketch', value: ['@sk1', '@sk2'] } },
  { name: 'set_fillet_field', makeDoc: filletNoopDoc, same: { type: 'set_fillet_field', featureId: 'f1', field: 'radius', value: 1 }, changed: { type: 'set_fillet_field', featureId: 'f1', field: 'radius', value: 3 } },
  { name: 'set_chamfer_field', makeDoc: chamferNoopDoc, same: { type: 'set_chamfer_field', featureId: 'ch1', field: 'distance', value: 1 }, changed: { type: 'set_chamfer_field', featureId: 'ch1', field: 'distance', value: 5 } },
  { name: 'set_boolean_field', makeDoc: booleanNoopDoc, same: { type: 'set_boolean_field', featureId: 'b1', field: 'operation', value: 'union' }, changed: { type: 'set_boolean_field', featureId: 'b1', field: 'operation', value: 'subtract' } },
  { name: 'set_array_field', makeDoc: arrayNoopDoc, same: { type: 'set_array_field', featureId: 'a1', field: 'count_x', value: 2 }, changed: { type: 'set_array_field', featureId: 'a1', field: 'count_x', value: 5 } },
  { name: 'set_circular_array_field', makeDoc: circularArrayNoopDoc, same: { type: 'set_circular_array_field', featureId: 'ca1', field: 'count', value: 4 }, changed: { type: 'set_circular_array_field', featureId: 'ca1', field: 'count', value: 8 } },
  { name: 'set_hole_field', makeDoc: holeNoopDoc, same: { type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 10 }, changed: { type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 15 } },
  { name: 'set_transform_field', makeDoc: transformNoopDoc, same: { type: 'set_transform_field', featureId: 't1', field: 'scale', value: 1 }, changed: { type: 'set_transform_field', featureId: 't1', field: 'scale', value: 2 } },
  { name: 'set_mirror_field', makeDoc: mirrorNoopDoc, same: { type: 'set_mirror_field', featureId: 'm1', field: 'keep_original', value: true }, changed: { type: 'set_mirror_field', featureId: 'm1', field: 'keep_original', value: false } },
  { name: 'set_variable_field', makeDoc: variableNoopDoc, same: { type: 'set_variable_field', featureId: 'v1', field: 'expression', value: '0' }, changed: { type: 'set_variable_field', featureId: 'v1', field: 'expression', value: '42' } },
  { name: 'set_constraint_value', makeDoc: constraintNoopDoc, same: { type: 'set_constraint_value', featureId: 'sk1', constraintId: 'c1', value: 5 }, changed: { type: 'set_constraint_value', featureId: 'sk1', constraintId: 'c1', value: 42.5678 } },
  { name: 'set_constraint_pos', makeDoc: constraintNoopDoc, same: { type: 'set_constraint_pos', featureId: 'sk1', constraintId: 'c1', pos: [1, 2] }, changed: { type: 'set_constraint_pos', featureId: 'sk1', constraintId: 'c1', pos: [3.5, -2] } },
  { name: 'set_constraint_sign', makeDoc: constraintNoopDoc, same: { type: 'set_constraint_sign', featureId: 'sk1', constraintId: 'c1', sign: 1 }, changed: { type: 'set_constraint_sign', featureId: 'sk1', constraintId: 'c1', sign: -1 } },
  { name: 'set_part_color', makeDoc: partStyleNoopDoc, same: { type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }, changed: { type: 'set_part_color', bodyId: 'b1', color: '#00ff00' } },
  { name: 'set_part_transparency', makeDoc: partStyleNoopDoc, same: { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 }, changed: { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.8 } },
  { name: 'set_part_metalness', makeDoc: partStyleNoopDoc, same: { type: 'set_part_metalness', bodyId: 'b1', metalness: 0.5 }, changed: { type: 'set_part_metalness', bodyId: 'b1', metalness: 0.8 } },
  { name: 'set_part_roughness', makeDoc: partStyleNoopDoc, same: { type: 'set_part_roughness', bodyId: 'b1', roughness: 0.3 }, changed: { type: 'set_part_roughness', bodyId: 'b1', roughness: 0.8 } },
  { name: 'set_part_transmission', makeDoc: partStyleNoopDoc, same: { type: 'set_part_transmission', bodyId: 'b1', transmission: 0.2 }, changed: { type: 'set_part_transmission', bodyId: 'b1', transmission: 0.7 } },
  { name: 'rename_part', makeDoc: partStyleNoopDoc, same: { type: 'rename_part', bodyId: 'b1', name: 'part 1' }, changed: { type: 'rename_part', bodyId: 'b1', name: 'renamed' } },
  { name: 'set_body_visibility', makeDoc: partStyleNoopDoc, same: { type: 'set_body_visibility', bodyId: 'b1', visible: false }, changed: { type: 'set_body_visibility', bodyId: 'b1', visible: true } },
  { name: 'set_feature_plane', makeDoc: treeNoopDoc, same: { type: 'set_feature_plane', featureId: 'sk1', plane: 'Front' }, changed: { type: 'set_feature_plane', featureId: 'sk1', plane: 'Top' } },
  { name: 'set_plane_definition_field', makeDoc: treeNoopDoc, same: { type: 'set_plane_definition_field', featureId: 'Top', field: 'offset', value: 15 }, changed: { type: 'set_plane_definition_field', featureId: 'Top', field: 'offset', value: 25 } },
]

describe.each(NO_OP_PINS)('idempotent no-op pin: $name', ({ makeDoc, same, changed }) => {
  it('dispatching the current value pushes nothing and stays clean', () => {
    setDoc(makeDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation(same) })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(pushUndo).not.toHaveBeenCalled()
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('dispatching a changed value pushes exactly one entry, marks dirty and re-solves', () => {
    setDoc(makeDoc())
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(changed) })

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolve).toHaveBeenCalledTimes(1)
  })
})

// ─── Body-style mutations with a missing bodyId ───

// A body-style mutation without a bodyId writes part_style[undefined] - a real
// doc change the no-op slice cannot represent - so the guard must never swallow
// it. failLoud flags the missing id in dev/test; in prod the mutation still
// lands (push + dirty + solve).
const BODYLESS_MUTATIONS: { name: string; mutation: Mutation }[] = [
  { name: 'set_part_color', mutation: { type: 'set_part_color', color: '#00ff00' } as unknown as Mutation },
  { name: 'set_part_transparency', mutation: { type: 'set_part_transparency', transparency: 0.5 } as unknown as Mutation },
  { name: 'rename_part', mutation: { type: 'rename_part', name: 'renamed' } as unknown as Mutation },
]

describe.each(BODYLESS_MUTATIONS)('$name dispatched with no bodyId', ({ mutation }) => {
  it('failLouds in dev/test before the change can be silently swallowed', () => {
    setDoc(partStyleNoopDoc())
    const { result } = renderPartDoc()

    expect(() => {
      act(() => { result.current.handleMutation(mutation) })
    }).toThrow(/bodyId/)

    expect(failLoudMock).toHaveBeenCalledTimes(1)
    expect(pushUndo).not.toHaveBeenCalled()
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('in prod still pushes an entry and marks dirty (the guard never swallows it)', () => {
    failLoudMock.mockImplementation(() => {})
    setDoc(partStyleNoopDoc())
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(mutation) })

    expect(failLoudMock).toHaveBeenCalledTimes(1)
    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.part_style as Record<string, unknown>)['undefined']).toBeDefined()
  })
})
