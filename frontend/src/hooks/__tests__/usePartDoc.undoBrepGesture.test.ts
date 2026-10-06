import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { Mutation } from '@/types/cad'
import {
  docRef, makeSketchDoc, renameTo, labelOf, sketchEntitiesOf, sketchConstraintsOf, resetHarness,
} from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// The brep dimension gesture: a pick arms a withhold so the projection can fold
// into the dimension commit as one undo step, and any other mutation mid-gesture
// steals that arm so the projection is owned by a normal entry chain instead.
describe('usePartDoc undo brep gesture withhold', () => {
  beforeEach(resetHarness)

  it('a two-pick brep dimension is one undo step that drops both projections', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      act(() => { store.addBrepDimensionPick('?b1/edge:2', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(2)

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })

      expect(result.current.undoStack).toHaveLength(1)
      expect(sketchConstraintsOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })

      // One undo removes the dimension and BOTH projections: the second pick
      // must not have replaced the pre-gesture doc the commit restores.
      expect(sketchEntitiesOf()).toHaveLength(0)
      expect(sketchConstraintsOf()).toHaveLength(0)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('an unrelated mutation mid-gesture clears the brep withhold and owns the projection', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      // A tree edit lands between the pick and the commit. It pushes its own
      // entry restoring the CURRENT doc (which carries the projection) and
      // clears the withhold, so the projection is owned by a normal entry chain
      // instead of waiting on a pre-pick doc a later commit cannot see.
      act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect((result.current.undoStack[0].doc.features?.[0] as { entities: unknown[] }).entities).toHaveLength(1)

      // The commit keys to the current doc: its entry restores the projection
      // and the steal, so undo removes only the dimension.
      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect((result.current.undoStack[1].doc.features?.[0] as { entities?: unknown[] }).entities ?? []).toHaveLength(2)

      act(() => { result.current.handleUndo() })

      // The dimension is gone, the projection and the mid-gesture edit survive.
      expect(sketchConstraintsOf()).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(2)

      act(() => { result.current.handleUndo() })

      // The steal reverts and the projection survives owned: no step can
      // re-materialise it alone off a removed pre-pick key.
      expect(sketchEntitiesOf()).toHaveLength(1)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a non-dimension add_constraint mid-gesture clears the withhold instead of consuming it', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      // A geometric add_constraint (coincident) lands between the pick and the
      // commit. It is NOT the brep dimension commit, so it must push its own
      // entry restoring the CURRENT doc (projection included) and clear the
      // withhold, exactly like any other steal. Consuming the withhold here
      // would key an entry to a pre-pick doc the projection can never be
      // restored from.
      act(() => { result.current.handleMutation({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l1:end', 'vertex:sk1:l2:start'] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect((result.current.undoStack[0].doc.features?.[0] as { entities: unknown[] }).entities).toHaveLength(1)

      // The dimension commit now keys to the current doc: undo removes only the
      // dimension, leaving the projection and the geometric constraint.
      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect(sketchConstraintsOf().map(c => c.kind).sort()).toEqual(['coincident', 'length'])
      expect(sketchEntitiesOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })
      expect(sketchConstraintsOf().map(c => c.kind)).toEqual(['coincident'])
      expect(sketchEntitiesOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })
      expect(sketchConstraintsOf()).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a rename-steal mid-gesture undoes per step and never strands the projection', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      // A tree rename steals the gesture mid-flight. It pushes its own entry
      // and clears the withhold, so the commit keys to the current doc instead
      // of a pre-pick doc the steal's own undo has moved past.
      act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'sk1', label: 'renamed' } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect(labelOf()).toBe('renamed')

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect(sketchConstraintsOf()).toHaveLength(1)

      // One undo removes only the dimension: the projection and the rename
      // survive, each owned by their own entry.
      act(() => { result.current.handleUndo() })
      expect(sketchConstraintsOf()).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)
      expect(labelOf()).toBe('renamed')

      // A second undo reverts the rename and keeps the projection as a normal
      // entity: it never re-materialises alone off a removed pre-pick key.
      act(() => { result.current.handleUndo() })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)
      expect(labelOf()).toBeUndefined()
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a brep dimension pick and its OK commit are one undo step', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' }) })

      // The projection is committed to the doc but not to the stack: its entry
      // waits for the dimension commit.
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })

      expect(result.current.undoStack).toHaveLength(1)
      expect(sketchConstraintsOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })

      // One undo removes the dimension and the projection together.
      expect(sketchEntitiesOf()).toHaveLength(0)
      expect(sketchConstraintsOf()).toHaveLength(0)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  // A mid-gesture no-op must still fulfil "the next mutation" contract of an
  // armed withhold (like the suppression branch does), or it strands the arm
  // and the NEXT real mutation gets swallowed as the never-arriving projection.
  it('a mid-gesture no-op rename consumes the brep withhold so a later edit pushes normally', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.beginBrepProjection() })
    // An idempotent rename dispatching its current label changes nothing, so
    // the guard returns early - but the gesture's arm must be consumed here.
    act(() => { result.current.handleMutation(renameTo('first')) })
    expect(result.current.undoStack).toHaveLength(0)

    // The next REAL mutation pushes its own entry instead of being swallowed
    // as "the projection".
    act(() => { result.current.handleMutation(renameTo('second')) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(labelOf()).toBe('second')
  })

  it('a fully no-op mutation group consumes the brep withhold so a later edit pushes normally', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.beginBrepProjection() })
    // A group whose handlers all no-op takes the group early return.
    act(() => { result.current.commitMutationGroup([renameTo('first')]) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.handleMutation(renameTo('second')) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(labelOf()).toBe('second')
  })

  it('cancelling a brep dimension pick removes the projection and its entry', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onCancel!() })

      // The projection is gone and nothing was pushed: no orphan, no stale step.
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(0)

      // The withhold was cleared, so a later edit pushes normally again.
      act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a projection group run while a brep withhold is pending restores the pre-pick doc in one entry', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // A pick armed the withhold; the N-face projection lands through the
    // gesture-group seam instead of the single-mutation funnel. The group must
    // honor the withhold the same way handleMutation does.
    act(() => { result.current.beginBrepProjection() })
    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId: 'p1' },
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:2', entityId: 'p2' },
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:3', entityId: 'p3' },
      ] as Mutation[])
    })

    // The group consumed the arm: no entry yet, the projections wait for the
    // dimension commit like any withheld projection.
    expect(result.current.undoStack).toHaveLength(0)
    expect(sketchEntitiesOf()).toHaveLength(3)

    act(() => {
      result.current.handleMutation({
        type: 'add_constraint', featureId: 'sk1', kind: 'length',
        targets: ['entity:sk1:p1'], value: 10,
      } as Mutation)
    })

    // One entry keyed to the pre-pick doc: undo removes the dimension and all
    // three projections together, nothing is orphaned.
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.features?.[0] as { entities?: unknown[] }).entities ?? []).toHaveLength(0)

    act(() => { result.current.handleUndo() })
    expect(sketchEntitiesOf()).toHaveLength(0)
    expect(sketchConstraintsOf()).toHaveLength(0)
  })

  it('a brep arm made while suppression is on does not leak past the suppression boundary', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    usePartEditorStore.getState().setEditingFeatureId('sk1')

    // A suppressed feature session is the undo owner; a brep pick armed inside
    // it has its projection swallowed without an entry.
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.beginBrepProjection() })
    act(() => {
      result.current.handleMutation({ type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId: 'p1' } as Mutation)
    })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })
    // The session folds into one aggregate and suppression turns off.
    expect(result.current.undoStack).toHaveLength(1)

    // Without the swallow consuming the arm, this unrelated edit would still
    // be swallowed as "the projection" and never earn an entry.
    act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
    expect(result.current.undoStack).toHaveLength(2)
  })
})
