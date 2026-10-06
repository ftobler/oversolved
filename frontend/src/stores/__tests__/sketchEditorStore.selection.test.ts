import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback, prunePickClaims } from '@/stores/sketchEditorStore'
import { installSketchStoreSetup, resetSketchEditorStore } from './helpers/sketchEditorStoreTestSetup'

describe('sketchEditorStore', () => {
  installSketchStoreSetup()

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

    it('a claim-shrink click on a multi-key orphan re-asserts the query it left unselected', () => {
      // Orphan: another writer cleared normalSelection but left a 2-key claim under Q.
      // Clicking one of those keys removes it AND must heal Q back into
      // normalSelection, exactly as the colliding-sibling branch does for a 1-key orphan.
      useSketchEditorStore.setState({
        normalSelection: new Set(),
        selectedPicks: new Map([['Q', new Set(['ex1/b0#edge#0', 'ex1/b0#edge#1'])]]),
      })
      useSketchEditorStore.getState().toggleNormalSelection('Q', 'ex1/b0#edge#0')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('Q')).toBe(true)
      expect(s.selectedPicks.get('Q')).toEqual(new Set(['ex1/b0#edge#1']))
    })

    it('a claim-shrink click that empties a single-key orphan removes the query entirely', () => {
      // The full-deselect outcome must still fully remove: the re-assert belongs
      // only to the path that leaves keys behind.
      useSketchEditorStore.setState({
        normalSelection: new Set(),
        selectedPicks: new Map([['Q', new Set(['ex1/b0#edge#0'])]]),
      })
      useSketchEditorStore.getState().toggleNormalSelection('Q', 'ex1/b0#edge#0')
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('Q')).toBe(false)
      expect(s.selectedPicks.has('Q')).toBe(false)
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

  describe('selectionDomain', () => {
    beforeEach(resetSketchEditorStore)

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
