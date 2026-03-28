import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore } from '../sketchEditorStore'

const POS: [number, number] = [0, 0]

function reset() {
  useSketchEditorStore.setState({
    selection: new Set(),
    drag: null,
    orbitEnabled: true,
    onMutation: null,
    activeTool: 'dimension',
    activeFeatureId: null,
    pendingDimTarget: null,
    pendingDimEntityKind: null,
    pendingDialog: null,
    planeSelectionFeatureId: null,
  })
}

/** Simulate user confirming the currently open dialog with a value. */
function confirmDialog(value: string) {
  const dialog = useSketchEditorStore.getState().pendingDialog
  if (!dialog) throw new Error('No dialog open')
  dialog.onConfirm(value)
  useSketchEditorStore.getState().closeDialog()
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
      useSketchEditorStore.getState().setActiveFeatureId('Sketch1')
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
    it('line: single click goes pending (waiting for second click)', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')

      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().pendingDimTarget).toBe('entity:S1:L1')
      expect(useSketchEditorStore.getState().pendingDimEntityKind).toBe('line')
    })

    it('line: clicking same line twice creates length constraint', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      confirmDialog('10')

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

    it('arc: single click opens dialog and creates radius constraint on confirm', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:A1', 'S1', 'entity', POS, 'arc')
      expect(useSketchEditorStore.getState().pendingDialog).not.toBeNull()
      confirmDialog('5')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'radius',
        targets: ['entity:S1:A1'],
        value: 5,
      })
    })

    it('circle: single click opens dialog and creates diameter constraint on confirm', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:C1', 'S1', 'entity', POS, 'circle')
      confirmDialog('8')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'diameter',
        targets: ['entity:S1:C1'],
        value: 8,
      })
    })

    it('line: no constraint when dialog is not confirmed', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      // First click → pending, no dialog
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      expect(handler).not.toHaveBeenCalled()
    })

    it('two vertex clicks create point_distance constraint', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('vertex:S1:L1:start', 'S1', 'vertex', POS)
      expect(useSketchEditorStore.getState().pendingDimTarget).toBe('vertex:S1:L1:start')

      useSketchEditorStore.getState().handleDimensionClick('vertex:S1:L2:end', 'S1', 'vertex', POS)
      confirmDialog('7')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'point_distance',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L2:end'],
        value: 7,
      })
    })

    it('two different line clicks create angle constraint', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L2', 'S1', 'entity', POS, 'line')
      confirmDialog('45')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'angle',
        targets: ['entity:S1:L1', 'entity:S1:L2'],
        value: 45,
      })
      expect(useSketchEditorStore.getState().pendingDimTarget).toBeNull()
    })

    it('two non-line-segment entity clicks create line_distance constraint', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.setState({
        pendingDimTarget: 'entity:S1:A1',
        pendingDimEntityKind: 'arc',
      })

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:A2', 'S1', 'entity', POS, 'arc')
      confirmDialog('3')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1',
        kind: 'line_distance',
        targets: ['entity:S1:A1', 'entity:S1:A2'],
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
