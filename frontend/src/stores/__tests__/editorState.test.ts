import { describe, it, expect, beforeEach } from 'vitest'
import { editorState, DEFAULT_EDITOR_STATE, clampRollback } from '@/stores/editorState'
import type { PartDoc } from '@/types/cad'

function makeDoc(featureCount: number, rollback?: number): PartDoc {
  const doc: PartDoc = {
    version: 1,
    kind: 'part',
    features: Array.from({ length: featureCount }, (_, i) => ({ id: `f${i}`, kind: 'sketch' })),
  }
  if (rollback !== undefined) doc.rollback = rollback
  return doc
}

beforeEach(() => {
  editorState.getState().resetEditorState()
})

describe('editorState part FSM', () => {
  it('owns rollbackPosition, pickBoundary and editingFeatureId through setters', () => {
    const store = editorState.getState()
    expect(store.rollbackPosition).toBe(DEFAULT_EDITOR_STATE.rollbackPosition)
    expect(store.pickBoundary).toBe(DEFAULT_EDITOR_STATE.pickBoundary)
    expect(store.editingFeatureId).toBe(DEFAULT_EDITOR_STATE.editingFeatureId)

    store.setRollbackPosition(5)
    store.setPickBoundary(3)
    store.setEditingFeatureId('feat')
    const after = editorState.getState()
    expect(after.rollbackPosition).toBe(5)
    expect(after.pickBoundary).toBe(3)
    expect(after.editingFeatureId).toBe('feat')
  })

  it('resetEditorState drops every field the store owns, leaving nothing behind', () => {
    const store = editorState.getState()
    store.setRollbackPosition(2)
    store.setPickBoundary(1)
    store.setEditingFeatureId('feat')
    store.setViewportDerived({ ghostMode: true, partColors: { b1: '#fff' }, partStyle: { b1: { color: '#fff' } } })
    store.setActiveSketchFeatureId('sk1')

    editorState.getState().resetEditorState()

    const after = editorState.getState()
    expect(after.rollbackPosition).toBeNull()
    expect(after.pickBoundary).toBeNull()
    expect(after.editingFeatureId).toBeNull()
    expect(after.ghostMode).toBe(false)
    expect(after.partColors).toEqual({})
    expect(after.partStyle).toEqual({})
    expect(after.activeSketchFeatureId).toBeNull()
  })
})

describe('clampRollback', () => {
  it('clamps a stale position to the restored feature list', () => {
    expect(clampRollback(makeDoc(3, 99))).toBe(3)
  })

  it('keeps an in-range parked position', () => {
    expect(clampRollback(makeDoc(3, 2))).toBe(2)
  })

  it('floors a negative position at zero', () => {
    expect(clampRollback(makeDoc(3, -3))).toBe(0)
  })

  it('defaults to the end of the stack when the doc parks nothing', () => {
    expect(clampRollback(makeDoc(3))).toBe(3)
    expect(clampRollback({ version: 1, kind: 'part', features: [] } as PartDoc)).toBe(0)
  })
})

describe('restoreHistory', () => {
  // Undo and redo both emit one restored doc through the same store action, so
  // one behavior table covers both directions.
  it('clamps the bar to the restored doc and clears the open editor', () => {
    const store = editorState.getState()
    store.setRollbackPosition(1)
    store.setEditingFeatureId('ex1')
    store.setPickBoundary(0)

    editorState.getState().restoreHistory(makeDoc(4, 2))

    const after = editorState.getState()
    expect(after.rollbackPosition).toBe(2)
    expect(after.editingFeatureId).toBeNull()
    expect(after.pickBoundary).toBeNull()
  })

  it('falls back to the end of the restored feature list when it parks nothing', () => {
    editorState.getState().setRollbackPosition(9)

    editorState.getState().restoreHistory(makeDoc(2))

    expect(editorState.getState().rollbackPosition).toBe(2)
  })
})

describe('restoreHistoryInSession', () => {
  it('keeps the edited feature and its pick boundary, and parks the bar just past it', () => {
    const store = editorState.getState()
    store.setRollbackPosition(9)
    store.setEditingFeatureId('sk1')
    store.setPickBoundary(4)

    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'origin', kind: 'origin' },
        { id: 'sk1', kind: 'sketch' },
        { id: 'plane1', kind: 'plane' },
      ],
    }
    editorState.getState().restoreHistoryInSession(doc)

    const after = editorState.getState()
    expect(after.editingFeatureId).toBe('sk1')
    expect(after.pickBoundary).toBe(4)
    // The edited feature sits at index 1, so the bar is 2, not the doc's end.
    expect(after.rollbackPosition).toBe(2)
  })

  it('falls back to the clamped end when the edited feature is not in the restored doc', () => {
    const store = editorState.getState()
    store.setEditingFeatureId('gone')

    editorState.getState().restoreHistoryInSession(makeDoc(2))

    expect(editorState.getState().rollbackPosition).toBe(2)
    expect(editorState.getState().editingFeatureId).toBe('gone')
  })
})

describe('resetSessionTransients', () => {
  it('keeps the open sketch, the armed tool and its mode entry', () => {
    const store = editorState.getState()
    store.setActiveFeatureId('sk1')
    // Raw writes, not setActiveTool: this node suite never registers the tool
    // registry, and the lifecycle hook would fail loud on an unknown tool.
    editorState.setState({ activeTool: 'line', modeStack: ['tool:line'] })
    store.setNormalSelection(new Set(['entity:sk1:l1']))
    store.addDrawPoint([1, 2])

    store.resetSessionTransients()

    const after = editorState.getState()
    expect(after.activeFeatureId).toBe('sk1')
    expect(after.activeTool).toBe('line')
    expect(after.modeStack).toEqual(['tool:line'])
  })

  it('drops the in-progress gesture, selection, hover and drag', () => {
    const store = editorState.getState()
    store.setActiveFeatureId('sk1')
    editorState.setState({ activeTool: 'dimension', modeStack: ['tool:dimension'] })
    store.setNormalSelection(new Set(['entity:sk1:l1']))
    store.setHoveredSelectionId('entity:sk1:l1')
    store.setHoveredVertex('vertex:sk1:l1:start', [0, 0], 'vertex')
    store.setDrag({ type: 'vertex', vertexId: 'entity:sk1:l1', featureId: 'sk1', entityId: 'l1' } as never)
    store.setIsPointerDown(true)
    store.addDrawPoint([1, 2])
    store.setDrawHover([3, 4])
    store.setDimensionCursorWorld([5, 6])
    editorState.setState({ dimensionPicks: [{ target: 'entity:sk1:l1', pickIndex: 0 }] as never })

    store.resetSessionTransients()

    const after = editorState.getState()
    expect(after.drawPoints).toEqual([])
    expect(after.drawHover).toBeNull()
    expect(after.dimensionPicks).toEqual([])
    expect(after.dimensionCursorWorld).toBeNull()
    expect(after.normalSelection.size).toBe(0)
    expect(after.selectedPicks.size).toBe(0)
    expect(after.hoveredSelectionId).toBeNull()
    expect(after.hoveredVertexId).toBeNull()
    expect(after.drag).toBeNull()
    expect(after.dragPending).toBeNull()
    expect(after.isPointerDown).toBe(false)
    expect(after.modeStack).toEqual(['tool:dimension'])
  })

  it('drops the gesture but keeps an armed pick field and its mode entry', () => {
    const store = editorState.getState()
    // DEFAULT_EDITOR_STATE carries only the part-side fields, so a tool a
    // previous test armed would otherwise still be standing here.
    editorState.setState({ activeTool: null, modeStack: [] })
    store.setActiveFeatureId('sk1')
    store.setActivePickField({ featureId: 'sk1', field: 'plane' } as never)

    expect(editorState.getState().modeStack).toEqual(['pick'])
    store.resetSessionTransients()

    const after = editorState.getState()
    // The field is the session's input, not document content: dropping it would
    // read to the page as an abandoned pick and cancel the open sketch.
    expect(after.activePickField).toEqual({ featureId: 'sk1', field: 'plane' })
    expect(after.activeTool).toBeNull()
    expect(after.modeStack).toEqual(['pick'])
    expect(after.activeFeatureId).toBe('sk1')
  })
})

describe('resetTransientState', () => {
  it('drops the document-derived entity kinds along with the transient editor state', () => {
    // The matrix harness and the sketch store setup used to add entityKindMap
    // to their own field lists; a canonical wipe that left it behind would let
    // a fresh harness read the previous document's kinds.
    const store = editorState.getState()
    store.setEntityKindMap({ 'entity:sk1:l1': 'line' })
    store.resetTransientState()
    expect(editorState.getState().entityKindMap).toEqual({})
  })

  it('clears drag, selection, tool and the mode stack', () => {
    const store = editorState.getState()
    store.setDrag({ type: 'vertex', vertexId: 'entity:sk1:l1', featureId: 'sk1', entityId: 'l1' } as never)
    store.setIsPointerDown(true)
    editorState.setState({ activeTool: 'line' })
    store.resetTransientState()
    const after = editorState.getState()
    expect(after.drag).toBeNull()
    expect(after.isPointerDown).toBe(false)
    expect(after.activeTool).toBeNull()
    expect(after.modeStack).toEqual([])
  })
})
