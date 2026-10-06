import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { installSketchStoreSetup } from './helpers/sketchEditorStoreTestSetup'

describe('sketchEditorStore', () => {
  installSketchStoreSetup()

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
      expect(useSketchEditorStore.getState().drawSnapRefs).toEqual([])
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

    // The transition reset used to hand-list a subset of clearDragState's fields,
    // so any field clearDragState later grew silently missed this path too.
    it("setActiveFeatureId's drag reset covers every clearDragState field", () => {
      useSketchEditorStore.getState().setActiveFeatureId('S0')
      useSketchEditorStore.getState().setDrag({
        type: 'vertex',
        vertexId: 'vertex:S0:e1:start',
        featureId: 'S0',
        entityId: 'e1',
        vertexKey: 'start',
        startWorld: [0, 0],
        currentWorld: [1, 1],
        startClient: [5, 6],
      })
      useSketchEditorStore.getState().setDragPending({
        type: 'vertex',
        vertexId: 'vertex:S0:e1:start',
        featureId: 'S0',
        entityId: 'e1',
        vertexKey: 'start',
        startWorld: [0, 0],
      })
      useSketchEditorStore.getState().setDragStartClient([10, 20])
      useSketchEditorStore.getState().setDragSnap({ kind: 'vertex', constraintKind: 'coincident', vertexId: 'vertex:S0:L1:start', position: [3, 4] })
      useSketchEditorStore.getState().setIsPointerDown(true)
      useSketchEditorStore.getState().setIsRotating(true)
      useSketchEditorStore.getState().setAlignmentSnap([1, 2], 'kinda_horizontal')

      useSketchEditorStore.getState().setActiveFeatureId('S1')

      const s = useSketchEditorStore.getState()
      expect(s.drag).toBeNull()
      expect(s.dragPending).toBeNull()
      expect(s.dragStartClient).toBeNull()
      expect(s.dragSnap).toBeNull()
      expect(s.isPointerDown).toBe(false)
      expect(s.isRotating).toBe(false)
      expect(s.alignmentSnapPoint).toBeNull()
      expect(s.alignmentSnapKind).toBeNull()
    })

    it('retires selection, picks, chip-owned entries and hover on sketch exit', () => {
      const s = useSketchEditorStore.getState()
      s.setActiveFeatureId('S1')
      s.toggleNormalSelection('entity:S1:l1')
      s.syncChipSelection(['@builtin_plane_front'])
      useSketchEditorStore.setState({
        hoveredSelectionId: 'entity:S1:l1',
        hoveredPickKey: 'ex1#b0#3',
        hoveredConstraintEntityIds: new Set(['entity:S1:l1']),
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [1, 2, 3],
      })

      s.setActiveFeatureId(null)

      const after = useSketchEditorStore.getState()
      expect(after.normalSelection.size).toBe(0)
      expect(after.selectedPicks.size).toBe(0)
      expect(after.chipOwnedSelection.size).toBe(0)
      expect(after.selectionDomain).toBe('sketch_2d')
      expect(after.hoveredSelectionId).toBeNull()
      expect(after.hoveredPickKey).toBeNull()
      expect(after.hoveredConstraintEntityIds.size).toBe(0)
      expect(after.hoveredFaceNormal).toBeNull()
      expect(after.hoveredFaceCenter).toBeNull()
    })

    it('retires selection when switching directly from one sketch to another', () => {
      const s = useSketchEditorStore.getState()
      s.setActiveFeatureId('S1')
      s.toggleNormalSelection('entity:S1:l1')
      s.setActiveFeatureId('S2')
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    })

    it('keeps a pre-existing selection when entering a sketch from the part view', () => {
      const s = useSketchEditorStore.getState()
      s.toggleNormalSelection('@builtin_plane_front')
      s.setActiveFeatureId('S1')
      expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_front')).toBe(true)
    })

    it('leaves selection untouched when the active feature is re-asserted unchanged', () => {
      const s = useSketchEditorStore.getState()
      s.setActiveFeatureId('S1')
      s.toggleNormalSelection('entity:S1:l1')
      s.setActiveFeatureId('S1')
      expect(useSketchEditorStore.getState().normalSelection.has('entity:S1:l1')).toBe(true)
    })
  })

  describe('resetTransientState', () => {
    it('still clears every selection and hover field (delegates to clearSelectionAndHover)', () => {
      useSketchEditorStore.setState({
        normalSelection: new Set(['entity:S1:l1']),
        selectedPicks: new Map([['@ex1/edge/0', new Set(['ex1#b0#3'])]]),
        chipOwnedSelection: new Set(['entity:S1:l1']),
        selectionDomain: 'mixed',
        hoveredSelectionId: 'x',
        hoveredPickKey: 'y',
        hoveredConstraintEntityIds: new Set(['z']),
        hoveredVertexId: 'v',
        hoveredVertexPosition: [1, 1],
        hoveredSnapKind: 'path',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [0, 0, 0],
      })
      useSketchEditorStore.getState().resetTransientState()
      const s = useSketchEditorStore.getState()
      for (const v of [s.hoveredSelectionId, s.hoveredPickKey, s.hoveredVertexId, s.hoveredVertexPosition, s.hoveredSnapKind, s.hoveredFaceNormal, s.hoveredFaceCenter]) {
        expect(v).toBeNull()
      }
      expect(s.normalSelection.size).toBe(0)
      expect(s.selectedPicks.size).toBe(0)
      expect(s.chipOwnedSelection.size).toBe(0)
      expect(s.hoveredConstraintEntityIds.size).toBe(0)
      expect(s.selectionDomain).toBe('sketch_2d')
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

    it('setDrawSnap stores the carried refs', () => {
      useSketchEditorStore.getState().setDrawSnap(['vertex:S1:L1:start'])
      expect(useSketchEditorStore.getState().drawSnapRefs).toEqual(['vertex:S1:L1:start'])
    })

    it('clearDraw resets all draw state', () => {
      useSketchEditorStore.getState().addDrawPoint([1, 2])
      useSketchEditorStore.getState().setDrawHover([3, 4])
      useSketchEditorStore.getState().setDrawSnap(['vertex:S1:L1:start'])
      useSketchEditorStore.getState().clearDraw()
      expect(useSketchEditorStore.getState().drawPoints).toEqual([])
      expect(useSketchEditorStore.getState().drawHover).toBeNull()
      expect(useSketchEditorStore.getState().drawSnapRefs).toEqual([])
    })
  })

  describe('sticky draw tools', () => {
    beforeEach(() => {
      useSketchEditorStore.setState({ activeFeatureId: 'S1' })
    })

    it('committing an entity leaves activeTool set and the mode stack intact', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.setState({ drawPoints: [[0, 0], [10, 0]] })

      // clearDraw is what DrawingTool calls after a committed gesture; the tool's
      // arming policy lives in the adapter, so clearing the buffer must not touch
      // the tool or its mode entry.
      useSketchEditorStore.getState().clearDraw()

      expect(useSketchEditorStore.getState().activeTool).toBe('line')
      expect(useSketchEditorStore.getState().modeStack).toEqual(['tool:line'])
    })

    it('an armed tool with an empty draw buffer passes validateSketchEditorState', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      // The resting sticky state: tool armed, nothing in progress.
      expect(useSketchEditorStore.getState().drawPoints).toEqual([])
      expect(() => useSketchEditorStore.getState().clearDraw()).not.toThrow()
      expect(useSketchEditorStore.getState().activeTool).toBe('line')
    })

    it('switching tools while armed still disarms the previous tool', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().setActiveTool('rect')

      expect(useSketchEditorStore.getState().activeTool).toBe('rect')
      expect(useSketchEditorStore.getState().modeStack).toEqual(['tool:rect'])
    })

    it('leaving the sketch while armed disarms the tool', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.setState({ activeFeatureId: 'S1' })
      useSketchEditorStore.getState().setActiveFeatureId(null)

      expect(useSketchEditorStore.getState().activeTool).toBeNull()
      expect(useSketchEditorStore.getState().modeStack).toEqual([])
    })

    it('opening a pick field while armed disarms the tool', () => {
      useSketchEditorStore.getState().setActiveTool('line')
      useSketchEditorStore.getState().setActivePickField({ featureId: 'S1', field: 'plane' })

      // The tool is disarmed and its 'tool:line' mode entry is gone (replaced by
      // 'pick'), so a sticky tool cannot leak its mode entry across enter/exit.
      expect(useSketchEditorStore.getState().activeTool).toBeNull()
      expect(useSketchEditorStore.getState().modeStack).not.toContain('tool:line')
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

      it('keeps the pick field when entering the passive drag tool', () => {
        // Regression: clicking empty canvas activates drag (select), which used
        // to wipe activePickField and silently kill face picks afterwards.
        useSketchEditorStore.setState({
          normalSelection: new Set(['@edge_0']),
          chipOwnedSelection: new Set(['@edge_0']),
          activePickField: { featureId: 'F1', field: 'profile' },
          modeStack: ['pick'],
        })
        useSketchEditorStore.getState().setActiveTool('drag')
        const s = useSketchEditorStore.getState()
        expect(s.activePickField).toEqual({ featureId: 'F1', field: 'profile' })
        expect(s.modeStack).toEqual(['pick'])
      })

      it('entering a drawing tool with an open pick field prunes claims by query, not a blanket wipe', () => {
        const s = useSketchEditorStore.getState()
        s.setActivePickField({ featureId: 'ex1', field: 'edges', multi: true })
        // A non-chip entry that survives the switch (box-select does not gate on
        // the open field). Its claim must ride along with its still-selected query.
        useSketchEditorStore.setState({
          normalSelection: new Set(['@ex1/edge/0']),
          selectedPicks: new Map([['@ex1/edge/0', new Set(['ex1#b0#3'])]]),
          selectionDomain: 'body_3d',
        })

        s.setActiveTool('line')

        const after = useSketchEditorStore.getState()
        expect(after.activePickField).toBeNull()
        expect(after.normalSelection.has('@ex1/edge/0')).toBe(true)
        expect(after.selectedPicks.get('@ex1/edge/0')).toEqual(new Set(['ex1#b0#3']))
      })

      it('clears the pick field and chip selection when entering a drawing tool', () => {
        useSketchEditorStore.setState({
          normalSelection: new Set(['@edge_0', '@edge_1']),
          chipOwnedSelection: new Set(['@edge_0']),
          activePickField: { featureId: 'F1', field: 'profile' },
          modeStack: ['pick'],
        })
        useSketchEditorStore.getState().setActiveTool('line')
        const s = useSketchEditorStore.getState()
        expect(s.activePickField).toBeNull()
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

      it('keeps activePickField and chip-owned selection when entering the passive drag tool', () => {
        useSketchEditorStore.setState({
          activePickField: { featureId: 'Sketch1', field: 'plane' },
          activeTool: null,
          chipOwnedSelection: new Set(['?body_ex1/face/0']),
          normalSelection: new Set(['?body_ex1/face/0', '@other_item']),
          modeStack: ['pick'],
        })
        // drag is the real idle/select entry (getEffectiveTool(null) === 'drag').
        // Entering it must NOT steal an open pick field, so a later face click
        // still routes through usePickField (the extrude Profile bug).
        useSketchEditorStore.getState().setActiveTool('drag')
        const s = useSketchEditorStore.getState()
        expect(s.activePickField).toEqual({ featureId: 'Sketch1', field: 'plane' })
        expect(s.chipOwnedSelection.has('?body_ex1/face/0')).toBe(true)
        expect(s.activeTool).toBeNull()
        expect(s.normalSelection.has('?body_ex1/face/0')).toBe(true)
        expect(s.normalSelection.has('@other_item')).toBe(true)
      })

      it('does not clear activePickField when setting tool to null', () => {
        useSketchEditorStore.setState({ activePickField: { featureId: 'Sketch1', field: 'plane' }, activeTool: null, modeStack: ['pick'] })
        useSketchEditorStore.getState().setActiveTool(null)
        // tool=null means we are NOT entering a tool mode, so the pick field persists
        expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'Sketch1', field: 'plane' })
      })

      it('clears the carried draw snaps when switching tool', () => {
        useSketchEditorStore.getState().setDrawSnap(['vertex:S1:L1:start'])
        useSketchEditorStore.getState().setActiveTool('circle')
        expect(useSketchEditorStore.getState().drawSnapRefs).toEqual([])
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
        expect(s.drawSnapRefs).toEqual([])
      })

      it('does not clear tool state when clearing the pick', () => {
        useSketchEditorStore.getState().setActiveTool('drag')
        useSketchEditorStore.getState().setActivePickField({ featureId: 'Sketch1', field: 'plane' })
        useSketchEditorStore.getState().setActivePickField(null)
        expect(useSketchEditorStore.getState().activeTool).toBeNull()  // tool was already cleared when entering pick mode
      })

      // Entering a pick mid-gesture strands the armed brep withhold otherwise:
      // the pending projections survive and the next unrelated mutation gets
      // swallowed as "the projection". Same contract as a tool switch.
      it('cancels an armed brep projection gesture when entering a pick', () => {
        const handler = vi.fn()
        setSketchCallback('onMutation', handler)
        setSketchCallback('getSketch', () => ({}))
        useSketchEditorStore.setState({ activeFeatureId: 'S1' })
        useSketchEditorStore.getState().setActiveTool('dimension')
        useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
        const eid = handler.mock.calls[0][0].entityId
        expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([eid])
        handler.mockClear()

        useSketchEditorStore.getState().setActivePickField({ featureId: 'S1', field: 'plane' })

        // The withheld delete removed the projection with no undo entry and
        // the gesture's pending state is gone.
        expect(handler).toHaveBeenCalledWith({ type: 'delete', targets: [`entity:S1:${eid}`] })
        expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
        expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'S1', field: 'plane' })
        setSketchCallback('getSketch', null)
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

})
