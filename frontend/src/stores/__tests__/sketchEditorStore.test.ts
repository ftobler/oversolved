import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore } from '../sketchEditorStore'

const POS: [number, number] = [0, 0]

function reset() {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    internalHoverSelection: null,
    dynamicSelection: new Set(),
    isPointerDown: false,
    drag: null,
    orbitEnabled: true,
    onMutation: null,
    activeTool: 'dimension',
    activeFeatureId: null,
    pendingDimTarget: null,
    pendingDimEntityKind: null,
    pendingDialog: null,
    planeSelectionFeatureId: null,
    hoveredEntityId: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    hoveredConstraintEntityIds: new Set(),
  })
}

// Simulate user confirming the currently open dialog with a value.
function confirmDialog(value: string) {
  const dialog = useSketchEditorStore.getState().pendingDialog
  if (!dialog) throw new Error('No dialog open')
  dialog.onConfirm(value)
  useSketchEditorStore.getState().closeDialog()
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
  })

  describe('clearNormalSelection', () => {
    it('empties the selection', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().clearNormalSelection()
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })
  })

  describe('deleteSelected', () => {
    it('dispatches mutation and clears selection', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
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
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no mutation handler', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      // no handler set — should not throw
      expect(() => useSketchEditorStore.getState().deleteSelected()).not.toThrow()
    })
  })

  describe('applyConstraint', () => {
    it('dispatches add_constraint with selected targets', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
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
      useSketchEditorStore.getState().setOnMutation(handler)
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

    it('setHoveredEntity updates hovered entity', () => {
      useSketchEditorStore.getState().setHoveredEntity('entity:S1:L1')
      expect(useSketchEditorStore.getState().hoveredEntityId).toBe('entity:S1:L1')
    })

    it('setHoveredEntity clears on null', () => {
      useSketchEditorStore.getState().setHoveredEntity('entity:S1:L1')
      useSketchEditorStore.getState().setHoveredEntity(null)
      expect(useSketchEditorStore.getState().hoveredEntityId).toBeNull()
    })

    it('setHoveredConstraintEntities updates constraint-highlighted entities', () => {
      const ids = new Set(['entity:S1:L1', 'entity:S1:L2'])
      useSketchEditorStore.getState().setHoveredConstraintEntities(ids)
      expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(ids)
    })

    it('setHoveredPathSnap updates path snap state', () => {
      useSketchEditorStore.getState().setHoveredPathSnap({ entityId: 'L1', position: [5, 5] })
      expect(useSketchEditorStore.getState().hoveredPathSnap).toEqual({ entityId: 'L1', position: [5, 5] })
    })

    it('setHoveredPathSnap clears on null', () => {
      useSketchEditorStore.getState().setHoveredPathSnap({ entityId: 'L1', position: [5, 5] })
      useSketchEditorStore.getState().setHoveredPathSnap(null)
      expect(useSketchEditorStore.getState().hoveredPathSnap).toBeNull()
    })

    it('setHoveredPlane updates hovered plane', () => {
      useSketchEditorStore.getState().setHoveredPlane('@builtin_plane_front')
      expect(useSketchEditorStore.getState().hoveredPlaneId).toBe('@builtin_plane_front')
    })

    it('setHoveredPlane clears on null', () => {
      useSketchEditorStore.getState().setHoveredPlane('@sketch1')
      useSketchEditorStore.getState().setHoveredPlane(null)
      expect(useSketchEditorStore.getState().hoveredPlaneId).toBeNull()
    })

    it('setHoveredSurface updates hovered surface', () => {
      useSketchEditorStore.getState().setHoveredSurface('face:sketch1:?3;@sketch1abc')
      expect(useSketchEditorStore.getState().hoveredSurfaceId).toBe('face:sketch1:?3;@sketch1abc')
    })

    it('setHoveredSurface clears on null', () => {
      useSketchEditorStore.getState().setHoveredSurface('face:sketch1:?3;@sketch1abc')
      useSketchEditorStore.getState().setHoveredSurface(null)
      expect(useSketchEditorStore.getState().hoveredSurfaceId).toBeNull()
    })

    it('hoveredSnapKind can be path', () => {
      useSketchEditorStore.getState().setHoveredVertex('vertex:S1:L1:start', [5, 5], 'path')
      expect(useSketchEditorStore.getState().hoveredSnapKind).toBe('path')
    })
  })

  describe('plane selection', () => {
    it('setPlaneSelectionFeatureId sets the plane feature being edited', () => {
      useSketchEditorStore.getState().setPlaneSelectionFeatureId('Sketch1')
      expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBe('Sketch1')
    })

    it('commitPlaneSelection dispatches mutation with face query', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().setPlaneSelectionFeatureId('Sketch1')
      useSketchEditorStore.getState().commitPlaneSelection('face:sketch0:?3;@sketch0abc')
      expect(handler).toHaveBeenCalledWith({
        type: 'set_feature_plane',
        featureId: 'Sketch1',
        plane: '?3;@sketch0abc',
      })
    })

    it('commitPlaneSelection is no-op when no feature selected', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().commitPlaneSelection('face:sketch0:?3;@sketch0abc')
      expect(handler).not.toHaveBeenCalled()
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
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
