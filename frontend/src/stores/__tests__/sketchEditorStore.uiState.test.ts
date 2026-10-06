import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { installSketchStoreSetup, resetSketchEditorStore } from './helpers/sketchEditorStoreTestSetup'

describe('sketchEditorStore', () => {
  installSketchStoreSetup()

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

    it('activating a pick field wipes a stray selection and its claims', () => {
      useSketchEditorStore.setState({
        normalSelection: new Set(['@ex1/edge/0']),
        selectedPicks: new Map([['@ex1/edge/0', new Set(['ex1#b0#3'])]]),
        selectionDomain: 'body_3d',
      })
      useSketchEditorStore.getState().setActivePickField({ featureId: 'S1', field: 'plane' })
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.size).toBe(0)
      expect(s.selectedPicks.size).toBe(0)
      expect(s.chipOwnedSelection.size).toBe(0)
    })
  })

  describe('dragSnap', () => {
    beforeEach(resetSketchEditorStore)

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

})
