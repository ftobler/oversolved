// Undo/redo for the boolean clearance field. `set_boolean_field` already carries
// any key of BooleanFeatureDef, so clearance needs no new mutation; this pins the
// two things that could regress: it is exactly one undo entry, and an absent
// clearance round-trips back to ABSENT (not 0).
import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import type { PartDoc, Mutation } from '@/types/cad'

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

const booleanDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{
    id: 'b1', kind: 'boolean', label: 'Boolean',
    boolean: { operation: 'subtract', target: '@b0', tools: ['@t1'] },
  }],
} as unknown as PartDoc)

const setClearance = (value: unknown): Mutation =>
  ({ type: 'set_boolean_field', featureId: 'b1', field: 'clearance', value } as Mutation)

describe('boolean clearance undo', () => {
  it('sets clearance as one undo entry and restores the exact pre-doc', () => {
    docRef.current = booleanDoc()
    solveResults = {}
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const before = structuredClone(docRef.current)

    act(() => { result.current.handleMutation(setClearance(0.1)) })
    const sub = (docRef.current!.features![0] as unknown as { boolean: Record<string, unknown> }).boolean
    expect(sub.clearance).toBe(0.1)
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleUndo() })
    expect(JSON.stringify(docRef.current)).toBe(JSON.stringify(before))
    const restored = (docRef.current!.features![0] as unknown as { boolean: Record<string, unknown> }).boolean
    // Absent, not 0: the field was absent before the edit.
    expect('clearance' in restored).toBe(false)
    expect(result.current.undoStack).toHaveLength(0)
  })
})
