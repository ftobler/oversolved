import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'

const { mockSolveLocally } = vi.hoisted(() => ({
  mockSolveLocally: vi.fn(),
}))

const { mockUnflattenGeometry } = vi.hoisted(() => ({
  mockUnflattenGeometry: vi.fn().mockReturnValue({}),
}))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveLocally }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: mockUnflattenGeometry }))

import { pickPartColor, reconcilePartStyle, useSolver } from '@/hooks/useSolver'
import { PART_COLOR_PALETTE } from '@/utils/core/partColors'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSolverStore } from '@/stores/solverStore'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import type { WorkspaceSession } from '@/workspace/session'
import type { PartDoc, BodyResult } from '@/types/cad'

function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { oversolved: 1, kind: 'part', features: [], ...overrides }
}

// A doc with one (ported) feature, so reSolve routes through the local kernel
// instead of the empty-doc early return.
function solvableDoc(overrides?: Partial<PartDoc>): PartDoc {
  return makeDoc({ features: [{ id: 'feat1', kind: 'sketch', entities: [] }], ...overrides })
}

function makeBody(id: string, overrides?: Partial<BodyResult>): BodyResult {
  return { id, created_by: `feature_${id}`, modified_by: [], ...overrides }
}

describe('pickPartColor', () => {
  it('cycles through palette colors', () => {
    const colors = new Set<string>()
    for (let i = 1; i <= PART_COLOR_PALETTE.length; i++) {
      colors.add(pickPartColor(i))
    }
    expect(colors.size).toBe(PART_COLOR_PALETTE.length)
  })

  it('wraps around after palette length', () => {
    expect(pickPartColor(1)).toBe(pickPartColor(PART_COLOR_PALETTE.length + 1))
  })

  it('returns consistent color for same part number', () => {
    expect(pickPartColor(5)).toBe(pickPartColor(5))
  })
})

describe('reconcilePartStyle', () => {
  it('assigns names and colors to new bodies', () => {
    const doc = makeDoc()
    const bodies = { a: makeBody('a'), b: makeBody('b') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.a?.name).toBe('part 1')
    expect(doc.part_style?.a?.color).toBe(PART_COLOR_PALETTE[0])
    expect(doc.part_style?.b?.name).toBe('part 2')
    expect(doc.part_style?.b?.color).toBe(PART_COLOR_PALETTE[1])
  })

  it('preserves existing body names and colors', () => {
    const doc = makeDoc({ part_style: { a: { name: 'custom', color: '#FF0000' } } })
    const bodies = { a: makeBody('a'), b: makeBody('b') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.a?.name).toBe('custom')
    expect(doc.part_style?.a?.color).toBe('#FF0000')
    expect(doc.part_style?.b?.name).toBe('part 1')
  })

  it('does not normalize existing entry colors (solve path is pure)', () => {
    // Normalizing would rewrite an authored color on every solve, invisible to
    // undo. The reconcile only adds entries for bodies it has never seen.
    const doc = makeDoc({ part_style: { a: { name: 'part 1', color: '#abcabc' } } })
    const bodies = { a: makeBody('a') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.a?.color).toBe('#abcabc')
  })

  it('leaves invalid hex colors as-is', () => {
    const doc = makeDoc({ part_style: { a: { name: 'part 1', color: '#ZZZZZZ' } } })
    const bodies = { a: makeBody('a') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.a?.color).toBe('#ZZZZZZ')
  })

  it('assigns sequential part numbers skipping existing numbers', () => {
    const doc = makeDoc({ part_style: { a: { name: 'part 1', color: PART_COLOR_PALETTE[0] } } })
    const bodies = { a: makeBody('a'), b: makeBody('b'), c: makeBody('c') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.b?.name).toBe('part 2')
    expect(doc.part_style?.c?.name).toBe('part 3')
  })

  it('sets created_by field for new bodies', () => {
    const doc = makeDoc()
    const bodies = { a: makeBody('a', { created_by: 'extrude1' }) }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.a?.created_by).toBe('extrude1')
  })

  it('does not mutate style entries for bodies not in the result', () => {
    const doc = makeDoc({ part_style: { old: { name: 'legacy', color: '#FF0000' } } })
    const bodies = { a: makeBody('a') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.old?.name).toBe('legacy')
    expect(doc.part_style?.old?.color).toBe('#FF0000')
  })

  it('returns early when bodies is undefined', () => {
    const doc = makeDoc()
    reconcilePartStyle(doc, undefined)
    expect(doc.part_style).toBeUndefined()
  })

  it('returns early when bodies is empty object', () => {
    const doc = makeDoc()
    reconcilePartStyle(doc, {})
    expect(doc.part_style).toBeUndefined()
  })

  it('does not mutate the original doc when called on a clone (in-place mutation guard)', () => {
    const original = makeDoc()
    const clone = structuredClone(original)
    const bodies = { a: makeBody('a', { created_by: 'feat1' }) }
    reconcilePartStyle(clone, bodies)
    // Clone gets the style
    expect(clone.part_style?.a?.name).toBe('part 1')
    // Original must remain untouched
    expect(original.part_style).toBeUndefined()
  })

  it('clone-then-reconcile pattern preserves existing styles', () => {
    const original = makeDoc({ part_style: { x: { name: 'custom', color: '#FF0000' } } })
    const clone = structuredClone(original)
    const bodies = { x: makeBody('x'), y: makeBody('y') }
    reconcilePartStyle(clone, bodies)
    // Clone has updated style
    expect(clone.part_style?.x?.name).toBe('custom')
    expect(clone.part_style?.y?.name).toBe('part 1')
    // Original untouched
    expect(original.part_style?.x?.name).toBe('custom')
    expect(original.part_style?.y).toBeUndefined()
  })
})

describe('useSolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: {},
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })
    mockUnflattenGeometry.mockReturnValue({})
    // Reset the store's owned fields between tests so rollback/pickBoundary
    // from a previous test don't leak into the next.
    const store = usePartEditorStore.getState()
    store.setRollbackPosition(DEFAULT_PART_EDITOR_DATA.rollbackPosition)
    store.setPickBoundary(DEFAULT_PART_EDITOR_DATA.pickBoundary)
    store.setEditingFeatureId(DEFAULT_PART_EDITOR_DATA.editingFeatureId)
    // The real solver store holds the cancel callback; clear it so a pending
    // solve from one test cannot be cancelled by the next.
    useSolverStore.setState({ isSolving: false, onCancelSolve: null })
  })

  function setupHook(opts?: { onFirstSolve?: () => void }) {
    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()
    const { result, unmount } = renderHookStrict(() =>
      useSolver('test-uuid', { onFirstSolve: opts?.onFirstSolve }, docRef, setDoc),
    )
    return { result, unmount, docRef, setDoc }
  }

  describe('reSolve', () => {
    it('calls setDoc exactly once per response (no double clone)', async () => {
      const { result, setDoc } = setupHook()
      mockSolveLocally.mockResolvedValue({
        solve_ms: 0,
        result: {},
        bodies: { a: makeBody('a') } as Record<string, BodyResult>,
        _build_state: null,
      })
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(setDoc).toHaveBeenCalledTimes(1)
    })

    it('reconciles part_style from bodies in the single setDoc call', async () => {
      const { result, setDoc } = setupHook()
      mockSolveLocally.mockResolvedValue({
        solve_ms: 0,
        result: {},
        bodies: { a: makeBody('a') } as Record<string, BodyResult>,
        _build_state: null,
      })
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      const docArg = setDoc.mock.calls[0][0]
      expect(docArg.part_style?.a?.name).toBe('part 1')
    })

    it('sets solving=true then false on success', async () => {
      const { result } = setupHook()
      expect(result.current.solving).toBe(false)
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(result.current.solving).toBe(false)
      expect(result.current.solveError).toBeNull()
    })

    it('clears result/body state for an empty doc without invoking the solver', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockSolveLocally).not.toHaveBeenCalled()
      expect(result.current.bodies).toEqual({})
      expect(result.current.solveError).toBeNull()
    })

    it('invokes the local kernel for a solvable doc', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(mockSolveLocally).toHaveBeenCalledTimes(1)
      expect(result.current.solveError).toBeNull()
    })

    it('discards a stale local result when a newer solve has started', async () => {
      const { result, setDoc } = setupHook()
      let resolveSlow: (v: unknown) => void
      const slow = new Promise<unknown>(r => { resolveSlow = r })
      // First call: slow (in flight). Second call: resolves immediately.
      mockSolveLocally
        .mockReturnValueOnce(slow)
        .mockResolvedValueOnce({ solve_ms: 0, result: {}, bodies: {}, _build_state: null })
      let p1: Promise<void>, p2: Promise<void>
      act(() => { p1 = result.current.reSolve(solvableDoc()) })
      await act(async () => { p2 = result.current.reSolve(solvableDoc()); await p2 })
      // Now release the first (stale) solve; its result must be dropped.
      await act(async () => { resolveSlow!({ solve_ms: 0, result: {}, bodies: {}, _build_state: null }); await p1 })
      expect(mockSolveLocally).toHaveBeenCalledTimes(2)
      // Only the winning (second) solve applied the doc.
      expect(setDoc).toHaveBeenCalledTimes(1)
    })

    it('sets solveError when the local solver throws', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockRejectedValue(new Error('kernel boom'))
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(result.current.solveError).toBe('Error: kernel boom')
    })

    it('suppresses solveError for a cancelled solve', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockRejectedValue(new Error('solve cancelled'))
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(result.current.solveError).toBeNull()
    })

    it('suppresses solveError for a solver worker timeout', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockRejectedValue(new Error('solver worker timed out'))
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(result.current.solveError).toBeNull()
    })

    it('other error messages still set solveError', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockRejectedValue(new Error('unexpected failure'))
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(result.current.solveError).toBe('Error: unexpected failure')
    })

    it('sets solveError when the local solver is unavailable (returns null)', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockResolvedValue(null)
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      expect(result.current.solveError).toContain('Local solver unavailable')
    })

    it('sets solveError for a doc with an unported feature kind', async () => {
      const { result } = setupHook()
      const doc = makeDoc({ features: [{ id: 'x1', kind: 'future_feature' }] })
      await act(async () => { await result.current.reSolve(doc) })
      expect(mockSolveLocally).not.toHaveBeenCalled()
      expect(result.current.solveError).toContain('unported feature kinds')
    })

    it('calls onFirstSolve on first successful solve', async () => {
      vi.useFakeTimers()
      const onFirstSolve = vi.fn()
      const { result } = setupHook({ onFirstSolve })
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('does not call onFirstSolve on subsequent solves', async () => {
      vi.useFakeTimers()
      const onFirstSolve = vi.fn()
      const { result } = setupHook({ onFirstSolve })
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(1)
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('handles rollbackPosition parameter', async () => {
      const { result } = setupHook()
      const doc = makeDoc({
        features: [
          { id: 'feat1', kind: 'sketch' },
          { id: 'feat2', kind: 'extrude' },
        ],
      })
      usePartEditorStore.getState().setRollbackPosition(1)
      await act(async () => { await result.current.reSolve(doc) })
      const payload = mockSolveLocally.mock.calls[0][0]
      expect(payload.rollback_position).toBe(1)
      expect(payload.features).toHaveLength(1)
      expect(payload.features[0].id).toBe('feat1')
    })

    it('a code-tab swap solve reads the re-derived store position, not the stale one', async () => {
      const { result } = setupHook()
      // The swapped-in doc parks the bar at 2 and carries a raw rollback: 5. The
      // swap writes the re-derived position into the store BEFORE reSolve; the
      // solve must read that (2), not the previous document's position (1) and
      // not the doc's own rollback field.
      const doc = makeDoc({
        rollback: 5,
        features: [
          { id: 'f1', kind: 'sketch' },
          { id: 'f2', kind: 'extrude' },
          { id: 'f3', kind: 'extrude' },
        ],
      })
      usePartEditorStore.getState().setRollbackPosition(1)
      usePartEditorStore.getState().setRollbackPosition(2)
      await act(async () => { await result.current.reSolve(doc) })
      const payload = mockSolveLocally.mock.calls[0][0]
      expect(payload.rollback_position).toBe(2)
      expect(payload.features).toHaveLength(2)
      expect(payload.features.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2'])
    })

    it('handles pickBoundary for preview solves', async () => {
      const { result } = setupHook()
      usePartEditorStore.getState().setPickBoundary(5)
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      const payload = mockSolveLocally.mock.calls[0][0]
      expect(payload.is_preview).toBe(true)
      expect(payload.pick_boundary).toBe(5)
    })

    it('filters out builtin features before solve', async () => {
      const { result } = setupHook()
      const doc = makeDoc({
        features: [
          { id: 'Origin', kind: 'origin' },
          { id: 'Front', kind: 'plane' },
          { id: 'feat1', kind: 'sketch' },
        ],
      })
      await act(async () => { await result.current.reSolve(doc) })
      const payload = mockSolveLocally.mock.calls[0][0]
      expect(payload.features).toHaveLength(1)
      expect(payload.features[0].id).toBe('feat1')
    })

    it('passes _validate=true in payload when reSolve is called with validate option', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(solvableDoc(), { validate: true }) })
      const payload = mockSolveLocally.mock.calls[0][0] as Record<string, unknown>
      expect(payload._validate).toBe(true)
    })

    it('does not pass _validate when reSolve is called without the validate option', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      const payload = mockSolveLocally.mock.calls[0][0] as Record<string, unknown>
      expect(payload._validate).toBeUndefined()
    })

    it('exposes validation state from the response and is cleared by clearValidation', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockResolvedValueOnce({
        solve_ms: 0, result: {}, bodies: {}, _build_state: null,
        _validation: { level: 2, passed: false, fp_only: true, diffs: {} },
      })
      await act(async () => { await result.current.reSolve(solvableDoc(), { validate: true }) })
      expect(result.current.validation).toEqual({ level: 2, passed: false, fp_only: true, diffs: {} })
      act(() => { result.current.clearValidation() })
      expect(result.current.validation).toBeNull()
    })

    it('sends monotonically increasing request_version on each solve', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      await act(async () => { await result.current.reSolve(solvableDoc()) })
      const versions = mockSolveLocally.mock.calls.map(c => (c[0] as Record<string, unknown>).request_version)
      expect(versions).toEqual([1, 2, 3])
    })

    it('sets featureTimings from solve_ms fields', async () => {
      const { result } = setupHook()
      mockSolveLocally.mockResolvedValue({
        solve_ms: 0,
        result: {
          feat1: {
            geometry: { l1: [0, 0, 1, 1] },
            status: 'solved',
            solve_ms: 123,
          },
        },
        bodies: {} as Record<string, BodyResult>,
        _build_state: null,
      })
      const doc = makeDoc({
        features: [{ id: 'feat1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }] }],
      })
      await act(async () => { await result.current.reSolve(doc) })
      expect(result.current.featureTimings).toEqual({ feat1: 123 })
    })

    it('resolves import bytes through the open workspace session before the flat registry', async () => {
      const resolveFile = vi.fn(async () => new Uint8Array([1, 2, 3]))
      useWorkspaceSessionStore.setState({ session: { workspace: 'ws', resolveFile } as unknown as WorkspaceSession })
      try {
        const { result } = setupHook()
        const doc = makeDoc({ features: [{ id: 'imp1', kind: 'import_step', file_id: 'f1' }] })
        await act(async () => { await result.current.reSolve(doc) })
        expect(resolveFile).toHaveBeenCalledWith('f1')
        const files = mockSolveLocally.mock.calls[0][2] as Record<string, Uint8Array>
        expect(Array.from(files.f1)).toEqual([1, 2, 3])
      } finally {
        useWorkspaceSessionStore.setState({ session: null })
      }
    })
  })

  describe('lifecycle', () => {
    it('reads rollbackPosition from the partEditorStore on each solve', async () => {
      const { result } = setupHook()
      const features = Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, kind: 'sketch' as const }))
      const doc = makeDoc({ features })
      await act(async () => { await result.current.reSolve(doc) })
      expect(mockSolveLocally.mock.calls[0][0].features).toHaveLength(15)
      usePartEditorStore.getState().setRollbackPosition(10)
      mockSolveLocally.mockClear()
      await act(async () => { await result.current.reSolve(doc) })
      expect(mockSolveLocally.mock.calls[0][0].features).toHaveLength(10)
    })

    it('clears pickBodies on pickBoundary non-null -> null transition (store subscription)', () => {
      const { result } = setupHook()
      // Move pickBoundary to non-null, then back to null. The subscription
      // inside useSolver wipes pickBodies on the falling edge.
      act(() => { usePartEditorStore.getState().setPickBoundary(5) })
      act(() => { usePartEditorStore.getState().setPickBoundary(null) })
      expect(result.current.pickBodies).toEqual({})
    })
  })
})
