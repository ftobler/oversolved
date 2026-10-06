import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { Mutation } from '@/types/cad'
import { installSketchStoreSetup } from './helpers/sketchEditorStoreTestSetup'

describe('sketchEditorStore', () => {
  installSketchStoreSetup()

  describe('dimension sticky placement', () => {
    beforeEach(() => {
      useSketchEditorStore.setState({
        activeTool: 'dimension',
        activeFeatureId: 'S1',
        dimensionPicks: [],
        pendingBrepProjectionIds: [],
        pendingDialog: null,
        normalSelection: new Set(),
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
      useSketchEditorStore.setState({ activeFeatureId: null })
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false })
      expect(handler).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
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

    it('cancelling the value dialog deletes the pending projection', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      const eid = handler.mock.calls[0][0].entityId
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      handler.mockClear()

      dialog.onCancel!()

      expect(handler).toHaveBeenCalledWith({ type: 'delete', targets: [`entity:S1:${eid}`] })
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      setSketchCallback('getSketch', null)
    })

    it('committing the dimension clears the pending projections', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({}))
      useSketchEditorStore.getState().addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      handler.mockClear()

      dialog.onConfirm('10')

      // The projection is now part of the committed dimension, so nothing is
      // pending cleanup any more.
      expect(useSketchEditorStore.getState().pendingBrepProjectionIds).toEqual([])
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'add_constraint' }))
      setSketchCallback('getSketch', null)
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

      const dialog = useSketchEditorStore.getState().pendingDialog!
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
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:P1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
      setSketchCallback('getSketch', null)
    })

    it('clearDimensionPicks resets to empty', () => {
      useSketchEditorStore.setState({ dimensionPicks: [
        { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
      ] })
      useSketchEditorStore.getState().clearDimensionPicks()
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    })

    it('finalizeDimensionPlacement: single line → dialog opens; OK dispatches add_constraint(length)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([200, 300])

      const dialog = useSketchEditorStore.getState().pendingDialog
      expect(dialog).not.toBeNull()
      expect(dialog!.label).toBe('Dimension value')
      expect(dialog!.position).toEqual([200, 300])
      // Picks are dropped immediately so a second click can't double-fire.
      expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])

      dialog!.onConfirm('42')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 42,
      })
    })

    it('finalizeDimensionPlacement: two lines → angle on OK', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
          { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
        ],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('45')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'angle',
        targets: ['entity:S1:L1', 'entity:S1:L2'], value: 45,
      })
    })

    it('finalizeDimensionPlacement: same-line twice deduplicates targets to one (length)', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      const pick = { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }
      useSketchEditorStore.setState({ dimensionPicks: [pick, pick] })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint', featureId: 'S1', kind: 'length',
        targets: ['entity:S1:L1'], value: 10,
      })
    })

    it('finalizeDimensionPlacement: vertex alone is undimensionable, no dialog opens', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: true, target: 'vertex:S1:L1:start' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
      // Picks are preserved so the user can keep adding without restarting.
      expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: empty picks is a no-op', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({ dimensionPicks: [] })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: Cancel (dialog onConfirm not called) dispatches nothing', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().closeDialog()
      expect(handler).not.toHaveBeenCalled()
    })

    it('finalizeDimensionPlacement: OK keeps the tool armed for the next dim', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('5')
      expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
    })

    it('finalizeDimensionPlacement: dialog defaultValue is the natural measurement', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog!.defaultValue).toBe('10')
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: accepting the rounded default commits the exact measured value', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      // Length 12.345... -> default displays rounded to 2 decimals.
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [12.3456, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      expect(dialog.defaultValue).toBe('12.35')
      // Submitting the default unchanged commits the full-precision value, not 12.35.
      dialog.onConfirm(dialog.defaultValue!)
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ value: 12.3456 }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: editing the default commits the typed value', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [12.3456, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().pendingDialog!.onConfirm('20')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ value: 20 }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: dialog.validate rejects non-numeric and non-positive input', () => {
      setSketchCallback('onMutation', vi.fn())
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const validate = useSketchEditorStore.getState().pendingDialog!.validate!
      expect(validate('abc')).toBeTruthy()
      expect(validate('0')).toBeTruthy()
      expect(validate('-3')).toBeTruthy()
      expect(validate('5')).toBeNull()
    })

    it('finalizeDimensionPlacement: no getSketch → dialog opens with no default', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().pendingDialog!.defaultValue).toBeUndefined()
    })

    it('finalizeDimensionPlacement: writes pos relative to the dim anchor when cursorWorld is set', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: [5, 7],  // 5 along the line, 7 above it
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().pendingDialog!.onConfirm('10')
      // Length anchor = midpoint(L1) = (5, 0). Pos = world - anchor = (0, 7).
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
        pos: [0, 7],
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: omits pos when no cursorWorld', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
        dimensionCursorWorld: null,
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      useSketchEditorStore.getState().pendingDialog!.onConfirm('10')
      expect(handler).toHaveBeenCalledWith({
        type: 'add_constraint',
        featureId: 'S1', kind: 'length', targets: ['entity:S1:L1'], value: 10,
      })
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: clears cursorWorld together with picks', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [{ isVertex: false, target: 'entity:S1:C1', entityKind: 'circle' }],
        dimensionCursorWorld: [1, 2],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      expect(useSketchEditorStore.getState().dimensionCursorWorld).toBeNull()
    })

    // ─── point_distance mode switching ───
    // Two-vertex picks with a placementWorld offset switch the constraint kind:
    //   vertical drag → point_distance_x, horizontal drag → point_distance_y

    it('finalizeDimensionPlacement: two vertices with vertical drag switches to point_distance_x', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      // Vertical drag (y offset > x offset) → point_distance_x
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance_x',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L1:end'], value: 10,
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices with horizontal drag switches to point_distance_y', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [12, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      // Horizontal drag (x offset > y offset) → point_distance_y
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance_y',
        targets: ['vertex:S1:L1:start', 'vertex:S1:L1:end'], value: 10,
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices with no clear direction stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      setSketchCallback('getSketch', () => ({
        L1: { start: [0, 0], end: [10, 0] },
      } as never))
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        // cursor exactly at midpoint: no clear direction
        dimensionCursorWorld: [5, 0],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
      setSketchCallback('getSketch', null)
    })

    it('finalizeDimensionPlacement: two vertices without getSketch stays point_distance', () => {
      const handler = vi.fn()
      setSketchCallback('onMutation', handler)
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: [5, 7],
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
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
      useSketchEditorStore.setState({
        dimensionPicks: [
          { isVertex: true, target: 'vertex:S1:L1:start' },
          { isVertex: true, target: 'vertex:S1:L1:end' },
        ],
        dimensionCursorWorld: null,
      })
      useSketchEditorStore.getState().finalizeDimensionPlacement([0, 0])
      const dialog = useSketchEditorStore.getState().pendingDialog!
      dialog.onConfirm('10')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'S1', kind: 'point_distance',
      }))
      setSketchCallback('getSketch', null)
    })
  })

})
