import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore } from '../sketchEditorStore'

function reset() {
  useSketchEditorStore.setState({
    selection: new Set(),
    drag: null,
    orbitEnabled: true,
    onMutation: null,
  })
}

describe('sketchEditorStore', () => {
  beforeEach(reset)

  describe('toggleSelect', () => {
    it('adds an id when absent', () => {
      useSketchEditorStore.getState().toggleSelect('entity:S1:L1')
      expect(useSketchEditorStore.getState().selection.has('entity:S1:L1')).toBe(true)
    })

    it('removes an id when present', () => {
      useSketchEditorStore.getState().toggleSelect('entity:S1:L1')
      useSketchEditorStore.getState().toggleSelect('entity:S1:L1')
      expect(useSketchEditorStore.getState().selection.has('entity:S1:L1')).toBe(false)
    })

    it('accumulates multiple selections', () => {
      const { toggleSelect } = useSketchEditorStore.getState()
      toggleSelect('entity:S1:L1')
      toggleSelect('vertex:S1:L1:start')
      const sel = useSketchEditorStore.getState().selection
      expect(sel.size).toBe(2)
      expect(sel.has('entity:S1:L1')).toBe(true)
      expect(sel.has('vertex:S1:L1:start')).toBe(true)
    })
  })

  describe('clearSelection', () => {
    it('empties the selection', () => {
      useSketchEditorStore.getState().toggleSelect('entity:S1:L1')
      useSketchEditorStore.getState().clearSelection()
      expect(useSketchEditorStore.getState().selection.size).toBe(0)
    })
  })

  describe('deleteSelected', () => {
    it('dispatches mutation and clears selection', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().toggleSelect('entity:S1:L1')
      useSketchEditorStore.getState().toggleSelect('constraint:S1:C1')

      useSketchEditorStore.getState().deleteSelected()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'delete',
        targets: expect.arrayContaining(['entity:S1:L1', 'constraint:S1:C1']),
      })
      expect(useSketchEditorStore.getState().selection.size).toBe(0)
    })

    it('does nothing with no selection', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no mutation handler', () => {
      useSketchEditorStore.getState().toggleSelect('entity:S1:L1')
      // no handler set — should not throw
      expect(() => useSketchEditorStore.getState().deleteSelected()).not.toThrow()
    })
  })

  describe('applyConstraint', () => {
    it('dispatches add_constraint with selected targets', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().toggleSelect('entity:Sketch1:L1')
      useSketchEditorStore.getState().toggleSelect('entity:Sketch1:L2')

      useSketchEditorStore.getState().applyConstraint('horizontal')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'Sketch1',
        kind: 'horizontal',
        targets: expect.arrayContaining(['entity:Sketch1:L1', 'entity:Sketch1:L2']),
      })
    })

    it('does nothing with empty selection', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('orbit control', () => {
    it('defaults to enabled', () => {
      expect(useSketchEditorStore.getState().orbitEnabled).toBe(true)
    })

    it('can be disabled and re-enabled', () => {
      useSketchEditorStore.getState().setOrbitEnabled(false)
      expect(useSketchEditorStore.getState().orbitEnabled).toBe(false)
      useSketchEditorStore.getState().setOrbitEnabled(true)
      expect(useSketchEditorStore.getState().orbitEnabled).toBe(true)
    })
  })
})
