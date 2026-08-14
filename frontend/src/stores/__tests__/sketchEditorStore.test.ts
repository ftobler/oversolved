import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback, prunePickClaims } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'
import { toolRegistry } from '@/registry/toolRegistry'
import type { Mutation } from '@/types/cad'

// Reset + re-init the tool registry before each test so tool lifecycle tests
// can verify activate/deactivate wiring against a known, non-throwing singleton.
beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
})

function reset() {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    hoveredSelectionId: null,
    hoveredPickKey: null,
    isPointerDown: false,
    drag: null,
    activeTool: null,
    activeFeatureId: null,
    dimensionPicks: [],
    pendingBrepProjectionIds: [],
    pendingDialog: null,
    activePickField: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    hoveredConstraintEntityIds: new Set(),
    modeStack: [],
    entityKindMap: {},
  })
  setSketchCallback('onMutation', null)
  setSketchCallback('onMutationBatch', null)
  setSketchCallback('beginBrepProjection', null)
  setSketchCallback('cancelBrepProjection', null)
}

describe('sketchEditorStore', () => {
  beforeEach(reset)

  describe('toggleNormalSelection', () => {
    it('adds an id when absent', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().normalSelection.has('entity:S1:L1')).toBe(true)
    })

    it('removes an id when present', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().normalSelection.has('entity:S1:L1')).toBe(false)
    })

    it('accumulates multiple selections', () => {
      const { toggleNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('entity:S1:L1')
      toggleNormalSelection('vertex:S1:L1:start')
      const sel = useSketchEditorStore.getState().normalSelection
      expect(sel.size).toBe(2)
      expect(sel.has('entity:S1:L1')).toBe(true)
      expect(sel.has('vertex:S1:L1:start')).toBe(true)
    })

    it('records the pickKey in the live channel alongside the query', () => {
      useSketchEditorStore.getState().toggleNormalSelection('edge@q', 'ex1/b0#3')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('edge@q')).toBe(true)
      expect(s.selectedPicks.get('edge@q')).toEqual(new Set(['ex1/b0#3']))
    })

    it('drops the pickKey when the query is toggled back off', () => {
      const { toggleNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('edge@q', 'ex1/b0#3')
      toggleNormalSelection('edge@q', 'ex1/b0#3')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('edge@q')).toBe(false)
      expect(s.selectedPicks.has('edge@q')).toBe(false)
    })

    it('a shared-query sibling is added, not swapped in for the first pick', () => {
      // Regression: edges A and B share query Q because neither earned a
      // construction UUID. Clicking B used to toggle Q off and take A's
      // selection with it -- the query, not the primitive, was the selection
      // identity. Both must now be selected, and each must toggle off alone.
      const { toggleNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('Q', 'ex1/b0#edge#0')  // click edge A
      toggleNormalSelection('Q', 'ex1/b0#edge#1')  // click sibling B
      expect(useSketchEditorStore.getState().selectedPicks.get('Q'))
        .toEqual(new Set(['ex1/b0#edge#0', 'ex1/b0#edge#1']))

      toggleNormalSelection('Q', 'ex1/b0#edge#0')  // deselect A only
      const s = useSketchEditorStore.getState()
      expect(s.selectedPicks.get('Q')).toEqual(new Set(['ex1/b0#edge#1']))
      expect(s.normalSelection.has('Q')).toBe(true)
    })

    it('the query leaves normalSelection when its last claiming primitive does', () => {
      // No stale claim may outlive the query: once B (the last claimer) is
      // deselected the whole entry goes, so a later re-select of Q cannot
      // resurrect A's key and co-highlight a primitive nobody clicked.
      const { toggleNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('Q', 'ex1/b0#edge#0')
      toggleNormalSelection('Q', 'ex1/b0#edge#1')
      toggleNormalSelection('Q', 'ex1/b0#edge#0')
      toggleNormalSelection('Q', 'ex1/b0#edge#1')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('Q')).toBe(false)
      expect(s.selectedPicks.size).toBe(0)
    })

    it('a colliding-sibling click re-adds a query that only its claim survived', () => {
      // An orphan: another writer cleared normalSelection but left a pick claim
      // behind. The sibling click must re-assert the query into normalSelection
      // instead of growing the claim set under a query nobody selected.
      useSketchEditorStore.setState({
        normalSelection: new Set(),
        selectedPicks: new Map([['Q', new Set(['ex1/b0#edge#0'])]]),
      })
      useSketchEditorStore.getState().toggleNormalSelection('Q', 'ex1/b0#edge#1')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('Q')).toBe(true)
      expect(s.selectedPicks.get('Q')).toEqual(new Set(['ex1/b0#edge#0', 'ex1/b0#edge#1']))
    })

    it('leaves the pickKey channel untouched for selections with no pickKey', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().selectedPicks.size).toBe(0)
    })

    it('clearNormalSelection empties the live pickKey channel', () => {
      useSketchEditorStore.getState().toggleNormalSelection('edge@q', 'ex1/b0#3')
      useSketchEditorStore.getState().clearNormalSelection()
      expect(useSketchEditorStore.getState().selectedPicks.size).toBe(0)
    })
  })

  describe('addToNormalSelection', () => {
    it('adds an id when absent', () => {
      useSketchEditorStore.getState().addToNormalSelection('@body_ex1')
      expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(true)
    })

    it('does not remove an id when already present', () => {
      useSketchEditorStore.getState().addToNormalSelection('@body_ex1')
      useSketchEditorStore.getState().addToNormalSelection('@body_ex1')
      expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(true)
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(1)
    })

    it('accumulates multiple selections without toggling', () => {
      const { addToNormalSelection } = useSketchEditorStore.getState()
      addToNormalSelection('@body_ex1')
      addToNormalSelection('entity:S1:L1')
      const sel = useSketchEditorStore.getState().normalSelection
      expect(sel.size).toBe(2)
      expect(sel.has('@body_ex1')).toBe(true)
      expect(sel.has('entity:S1:L1')).toBe(true)
    })
  })

  describe('setNormalSelection', () => {
    it('replaces the current selection with the boxed set', () => {
      const { toggleNormalSelection, setNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('entity:S1:L1')
      toggleNormalSelection('vertex:S1:L2:start')
      setNormalSelection(new Set(['entity:S1:L3', 'entity:S1:L4']))
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection).toEqual(new Set(['entity:S1:L3', 'entity:S1:L4']))
    })

    it('re-selecting a covered entity keeps it selected (no toggle-off)', () => {
      // Regression: the old per-entity toggle loop deselected a covered
      // entity that was already selected (edge A, then a box over A+B gave
      // {B}). A replace box must never deselect a covered entity.
      const { toggleNormalSelection, setNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('entity:S1:L1')
      setNormalSelection(new Set(['entity:S1:L1', 'entity:S1:L2']))
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('entity:S1:L1')).toBe(true)
      expect(s.normalSelection.has('entity:S1:L2')).toBe(true)
    })

    it('recomputes selectionDomain from the boxed set', () => {
      const { setNormalSelection } = useSketchEditorStore.getState()
      setNormalSelection(new Set(['entity:S1:L1']))
      expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
      setNormalSelection(new Set(['@body_1@extrude1/face/3']))
      expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')
    })

    it('clears selectedPicks claims the box does not re-establish', () => {
      const { toggleNormalSelection, setNormalSelection } = useSketchEditorStore.getState()
      toggleNormalSelection('edge@q', 'ex1/b0#3')
      setNormalSelection(new Set(['edge@q']))
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('edge@q')).toBe(true)
      expect(s.selectedPicks.size).toBe(0)
    })

    it('clears chipOwnedSelection so no orphan chip signal survives the box', () => {
      const { syncChipSelection, setNormalSelection } = useSketchEditorStore.getState()
      syncChipSelection(['@edge_0'])
      setNormalSelection(new Set(['entity:S1:L1']))
      const s = useSketchEditorStore.getState()
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.normalSelection.has('entity:S1:L1')).toBe(true)
    })

    it('does not notify or mint fresh maps when the boxed set equals the current selection', () => {
      const { setNormalSelection } = useSketchEditorStore.getState()
      setNormalSelection(new Set(['entity:S1:L1', 'vertex:S1:L2:start']))
      const before = useSketchEditorStore.getState().normalSelection
      let notifications = 0
      const unsubscribe = useSketchEditorStore.subscribe(() => { notifications++ })
      try {
        setNormalSelection(new Set(['vertex:S1:L2:start', 'entity:S1:L1']))
      } finally {
        unsubscribe()
      }
      expect(notifications).toBe(0)
      expect(useSketchEditorStore.getState().normalSelection).toBe(before)
    })

    it('still replaces when the boxed set differs from the current selection', () => {
      const { setNormalSelection } = useSketchEditorStore.getState()
      setNormalSelection(new Set(['entity:S1:L1']))
      setNormalSelection(new Set(['entity:S1:L2']))
      expect(useSketchEditorStore.getState().normalSelection.has('entity:S1:L2')).toBe(true)
    })

    it('still clears a lingering claim even when the boxed set matches the selection', () => {
      const { setNormalSelection } = useSketchEditorStore.getState()
      setNormalSelection(new Set(['edge@q']))
      useSketchEditorStore.setState({ selectedPicks: new Map([['edge@q', new Set(['ex1/b0#3'])]]) })
      setNormalSelection(new Set(['edge@q']))
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('edge@q')).toBe(true)
      expect(s.selectedPicks.size).toBe(0)
    })
  })

  describe('clearNormalSelection', () => {
    it('empties the selection', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().clearNormalSelection()
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('clears chipOwnedSelection too', () => {
      useSketchEditorStore.getState().syncChipSelection(['@edge_0'])
      useSketchEditorStore.getState().clearNormalSelection()
      const s = useSketchEditorStore.getState()
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.normalSelection.size).toBe(0)
    })
  })

  describe('deleteSelected', () => {
    it('dispatches mutation and clears selection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('constraint:S1:C1')

      useSketchEditorStore.getState().deleteSelected()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'delete',
        targets: expect.arrayContaining(['entity:S1:L1', 'constraint:S1:C1']),
      })
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('does nothing with no selection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no mutation handler', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      // no handler set, should not throw
      expect(() => useSketchEditorStore.getState().deleteSelected()).not.toThrow()
    })
  })

  describe('applyOffset', () => {
    it('dispatches apply_offset with the selected entity ids and distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C2')

      useSketchEditorStore.getState().applyOffset(4)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'apply_offset',
        featureId: 'Sketch1',
        sourceIds: expect.arrayContaining(['L1', 'C2']),
        distance: 4,
      })
    })

    it('ignores non-entity selections and other features', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().toggleNormalSelection('constraint:Sketch1:C1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Other:L9')

      useSketchEditorStore.getState().applyOffset(2)
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no selection or no handler', () => {
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      expect(() => useSketchEditorStore.getState().applyOffset(2)).not.toThrow()
    })
  })

  describe('applyConstraint', () => {
    it('dispatches add_constraint with selected targets', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L2')

      useSketchEditorStore.getState().applyConstraint('horizontal')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'Sketch1',
        kind: 'horizontal',
        targets: expect.arrayContaining(['entity:Sketch1:L1', 'entity:Sketch1:L2']),
      })
    })

    it('dispatches parallel constraint with two selected lines', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L2')

      useSketchEditorStore.getState().applyConstraint('parallel')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'Sketch1',
        kind: 'parallel',
        targets: expect.arrayContaining(['entity:Sketch1:L1', 'entity:Sketch1:L2']),
      })
    })

    it('rejects parallel between two arcs (entityKinds guard)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:A1': 'arc',
        'entity:Sketch1:A2': 'arc',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:A1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:A2')

      useSketchEditorStore.getState().applyConstraint('parallel')

      expect(handler).not.toHaveBeenCalled()
    })

    it('rejects parallel mixing a line and a circle', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:L1': 'line',
        'entity:Sketch1:C1': 'circle',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C1')

      useSketchEditorStore.getState().applyConstraint('parallel')

      expect(handler).not.toHaveBeenCalled()
    })

    it('allows parallel between two lines when kinds are known', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:L1': 'line',
        'entity:Sketch1:L2': 'line',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L2')

      useSketchEditorStore.getState().applyConstraint('parallel')

      expect(handler).toHaveBeenCalledOnce()
    })

    it('rejects concentric between two lines', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:L1': 'line',
        'entity:Sketch1:L2': 'line',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L2')

      useSketchEditorStore.getState().applyConstraint('concentric')

      expect(handler).not.toHaveBeenCalled()
    })

    it('allows equal between two circles (equal radius)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:C1': 'circle',
        'entity:Sketch1:C2': 'circle',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C2')

      useSketchEditorStore.getState().applyConstraint('equal_length')

      expect(handler).toHaveBeenCalledOnce()
    })

    it('allows equal between an arc and a circle', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:A1': 'arc',
        'entity:Sketch1:C1': 'circle',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:A1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C1')

      useSketchEditorStore.getState().applyConstraint('equal_length')

      expect(handler).toHaveBeenCalledOnce()
    })

    it('rejects equal mixing a line and a circle (no shared measure)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:L1': 'line',
        'entity:Sketch1:C1': 'circle',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C1')

      useSketchEditorStore.getState().applyConstraint('equal_length')

      expect(handler).not.toHaveBeenCalled()
    })

    it('allows equal between two lines', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:L1': 'line',
        'entity:Sketch1:L2': 'line',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L2')

      useSketchEditorStore.getState().applyConstraint('equal_length')

      expect(handler).toHaveBeenCalledOnce()
    })

    it('does nothing with empty selection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no activeFeatureId', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no mutation handler', () => {
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(() => useSketchEditorStore.getState().applyConstraint('horizontal')).not.toThrow()
    })

    describe('midpoint', () => {
      it('accepts 1 entity + 1 vertex', () => {
        const handler = vi.fn()
        setSketchCallback('onMutation', handler)
        useSketchEditorStore.getState().setActiveFeatureId('S1')
        useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
        useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
        useSketchEditorStore.getState().applyConstraint('midpoint')
        expect(handler).toHaveBeenCalledOnce()
        expect(handler).toHaveBeenCalledWith({
          type: 'add_constraint',
          featureId: 'S1',
          kind: 'midpoint',
          targets: expect.arrayContaining(['entity:S1:L1', 'vertex:S1:L1:start']),
        })
      })

      it('accepts 3 vertices', () => {
        const handler = vi.fn()
        setSketchCallback('onMutation', handler)
        useSketchEditorStore.getState().setActiveFeatureId('S1')
        useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
        useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L2:end')
        useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L3:start')
        useSketchEditorStore.getState().applyConstraint('midpoint')
        expect(handler).toHaveBeenCalledOnce()
        expect(handler).toHaveBeenCalledWith({
          type: 'add_constraint',
          featureId: 'S1',
          kind: 'midpoint',
          targets: expect.arrayContaining(['vertex:S1:L1:start', 'vertex:S1:L2:end', 'vertex:S1:L3:start']),
        })
      })

      it('rejects 1 entity only', () => {
        const handler = vi.fn()
        setSketchCallback('onMutation', handler)
        useSketchEditorStore.getState().setActiveFeatureId('S1')
        useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
        useSketchEditorStore.getState().applyConstraint('midpoint')
        expect(handler).not.toHaveBeenCalled()
      })

      it('rejects 2 entities', () => {
        const handler = vi.fn()
        setSketchCallback('onMutation', handler)
        useSketchEditorStore.getState().setActiveFeatureId('S1')
        useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
        useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L2')
        useSketchEditorStore.getState().applyConstraint('midpoint')
        expect(handler).not.toHaveBeenCalled()
      })

      it('rejects 1 entity + 2 vertices', () => {
        const handler = vi.fn()
        setSketchCallback('onMutation', handler)
        useSketchEditorStore.getState().setActiveFeatureId('S1')
        useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
        useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
        useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:end')
        useSketchEditorStore.getState().applyConstraint('midpoint')
        expect(handler).not.toHaveBeenCalled()
      })
    })
  })

  describe('toggleConstruction', () => {
    it('dispatches toggle_construction with entity targets', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L2')
      useSketchEditorStore.getState().toggleConstruction()
      expect(handler).toHaveBeenCalledWith({
        type: 'toggle_construction',
        targets: expect.arrayContaining(['entity:S1:L1', 'entity:S1:L2']),
      })
    })

    it('filters out non-entity selection items', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
      useSketchEditorStore.getState().toggleNormalSelection('constraint:S1:C1')
      useSketchEditorStore.getState().toggleConstruction()
      expect(handler).toHaveBeenCalledWith({
        type: 'toggle_construction',
        targets: ['entity:S1:L1'],
      })
    })

    it('does nothing when only non-entity items are selected', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
      useSketchEditorStore.getState().toggleConstruction()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with empty selection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().toggleConstruction()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no mutation handler', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(() => useSketchEditorStore.getState().toggleConstruction()).not.toThrow()
    })
  })

  describe('deleteSelected', () => {
    it('skips entities from a different feature', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S2:L1')
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).toHaveBeenCalledWith({
        type: 'delete',
        targets: ['entity:S1:L1'],
      })
    })

    it('does nothing when all selected entities belong to other features', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S2:L1')
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).not.toHaveBeenCalled()
    })

    it('clears selection after dispatch', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().deleteSelected()
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('clears hoveredConstraintEntityIds after dispatch', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        activeFeatureId: 'S1',
        normalSelection: new Set(['constraint:S1:C1']),
        hoveredConstraintEntityIds: new Set(['entity:S1:L1']),
      })
      useSketchEditorStore.getState().deleteSelected()
      expect(useSketchEditorStore.getState().hoveredConstraintEntityIds.size).toBe(0)
    })

    it('deletes only matching sketch entities and skips feature and body ids in a mixed selection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1')
      useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).toHaveBeenCalledWith({
        type: 'delete',
        targets: ['entity:S1:L1'],
      })
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('constraint click replaces selection instead of accumulating (bug fix: delete too much)', () => {
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      // Simulate clicking a constraint tile/dim label
      const st = useSketchEditorStore.getState()
      st.clearNormalSelection()
      st.addToNormalSelection('constraint:S1:C1')
      expect(useSketchEditorStore.getState().normalSelection).toEqual(new Set(['constraint:S1:C1']))
    })
  })

  describe('setActiveTool', () => {
    it('clears drawPoints and drawHover when switching tool', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().setDrawHover([3, 4])
      useSketchEditorStore.getState().setActiveTool('line')
      expect(useSketchEditorStore.getState().drawPoints).toEqual([])
      expect(useSketchEditorStore.getState().drawHover).toBeNull()
    })

    it('sets the active tool', () => {
      useSketchEditorStore.getState().setActiveTool('circle')
      expect(useSketchEditorStore.getState().activeTool).toBe('circle')
    })

    it('accepts null to clear tool', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().setActiveTool(null)
      expect(useSketchEditorStore.getState().activeTool).toBeNull()
    })
  })

  describe('setActiveFeatureId', () => {
    it('clears tool and draw state on transition to null', () => {
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().setDrawHover([3, 4])
      useSketchEditorStore.getState().setActiveFeatureId(null)
      expect(useSketchEditorStore.getState().activeFeatureId).toBeNull()
      expect(useSketchEditorStore.getState().activeTool).toBeNull()
      expect(useSketchEditorStore.getState().drawPoints).toEqual([])
      expect(useSketchEditorStore.getState().drawHover).toBeNull()
      expect(useSketchEditorStore.getState().drawSnapVertexId).toBeNull()
      // The tool must leave through its lifecycle hook, otherwise its mode entry
      // outlives the sketch session.
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('does not leak a tool mode entry across repeated enter/exit cycles', () => {
      for (let i = 0; i < 3; i++) {
        useSketchEditorStore.getState().setActiveFeatureId('S1')
        useSketchEditorStore.getState().setActiveTool('line')
        expect(useSketchEditorStore.getState().modeStack).toEqual(['tool:line'])
        useSketchEditorStore.getState().setActiveFeatureId(null)
        expect(useSketchEditorStore.getState().modeStack).toEqual([])
      }
    })

    it('leaves the stack alone when no tool is armed on exit', () => {
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().setActiveFeatureId(null)
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('does not reset tool when setting same null', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().setActiveFeatureId(null)
      expect(useSketchEditorStore.getState().activeTool).toBe('line')
    })

    it('does not reset tool when transitioning to non-null', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      expect(useSketchEditorStore.getState().activeTool).toBe('line')
    })

    // Load race: pressing Edit while a document is still loading can remount the
    // DragPlane mid-press, losing the pointerup that would clear dragPending.
    // Orbit is derived as `!drag && !dragPending`, so stuck drag state disables
    // the camera permanently. Entering/exiting a sketch must recover it.
    it('clears stuck drag state on transition to a new feature', () => {
      const pending = {
        type: 'vertex' as const,
        vertexId: 'vertex:S0:e1:start',
        featureId: 'S0',
        entityId: 'e1',
        vertexKey: 'start',
        startWorld: [0, 0] as [number, number],
      }
      useSketchEditorStore.getState().setActiveFeatureId('S0')
      useSketchEditorStore.getState().setDragPending(pending)
      useSketchEditorStore.getState().setDragStartClient([10, 20])
      useSketchEditorStore.getState().setIsPointerDown(true)

      useSketchEditorStore.getState().setActiveFeatureId('S1')

      const s = useSketchEditorStore.getState()
      expect(s.dragPending).toBeNull()
      expect(s.drag).toBeNull()
      expect(s.dragStartClient).toBeNull()
      expect(s.dragSnap).toBeNull()
      expect(s.isPointerDown).toBe(false)
    })

    it('clears stuck drag state on exit to null', () => {
      const pending = {
        type: 'vertex' as const,
        vertexId: 'vertex:S1:e1:start',
        featureId: 'S1',
        entityId: 'e1',
        vertexKey: 'start',
        startWorld: [0, 0] as [number, number],
      }
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().setDragPending(pending)
      useSketchEditorStore.getState().setActiveFeatureId(null)
      expect(useSketchEditorStore.getState().dragPending).toBeNull()
    })

    it('leaves drag state untouched when the feature is unchanged', () => {
      const pending = {
        type: 'vertex' as const,
        vertexId: 'vertex:S1:e1:start',
        featureId: 'S1',
        entityId: 'e1',
        vertexKey: 'start',
        startWorld: [0, 0] as [number, number],
      }
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().setDragPending(pending)
      // Re-asserting the same active feature must not clobber an in-progress drag.
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      expect(useSketchEditorStore.getState().dragPending).toBe(pending)
    })
  })

  describe('draw tool state', () => {
    it('addDrawPoint accumulates points', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().addDrawPoint([3, 4])
      expect(useSketchEditorStore.getState().drawPoints).toEqual([[1, 2], [3, 4]])
    })

    it('setDrawPoints replaces the whole buffer and notifies subscribers', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      const states: { drawPoints: [number, number][] }[] = []
      const unsub = useSketchEditorStore.subscribe(s => { states.push({ drawPoints: s.drawPoints }) })

      useSketchEditorStore.getState().setDrawPoints([[7, 8]])

      // A fresh reference flows through zustand so the preview re-renders on
      // the committing click instead of waiting for the next pointermove.
      expect(useSketchEditorStore.getState().drawPoints).toEqual([[7, 8]])
      expect(states[states.length - 1]?.drawPoints).toEqual([[7, 8]])
      unsub()
    })

    it('setDrawHover updates hover position', () => {
      useSketchEditorStore.getState().setDrawHover([5, 6])
      expect(useSketchEditorStore.getState().drawHover).toEqual([5, 6])
    })

    it('setDrawHover clears on null', () => {
      useSketchEditorStore.getState().setDrawHover([5, 6])
      useSketchEditorStore.getState().setDrawHover(null)
      expect(useSketchEditorStore.getState().drawHover).toBeNull()
    })

    it('setDrawSnap stores vertexId', () => {
      useSketchEditorStore.getState().setDrawSnap('vertex:S1:L1:start')
      expect(useSketchEditorStore.getState().drawSnapVertexId).toBe('vertex:S1:L1:start')
    })

    it('clearDraw resets all draw state', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().setDrawHover([3, 4])
      useSketchEditorStore.getState().setDrawSnap('vertex:S1:L1:start')
      useSketchEditorStore.getState().clearDraw()
      expect(useSketchEditorStore.getState().drawPoints).toEqual([])
      expect(useSketchEditorStore.getState().drawHover).toBeNull()
      expect(useSketchEditorStore.getState().drawSnapVertexId).toBeNull()
    })
  })

  describe('contextMenu', () => {
    it('starts as null', () => {
      expect(useSketchEditorStore.getState().contextMenu).toBeNull()
    })

    it('openContextMenu stores position', () => {
      useSketchEditorStore.getState().openContextMenu([100, 200])
      expect(useSketchEditorStore.getState().contextMenu).toEqual([100, 200])
    })

    it('closeContextMenu clears position', () => {
      useSketchEditorStore.getState().openContextMenu([100, 200])
      useSketchEditorStore.getState().closeContextMenu()
      expect(useSketchEditorStore.getState().contextMenu).toBeNull()
    })
  })

  describe('hover tracking', () => {
    it('setHoveredVertex updates vertex id and position', () => {
      useSketchEditorStore.getState().setHoveredVertex('vertex:S1:L1:start', [5.5, 10.2], null)
      expect(useSketchEditorStore.getState().hoveredVertexId).toBe('vertex:S1:L1:start')
      expect(useSketchEditorStore.getState().hoveredVertexPosition).toEqual([5.5, 10.2])
      expect(useSketchEditorStore.getState().hoveredSnapKind).toBeNull()
    })

    it('setHoveredVertex updates snap kind', () => {
      useSketchEditorStore.getState().setHoveredVertex('vertex:S1:L1:start', [5, 5], 'midpoint')
      expect(useSketchEditorStore.getState().hoveredSnapKind).toBe('midpoint')
    })

    it('setHoveredSelectionId updates hoveredSelectionId', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('entity:S1:L1')
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('entity:S1:L1')
    })

    it('setHoveredSelectionId clears on null', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('entity:S1:L1')
      useSketchEditorStore.getState().setHoveredSelectionId(null)
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
    })

    it('setHoveredPickKey records the per-primitive hover key', () => {
      useSketchEditorStore.getState().setHoveredPickKey('ex1/b0#edge#2')
      expect(useSketchEditorStore.getState().hoveredPickKey).toBe('ex1/b0#edge#2')
    })

    it('setHoveredPickKey clears on null', () => {
      useSketchEditorStore.getState().setHoveredPickKey('ex1/b0#edge#2')
      useSketchEditorStore.getState().setHoveredPickKey(null)
      expect(useSketchEditorStore.getState().hoveredPickKey).toBeNull()
    })

    it('setHoveredConstraintEntities updates constraint-highlighted entities', () => {
      const ids = new Set(['entity:S1:L1', 'entity:S1:L2'])
      useSketchEditorStore.getState().setHoveredConstraintEntities(ids)
      expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(ids)
    })

    it('setHoveredSelectionId updates hoveredSelectionId (plane)', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('@builtin_plane_front')
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@builtin_plane_front')
    })

    it('setHoveredSelectionId clears on null (plane)', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('@sketch1')
      useSketchEditorStore.getState().setHoveredSelectionId(null)
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
    })

    it('setHoveredSelectionId updates hoveredSelectionId (surface)', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('face:sketch1:?3;@sketch1abc')
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('face:sketch1:?3;@sketch1abc')
    })

    it('setHoveredSelectionId clears on null (surface)', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('face:sketch1:?3;@sketch1abc')
      useSketchEditorStore.getState().setHoveredSelectionId(null)
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
    })

    it('setHoveredSelectionId updates hoveredSelectionId (3D surface)', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('?d,d;@extrude1face0:face')
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('?d,d;@extrude1face0:face')
    })

    it('setHoveredSelectionId clears on null (3D surface)', () => {
      useSketchEditorStore.getState().setHoveredSelectionId('?d,d;@extrude1face0:face')
      useSketchEditorStore.getState().setHoveredSelectionId(null)
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
    })

    it('hoveredSnapKind can be path', () => {
      useSketchEditorStore.getState().setHoveredVertex('vertex:S1:L1:start', [5, 5], 'path')
      expect(useSketchEditorStore.getState().hoveredSnapKind).toBe('path')
    })
  })

  describe('pick field (activePickField)', () => {
    it('setActivePickField sets the field being picked', () => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
      expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'Sketch1', field: 'plane' })
    })

    it('setActivePickField(null) clears the field', () => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
      useSketchEditorStore.getState().setActivePickField(null)
      expect(useSketchEditorStore.getState().activePickField).toBeNull()
    })

    it('manual activate clears existing normal selection', () => {
      useSketchEditorStore.setState({ normalSelection: new Set(['@something']) })
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('seed activate keeps existing normal selection', () => {
      useSketchEditorStore.setState({ normalSelection: new Set(['@something']) })
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' }, { seed: true })
      expect(useSketchEditorStore.getState().normalSelection.has('@something')).toBe(true)
    })
  })

  describe('dragSnap', () => {
    beforeEach(reset)

    it('starts as null', () => {
      expect(useSketchEditorStore.getState().dragSnap).toBeNull()
    })

    it('setDragSnap stores snap target', () => {
      useSketchEditorStore.getState().setDragSnap({ kind: 'vertex', constraintKind: 'coincident', vertexId: 'vertex:S1:L1:start', position: [3, 4] })
      expect(useSketchEditorStore.getState().dragSnap).toEqual({ kind: 'vertex', constraintKind: 'coincident', vertexId: 'vertex:S1:L1:start', position: [3, 4] })
    })

    it('setDragSnap(null) clears snap target', () => {
      useSketchEditorStore.getState().setDragSnap({ kind: 'vertex', constraintKind: 'coincident', vertexId: 'vertex:S1:L1:start', position: [3, 4] })
      useSketchEditorStore.getState().setDragSnap(null)
      expect(useSketchEditorStore.getState().dragSnap).toBeNull()
    })
  })

  describe('selectionDomain', () => {
    beforeEach(reset)

    it('starts as sketch_2d', () => {
      expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    })

    it('sketch entity sets sketch_2d', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    })

    it('3D edge sets body_3d', () => {
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')
    })

    it('ancestry query sets body_3d', () => {
      useSketchEditorStore.getState().toggleNormalSelection('?9;@ex1face0:face')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')
    })

    it('builtin plane sets plane_3d', () => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_front')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('plane_3d')
    })

    it('mixed selection sets mixed', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('mixed')
    })

    it('reverts to sketch_2d after clearNormalSelection', () => {
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      useSketchEditorStore.getState().clearNormalSelection()
      expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    })

    it('applyConstraint does nothing when domain is body_3d', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })

    it('applyConstraint applies to sketch entities even in mixed domain', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('mixed')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'horizontal',
        targets: ['entity:S1:L1'],
      })
    })

    it('applyConstraint includes @builtin_origin in targets for coincident constraint', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_origin')
      useSketchEditorStore.getState().applyConstraint('coincident')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'coincident',
        targets: expect.arrayContaining(['vertex:S1:L1:start', '@builtin_origin']),
      })
    })

    it('applyConstraint includes dock: and isect: handles in targets (lazy materialization)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
      useSketchEditorStore.getState().toggleNormalSelection('dock:S1:tan1')
      useSketchEditorStore.getState().toggleNormalSelection('isect:S1:1:2:curA:curB')
      useSketchEditorStore.getState().applyConstraint('coincident')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'coincident',
        targets: expect.arrayContaining(['vertex:S1:L1:start', 'dock:S1:tan1', 'isect:S1:1:2:curA:curB']),
      })
    })

    it('applyConstraint does nothing in mixed domain with no sketch entities', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      useSketchEditorStore.getState().toggleNormalSelection('@plane1')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('chipOwnedSelection', () => {
    it('starts empty', () => {
      expect(useSketchEditorStore.getState().chipOwnedSelection.size).toBe(0)
    })

    it('syncChipSelection mirrors values into normalSelection and chipOwnedSelection', () => {
      useSketchEditorStore.getState().syncChipSelection(['@edge_0', '@edge_1'])
      const s = useSketchEditorStore.getState()
      expect([...s.chipOwnedSelection].sort()).toEqual(['@edge_0', '@edge_1'])
      expect(s.normalSelection.has('@edge_0')).toBe(true)
      expect(s.normalSelection.has('@edge_1')).toBe(true)
    })

    it('syncChipSelection diff removes dropped values and adds new ones', () => {
      useSketchEditorStore.getState().syncChipSelection(['a', 'b'])
      useSketchEditorStore.getState().syncChipSelection(['b', 'c'])
      const s = useSketchEditorStore.getState()
      expect([...s.chipOwnedSelection].sort()).toEqual(['b', 'c'])
      expect(s.normalSelection.has('a')).toBe(false)
      expect(s.normalSelection.has('b')).toBe(true)
      expect(s.normalSelection.has('c')).toBe(true)
    })

    it('clearChipSelection removes chip-owned entries from normalSelection', () => {
      useSketchEditorStore.getState().syncChipSelection(['x', 'y'])
      useSketchEditorStore.getState().clearChipSelection()
      const s = useSketchEditorStore.getState()
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.normalSelection.size).toBe(0)
    })

    it('setActivePickField(null) clears chipOwnedSelection', () => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
      useSketchEditorStore.setState({
        chipOwnedSelection: new Set(['?body_ex1/face/0']),
        normalSelection: new Set(['?body_ex1/face/0']),
      })
      useSketchEditorStore.getState().setActivePickField(null)
      expect(useSketchEditorStore.getState().chipOwnedSelection.size).toBe(0)
    })

    it('setActivePickField(null) evicts chip-owned entries and their claims before the pick pops', () => {
      // A toggled-off chip entry (in chipOwnedSelection, already out of
      // normalSelection) must be cleaned up ahead of the mode pop: the repair
      // that popMode runs on an emptied stack would otherwise prune the orphan
      // itself with a spurious set() (nit 18).
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
      useSketchEditorStore.setState({
        normalSelection: new Set(['entity:S1:L1']),
        chipOwnedSelection: new Set(['@edge_0']),
        selectedPicks: new Map([['@edge_0', new Set(['ex1/b0#3'])]]),
      })
      let chipClearOrder = -1
      let popOrder = -1
      let notify = 0
      const unsubscribe = useSketchEditorStore.subscribe(s => {
        notify++
        if (chipClearOrder === -1 && s.chipOwnedSelection.size === 0) chipClearOrder = notify
        if (popOrder === -1 && s.modeStack.length === 0) popOrder = notify
      })
      try {
        useSketchEditorStore.getState().setActivePickField(null)
      } finally {
        unsubscribe()
      }
      expect(chipClearOrder).toBeGreaterThan(-1)
      expect(popOrder).toBeGreaterThan(-1)
      expect(chipClearOrder).toBeLessThan(popOrder)
      const s = useSketchEditorStore.getState()
      expect(s.modeStack).toEqual([])
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.normalSelection).toEqual(new Set(['entity:S1:L1']))
      expect(s.selectedPicks.has('@edge_0')).toBe(false)
    })
  })

  describe('showConstraintTiles', () => {
    it('defaults to true', () => {
      expect(useSketchEditorStore.getState().showConstraintTiles).toBe(true)
    })

    it('setShowConstraintTiles flips the flag', () => {
      useSketchEditorStore.getState().setShowConstraintTiles(false)
      expect(useSketchEditorStore.getState().showConstraintTiles).toBe(false)
      useSketchEditorStore.getState().setShowConstraintTiles(true)
      expect(useSketchEditorStore.getState().showConstraintTiles).toBe(true)
    })
  })

  describe('entityKindMap', () => {
    it('defaults to empty', () => {
      expect(useSketchEditorStore.getState().entityKindMap).toEqual({})
    })

    it('setEntityKindMap stores and replaces the map', () => {
      useSketchEditorStore.getState().setEntityKindMap({ 'entity:f1:c1': 'circle' })
      expect(useSketchEditorStore.getState().entityKindMap).toEqual({ 'entity:f1:c1': 'circle' })
      useSketchEditorStore.getState().setEntityKindMap({})
      expect(useSketchEditorStore.getState().entityKindMap).toEqual({})
    })
  })

  describe('self-cleaning state transitions', () => {
    describe('setActiveTool', () => {
      it('clears normalSelection when entering the dimension tool', () => {
        useSketchEditorStore.setState({ normalSelection: new Set(['entity:S1:L1', 'vertex:S1:L2:start']) })
        useSketchEditorStore.getState().setActiveTool('dimension')
        expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      })

      it('clears normalSelection on dimension enter even while a pick field is active', () => {
        // Regression: the pick-field cleanup branch rebuilt normalSelection from
        // the pre-update state, silently undoing the clearsSelectionOnEnter
        // wipe when both branches fired in one setActiveTool call.
        useSketchEditorStore.setState({
          normalSelection: new Set(['entity:S1:L1', '@edge_0']),
          chipOwnedSelection: new Set(['@edge_0']),
          selectionDomain: 'mixed',
          activePickField: { featureId: 'F1', field: 'profile' },
          modeStack: ['pick'],
        })
        useSketchEditorStore.getState().setActiveTool('dimension')
        const s = useSketchEditorStore.getState()
        expect(s.activePickField).toBeNull()
        expect(s.normalSelection.size).toBe(0)
        expect(s.chipOwnedSelection.size).toBe(0)
      })

      it('clears dimensionPicks when leaving the dimension tool', () => {
        // Activate dimension tool, accumulate a pick, then switch away.
        useSketchEditorStore.getState().setActiveTool('dimension')
        useSketchEditorStore.getState().addDimensionPick({
          isVertex: false, target: 'entity:S1:L1', entityKind: 'line',
        })
        expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
        useSketchEditorStore.getState().setActiveTool('line')
        expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
      })

      it('clears dimensionPicks when re-entering the dimension tool', () => {
        // Accumulate a pick inside dimension, exit, re-enter -> picks reset.
        useSketchEditorStore.getState().setActiveTool('dimension')
        useSketchEditorStore.getState().addDimensionPick({
          isVertex: false, target: 'entity:S1:L1', entityKind: 'line',
        })
        useSketchEditorStore.getState().setActiveTool(null)
        // Simulate a stray pick from before re-arming (shouldn't survive).
        useSketchEditorStore.getState().setActiveTool('dimension')
        useSketchEditorStore.getState().addDimensionPick({
          isVertex: false, target: 'entity:S1:L2', entityKind: 'line',
        })
        useSketchEditorStore.getState().setActiveTool('dimension')
        expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
      })

      it('clears activePickField and chip-owned selection when entering a tool', () => {
        useSketchEditorStore.setState({
          activePickField: { featureId: 'Sketch1', field: 'plane' },
          activeTool: null,
          chipOwnedSelection: new Set(['?body_ex1/face/0']),
          normalSelection: new Set(['?body_ex1/face/0', '@other_item']),
          modeStack: ['pick'],
        })
        // drag is the real idle/select entry (getEffectiveTool(null) === 'drag');
        // entering it is "entering a tool" from the idle state.
        useSketchEditorStore.getState().setActiveTool('drag')
        const s = useSketchEditorStore.getState()
        expect(s.activePickField).toBeNull()
        expect(s.chipOwnedSelection.size).toBe(0)
        expect(s.normalSelection.has('?body_ex1/face/0')).toBe(false)
        expect(s.normalSelection.has('@other_item')).toBe(true)
      })

      it('does not clear activePickField when setting tool to null', () => {
        useSketchEditorStore.setState({ activePickField: { featureId: 'Sketch1', field: 'plane' }, activeTool: null, modeStack: ['pick'] })
        useSketchEditorStore.getState().setActiveTool(null)
        // tool=null means we are NOT entering a tool mode, so the pick field persists
        expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'Sketch1', field: 'plane' })
      })

      it('clears drawSnapVertexId when switching tool', () => {
        useSketchEditorStore.getState().setDrawSnap('vertex:S1:L1:start')
        useSketchEditorStore.getState().setActiveTool('circle')
        expect(useSketchEditorStore.getState().drawSnapVertexId).toBeNull()
      })
    })

    describe('setActivePickField', () => {
      it('clears activeTool and draw state when entering a pick', () => {
        useSketchEditorStore.getState().setActiveTool('drag')
        useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
        const s = useSketchEditorStore.getState()
        expect(s.activePickField).toEqual({ featureId: 'Sketch1', field: 'plane' })
        expect(s.activeTool).toBeNull()
        expect(s.drawPoints).toEqual([])
        expect(s.drawHover).toBeNull()
        expect(s.drawSnapVertexId).toBeNull()
      })

      it('does not clear tool state when clearing the pick', () => {
        useSketchEditorStore.getState().setActiveTool('drag')
        useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
        useSketchEditorStore.getState().setActivePickField(null)
        expect(useSketchEditorStore.getState().activeTool).toBeNull()  // tool was already cleared when entering pick mode
      })
    })
  })

  describe('tool lifecycle → mode stack integration', () => {
    it('setActiveTool pushes mode via activate', () => {
      useSketchEditorStore.getState().setActiveTool('drag')
      expect(useSketchEditorStore.getState().modeStack).toContain('tool:drag')
    })

    it('switching tools pops old mode and pushes new', () => {
      useSketchEditorStore.getState().setActiveTool('drag')
      useSketchEditorStore.getState().setActiveTool('line')
      const stack = useSketchEditorStore.getState().modeStack
      expect(stack).not.toContain('tool:drag')
      expect(stack).toContain('tool:line')
    })

    it('setting tool to null pops mode', () => {
      useSketchEditorStore.getState().setActiveTool('drag')
      useSketchEditorStore.getState().setActiveTool(null)
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('pick field pushes mode after deactivating tool', () => {
      useSketchEditorStore.getState().setActiveTool('drag')
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
      const stack = useSketchEditorStore.getState().modeStack
      expect(stack).not.toContain('tool:drag')
      expect(stack).toContain('pick')
    })

    it('setActivePickField(null) pops pick mode', () => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
      useSketchEditorStore.getState().setActivePickField(null)
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('tool switch spam never stacks more than the armed tool', () => {
      for (const tool of ['line', 'circle', 'drag', 'line', 'dimension'] as const) {
        useSketchEditorStore.getState().setActiveTool(tool)
        expect(useSketchEditorStore.getState().modeStack).toEqual(['tool:' + tool])
      }
      useSketchEditorStore.getState().setActiveTool(null)
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('pick enter/exit around an armed tool returns to an empty stack', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
      expect(useSketchEditorStore.getState().modeStack).toEqual(['pick'])
      useSketchEditorStore.getState().setActivePickField(null)
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('failLouds when activating an unregistered (forward-compat) tool id', () => {
      // mirror is an ActiveTool member with no registered tool mode; activating
      // it must throw in test mode, not silently no-op (the ellipse bug).
      expect(() => useSketchEditorStore.getState().setActiveTool('mirror'))
        .toThrow(/no registered tool/)
    })

    it('failLouds when deactivating an unregistered tool id', () => {
      useSketchEditorStore.setState({ activeTool: 'mirror', modeStack: ['tool:mirror'] })
      expect(() => useSketchEditorStore.getState().setActiveTool('line'))
        .toThrow(/no registered tool/)
    })
  })

  describe('mode stack', () => {
    it('starts empty', () => {
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('pushMode adds to stack', () => {
      useSketchEditorStore.getState().pushMode('tool:select')
      expect(useSketchEditorStore.getState().modeStack).toEqual(['tool:select'])
    })

    it('popMode removes from stack', () => {
      useSketchEditorStore.getState().pushMode('tool:select')
      useSketchEditorStore.getState().pushMode('dimension:pending')
      useSketchEditorStore.getState().popMode('dimension:pending')
      expect(useSketchEditorStore.getState().modeStack).toEqual(['tool:select'])
    })

    it('popMode validates expected kind', () => {
      useSketchEditorStore.getState().pushMode('tool:select')
      expect(() => useSketchEditorStore.getState().popMode('tool:line')).toThrow('[popMode]')
    })

    it('popMode on empty stack throws', () => {
      expect(() => useSketchEditorStore.getState().popMode()).toThrow('[popMode]')
    })

    it('nested push and pop returns to empty', () => {
      useSketchEditorStore.getState().pushMode('outer')
      useSketchEditorStore.getState().pushMode('inner')
      useSketchEditorStore.getState().popMode('inner')
      useSketchEditorStore.getState().popMode('outer')
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })
  })

  describe('dimension constraint deletion', () => {
    it('deleteSelected removes dimension constraint when selected', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        activeFeatureId: 'S1',
        normalSelection: new Set(['constraint:S1:c_dim_linear_abc']),
      })

      useSketchEditorStore.getState().deleteSelected()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'delete',
        targets: ['constraint:S1:c_dim_linear_abc'],
      })
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('deleteSelected does not clear non-matching selection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        activeFeatureId: 'S1',
        normalSelection: new Set(['entity:S1:L1', 'constraint:S1:C1']),
      })
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).toHaveBeenCalledWith({
        type: 'delete',
        targets: ['entity:S1:L1', 'constraint:S1:C1'],
      })
    })
  })

  describe('dimension sticky placement', () => {
    beforeEach(() => {
      useSketchEditorStore.setState({
        activeTool: 'dimension',
        activeFeatureId: 'S1',
        dimensionPicks: [],
        pendingBrepProjectionIds: [],
        pendingDialog: null,
        normalSelection: new Set(),
      })
    })

    it('addDimensionPick appends', () => {
      useSketchEditorStore.getState().addDimensionPick({
        isVertex: false, target: 'entity:S1:L1', entityKind: 'line',
      })
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
      useSketchEditorStore.getState().addDimensionPick({
        isVertex: false, target: 'entity:S1:L2', entityKind: 'line',
      })
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(2)
    })

    it('addDimensionPick caps at 2 picks (third replaces second)', () => {
      const a = { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }
      const b = { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' }
      const c = { isVertex: true, target: 'vertex:S1:L3:start' }
      useSketchEditorStore.getState().addDimensionPick(a)
      useSketchEditorStore.getState().addDimensionPick(b)
      useSketchEditorStore.getState().addDimensionPick(c)
      const picks = useSketchEditorStore.getState().dimensionPicks
      expect(picks).toHaveLength(2)
      expect(picks[0]).toEqual(a)
      expect(picks[1]).toEqual(c)
    })

    it('addBrepDimensionPick projects a body edge, then dimensions the projection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'circle' })

      expect(handler).toHaveBeenCalledTimes(1)
      const m = handler.mock.calls[0][0]
      expect(m).toMatchObject({ type: 'add_projected_entity', featureId: 'S1', kind: 'circle', source: '?b1/edge:3' })

      const picks = useSketchEditorStore.getState().dimensionPicks
      expect(picks).toEqual([
        { isVertex: false, target: `entity:S1:${m.entityId}`, entityKind: 'circle', source: '?b1/edge:3' },
      ])
      setSketchCallback('getSketch', null)
    })

    it('addBrepDimensionPick projects the same edge once when picked twice before the solve', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))  // the projection has not solved yet
      const pick = () => useSketchEditorStore.getState()
        .addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      pick()
      pick()

      expect(handler).toHaveBeenCalledTimes(1)
      const picks = useSketchEditorStore.getState().dimensionPicks
      expect(picks).toHaveLength(2)
      expect(picks[0].target).toBe(picks[1].target)
      setSketchCallback('getSketch', null)
    })

    it('addBrepDimensionPick reuses a projection the sketch already carries', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        P1: { start: [0, 0], end: [10, 0], projected: true, source: '?b1/edge:3' },
      } as never))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })

      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([
        { isVertex: false, target: 'entity:S1:P1', entityKind: 'line', source: '?b1/edge:3' },
      ])
      setSketchCallback('getSketch', null)
    })

    it('addBrepDimensionPick does nothing outside a sketch', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({ activeFeatureId: null })
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false })
      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    })

    it('replacing the second brep pick deletes the orphaned projection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' })
      const id1 = handler.mock.calls[0][0].entityId
      store.addBrepDimensionPick('?b1/edge:2', { isVertexPick: false, sourceKind: 'line' })
      const id2 = handler.mock.calls[1][0].entityId
      handler.mockClear()

      // A third edge replaces the second pick; the second's projection must go.
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })

      const calls = handler.mock.calls.map(c => c[0])
      const deleteCall = calls.find((m: Mutation) => m.type === 'delete') as { targets: string[] } | undefined
      expect(deleteCall).toBeDefined()
      expect(deleteCall!.targets).toEqual([`entity:S1:${id2}`])
      // The orphaned projection is no longer pending cleanup; the replaced and
      // new ones still are.
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).not.toContain(id2)
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([id1, expect.any(String)])
      setSketchCallback('getSketch', null)
    })

    it('replacing a pick that reused a prior gesture\'s projection does not delete it', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // The sketch already carries a projection for edge2, committed by a prior
      // gesture, so picking it reuses instead of projecting.
      setSketchCallback('getSketch', () => ({
        E2: { start: [0, 0], end: [1, 0], projected: true, source: '?b1/edge:2' },
      } as never))
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' })
      const id1 = handler.mock.calls[0][0].entityId
      handler.mockClear()
      store.addBrepDimensionPick('?b1/edge:2', { isVertexPick: false, sourceKind: 'line' })
      expect(handler).not.toHaveBeenCalled()  // reuse emits no projection
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([id1])

      handler.mockClear()
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      // Pick 2 (the reused edge2 projection) is replaced, but it is not owned
      // by this gesture, so no compensating delete may run or the committed
      // dimension that owns it would dangle.
      const deletes = handler.mock.calls.filter(c => (c[0] as Mutation).type === 'delete')
      expect(deletes).toHaveLength(0)
      const pending = useSketchEditorStore.getState().pendingBrepProjectionIds
      expect(pending).toHaveLength(2)  // edge1 and edge3 only
      expect(pending).toContain(id1)
      setSketchCallback('getSketch', null)
    })

    it('cancelling the value dialog deletes the pending projection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      const eid = handler.mock.calls[0][0].entityId
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      handler.mockClear()

      dialog.onCancel!()

      expect(handler).toHaveBeenCalledWith({ type: 'delete', targets: [`entity:S1:${eid}`] })
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      setSketchCallback('getSketch', null)
    })

    it('committing the dimension clears the pending projections', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      handler.mockClear()

      dialog.onConfirm('10')

      // The projection is now part of the committed dimension, so nothing is
      // pending cleanup any more.
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_constraint' }))
      setSketchCallback('getSketch', null)
    })

    it('a projected body edge dimensions as a length once solved', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        P1: { start: [0, 0], end: [7, 0], projected: true, source: '?b1/edge:3' },
      } as never))
      // Clicking the same edge twice is the same-entity path to a length dim.
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      const dialog = useSketchEditorStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('7')
      dialog.onConfirm('7')
      expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'add_constraint', kind: 'length', targets: ['entity:S1:P1'],
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalize adopts the solved kind of a projection the lowerer promoted', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // The tilted body circle was picked as 'circle'; the solve lowered it to
      // an ellipse, which has no dimension rule -- the dim must not resolve as
      // a diameter against geometry that has no radius.
      setSketchCallback('getSketch', () => ({
        P1: { center: [0, 0], a: 2, b: 1, theta: 0, projected: true, source: '?b1/edge:3' },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:P1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
      setSketchCallback('getSketch', null)
    })

    it('clearDimensionPicks resets to empty', () => {
      useSketchEditorStore.setState({ dimensionPicks: [
        { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
      ] })
      useSketchEditorStore.getState().clearDimensionPicks()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    })

    it('finalizeDimensionPlacement: single line → dialog opens; OK dispatches add_constraint(length)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([200, 300])

      const dialog = useSketchEditorStore.getState().pendingDialog
      expect(dialog).not.toBeNull()
      expect(dialog!.label).toBe('Dimension value')
      expect(dialog!.position).toEqual([200, 300])
      // Picks are dropped immediately so a second click can't double-fire.
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])

      dialog!.onConfirm('42')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 42,
      })
    })

    it('finalizeDimensionPlacement: two lines → angle on OK', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
          { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
        ],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('45')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'angle',
        targets: ['entity:S1:L1', 'entity:S1:L2'], value: 45,
      })
    })

    it('finalizeDimensionPlacement: same-line twice deduplicates targets to one (length)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const pick = { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }
      useSketchEditorStore.setState({ dimensionPicks: [pick, pick] })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'length',
        targets: ['entity:S1:L1'], value: 10,
      })
    })

    it('finalizeDimensionPlacement: vertex alone is undimensionable, no dialog opens', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: true, target: 'vertex:S1:L1:start' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
      // Picks are preserved so the user can keep adding without restarting.
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: empty picks is a no-op', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({ dimensionPicks: [] })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: Cancel (dialog onConfirm not called) dispatches nothing', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().closeDialog()
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: OK keeps the tool armed for the next dim', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('5')
      expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
    })

    it('finalizeDimensionPlacement: dialog defaultValue is the natural measurement', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog!.defaultValue).toBe('10')
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: accepting the rounded default commits the exact measured value', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // Length 12.345... -> default displays rounded to 2 decimals.
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [12.3456, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('12.35')
      // Submitting the default unchanged commits the full-precision value, not 12.35.
      dialog.onConfirm(dialog.defaultValue!)
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ value: 12.3456 }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: editing the default commits the typed value', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [12.3456, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().pendingDialog!.onConfirm('20')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ value: 20 }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: dialog.validate rejects non-numeric and non-positive input', () => {
      setSketchCallback('onMutation', vi.fn())
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const validate = useSketchEditorStore.getState().pendingDialog!.validate!
      expect(validate('abc')).toBeTruthy()
      expect(validate('0')).toBeTruthy()
      expect(validate('-3')).toBeTruthy()
      expect(validate('5')).toBeNull()
    })

    it('finalizeDimensionPlacement: no getSketch → dialog opens with no default', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog!.defaultValue).toBeUndefined()
    })

    it('finalizeDimensionPlacement: writes pos relative to the dim anchor when cursorWorld is set', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: [5, 7],  // 5 along the line, 7 above it
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().pendingDialog!.onConfirm('10')
      // Length anchor = midpoint(L1) = (5, 0). Pos = world - anchor = (0, 7).
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
        pos: [0, 7],
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: omits pos when no cursorWorld', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: null,
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().pendingDialog!.onConfirm('10')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: clears cursorWorld together with picks', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
        dimensionCursorWorld: [1, 2],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().dimensionCursorWorld).toBeNull()
    })

    // ─── point_distance mode switching ───
    // Two-vertex picks with a placementWorld offset switch the constraint kind:
    //   vertical drag → point_distance_x, horizontal drag → point_distance_y

    it('finalizeDimensionPlacement: two vertices with vertical drag switches to point_distance_x', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      // Vertical drag (y offset > x offset) → point_distance_x
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance_x',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L1:end'], value: 10,
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices with horizontal drag switches to point_distance_y', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [12, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      // Horizontal drag (x offset > y offset) → point_distance_y
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance_y',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L1:end'], value: 10,
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices with no clear direction stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        // cursor exactly at midpoint: no clear direction
        dimensionCursorWorld: [5, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices without getSketch stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      // No getSketch → no point resolution → stays point_distance
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
    })

    it('finalizeDimensionPlacement: two vertices without cursorWorld stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: null,
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
      setSketchCallback('getSketch', null)
    })
  })

  describe('prunePickClaims', () => {
    it('returns the original map when no claim needs pruning', () => {
      const picks = new Map([['Q', new Set(['a#1'])], ['R', new Set(['b#2'])]])
      const live = new Set(['Q', 'R'])
      expect(prunePickClaims(picks, live)).toBe(picks)
    })

    it('drops claims whose queries left the live set', () => {
      const picks = new Map([['Q', new Set(['a#1'])], ['R', new Set(['b#2'])]])
      const pruned = prunePickClaims(picks, new Set(['R']))
      expect(pruned.has('Q')).toBe(false)
      expect(pruned.get('R')).toEqual(new Set(['b#2']))
    })

    it('keeps the claim sets of surviving queries intact', () => {
      const picks = new Map([['Q', new Set(['a#1', 'a#2'])], ['dead', new Set(['x#9'])]])
      const pruned = prunePickClaims(picks, new Set(['Q']))
      expect(pruned.get('Q')).toEqual(new Set(['a#1', 'a#2']))
    })

    it('does not mutate the caller map', () => {
      const picks = new Map([['Q', new Set(['a#1'])], ['dead', new Set(['x#9'])]])
      prunePickClaims(picks, new Set(['Q']))
      expect(picks.has('dead')).toBe(true)
    })

    it('evicts every dead claim when the live set is empty', () => {
      const picks = new Map([['Q', new Set(['a#1'])], ['R', new Set(['b#2'])]])
      const pruned = prunePickClaims(picks, new Set())
      expect(pruned.size).toBe(0)
    })
  })
})
