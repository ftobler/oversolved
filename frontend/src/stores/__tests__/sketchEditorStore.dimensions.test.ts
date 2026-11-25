import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback, useSketchUiStore, getSketchCallback } from '@/stores/sketchEditorStore'
import type { Mutation } from '@/types/cad'
import { installSketchStoreSetup } from './helpers/sketchEditorStoreTestSetup'
import { useEditorState } from '@/hooks/useEditorState'
import { dimensionEditorIcon } from '@/stores/dimensionEditor'

describe('sketchEditorStore', () => {
  installSketchStoreSetup()

  describe('dimension sticky placement', () => {
    beforeEach(() => {
      useEditorState.setState({
    activeTool: 'dimension',
    activeFeatureId: 'S1',
    dimensionPicks: [],
    pendingBrepProjectionIds: [],
    normalSelection: new Set(),
    activeOriginLocal: [0, 0],
  })
  useSketchUiStore.setState({
    pendingDialog: null,
  })
    })

    it('addDimensionPick appends', () => {
      useSketchEditorStore.getState().addDimensionPick({
        isVertex: false, target: 'entity:S1:L1', entityKind: 'line',
      })
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
      useSketchEditorStore.getState().addDimensionPick({
        isVertex: false, target: 'entity:S1:L2', entityKind: 'line',
      })
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(2)
    })

    it('addDimensionPick caps at 2 picks (third replaces second)', () => {
      const a = { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }
      const b = { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' }
      const c = { isVertex: true, target: 'vertex:S1:L3:start' }
      useSketchEditorStore.getState().addDimensionPick(a)
      useSketchEditorStore.getState().addDimensionPick(b)
      useSketchEditorStore.getState().addDimensionPick(c)
      const picks = useSketchEditorStore.getState().dimensionPicks
      expect(picks).toHaveLength(2)
      expect(picks[0]).toEqual(a)
      expect(picks[1]).toEqual(c)
    })

    it('addBrepDimensionPick projects a body edge, then dimensions the projection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'circle' })

      expect(handler).toHaveBeenCalledTimes(1)
      const m = handler.mock.calls[0][0]
      expect(m).toMatchObject({ type: 'add_projected_entity', featureId: 'S1', kind: 'circle', source: '?b1/edge:3' })

      const picks = useSketchEditorStore.getState().dimensionPicks
      expect(picks).toEqual([
        { isVertex: false, target: `entity:S1:${m.entityId}`, entityKind: 'circle', source: '?b1/edge:3' },
      ])
      setSketchCallback('getSketch', null)
    })

    it('addBrepDimensionPick projects the same edge once when picked twice before the solve', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))  // the projection has not solved yet
      const pick = () => useSketchEditorStore.getState()
        .addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      pick()
      pick()

      expect(handler).toHaveBeenCalledTimes(1)
      const picks = useSketchEditorStore.getState().dimensionPicks
      expect(picks).toHaveLength(2)
      expect(picks[0].target).toBe(picks[1].target)
      setSketchCallback('getSketch', null)
    })

    it('addBrepDimensionPick reuses a projection the sketch already carries', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        P1: { start: [0, 0], end: [10, 0], projected: true, source: '?b1/edge:3' },
      } as never))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })

      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([
        { isVertex: false, target: 'entity:S1:P1', entityKind: 'line', source: '?b1/edge:3' },
      ])
      setSketchCallback('getSketch', null)
    })

    it('addBrepDimensionPick does nothing outside a sketch', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
    activeFeatureId: null,
  })
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false })
      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    })

    it('opens the editor for the id the applier actually created', () => {
      // A caller id that collided with a live row is substituted by the
      // applier; the editor must address the row that landed, not the one it
      // asked for, or every edit would hit an id that does not exist.
      const handler = vi.fn(() => ({ ok: true, createdIds: ['c_substituted'] }))
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBe('c_substituted')
      useSketchUiStore.getState().pendingDialog!.onConfirm('20')
      expect(handler).toHaveBeenLastCalledWith({
        type: 'set_constraint_value', featureId: 'S1', constraintId: 'c_substituted', value: 20,
      })
      setSketchCallback('getSketch', null)
    })

    it('evaluates a variable expression on confirm and sets the inserted row', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getDoc', () => ({
        kind: 'part',
        features: [
          { id: 'v1', kind: 'variable', label: 'w', variable: { expression: '5' } },
          { id: 'S1', kind: 'sketch' },
        ],
      } as never))
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.validate!('2*w')).toBeNull()
      handler.mockClear()

      dialog.onConfirm('2*w')

      // The placement editor is an expression box: the variable scope is the
      // document's own, the same one a feature field reads.
      expect(handler).toHaveBeenCalledWith({
        type: 'set_constraint_value', featureId: 'S1', constraintId: insert.id, value: 10,
      })
      setSketchCallback('getDoc', null)
      setSketchCallback('getSketch', null)
    })

    it('replacing the second brep pick deletes the orphaned projection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' })
      const id1 = handler.mock.calls[0][0].entityId
      store.addBrepDimensionPick('?b1/edge:2', { isVertexPick: false, sourceKind: 'line' })
      const id2 = handler.mock.calls[1][0].entityId
      handler.mockClear()

      // A third edge replaces the second pick; the second's projection must go.
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })

      const calls = handler.mock.calls.map(c => c[0])
      const deleteCall = calls.find((m: Mutation) => m.type === 'delete') as { targets: string[] } | undefined
      expect(deleteCall).toBeDefined()
      expect(deleteCall!.targets).toEqual([`entity:S1:${id2}`])
      // The orphaned projection is no longer pending cleanup; the replaced and
      // new ones still are.
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).not.toContain(id2)
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([id1, expect.any(String)])
      setSketchCallback('getSketch', null)
    })

    it('replacing a pick that reused a prior gesture\'s projection does not delete it', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // The sketch already carries a projection for edge2, committed by a prior
      // gesture, so picking it reuses instead of projecting.
      setSketchCallback('getSketch', () => ({
        E2: { start: [0, 0], end: [1, 0], projected: true, source: '?b1/edge:2' },
      } as never))
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' })
      const id1 = handler.mock.calls[0][0].entityId
      handler.mockClear()
      store.addBrepDimensionPick('?b1/edge:2', { isVertexPick: false, sourceKind: 'line' })
      expect(handler).not.toHaveBeenCalled()  // reuse emits no projection
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([id1])

      handler.mockClear()
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      // Pick 2 (the reused edge2 projection) is replaced, but it is not owned
      // by this gesture, so no compensating delete may run or the committed
      // dimension that owns it would dangle.
      const deletes = handler.mock.calls.filter(c => (c[0] as Mutation).type === 'delete')
      expect(deletes).toHaveLength(0)
      const pending = useSketchEditorStore.getState().pendingBrepProjectionIds
      expect(pending).toHaveLength(2)  // edge1 and edge3 only
      expect(pending).toContain(id1)
      setSketchCallback('getSketch', null)
    })

    it('cancelling the value dialog cancels the placement', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      const cancelPlacement = vi.fn()
      setSketchCallback('cancelPlacement', cancelPlacement)
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      handler.mockClear()

      dialog.onCancel!()

      // The transaction owns the whole gesture: cancelling it rewinds the
      // projection and the inserted constraint with no compensating delete.
      expect(cancelPlacement).toHaveBeenCalledTimes(1)
      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
      setSketchCallback('getSketch', null)
      setSketchCallback('cancelPlacement', null)
    })

    // The reported bug: the value prompt outlived the gesture abort that
    // cancelled the placement it was measuring. Arm the dimension tool, click a
    // body edge, click empty space (the prompt opens), then click Line in the
    // sketch toolbar. The tool switch cancels the placement with no undo entry,
    // so the prompt must die with it: a later Enter on a surviving prompt would
    // address a constraint the rewind removed.
    it('a tool switch drops the value dialog whose own gesture it cancels', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      const cancelPlacement = vi.fn()
      setSketchCallback('cancelPlacement', cancelPlacement)
      // Arm through the store so the mode stack matches the armed tool.
      useEditorState.setState({
        activeTool: null,
        modeStack: [],
      })
      const store = useSketchEditorStore.getState()
      store.setActiveTool('dimension')
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      store.finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).not.toBeNull()
      cancelPlacement.mockClear()

      useSketchEditorStore.getState().setActiveTool('line')

      // The abort cancelled the placement, and the prompt did not survive it.
      expect(cancelPlacement).toHaveBeenCalledTimes(1)
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
      expect(useSketchUiStore.getState().pendingDialog).toBeNull()

      // The whole sequence dispatched the projection and the insert, and
      // nothing else: no delete chased the rewind.
      expect(handler.mock.calls.map(c => c[0].type)).toEqual(['add_projected_entity', 'add_constraint'])
      setSketchCallback('getSketch', null)
      setSketchCallback('cancelPlacement', null)
    })

    // Same defect by a second door: leaving the sketch is also a gesture abort
    // (setActiveFeatureId cancels the pending placement), and the Viewport
    // keeps the prompt mounted across the editor switch.
    it('leaving the sketch drops the value dialog too', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      setSketchCallback('cancelPlacement', vi.fn())
      useEditorState.setState({
        activeTool: null,
        modeStack: [],
      })
      const store = useSketchEditorStore.getState()
      store.setActiveTool('dimension')
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      store.finalizeDimensionPlacement([0, 0])

      useSketchEditorStore.getState().setActiveFeatureId(null)

      expect(useSketchUiStore.getState().pendingDialog).toBeNull()
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
      expect(handler.mock.calls.map(c => c[0].type)).toEqual(['add_projected_entity', 'add_constraint'])
      setSketchCallback('getSketch', null)
      setSketchCallback('cancelPlacement', null)
    })

    it('committing the dimension clears the placement bookkeeping', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      const commitPlacement = vi.fn()
      setSketchCallback('commitPlacement', commitPlacement)
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      // The projection's solve has landed by the placement click.
      const eid = handler.mock.calls[0][0].entityId
      setSketchCallback('getSketch', () => ({ [eid]: { start: [0, 0], end: [10, 0] } } as never))
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      handler.mockClear()

      dialog.onConfirm('10')

      // The insert already happened; an unchanged confirm only commits the
      // placement, so no second mutation and nothing is pending any more.
      expect(commitPlacement).toHaveBeenCalledTimes(1)
      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
      setSketchCallback('getSketch', null)
      setSketchCallback('commitPlacement', null)
    })

    it('a redundant dimension is authored driven before the insert, with the toggle preset and locked', () => {
      // The dimension tool is the canonical dimension path: the gate runs
      // before the insert, but a redundant measurement is no longer a refusal.
      // It lands driven, with a read-only measured value and no cannot-apply
      // message; the gesture still commits as one placement.
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const gate = vi.fn(() => true)
      setSketchCallback('checkRedundantAdd', gate)
      const messages = vi.fn()
      setSketchCallback('showMessage', messages)
      const cancelPlacement = vi.fn()
      setSketchCallback('cancelPlacement', cancelPlacement)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      expect(gate).toHaveBeenCalledWith({
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
      })
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'],
        value: 10, id: expect.any(String), driven: true,
      })
      expect(messages).not.toHaveBeenCalled()
      expect(cancelPlacement).not.toHaveBeenCalled()
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog).not.toBeNull()
      expect(dialog.toggle).toMatchObject({
        label: 'Driven', value: true, locked: true,
        hint: 'Already set by the existing constraints; this dimension can only measure.',
      })
      expect(dialog.defaultValue).toBe('10')
      handler.mockClear()
      dialog.onConfirm('10')
      expect(handler).not.toHaveBeenCalled()
      setSketchCallback('getSketch', null)
      setSketchCallback('checkRedundantAdd', null)
      setSketchCallback('showMessage', null)
      setSketchCallback('cancelPlacement', null)
    })

    it('a free dimension opens with the toggle off; turning it on commits it driven with the measured value', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('checkRedundantAdd', () => false)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.toggle).toMatchObject({ label: 'Driven', value: false, locked: false })
      handler.mockClear()
      dialog.toggle!.onChange!(true)
      expect(handler).toHaveBeenCalledWith({
        type: 'set_constraint_driven', featureId: 'S1', constraintId: expect.any(String),
        driven: true, value: 10,
      })
      // The measured box is read-only in the dialog, so confirming edits no
      // value: the toggle is the only authoring that happened.
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledTimes(1)
      setSketchCallback('getSketch', null)
      setSketchCallback('checkRedundantAdd', null)
    })

    it('hands the gate the label pos the placement collected, and inserts on a false answer', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const gate = vi.fn(() => false)
      setSketchCallback('checkRedundantAdd', gate)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      // The probe sees exactly what the mutation carries (pos relative to the
      // dim anchor), so it judges the dimension that is about to land.
      expect(gate).toHaveBeenCalledWith({
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10, pos: [0, 7],
      })
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'],
        value: 10, pos: [0, 7], id: expect.any(String),
      })
      // The prompt opens for that exact id.
      expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId)
        .toBe((handler.mock.calls[0][0] as { id: string }).id)
      setSketchCallback('getSketch', null)
      setSketchCallback('checkRedundantAdd', null)
    })

    it('a redundant projected dimension becomes a driven dimension on the landed projection', () => {
      // The projection is no longer scratch work for a refused gesture: the
      // dimension lands on it as a driven reference, in the one placement entry.
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('checkRedundantAdd', () => true)
      const messages = vi.fn()
      setSketchCallback('showMessage', messages)
      const cancelPlacement = vi.fn()
      setSketchCallback('cancelPlacement', cancelPlacement)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      handler.mockClear()
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      const insert = handler.mock.calls.find(([m]) => m.type === 'add_constraint')?.[0]
      expect(insert).toMatchObject({ type: 'add_constraint', driven: true, kind: 'length' })
      expect(messages).not.toHaveBeenCalled()
      expect(cancelPlacement).not.toHaveBeenCalled()
      expect(useSketchUiStore.getState().pendingDialog?.toggle?.value).toBe(true)
      // The projection id stays pending until the dialog commits the gesture,
      // exactly as for a driving dimension.
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds.length).toBe(1)
      setSketchCallback('getSketch', null)
      setSketchCallback('checkRedundantAdd', null)
      setSketchCallback('showMessage', null)
      setSketchCallback('cancelPlacement', null)
    })

    it('a second brep pick after an insert banks the placement and clears its bookkeeping', () => {
      // The commit in finalize leaves the projection id pending and the prompt
      // open. Starting a new brep pick must resolve that gesture first: a later
      // delete must not remove the now-committed projection, and the stale
      // prompt must not confirm a second entry.
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const commitPlacement = vi.fn()
      setSketchCallback('commitPlacement', commitPlacement)
      setSketchCallback('getSketch', () => ({}))
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      const eid = handler.mock.calls[0][0].entityId
      store.finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([eid])
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).not.toBeNull()
      // Once the insert commits, the projection is solved on the sketch, so a
      // second pick of the same edge reuses it instead of projecting again.
      setSketchCallback('getSketch', () => ({
        [eid]: { start: [0, 0], end: [1, 0], projected: true, source: '?b1/edge:3' },
      } as never))
      handler.mockClear()

      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })

      expect(commitPlacement).toHaveBeenCalledTimes(1)
      expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      expect(useSketchUiStore.getState().pendingDialog).toBeNull()
      // The banked projection is not deleted: the new pick reused it.
      expect(handler).not.toHaveBeenCalled()
      setSketchCallback('getSketch', null)
      setSketchCallback('commitPlacement', null)
    })

    it('a projected body edge dimensions as a length once solved', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        P1: { start: [0, 0], end: [7, 0], projected: true, source: '?b1/edge:3' },
      } as never))
      // Clicking the same edge twice is the same-entity path to a length dim.
      const store = useSketchEditorStore.getState()
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('7')
      dialog.onConfirm('7')
      expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'add_constraint', kind: 'length', targets: ['entity:S1:P1'],
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalize adopts the solved kind of a projection the lowerer promoted', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // The tilted body circle was picked as 'circle'; the solve lowered it to
      // an ellipse, which has no dimension rule -- the dim must not resolve as
      // a diameter against geometry that has no radius.
      setSketchCallback('getSketch', () => ({
        P1: { center: [0, 0], a: 2, b: 1, theta: 0, projected: true, source: '?b1/edge:3' },
      } as never))
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:P1', entityKind: 'circle' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog).toBeNull()
      setSketchCallback('getSketch', null)
    })

    it('clearDimensionPicks resets to empty', () => {
      useEditorState.setState({
    dimensionPicks: [
        { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
      ],
  })
      useSketchEditorStore.getState().clearDimensionPicks()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    })

    it('finalizeDimensionPlacement: inserts on the click, then OK edits the inserted row', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([200, 300])

      // The insert lands with the click, before any confirm: one mutation with
      // a caller id and the measured value.
      expect(handler).toHaveBeenCalledTimes(1)
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(insert).toMatchObject({
        type: 'add_constraint', featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'],
      })
      expect(insert.id).toEqual(expect.any(String))

      const dialog = useSketchUiStore.getState().pendingDialog
      expect(dialog).not.toBeNull()
      // The constraint's own prompt label, the same words a double-click shows,
      // and the dimension tool's glyph for a linear size.
      expect(dialog!.label).toBe('dimension')
      expect(dialog!.icon).toBe(dimensionEditorIcon('length'))
      expect(dialog!.position).toEqual([200, 300])
      // Picks are dropped at insertion so a second click can't double-fire.
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])

      dialog!.onConfirm('42')
      expect(handler).toHaveBeenLastCalledWith({
        type: 'set_constraint_value', featureId: 'S1', constraintId: insert.id, value: 42,
      })
    })

    it('finalizeDimensionPlacement: two lines insert an angle, then OK edits it', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
          { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
        ],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(insert).toMatchObject({
        type: 'add_constraint', featureId: 'S1', kind: 'angle',
        targets: ['entity:S1:L1', 'entity:S1:L2'],
      })
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.label).toBe('angle in degrees')
      // The angular dimension is the one kind with its own editor glyph.
      expect(dialog.icon).toBe(dimensionEditorIcon('angle'))
      dialog.onConfirm('45')
      expect(handler).toHaveBeenLastCalledWith({
        type: 'set_constraint_value', featureId: 'S1', constraintId: insert.id, value: 45,
      })
    })

    it('finalizeDimensionPlacement: the fresh box states the unit it will author', () => {
      // The placement prompt is the first editor a new dimension gets, so it must
      // state mm/deg like the double-click editor does. A length is the default;
      // the two-line angle is the only angular kind.
      setSketchCallback('onMutation', vi.fn())
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog!.quantity).toBe('length')
      useSketchUiStore.setState({ pendingDialog: null })

      useEditorState.setState({
    dimensionPicks: [
          { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
          { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
        ],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog!.quantity).toBe('angle')
    })

    it('finalizeDimensionPlacement: a supplement-wedge label inserts and edits the displayed number', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // The bug-1 trapezoid corner: the stored directions make theta 135 and the
      // corner drawn at the vertex is its supplement, 45. A click in that wedge
      // must insert 45 with the label pos; the applier stores theta.
      setSketchCallback('getSketch', () => ({
        L1: { start: [2.5, 0], end: [6.5, 0] },
        L2: { start: [6.5, 0], end: [6, 0.5] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
          { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
        ],
        dimensionCursorWorld: [5.5, 0.5],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(Number(insert.value)).toBeCloseTo(45, 6)
      expect(insert.pos?.[0]).toBeCloseTo(-1, 6)
      expect(insert.pos?.[1]).toBeCloseTo(0.5, 6)
      expect(Number(dialog.defaultValue)).toBeCloseTo(45, 6)

      // Accepting the pre-filled number changes nothing: the exact stored theta
      // survives because no set is dispatched.
      handler.mockClear()
      dialog.onConfirm(dialog.defaultValue!)
      expect(handler).not.toHaveBeenCalled()

      // Typing 40 in the same wedge carries 40, not 140.
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
          { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
        ],
        dimensionCursorWorld: [5.5, 0.5],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const second = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      useSketchUiStore.getState().pendingDialog!.onConfirm('40')
      expect(handler).toHaveBeenLastCalledWith({
        type: 'set_constraint_value', featureId: 'S1', constraintId: second.id, value: 40,
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: same-line twice deduplicates targets to one (length)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const pick = { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }
      useEditorState.setState({
        dimensionPicks: [pick, pick],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'add_constraint', featureId: 'S1', kind: 'length',
        targets: ['entity:S1:L1'],
      }))
      useSketchUiStore.getState().pendingDialog!.onConfirm('10')
      expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'set_constraint_value', value: 10,
      }))
    })

    it('finalizeDimensionPlacement: vertex alone is undimensionable, no dialog opens', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
    dimensionPicks: [{ isVertex: true, target: 'vertex:S1:L1:start' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog).toBeNull()
      // Picks are preserved so the user can keep adding without restarting.
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: refuses to insert without the dialog port', () => {
      // The prompt is the gesture's other half; without it the insert would
      // leave a dimension nobody can edit behind an open placement.
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const beginPlacement = vi.fn()
      setSketchCallback('beginPlacement', beginPlacement)
      const openDialog = getSketchCallback('openDialog')
      setSketchCallback('openDialog', null)
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        pendingPlacementConstraintId: null,
      })
      try {
        // The loud refusal is dev/test only; in every build the insert and the
        // placement begin are behind it.
        expect(() => useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0]))
          .toThrow(/openDialog port/)

        expect(handler).not.toHaveBeenCalled()
        expect(beginPlacement).not.toHaveBeenCalled()
        expect(useSketchUiStore.getState().pendingDialog).toBeNull()
        expect(useSketchEditorStore.getState().pendingPlacementConstraintId).toBeNull()
      } finally {
        setSketchCallback('openDialog', openDialog)
        setSketchCallback('beginPlacement', null)
      }
    })

    it('finalizeDimensionPlacement: empty picks is a no-op', () => {      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
    dimensionPicks: [],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog).toBeNull()
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: a dialog Cancel dispatches no editing mutation', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const cancelPlacement = vi.fn()
      setSketchCallback('cancelPlacement', cancelPlacement)
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(handler).toHaveBeenCalledTimes(1)
      handler.mockClear()

      useSketchUiStore.getState().pendingDialog!.onCancel!()

      // Cancel is the transaction's rewind, not a mutation: nothing new lands.
      expect(handler).not.toHaveBeenCalled()
      expect(cancelPlacement).toHaveBeenCalledTimes(1)
      setSketchCallback('cancelPlacement', null)
    })

    it('finalizeDimensionPlacement: OK keeps the tool armed for the next dim', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      dialog.onConfirm('5')
      expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
    })

    it('finalizeDimensionPlacement: dialog defaultValue is the natural measurement', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog!.defaultValue).toBe('10')
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement measures an origin dimension from the live sketch origin', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        PT: { x: 7, y: 1 },
      } as never))
      useEditorState.setState({
        activeOriginLocal: [5, -2],
        dimensionPicks: [
          { isVertex: true, target: '@builtin_origin' },
          { isVertex: true, target: 'vertex:S1:PT:xy' },
        ],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      // PT (7,1) to the face origin (5,-2): hypot(2,3), not hypot(7,1) from the
      // plane's local origin. The insert carries the exact measured value; the
      // box shows its five-decimal form.
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'point_distance',
        targets: ['@builtin_origin', 'vertex:S1:PT:xy'],
        value: Math.hypot(2, 3),
      }))
      expect(Number(dialog.defaultValue)).toBeCloseTo(Math.hypot(2, 3), 5)
      // Unchanged confirm keeps the exact value: no set is dispatched.
      handler.mockClear()
      dialog.onConfirm(dialog.defaultValue!)
      expect(handler).not.toHaveBeenCalled()
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: the insert carries the exact measured value and an unchanged confirm writes nothing', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // Length 12.3456 -> the box shows five decimals; the document keeps the
      // exact measurement from the insert.
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [12.3456, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(insert.value).toBe(12.3456)
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('12.3456')
      // Submitting the default unchanged is the commit, not a second write.
      handler.mockClear()
      dialog.onConfirm(dialog.defaultValue!)
      expect(handler).not.toHaveBeenCalled()
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: editing the default commits the typed value', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [12.3456, 0] },
      } as never))
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchUiStore.getState().pendingDialog!.onConfirm('20')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ value: 20 }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: dialog.validate rejects non-numeric and non-positive input', () => {
      setSketchCallback('onMutation', vi.fn())
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const validate = useSketchUiStore.getState().pendingDialog!.validate!
      expect(validate('abc')).toBeTruthy()
      expect(validate('0')).toBeTruthy()
      expect(validate('-3')).toBeTruthy()
      expect(validate('5')).toBeNull()
    })

    it('finalizeDimensionPlacement: no getSketch → dialog opens with no default', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', null)
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchUiStore.getState().pendingDialog!.defaultValue).toBeUndefined()
    })

    it('finalizeDimensionPlacement: writes pos relative to the dim anchor when cursorWorld is set', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      // Length anchor = midpoint(L1) = (5, 0). Pos = world - anchor = (0, 7).
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
        pos: [0, 7], id: expect.any(String),
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: omits pos when no cursorWorld', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: null,
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
        id: expect.any(String),
      })
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(insert).not.toHaveProperty('pos')
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: clears cursorWorld together with picks', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
    dimensionCursorWorld: [1, 2],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().dimensionCursorWorld).toBeNull()
    })

    it('finalizeDimensionPlacement: a press point on the line inserts a zero offset, not the default', () => {
      // The reported gesture: the line is picked by a click, then the
      // placement click lands right on the line with no move in between. The
      // press itself records dimensionCursorWorld (Drawing.tsx), so the insert
      // must carry it instead of falling back to the renderer's far offset.
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: [2, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([200, 300])
      // Length anchor = midpoint(L1) = (5, 0), so the press point is 3 left of
      // it. A zero y offset is still a real pos and must survive the insert.
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
        pos: [-3, 0], id: expect.any(String),
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: an unresolvable pick clears the placement cursor', () => {
      // A vertex alone resolves no dimension. The placement point belonged to
      // that abandoned attempt; keeping it would place the next dim at an old
      // cursor point, the stale-value half of the same bug.
      useEditorState.setState({
    dimensionPicks: [{ isVertex: true, target: 'vertex:S1:L1:start' }],
    dimensionCursorWorld: [5, 7],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([100, 100])
      expect(useSketchEditorStore.getState().dimensionCursorWorld).toBeNull()
      // The picks survive so the user can add the target the dim is missing.
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
    })

    // ─── point_distance mode switching ───
    // Two-vertex picks with a placementWorld offset switch the constraint kind:
    //   vertical drag → point_distance_x, horizontal drag → point_distance_y

    it('finalizeDimensionPlacement: two vertices with vertical drag switch to point_distance_x', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      // Vertical drag (y offset > x offset) -> point_distance_x. The measured
      // x distance is the line's own length, so the insert already carries it.
      expect(insert).toMatchObject({
        featureId: 'S1', kind: 'point_distance_x',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L1:end'],
        value: 10,
      })
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('10')
      handler.mockClear()
      dialog.onConfirm('10')
      expect(handler).not.toHaveBeenCalled()
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices with horizontal drag switch to point_distance_y', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [12, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      // Horizontal drag (x offset > y offset) -> point_distance_y
      expect(insert).toMatchObject({
        featureId: 'S1', kind: 'point_distance_y',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L1:end'],
      })
      useSketchUiStore.getState().pendingDialog!.onConfirm('10')
      expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'set_constraint_value', constraintId: insert.id, value: 10,
      }))
      setSketchCallback('getSketch', null)
    })

    it('a zero euclidean distance is refused before the insert with the coincident hint', () => {
      // A zero measured distance is a coincident, not a dimension: the row has
      // no direction there, so the placement gate refuses it before any
      // mutation exists and the user reads why.
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const messages = vi.fn()
      setSketchCallback('showMessage', messages)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [0, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [0, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])

      expect(handler).not.toHaveBeenCalled()
      expect(messages).toHaveBeenCalledWith({
        title: 'Cannot apply constraint',
        message: expect.stringContaining('coincident'),
        variant: 'error',
      })
      expect(useSketchUiStore.getState().pendingDialog).toBeNull()
      setSketchCallback('getSketch', null)
      setSketchCallback('showMessage', null)
    })

    it('the placement validate accepts zero for the zero-legal dimension kinds', () => {
      // The axis distances are authored here (a vertical or horizontal drag
      // switches the kind) and the radial gap comes from two curve picks. Their
      // analytic rows make 0 a real constraint, so the dialog must not refuse it.
      setSketchCallback('onMutation', vi.fn())
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
    dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
    dimensionCursorWorld: [5, 7],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      let dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.validate!('0')).toBeNull()
      expect(dialog.validate!('-1')).toBe('Value refused: must be 0 or more')
      useSketchUiStore.setState({ pendingDialog: null })

      useEditorState.setState({
    dimensionPicks: [
          { isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' },
          { isVertex: false, target: 'entity:S1:C2', entityKind: 'circle' },
        ],
    dimensionCursorWorld: null,
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.validate!('0')).toBeNull()
      expect(dialog.validate!('-1')).toBe('Value refused: must be 0 or more')
      useSketchUiStore.setState({ pendingDialog: null })
      setSketchCallback('getSketch', null)
    })

    it('flips a placed directional dimension and commits it', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      const commitPlacement = vi.fn()
      setSketchCallback('commitPlacement', commitPlacement)
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(insert.sign).toBe(1)
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.extraAction?.label).toBe('Flip side')

      dialog.extraAction!.onClick()

      expect(handler).toHaveBeenLastCalledWith({
        type: 'set_constraint_sign', featureId: 'S1', constraintId: insert.id, sign: -1,
      })
      // The prompt closes on the flip, so the placement commits with it rather
      // than staying open behind a dismissed dialog.
      expect(commitPlacement).toHaveBeenCalledTimes(1)
      setSketchCallback('getSketch', null)
      setSketchCallback('commitPlacement', null)
    })

    it('finalizeDimensionPlacement: two vertices with no clear direction stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        // cursor exactly at midpoint: no clear direction
        dimensionCursorWorld: [5, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const insert = handler.mock.calls[0][0] as Extract<Mutation, { type: 'add_constraint' }>
      expect(insert).toMatchObject({
        featureId: 'S1', kind: 'point_distance', value: 10,
      })
      const dialog = useSketchUiStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('10')
      handler.mockClear()
      dialog.onConfirm('10')
      expect(handler).not.toHaveBeenCalled()
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices without getSketch stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useEditorState.setState({
    dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
    dimensionCursorWorld: [5, 7],
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      dialog.onConfirm('10')
      // No getSketch → no point resolution → stays point_distance
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
    })

    it('finalizeDimensionPlacement: two vertices without cursorWorld stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useEditorState.setState({
    dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
    dimensionCursorWorld: null,
  })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchUiStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
      setSketchCallback('getSketch', null)
    })
  })

})
