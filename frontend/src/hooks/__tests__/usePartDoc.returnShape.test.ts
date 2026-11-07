// @vitest-environment jsdom
//
// The adapter's return shape is the boundary: a raw doc setter or a raw
// solve-result setter would let a caller write around DocSession (past docRef,
// undo and the dirty decision), which is exactly how the old hook leaked. The
// hook still needs both internally (the doc port and the solve-result port), so
// this pins that they do not come back out.
import { describe, it, expect, vi } from 'vitest'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

describe('the usePartDoc return shape', () => {
  it('exposes no raw doc or solve-result setter and no raw reSolve', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // @ts-expect-error setDoc is not part of the return shape; the session owns the doc
    expect(result.current.setDoc).toBeUndefined()
    // @ts-expect-error setSolveResults is not part of the return shape
    expect(result.current.setSolveResults).toBeUndefined()
    // @ts-expect-error useSolver's reSolve stays behind the session scheduler
    expect(result.current.reSolve).toBeUndefined()

    expect(typeof result.current.requestSolve).toBe('function')
  })
})
