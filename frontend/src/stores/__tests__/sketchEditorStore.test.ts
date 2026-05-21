import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'

// Lazy-init the tool registry once so tool lifecycle tests can verify activate/deactivate wiring.
let toolsInitialized = false

beforeAll(() => {
  if (!toolsInitialized) {
    initializeTools()
    toolsInitialized = true
  }
})

function reset() {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    internalHoverSelection: null,
    isPointerDown: false,
    drag: null,
    orbitEnabled: true,
    activeTool: null,
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
    modeStack: [],
  })
  setSketchCallback('onMutation', null)
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
      // no handler set — should not throw
      expect(() => useSketchEditorStore.getState().deleteSelected()).not.toThrow()
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

    it('setHovered3DSurface updates hovered 3D surface', () => {
      useSketchEditorStore.getState().setHovered3DSurface('?d,d;@extrude1face0:face')
      expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBe('?d,d;@extrude1face0:face')
    })

    it('setHovered3DSurface clears on null', () => {
      useSketchEditorStore.getState().setHovered3DSurface('?d,d;@extrude1face0:face')
      useSketchEditorStore.getState().setHovered3DSurface(null)
      expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBeNull()
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
      setSketchCallback('onMutation', handler)
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
      setSketchCallback('onMutation', handler)
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

    it('commitPlaneSelection clears chipOwnedSelection', () => {
      useSketchEditorStore.getState().setPlaneSelectionFeatureId('sk1')
      useSketchEditorStore.setState({
        chipOwnedSelection: new Set(['?body_ex1/face/0']),
        normalSelection: new Set(['?body_ex1/face/0']),
      })
      setSketchCallback('onMutation', vi.fn())
      useSketchEditorStore.getState().commitPlaneSelection('?body_ex1/face/0')
      expect(useSketchEditorStore.getState().chipOwnedSelection.size).toBe(0)
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
      it('clears pendingDimTarget when switching from dimension to another tool', () => {
        useSketchEditorStore.setState({ pendingDimTarget: 'entity:S1:L1', pendingDimEntityKind: 'line' })
        useSketchEditorStore.getState().setActiveTool('line')
        const s = useSketchEditorStore.getState()
        expect(s.pendingDimTarget).toBeNull()
        expect(s.pendingDimEntityKind).toBeNull()
      })

      it('preserves pendingDimTarget when staying in dimension tool', () => {
        useSketchEditorStore.setState({ pendingDimTarget: 'entity:S1:L1', pendingDimEntityKind: 'line' })
        useSketchEditorStore.getState().setActiveTool('dimension')
        const s = useSketchEditorStore.getState()
        expect(s.pendingDimTarget).toBe('entity:S1:L1')
        expect(s.pendingDimEntityKind).toBe('line')
      })

      it('clears planeSelectionFeatureId when entering a tool', () => {
        useSketchEditorStore.setState({ planeSelectionFeatureId: 'Sketch1', activeTool: null })
        useSketchEditorStore.getState().setActiveTool('select')
        expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBeNull()
      })

      it('does not clear planeSelectionFeatureId when setting tool to null', () => {
        useSketchEditorStore.setState({ planeSelectionFeatureId: 'Sketch1', activeTool: null })
        useSketchEditorStore.getState().setActiveTool(null)
        // tool=null means we are NOT entering a tool mode, so plane selection persists
        expect(useSketchEditorStore.getState().planeSelectionFeatureId).toBe('Sketch1')
      })

      it('clears drawSnapVertexId when switching tool', () => {
        useSketchEditorStore.getState().setDrawSnap('vertex:S1:L1:start')
        useSketchEditorStore.getState().setActiveTool('circle')
        expect(useSketchEditorStore.getState().drawSnapVertexId).toBeNull()
      })
    })

    describe('setPlaneSelectionFeatureId', () => {
      it('clears activeTool and draw state when entering plane selection', () => {
        useSketchEditorStore.getState().setActiveTool('select')
        useSketchEditorStore.getState().setPlaneSelectionFeatureId('Sketch1')
        const s = useSketchEditorStore.getState()
        expect(s.planeSelectionFeatureId).toBe('Sketch1')
        expect(s.activeTool).toBeNull()
        expect(s.drawPoints).toEqual([])
        expect(s.drawHover).toBeNull()
        expect(s.drawSnapVertexId).toBeNull()
      })

      it('does not clear tool state when clearing plane selection', () => {
        useSketchEditorStore.getState().setActiveTool('select')
        useSketchEditorStore.getState().setPlaneSelectionFeatureId('Sketch1')
        useSketchEditorStore.getState().setPlaneSelectionFeatureId(null)
        expect(useSketchEditorStore.getState().activeTool).toBeNull()  // tool was already cleared when entering plane mode
      })
    })
  })

  describe('tool lifecycle → mode stack integration', () => {
    it('setActiveTool pushes mode via activate', () => {
      useSketchEditorStore.getState().setActiveTool('select')
      expect(useSketchEditorStore.getState().modeStack).toContain('tool:select')
    })

    it('switching tools pops old mode and pushes new', () => {
      useSketchEditorStore.getState().setActiveTool('select')
      useSketchEditorStore.getState().setActiveTool('line')
      const stack = useSketchEditorStore.getState().modeStack
      expect(stack).not.toContain('tool:select')
      expect(stack).toContain('tool:line')
    })

    it('setting tool to null pops mode', () => {
      useSketchEditorStore.getState().setActiveTool('select')
      useSketchEditorStore.getState().setActiveTool(null)
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('plane selection pushes mode after deactivating tool', () => {
      useSketchEditorStore.getState().setActiveTool('select')
      useSketchEditorStore.getState().setPlaneSelectionFeatureId('Sketch1')
      const stack = useSketchEditorStore.getState().modeStack
      expect(stack).not.toContain('tool:select')
      expect(stack).toContain('plane_selection')
    })

    it('commitPlaneSelection pops plane_selection mode', () => {
      setSketchCallback('onMutation', vi.fn())
      useSketchEditorStore.getState().setPlaneSelectionFeatureId('Sketch1')
      useSketchEditorStore.getState().commitPlaneSelection('@builtin_plane_top')
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
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
})
