// @vitest-environment jsdom
//
// Undo for the three inline adds. Each one is a single mutation, so the whole
// authored feature (faces and distance, expression, or the helix fields) must
// land in one undo entry and come back to the exact pre-doc in one undo. The
// history-properties suite covers the plain example of every mutation; this
// pins the inline payloads those examples do not carry.
import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import type { PartDoc, Mutation } from '@/types/cad'
import { featureAt } from '@/testing/featureAccess'

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()
let solveResults: Record<string, unknown> = {}

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults,
    setSolveResults: (r: Record<string, unknown>) => { solveResults = r },
    bodies: {}, pickBodies: {}, pickStateReady: false,
    solving: false, solveError: null, setSolveError: vi.fn(),
    solveResult: null, featureTimings: {}, reSolve, validation: null,
  }),
}))

const emptyDoc = (): PartDoc => ({ version: 1, kind: 'part', features: [] } as unknown as PartDoc)

/** Apply one mutation through the real hook; the ref follows every re-render. */
function applyOne(mutation: Mutation) {
  const rendered = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  act(() => { rendered.result.current.handleMutation(mutation) })
  return rendered
}

describe('inline adds are one undo entry each', () => {
  it('move face carries faces and distance in one entry', () => {
    docRef.current = emptyDoc()
    solveResults = {}
    const before = structuredClone(docRef.current)
    const { result } = applyOne({
      type: 'add_move_face', featureId: 'mf1', faces: ['?f1'], distance: 5,
    })
    expect(result.current.undoStack).toHaveLength(1)
    expect(featureAt(docRef.current!, 0, 'move_face').move_face).toEqual({ faces: ['?f1'], distance: 5 })
    act(() => { result.current.handleUndo() })
    expect(JSON.stringify(docRef.current)).toBe(JSON.stringify(before))
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('variable carries its expression in one entry', () => {
    docRef.current = emptyDoc()
    solveResults = {}
    const before = structuredClone(docRef.current)
    const { result } = applyOne({
      type: 'add_variable', featureId: 'v1', label: 'w', expression: '40',
    })
    expect(result.current.undoStack).toHaveLength(1)
    expect(featureAt(docRef.current!, 0, 'variable').variable).toEqual({ expression: '40' })
    act(() => { result.current.handleUndo() })
    expect(JSON.stringify(docRef.current)).toBe(JSON.stringify(before))
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('helix carries its whole placement in one entry', () => {
    docRef.current = emptyDoc()
    solveResults = {}
    const before = structuredClone(docRef.current)
    const { result } = applyOne({
      type: 'add_helix', featureId: 'hx1', reference: '@ex1/face/0',
      mode: 'pitch_turns', pitch: 3, turns: 8, offset: 2,
    })
    expect(result.current.undoStack).toHaveLength(1)
    expect(featureAt(docRef.current!, 0, 'helix').helix).toMatchObject({
      reference: '@ex1/face/0', mode: 'pitch_turns', pitch: 3, turns: 8, offset: 2,
    })
    act(() => { result.current.handleUndo() })
    expect(JSON.stringify(docRef.current)).toBe(JSON.stringify(before))
    expect(result.current.undoStack).toHaveLength(0)
  })
})
