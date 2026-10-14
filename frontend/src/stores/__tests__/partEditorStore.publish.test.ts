// The session/solver publication store contract. Each field has exactly one
// publisher (the session adapter, the solver, or the page); nothing merges a
// React snapshot any more, and the editor FSM fields live in editorState.
import { describe, it, expect, beforeEach } from 'vitest'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import type { Mutation } from '@/types/cad'

const mutation = { type: 'add_sketch', featureId: 'sk1' } as Mutation
const undoEntry = { doc: { version: 1, kind: 'part' }, mutation }
const redoEntry = { doc: { version: 1, kind: 'part' }, mutation }

beforeEach(() => {
  usePartEditorStore.setState(DEFAULT_PART_EDITOR_DATA)
})

describe('partEditorStore publication contract', () => {
  it('publishSession writes the session facts the toolbar and the viewport read', () => {
    usePartEditorStore.getState().publishSession({
      doc: { version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }] },
      features: [{ id: 'sk1', kind: 'sketch' }],
      undoStack: [undoEntry],
      redoStack: [redoEntry],
    })

    const store = usePartEditorStore.getState()
    expect(store.features).toHaveLength(1)
    expect(store.features[0].id).toBe('sk1')
    expect(store.doc?.features?.[0].id).toBe('sk1')
    expect(store.undoStack).toEqual([undoEntry])
    expect(store.redoStack).toEqual([redoEntry])
  })

  it('publishSolve writes the solve facts and defaults clear them', () => {
    usePartEditorStore.getState().publishSolve({
      solveResults: { sk1: { solved: {} } },
      bodies: {},
      pickBodies: {},
      featureTimings: { sk1: 4 },
      validation: null,
    })
    expect(usePartEditorStore.getState().featureTimings.sk1).toBe(4)

    usePartEditorStore.getState().publishSolve(DEFAULT_PART_EDITOR_DATA)
    expect(usePartEditorStore.getState().solveResults).toEqual({})
    expect(usePartEditorStore.getState().featureTimings).toEqual({})
  })

  it('publishDerived writes the doc-derived view data', () => {
    usePartEditorStore.getState().publishDerived({
      visibleFeatures: new Set(['sk1']),
      visibleBodies: new Set(['b1']),
      partLabels: { b1: 'part 1' },
      otherSketches: {},
      isRebuilding: true,
    })

    const store = usePartEditorStore.getState()
    expect(store.visibleFeatures.has('sk1')).toBe(true)
    expect(store.visibleBodies?.has('b1')).toBe(true)
    expect(store.partLabels.b1).toBe('part 1')
    expect(store.isRebuilding).toBe(true)
  })

  it('carries none of the editor FSM fields the L2 store owns', () => {
    const state = usePartEditorStore.getState() as unknown as Record<string, unknown>
    for (const field of ['rollbackPosition', 'pickBoundary', 'editingFeatureId', 'ghostMode', 'partColors', 'partStyle', 'activeSketchFeatureId']) {
      expect(field in state).toBe(false)
    }
  })

  it('exposes no setSnapshot merge', () => {
    const state = usePartEditorStore.getState() as unknown as Record<string, unknown>
    expect('setSnapshot' in state).toBe(false)
  })

  it('field list in DEFAULT_PART_EDITOR_DATA matches the live state', () => {
    const afterReset = Object.keys(usePartEditorStore.getState())
      .filter(k => !k.startsWith('publish'))
      .sort()
    const defaultKeys = Object.keys(DEFAULT_PART_EDITOR_DATA).sort()
    expect(afterReset).toEqual(defaultKeys)
  })
})
