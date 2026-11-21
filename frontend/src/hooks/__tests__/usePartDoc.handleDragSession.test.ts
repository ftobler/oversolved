// @vitest-environment jsdom
//
// A feature-handle drag now sends live field mutations through the newest-value
// pump while the edit session is open. This pins the session half of that: the
// live mutations and the release still make ONE undo entry on OK, Cancel
// rewinds every one of them, and a drag that ends back on its start value is a
// clean no-op. The release is modelled the way FeatureHandles does it: cancel
// the pump and send the final value at once, so it lands before OK or Cancel
// can close the session.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { createLiveValuePump } from '@/components/Geometry3D/liveValuePump'
import type { PartDoc } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { featureAt } from '@/testing/featureAccess'

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: vi.fn(),
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    loading: false,
    error: null,
    setError: vi.fn(),
    setLoadFailure: vi.fn(),
    loadFailure: null,
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
    cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {},
    setSolveResults: vi.fn(),
    bodies: {},
    pickBodies: {},
    pickStateReady: true,
    solving: false,
    solveError: null,
    setSolveError: vi.fn(),
    featureTimings: {},
    reSolve,
    validation: null,
    generation: 0,
    measureSet: null,
  }),
}))

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', entities: [], initial: {}, constraints: [] },
      {
        id: 'ex1',
        kind: 'extrude',
        extrude: { sketch: '@sk1', distance: 10, direction: 'normal' },
      },
    ],
  } as unknown as PartDoc
}

function distance(): unknown {
  return featureAt(docRef.current!, 1, 'extrude').extrude.distance
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** The live mutation sink Part.tsx registers: the mutation, then its solve. */
function makePump(result: { current: ReturnType<typeof usePartDoc> }) {
  return createLiveValuePump(value => {
    result.current.handleMutation({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value })
    return result.current.session.idle()
  })
}

describe('a live handle drag inside the edit session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    docRef.current = makeDoc()
    useEditorState.getState().setEditingFeatureId(null)
    useUnsavedChangesStore.setState({ dirty: false, saves: 0, savedHash: null })
  })

  function openExtrudeEdit() {
    const rendered = renderHookStrict(() => usePartDoc('doc1', { solveOnLoad: false }))
    useEditorState.getState().setEditingFeatureId('ex1')
    act(() => { rendered.result.current.startEditSession(true) })
    return rendered
  }

  it('OK after a live drag keeps the released value and is one undo entry', async () => {
    const gate = deferred()
    reSolve.mockReturnValue(gate.promise)
    const { result } = openExtrudeEdit()
    const pump = makePump(result)

    // The first live value goes out; the rest only replace the waiting value.
    act(() => pump.offer(12))
    act(() => pump.offer(18))
    act(() => pump.offer(25))
    expect(distance()).toBe(12)

    // Release at 25: the final value lands at once, before the first solve
    // settles.
    act(() => {
      pump.cancel()
      result.current.handleMutation({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 25 })
    })
    expect(distance()).toBe(25)

    await act(async () => {
      gate.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => { result.current.commitEditSession() })
    expect(distance()).toBe(25)
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleUndo() })
    expect(distance()).toBe(10)
  })

  it('Cancel rewinds every live value and leaves the document clean', () => {
    const { result } = openExtrudeEdit()
    const pump = makePump(result)

    act(() => pump.offer(12))
    act(() => pump.offer(25))
    act(() => {
      pump.cancel()
      result.current.handleMutation({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 25 })
    })
    expect(distance()).toBe(25)

    act(() => { result.current.cancelEditSession() })
    expect(distance()).toBe(10)
    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a drag back to the start value then OK is a clean no-op', () => {
    const { result } = openExtrudeEdit()
    const pump = makePump(result)

    act(() => pump.offer(12))
    // Back on the start value: the release sends it, putting the doc exactly
    // back where the session began.
    act(() => {
      pump.cancel()
      result.current.handleMutation({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 10 })
    })
    expect(distance()).toBe(10)

    act(() => { result.current.commitEditSession() })
    expect(distance()).toBe(10)
    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })
})
