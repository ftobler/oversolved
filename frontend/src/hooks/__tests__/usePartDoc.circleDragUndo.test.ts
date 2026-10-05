// Store-level tests for the circle-rim drag commit path: one undo entry per drag,
// the locked no-op (no junk undo entry), and the checkpoint-cache bypass. No
// canvas, no WASM. Mirrors the wiring in DragTool (it only forwards a non-null
// mutation from computeDragMutation to the store) so the test exercises the real
// usePartDoc commit + undo accounting.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { computeDragMutation } from '@/components/Geometry3D/dragLogic'
import type { PartDoc, Mutation } from '@/types/cad'
import type { VertexOrEdgeDrag } from '@/stores/sketchEditorStore'

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()
const pushUndo = vi.fn()

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
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
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
    solving: false,
    solveError: null,
    setSolveError: vi.fn(),
    solveResult: null,
    featureTimings: {},
    reSolve,
    validation: null,
  }),
}))

vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({
    undoStack: [],
    redoStack: [],
    suppressUndoRef: { current: false },
    pushUndo,
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    saveUndoStackSnapshot: vi.fn(),
    restoreUndoStackSnapshot: vi.fn(),
    clearUndoStackSnapshot: vi.fn(),
  }),
}))

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'circ1', kind: 'circle' }, { id: 'ln1', kind: 'line' }],
        initial: { circ1: [5, 5, 3], ln1: [0, 0, 10, 0] },
        constraints: [],
      },
    ],
  } as unknown as PartDoc
}

function edgeDrag(currentWorld: [number, number]): VertexOrEdgeDrag {
  return {
    type: 'edge',
    vertexId: 'entity:sk1:circ1',
    featureId: 'sk1',
    entityId: 'circ1',
    vertexKey: '',
    startWorld: [0, 0],
    currentWorld,
    startClient: [100, 100],
  } as VertexOrEdgeDrag
}

/** Reproduce the DragTool path: only a non-null computeDragMutation result is
 *  forwarded to the store. Returns the mutation that was (or was not) committed. */
function commitDrag(drag: VertexOrEdgeDrag, lastDragSolve: Parameters<typeof computeDragMutation>[4]) {
  docRef.current = makeDoc()
  const { result } = renderHookStrict(() => usePartDoc('doc1', { solveOnLoad: false }))
  const m = computeDragMutation([200, 200], drag, null, null, lastDragSolve)
  if (m) act(() => { result.current.handleMutation(m as Mutation) })
  return { m, result }
}

describe('circle-rim drag commit accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    docRef.current = null
  })

  it('one radius drag produces exactly one undo entry', () => {
    const { m } = commitDrag(edgeDrag([3, 4]), {
      featureId: 'sk1',
      geometry: { circ1: [5, 5, 7.5] },
      mode: 'radius',
    })
    expect(m?.type).toBe('resize_circle')
    expect(pushUndo).toHaveBeenCalledTimes(1)
  })

  it('undo after a radius drag restores the pre-drag radius', () => {
    const { m } = commitDrag(edgeDrag([3, 4]), {
      featureId: 'sk1',
      geometry: { circ1: [5, 5, 7.5] },
      mode: 'radius',
    })
    expect(m?.type).toBe('resize_circle')
    // The undo entry snapshots the pre-drag doc, which still carries radius 3.
    const preDoc = pushUndo.mock.calls[0][1] as PartDoc
    const preCirc = (preDoc.features as PartDoc['features'])![0].initial!.circ1!
    expect(preCirc[2]).toBe(3)
  })

  it('a locked-mode drag produces no undo entry', () => {
    // A fully constrained circle: computeDragMutation returns null, so the store
    // is never asked to commit and no junk undo entry is recorded (the bug this
    // feature closes).
    const { m } = commitDrag(edgeDrag([3, 4]), { featureId: 'sk1', mode: 'locked' })
    expect(m).toBeNull()
    expect(pushUndo).not.toHaveBeenCalled()
    // The doc is untouched (no mutation reached it).
    if (docRef.current) {
      const circ = (docRef.current.features as PartDoc['features'])![0].initial!.circ1!
      expect(circ[2]).toBe(3)
    }
  })

  it('resize_circle bypasses the checkpoint cache like the other drag commits', () => {
    docRef.current = makeDoc()
    const { result } = renderHookStrict(() => usePartDoc('doc1', { solveOnLoad: false }))
    act(() => {
      result.current.handleMutation({
        type: 'resize_circle',
        featureId: 'sk1',
        entityId: 'circ1',
        radius: 7.5,
        solvedGeometry: { circ1: [5, 5, 7.5] },
      })
    })
    expect(reSolve).toHaveBeenCalledTimes(1)
    const opts = reSolve.mock.calls[0][1] as { bypassCache?: boolean; dragAnchor?: { featureId: string; entityId: string } }
    expect(opts?.bypassCache).toBe(true)
    expect(opts?.dragAnchor).toEqual({ featureId: 'sk1', entityId: 'circ1' })
  })
})
