// The IDEMPOTENT_MUTATION no-op guard in handleMutation: a dispatch that leaves
// the doc byte-identical must push no undo entry, set no dirty flag and waste no
// re-solve, but ONLY for a mutation classified idempotent. This pins the guard
// per family: the value setters, the rename/visibility/suppression writes, the
// reorder of a pick list, set_rollback (a same-position drag), reorder_features
// (a drop that lands where the feature already is), the remove_* family (a stale
// out-of-range index) and the solve-derived remove_dangling_content cleanup
// (stale targets that match nothing). It confirms the excluded families still
// land: the add_* toggle family (a re-add is a real toggle change), and
// delete_feature, which can no-op on an absent id yet stays unguarded on purpose.
// Finally it confirms a REAL change is never swallowed, including by the two
// variants the guard reads through a branch of their own (reorder_features,
// remove_dangling_content).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'

import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { migrateLegacyBodyPicks } from '@/utils/yamlMutations'
import type { PartDoc, Mutation } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'

// The no-op guard's failLoud for a body-style mutation missing its bodyId
// throws in test mode, warns in dev and is a silent no-op in prod, and one test
// file cannot hold both behaviors of the real failLoud at once. It is mocked
// with a controllable implementation: the dev/test cases make it throw, the
// prod case makes it a silent no-op.
const { failLoudMock } = vi.hoisted(() => ({ failLoudMock: vi.fn() }))

// The guard's bodyId diagnostic lives in the shared session module, which
// imports failLoud from utils/invariants; the store module re-exports it but
// is no longer the path the guard reads, so the mock sits on the source.
vi.mock('@/utils/invariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/invariants')>()
  return { ...actual, failLoud: failLoudMock }
})

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: vi.fn(),
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
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

function setDoc(doc: PartDoc) {
  docRef.current = doc
}

function makeDoc(rollback?: number): PartDoc {
  const doc: PartDoc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
      { id: 'ex2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    ],
  }
  if (rollback !== undefined) doc.rollback = rollback
  return doc
}

// The tree with its builtin block: a reorder clamps a drop to the builtins, so
// the "already in that position" cases are only reachable with them present.
function treeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane' },
      { id: 'Front', kind: 'plane' },
      { id: 'Right', kind: 'plane' },
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
      { id: 'ex2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    ],
  } as unknown as PartDoc
}

// A projected (source-carrying) entity plus a constraint on it and one on the
// plain line: the two things the dangling cleanup removes, and the one it keeps.
function danglingDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'proj1', kind: 'line', source: '?edge;x' },
      ],
      constraints: [
        { id: 'c_super', kind: 'horizontal', target: '$l1' },
        { id: 'c_on_proj', kind: 'coincident', target: '$proj1' },
      ],
    }],
  } as unknown as PartDoc
}

function renderPartDoc() {
  return renderHookStrict(() => usePartDoc('test-uuid', { solveOnLoad: false }))
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
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'rv1', kind: 'revolve', revolve: { sketch: ['@sk1'], angle: 360, axis: '@axis' } }] }) as unknown as PartDoc,
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
  failLoudMock.mockReset()
  failLoudMock.mockImplementation((msg: string) => { throw new Error(msg) })
  useEditorState.setState({
    rollbackPosition: null,
    editingFeatureId: null,
    pickBoundary: null,
  })
  useUnsavedChangesStore.getState().setDirty(false)
})

describe('idempotent no-op guard', () => {
  it('set_rollback to the doc position already parked pushes nothing and stays clean', () => {
    setDoc(makeDoc(2))
    useEditorState.getState().setRollbackPosition(2)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 2 }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(docRef.current!.rollback).toBe(2)
  })

  it('set_rollback to the end when the key is absent is a no-op', () => {
    setDoc(makeDoc())
    useEditorState.getState().setRollbackPosition(3)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 3 }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect('rollback' in docRef.current!).toBe(false)
  })

  it('set_rollback to a NEW position pushes an entry, updates the doc and re-solves', () => {
    setDoc(makeDoc(2))
    useEditorState.getState().setRollbackPosition(1)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'set_rollback', position: 1 }) })

    expect(result.current.undoStack).toHaveLength(1)
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
      expect(result.current.undoStack).toHaveLength(0)
      expect(reSolve).not.toHaveBeenCalled()
      expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    })
  })

  it('a real remove at a valid index still pushes and re-solves', () => {
    setDoc({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' } }] } as unknown as PartDoc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'remove_extrude_profile', featureId: 'ex1', index: 0 }) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { extrude: { sketch: string[] } }).extrude.sketch).toEqual(['@sk2'])
  })

  it('re-adding an already-listed edge toggles it back out and still pushes', () => {
    setDoc({ version: 1, kind: 'part', features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2'], radius: 1 } }] } as unknown as PartDoc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?e1' }) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { fillet: { edges: string[] } }).fillet.edges).toEqual(['?e2'])
  })

  it('add_transform_body on a healed legacy doc toggles the ref and stays unguarded', () => {
    // Same pin as add_fillet_edge: the add_* toggle family is not in the no-op
    // guard, so re-picking the healed @b1 must push an entry, not be swallowed.
    const doc: PartDoc = {
      version: 1, kind: 'part',
      features: [{ id: 't1', kind: 'transform', transform: { body: '@b1', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 } }],
    } as unknown as PartDoc
    migrateLegacyBodyPicks(doc)
    setDoc(doc)
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'add_transform_body', featureId: 't1', bodyQuery: '@b1' }) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.features![0] as { transform: { bodies: string[] } }).transform.bodies).toEqual([])
  })

  it('remove_transform_body out-of-range on a healed legacy doc no-ops', () => {
    // A parse seam migrates the legacy doc first, so the out-of-range index
    // splices a real list and leaves the doc byte-identical: no push, no solve.
    const doc: PartDoc = {
      version: 1, kind: 'part',
      features: [{ id: 't1', kind: 'transform', transform: { body: '@b1', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 } }],
    } as unknown as PartDoc
    migrateLegacyBodyPicks(doc)
    setDoc(doc)
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation({ type: 'remove_transform_body', featureId: 't1', index: 9 }) })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('remove_dangling_content naming a missing feature (and an empty list) is a no-op', () => {
    // The cleanup targets come from the last solve; a stale-targets dispatch
    // leaves the doc byte-identical. Without the idempotent guard this pushed a
    // dead undo entry, dirtied the doc and wasted a re-solve.
    setDoc(makeDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => {
      result.current.handleMutation({
        type: 'remove_dangling_content',
        features: {
          ghost: { entities: ['e1'], constraints: ['c1'] },
          sk1: { entities: [], constraints: [] },
        },
      })
    })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('remove_dangling_content flagging a plain (non-projected) entity is a no-op', () => {
    // Only source-carrying entities are eligible: a flagged plain sketch line is
    // kept, so the plan matches nothing removable and must not push.
    setDoc(danglingDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => {
      result.current.handleMutation({
        type: 'remove_dangling_content',
        features: { sk1: { entities: ['l1'], constraints: [] } },
      })
    })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('remove_dangling_content that really cleans up pushes even beside a ghost target', () => {
    // The narrowest slice in the guard: it holds only the features the plan
    // names, and a name that resolves to nothing contributes the same undefined
    // on both sides. The one real removal still has to make the compare differ,
    // or the cleanup would silently drop the projection with no undo entry.
    setDoc(danglingDoc())
    const { result } = renderPartDoc()

    act(() => {
      result.current.handleMutation({
        type: 'remove_dangling_content',
        features: {
          ghost: { entities: ['e1'], constraints: [] },
          sk1: { entities: ['proj1'], constraints: [] },
        },
      })
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolve).toHaveBeenCalledTimes(1)
    const feature = docRef.current!.features![0] as { entities: { id: string }[]; constraints: { id: string }[] }
    expect(feature.entities.map(e => e.id)).toEqual(['l1'])
    // The constraint that referenced the removed projection goes with it, so
    // the doc is not left holding a dangling ref.
    expect(feature.constraints.map(c => c.id)).toEqual(['c_super'])
  })

  // A reorder's slice is the feature ID order alone (it never touches content),
  // so the guard reads it through a branch of its own. The doc carries the
  // builtin block because applyReorderFeatures clamps a drop to it, which is what
  // makes "back where the feature already is" reachable.
  // ─── reorder_features ───
  it('dropping a feature back on its own index leaves the order alone and pushes nothing', () => {
    setDoc(treeDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'ex1', toIndex: 5 }) })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('dropping a feature on its immediate successor leaves the order alone and pushes nothing', () => {
    setDoc(treeDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'ex1', toIndex: 6 }) })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a real reorder pushes one entry, marks dirty and moves the feature', () => {
    setDoc(treeDoc())
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'ex1', toIndex: 2 }) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect(docRef.current!.features!.map(f => f.id)).toEqual([
      'Origin', 'Top', 'Front', 'Right', 'ex1', 'sk1', 'ex2',
    ])
  })
})

// ─── No-op pins for the unpinned idempotent field setters ───

// The setter docs each already hold the value the `same` mutation writes, so a
// no-op dispatch must leave the doc byte-identical; `changed` must land exactly
// one undo entry through the real handleMutation. Each case narrows to the
// touched feature (or part_style entry), matching noOpSliceFor's scope.
const extrudeNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1'], distance: 10, direction: 'normal' } }] }) as unknown as PartDoc
const revolveNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'rv1', kind: 'revolve', revolve: { sketch: ['@sk1'], angle: 360, axis: '@axis' } }] }) as unknown as PartDoc
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
// The featureId path with no sub-def: a rename, the visibility flag (true DELETES
// the key, so an absent flag is the no-op), the suppression stamp, and a pick
// list whose out-of-range index is the no-op.
const renameNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch', label: 'base' }] }) as unknown as PartDoc
const flagNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }] }) as unknown as PartDoc
const pickListNoopDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [{ id: 'b1', kind: 'boolean', boolean: { operation: 'union', target: '', tools: ['@t1', '@t2'] } }] }) as unknown as PartDoc

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
  { name: 'rename_feature', makeDoc: renameNoopDoc, same: { type: 'rename_feature', featureId: 'sk1', label: 'base' }, changed: { type: 'rename_feature', featureId: 'sk1', label: 'renamed' } },
  { name: 'set_feature_visibility', makeDoc: flagNoopDoc, same: { type: 'set_feature_visibility', featureId: 'sk1', visible: true }, changed: { type: 'set_feature_visibility', featureId: 'sk1', visible: false } },
  { name: 'set_feature_suppression', makeDoc: flagNoopDoc, same: { type: 'set_feature_suppression', featureId: 'sk1', suppressed: false }, changed: { type: 'set_feature_suppression', featureId: 'sk1', suppressed: true } },
  { name: 'reorder_pick_field', makeDoc: pickListNoopDoc, same: { type: 'reorder_pick_field', featureId: 'b1', field: 'tools', fromIndex: 9, toIndex: 0 }, changed: { type: 'reorder_pick_field', featureId: 'b1', field: 'tools', fromIndex: 0, toIndex: 1 } },
]

describe.each(NO_OP_PINS)('idempotent no-op pin: $name', ({ makeDoc, same, changed }) => {
  it('dispatching the current value pushes nothing and stays clean', () => {
    setDoc(makeDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation(same) })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('dispatching a changed value pushes exactly one entry, marks dirty and re-solves', () => {
    setDoc(makeDoc())
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(changed) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolve).toHaveBeenCalledTimes(1)
  })
})

// ─── The excluded families still land ───

// An unclassified mutation must never be swallowed, even when its handler
// genuinely leaves the doc byte-identical. delete_feature on an absent id is the
// clean case: applyDeleteFeature filters and matches nothing, so the doc is
// unchanged, yet the classification says false and the guard must not look, so
// the dispatch lands. If the guard ever swallowed these, a user action would
// vanish with no undo entry; the push here is the whole point of the entry.
const UNGUARDED_NO_OPS: { name: string; makeDoc: () => PartDoc; mutation: Mutation }[] = [
  {
    name: 'delete_feature on an absent id',
    makeDoc: makeDoc,
    mutation: { type: 'delete_feature', featureId: 'ghost' },
  },
  {
    name: 'delete_feature on a builtin id',
    makeDoc: makeDoc,
    mutation: { type: 'delete_feature', featureId: 'Origin' },
  },
  {
    name: 'toggle_plane_visibility with no plane to toggle',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }] }) as unknown as PartDoc,
    mutation: { type: 'toggle_plane_visibility' },
  },
  {
    name: 'toggle_sketch_plane_visibility with no sketch or plane to toggle',
    makeDoc: () => ({ version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude' }] }) as unknown as PartDoc,
    mutation: { type: 'toggle_sketch_plane_visibility' },
  },
]

describe.each(UNGUARDED_NO_OPS)('$name', ({ makeDoc: makeUnguardedDoc, mutation }) => {
  it('is classified false, and lands with its entry instead of being swallowed', () => {
    expect(IDEMPOTENT_MUTATION[mutation.type]).toBe(false)
    setDoc(makeUnguardedDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation(mutation) })

    // The doc really is byte-identical: this is the no-op the guard declines to
    // look for, so a push here proves the decision was driven by the
    // classification rather than by an accidental diff.
    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })
})

it('the add_* toggle families are classified false, so a re-pick is never swallowed', () => {
  for (const type of ['add_fillet_edge', 'add_chamfer_edge', 'add_boolean_tool', 'add_extrude_profile', 'add_revolve_profile', 'add_sweep_profile', 'add_sweep_path', 'add_delete_body_ref', 'add_transform_body'] as const) {
    expect(IDEMPOTENT_MUTATION[type], `${type} must stay unguarded`).toBe(false)
  }
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
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('in prod still pushes an entry and marks dirty (the guard never swallows it)', () => {
    failLoudMock.mockImplementation(() => {})
    setDoc(partStyleNoopDoc())
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(mutation) })

    expect(failLoudMock).toHaveBeenCalledTimes(1)
    expect(result.current.undoStack).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect((docRef.current!.part_style as Record<string, unknown>)['undefined']).toBeDefined()
  })
})

// ─── add_constraint and delete: guarded by whole-doc compare, not the slice ───

// Both are classified false because their targets can span features, so the
// O(touched) slice cannot represent them. handleMutation still catches a
// dispatch that leaves the WHOLE doc identical, which is what stops a
// live-but-dead dispatch from pushing a dead entry, dirtying the doc and running
// a solve.
const sketchWithLine = (): PartDoc => ({
  version: 1, kind: 'part',
  features: [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], constraints: [], initial: {} }],
}) as unknown as PartDoc

describe('add_constraint whole-doc no-op guard', () => {
  it('add_constraint with an unresolvable inferred target pushes nothing', () => {
    setDoc(sketchWithLine())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => {
      result.current.handleMutation({
        type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
        targets: ['dock:sk1:noSuchHost'],
      })
    })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a real add_constraint still pushes and re-solves', () => {
    setDoc(sketchWithLine())
    const { result } = renderPartDoc()

    act(() => {
      result.current.handleMutation({
        type: 'add_constraint', featureId: 'sk1', kind: 'horizontal',
        targets: ['entity:sk1:l1'],
      })
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })
})

describe('delete whole-doc no-op guard', () => {
  it('delete naming an absent entity pushes nothing', () => {
    setDoc(makeDoc())
    const { result } = renderPartDoc()
    const before = JSON.stringify(docRef.current)

    act(() => { result.current.handleMutation({ type: 'delete', targets: ['entity:sk1:ghost'] }) })

    expect(JSON.stringify(docRef.current)).toBe(before)
    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a real delete still pushes and re-solves', () => {
    setDoc(sketchWithLine())
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'delete', targets: ['entity:sk1:l1'] }) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })
})
