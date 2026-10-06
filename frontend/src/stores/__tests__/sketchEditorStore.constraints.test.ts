import { describe, it, expect, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { installSketchStoreSetup } from './helpers/sketchEditorStoreTestSetup'

describe('sketchEditorStore', () => {
  installSketchStoreSetup()

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

    it('returns a rejection message (naming the kinds) when operand kinds are not allowed', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:A1': 'arc',
        'entity:Sketch1:A2': 'arc',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:A1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:A2')

      const reason = useSketchEditorStore.getState().applyConstraint('parallel')

      expect(reason).toBeTruthy()
      expect(reason).toMatch(/parallel/i)
      expect(reason).toMatch(/arc/)
      expect(handler).not.toHaveBeenCalled()
    })

    it('returns null when the constraint is authored', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({
        'entity:Sketch1:L1': 'line',
        'entity:Sketch1:L2': 'line',
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:L2')

      expect(useSketchEditorStore.getState().applyConstraint('parallel')).toBeNull()
      expect(handler).toHaveBeenCalledOnce()
    })

    it('returns a rejection message for a single non-line horizontal target', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
      useSketchEditorStore.getState().setEntityKindMap({ 'entity:Sketch1:C1': 'circle' })
      useSketchEditorStore.getState().toggleNormalSelection('entity:Sketch1:C1')

      const reason = useSketchEditorStore.getState().applyConstraint('horizontal')

      expect(reason).toMatch(/line/i)
      expect(handler).not.toHaveBeenCalled()
    })

    it('returns a rejection message for a malformed midpoint operand set', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L2')

      expect(useSketchEditorStore.getState().applyConstraint('midpoint')).toBeTruthy()
      expect(handler).not.toHaveBeenCalled()
    })

    it('returns null (no toast) when there is nothing to act on', () => {
      setSketchCallback('onMutation', vi.fn())
      expect(useSketchEditorStore.getState().applyConstraint('horizontal')).toBeNull()
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

})
