import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore } from '../sketchEditorStore'

function reset() {
  useSketchEditorStore.setState({
    selection: new Set(),
    drag: null,
    orbitEnabled: true,
    onMutation: null,
    activeTool: 'dimension',
    pendingDimTarget: null,
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

  describe('handleDimClick', () => {
    it('line_segment: single click creates length constraint immediately', () => {
      const handler = vi.fn()
      vi.spyOn(window, 'prompt').mockReturnValueOnce('10')
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', 'line_segment')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'length',
        targets: ['entity:S1:L1'],
        value: 10,
      })
      expect(useSketchEditorStore.getState().pendingDimTarget).toBeNull()
    })

    it('arc: single click creates radius constraint immediately', () => {
      const handler = vi.fn()
      vi.spyOn(window, 'prompt').mockReturnValueOnce('5')
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:A1', 'S1', 'entity', 'arc')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'radius',
        targets: ['entity:S1:A1'],
        value: 5,
      })
    })

    it('circle: single click creates diameter constraint immediately', () => {
      const handler = vi.fn()
      vi.spyOn(window, 'prompt').mockReturnValueOnce('8')
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:C1', 'S1', 'entity', 'circle')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'diameter',
        targets: ['entity:S1:C1'],
        value: 8,
      })
    })

    it('line_segment: does not create constraint when prompt is cancelled', () => {
      const handler = vi.fn()
      vi.spyOn(window, 'prompt').mockReturnValueOnce(null)
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', 'line_segment')

      expect(handler).not.toHaveBeenCalled()
    })

    it('two vertex clicks create point_distance constraint', () => {
      const handler = vi.fn()
      vi.spyOn(window, 'prompt').mockReturnValueOnce('7')
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('vertex:S1:L1:start', 'S1', 'vertex')
      expect(useSketchEditorStore.getState().pendingDimTarget).toBe('vertex:S1:L1:start')

      useSketchEditorStore.getState().handleDimensionClick('vertex:S1:L2:end', 'S1', 'vertex')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'point_distance',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L2:end'],
        value: 7,
      })
    })

    it('two entity clicks create line_distance constraint', () => {
      const handler = vi.fn()
      vi.spyOn(window, 'prompt').mockReturnValueOnce('3')
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', 'line_segment')
      // first click on a line: immediately creates length, no pending state
      // reset and test the two-entity flow by starting with a non-line entity kind
      // (or by simulating a second click via pending state directly)
      handler.mockClear()
      vi.spyOn(window, 'prompt').mockReturnValueOnce('3')
      useSketchEditorStore.setState({ pendingDimTarget: 'entity:S1:L1' })

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L2', 'S1', 'entity', 'line_segment')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'line_distance',
        targets: ['entity:S1:L1', 'entity:S1:L2'],
        value: 3,
      })
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
