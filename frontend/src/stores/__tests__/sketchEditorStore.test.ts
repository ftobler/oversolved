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

    it('does nothing with no activeFeatureId', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with no mutation handler', () => {
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(() => useSketchEditorStore.getState().applyConstraint('horizontal')).not.toThrow()
    })
  })

  describe('toggleConstruction', () => {
    it('dispatches toggle_construction with entity targets', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
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
      useSketchEditorStore.getState().setOnMutation(handler)
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
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
      useSketchEditorStore.getState().toggleConstruction()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing with empty selection', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
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
      useSketchEditorStore.getState().setOnMutation(handler)
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
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S2:L1')
      useSketchEditorStore.getState().deleteSelected()
      expect(handler).not.toHaveBeenCalled()
    })

    it('clears selection after dispatch', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().deleteSelected()
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
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

  describe('draw tool state', () => {
    it('addDrawPoint accumulates points', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().addDrawPoint([3, 4])
      expect(useSketchEditorStore.getState().drawPoints).toEqual([[1, 2], [3, 4]])
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

    it('setDrawSnap stores vertexId and entityRef', () => {
      useSketchEditorStore.getState().setDrawSnap('vertex:S1:L1:start', 'entity:S1:L1')
      expect(useSketchEditorStore.getState().drawSnapVertexId).toBe('vertex:S1:L1:start')
      expect(useSketchEditorStore.getState().drawSnapEntityRef).toBe('entity:S1:L1')
    })

    it('clearDraw resets all draw state', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().setDrawHover([3, 4])
      useSketchEditorStore.getState().setDrawSnap('vertex:S1:L1:start', 'entity:S1:L1')
      useSketchEditorStore.getState().clearDraw()
      expect(useSketchEditorStore.getState().drawPoints).toEqual([])
      expect(useSketchEditorStore.getState().drawHover).toBeNull()
      expect(useSketchEditorStore.getState().drawSnapVertexId).toBeNull()
      expect(useSketchEditorStore.getState().drawSnapEntityRef).toBeNull()
    })
  })

  describe('updateDynamicSelection', () => {
    it('adds a new id to dynamicSelection', () => {
      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(true)
    })

    it('clears dynamicSelection when called with null', () => {
      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      useSketchEditorStore.getState().updateDynamicSelection(null)
      expect(useSketchEditorStore.getState().dynamicSelection.size).toBe(0)
    })

    it('marks id for removal when id is already in normalSelection', () => {
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      // items in normal selection are not added to dynamic (they would be toggled off)
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(false)
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

    it('dialog cancel does not dispatch mutation', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      // cancel dialog without confirming
      const dialog = useSketchEditorStore.getState().pendingDialog
      dialog?.onCancel?.()
      useSketchEditorStore.getState().closeDialog()

      expect(handler).not.toHaveBeenCalled()
    })

    it('invalid dialog value (NaN) does not dispatch mutation', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      confirmDialog('not-a-number')

      expect(handler).not.toHaveBeenCalled()
    })

    it('invalid dialog value (zero) does not dispatch mutation', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      confirmDialog('0')

      expect(handler).not.toHaveBeenCalled()
    })

    it('negative value does not dispatch mutation', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)

      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      useSketchEditorStore.getState().handleDimensionClick('entity:S1:L1', 'S1', 'entity', POS, 'line')
      confirmDialog('-5')

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

    it('applyConstraint applies to sketch entities even in mixed domain', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
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

    it('applyConstraint does nothing in mixed domain with no sketch entities', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().setActiveFeatureId('S1')
      useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
      useSketchEditorStore.getState().toggleNormalSelection('@plane1')
      useSketchEditorStore.getState().applyConstraint('horizontal')
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('commitFieldPick (sketch field)', () => {
    it('dispatches add_extrude_profile with face ancestry query and keeps pick mode open', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.setState({
        pendingPickField: { featureId: 'ex2', field: 'sketch' },
      })
      const faceQuery = '?9,2;@ex1face0@ex1:flatface'
      useSketchEditorStore.getState().toggleNormalSelection(`face:ex1:${faceQuery}`)
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_extrude_profile',
        featureId: 'ex2',
        sketchQuery: faceQuery,
      })
      // pick mode stays open for multi-selection
      expect(useSketchEditorStore.getState().pendingPickField).toEqual({ featureId: 'ex2', field: 'sketch' })
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('passes raw selection id through for non-face picks', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.setState({
        pendingPickField: { featureId: 'ex1', field: 'sketch' },
      })
      useSketchEditorStore.getState().toggleNormalSelection('sk1')
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).toHaveBeenCalledWith({
        type: 'add_extrude_profile',
        featureId: 'ex1',
        sketchQuery: 'sk1',
      })
    })

    it('face pick dispatches set_plane_definition_field with ancestry query', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.setState({
        pendingPickField: { featureId: 'plane1', field: 'origin' },
      })
      useSketchEditorStore.getState().toggleNormalSelection('face:sk1:?3;@sk1abc')
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).toHaveBeenCalledWith({
        type: 'set_plane_definition_field',
        featureId: 'plane1',
        field: 'origin',
        value: '?3;@sk1abc',
      })
      expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('vertex pick dispatches set_plane_definition_field with @ reference', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.setState({
        pendingPickField: { featureId: 'plane1', field: 'x_axis' },
      })
      useSketchEditorStore.getState().toggleNormalSelection('vertex:S1:L1:start')
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).toHaveBeenCalledWith({
        type: 'set_plane_definition_field',
        featureId: 'plane1',
        field: 'x_axis',
        value: '@S1L1start',
      })
    })

    it('entity pick dispatches set_plane_definition_field with @ reference', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.setState({
        pendingPickField: { featureId: 'plane1', field: 'normal' },
      })
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).toHaveBeenCalledWith({
        type: 'set_plane_definition_field',
        featureId: 'plane1',
        field: 'normal',
        value: '@S1L1',
      })
    })

    it('does nothing when no pendingPickField', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does nothing when selection is empty', () => {
      const handler = vi.fn()
      useSketchEditorStore.getState().setOnMutation(handler)
      useSketchEditorStore.setState({
        pendingPickField: { featureId: 'plane1', field: 'origin' },
      })
      useSketchEditorStore.getState().commitFieldPick()
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
