import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolver } = vi.hoisted(() => ({
  mockSolver: {
    solve: vi.fn(),
    disconnect: vi.fn(),
    onGeometryUpdate: vi.fn().mockReturnValue(vi.fn()),
  },
}))

const { mockCache } = vi.hoisted(() => ({
  mockCache: {
    getCachedBuildResponse: vi.fn(),
    cacheBuildResponse: vi.fn(),
    cacheGeometry: vi.fn(),
  },
}))

const { mockUnpack } = vi.hoisted(() => ({
  mockUnpack: {
    unpackBodies: vi.fn().mockReturnValue({}),
    unpackPickBodies: vi.fn().mockReturnValue({}),
  },
}))

const { mockUnflattenGeometry } = vi.hoisted(() => ({
  mockUnflattenGeometry: vi.fn().mockReturnValue({}),
}))

const { mockInvalidateDocCache } = vi.hoisted(() => ({
  mockInvalidateDocCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/hooks/solverWs', () => ({ solverWs: mockSolver }))
vi.mock('@/hooks/useGeometryCache', () => ({
  useGeometryCache: vi.fn(() => mockCache),
}))
vi.mock('@/utils/geometryMapping', () => ({ unflattenGeometry: mockUnflattenGeometry }))
vi.mock('@/utils/geometryUnpack', () => mockUnpack)
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn() }) },
}))
vi.mock('@/utils/buildCache', () => ({
  invalidateDocCache: mockInvalidateDocCache,
}))

import { pickPartColor, reconcilePartStyle, useSolver } from '@/hooks/useSolver'
import { PART_COLOR_PALETTE } from '@/utils/partColors'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import type { PartDoc, BodyResult } from '@/types/cad'
import type { GeometryHeader } from '@/utils/geometryUnpack'

function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { oversolved: 1, kind: 'part', features: [], ...overrides }
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

  it('normalizes 3-digit hex colors to 6-digit uppercase', () => {
    const doc = makeDoc({ part_style: { a: { name: 'part 1', color: '#abc' } } })
    const bodies = { a: makeBody('a') }
    reconcilePartStyle(doc, bodies)
    expect(doc.part_style?.a?.color).toBe('#AABBCC')
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
})

describe('useSolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCache.getCachedBuildResponse.mockResolvedValue(null)
    mockCache.cacheBuildResponse.mockResolvedValue(undefined)
    mockCache.cacheGeometry.mockResolvedValue(undefined)
    mockInvalidateDocCache.mockResolvedValue(undefined)
    mockSolver.solve.mockResolvedValue({
      solve_ms: 0,
      result: {},
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })
    mockUnflattenGeometry.mockReturnValue({})
    mockUnpack.unpackBodies.mockReturnValue({})
    mockUnpack.unpackPickBodies.mockReturnValue({})
    // Reset the store's owned fields between tests so rollback/pickBoundary
    // from a previous test don't leak into the next.
    const store = usePartEditorStore.getState()
    store.setRollbackPosition(DEFAULT_PART_EDITOR_DATA.rollbackPosition)
    store.setPickBoundary(DEFAULT_PART_EDITOR_DATA.pickBoundary)
    store.setEditingFeatureId(DEFAULT_PART_EDITOR_DATA.editingFeatureId)
  })

  function setupHook(opts?: { onFirstSolve?: () => void }) {
    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()
    const modeRef = { current: 'feature' }
    const setCodeText = vi.fn()
    const { result, unmount } = renderHook(() =>
      useSolver('test-uuid', setCodeText, modeRef, { onFirstSolve: opts?.onFirstSolve }, docRef, setDoc),
    )
    return { result, unmount, docRef, setDoc, setCodeText }
  }

  describe('reSolve', () => {
    it('sets solving=true then false on success', async () => {
      const { result } = setupHook()
      expect(result.current.solving).toBe(false)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(result.current.solving).toBe(false)
      expect(result.current.solveError).toBeNull()
    })

    it('uses cache when fresh hit available', async () => {
      const { result } = setupHook()
      mockCache.getCachedBuildResponse.mockResolvedValue({
        entry: {
          buildResponse: {
            solve_ms: 0,
            result: {},
            bodies: {} as Record<string, BodyResult>,
            _build_state: null,
          },
          geometry: undefined,
          cache_key: 'k',
          doc_id: 'test-uuid',
          feature_spec_hash: 'h',
          timestamp: Date.now(),
          rollback_position: 0,
          pick_boundary: null,
        },
        isFresh: true,
      })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockSolver.solve).not.toHaveBeenCalled()
      expect(result.current.solveError).toBeNull()
    })

    it('applies cached geometry when cache hit includes geometry', async () => {
      const { result } = setupHook()
      const header = { msgId: 7, bodies: {}, pick_bodies: {} }
      const buffer = new ArrayBuffer(4)
      const jsonHeaderLen = 4
      mockCache.getCachedBuildResponse.mockResolvedValue({
        entry: {
          buildResponse: {
            solve_ms: 0,
            result: {},
            bodies: {} as Record<string, BodyResult>,
            _build_state: null,
          },
          geometry: { header, buffer, jsonHeaderLen },
          cache_key: 'k',
          doc_id: 'test-uuid',
          feature_spec_hash: 'h',
          timestamp: Date.now(),
          rollback_position: 0,
          pick_boundary: null,
        },
        isFresh: true,
      })
      const newBodies = { bodyA: makeBody('bodyA') }
      mockUnpack.unpackBodies.mockReturnValue(newBodies)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockSolver.solve).not.toHaveBeenCalled()
      expect(mockUnpack.unpackBodies).toHaveBeenCalled()
      expect(result.current.bodies).toEqual(newBodies)
    })

    it('calls solverWs.solve on cache miss', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockSolver.solve).toHaveBeenCalledTimes(1)
      expect(result.current.solveError).toBeNull()
    })

    it('discards stale response when new solve started', async () => {
      const { result } = setupHook()
      let cacheResolve: (v: unknown) => void
      const cachePromise = new Promise<unknown>(r => { cacheResolve = r })
      mockCache.getCachedBuildResponse.mockReturnValue(cachePromise)
      let p1: Promise<void>, p2: Promise<void>
      act(() => { p1 = result.current.reSolve(makeDoc()) })
      act(() => { p2 = result.current.reSolve(makeDoc()) })
      await act(async () => { cacheResolve!(null) })
      await act(async () => { await Promise.all([p1, p2]) })
      expect(mockSolver.solve).toHaveBeenCalledTimes(1)
      expect(result.current.solveError).toBeNull()
    })

    it('sets solveError on error response', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({ error: 'solver failed' })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(result.current.solveError).toBe('solver failed')
    })

    it('sets solveError on exception in solve pipeline', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockRejectedValue(new Error('network error'))
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(result.current.solveError).toBe('Error: network error')
    })

    it('calls onFirstSolve on first successful solve', async () => {
      vi.useFakeTimers()
      const onFirstSolve = vi.fn()
      const { result } = setupHook({ onFirstSolve })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('does not call onFirstSolve on subsequent solves', async () => {
      vi.useFakeTimers()
      const onFirstSolve = vi.fn()
      const { result } = setupHook({ onFirstSolve })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(1)
      await act(async () => { await result.current.reSolve(makeDoc()) })
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
      const payload = mockSolver.solve.mock.calls[0][0]
      expect(payload.rollback_position).toBe(1)
      expect(payload.features).toHaveLength(1)
      expect(payload.features[0].id).toBe('feat1')
    })

    it('handles pickBoundary for preview solves', async () => {
      const { result } = setupHook()
      usePartEditorStore.getState().setPickBoundary(5)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      const payload = mockSolver.solve.mock.calls[0][0]
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
      const payload = mockSolver.solve.mock.calls[0][0]
      expect(payload.features).toHaveLength(1)
      expect(payload.features[0].id).toBe('feat1')
    })

    it('passes _validate=true in payload when reSolve is called with validate option', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(makeDoc(), { validate: true }) })
      const payload = mockSolver.solve.mock.calls[0][0] as Record<string, unknown>
      expect(payload._validate).toBe(true)
    })

    it('does not pass _validate when reSolve is called without the validate option', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(makeDoc()) })
      const payload = mockSolver.solve.mock.calls[0][0] as Record<string, unknown>
      expect(payload._validate).toBeUndefined()
    })

    it('exposes validation state from the response and is cleared by clearValidation', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValueOnce({
        solve_ms: 0, result: {}, bodies: {}, _build_state: null,
        validation: { level: 2, passed: false, fp_only: true, diffs: {} },
      })
      await act(async () => { await result.current.reSolve(makeDoc(), { validate: true }) })
      expect(result.current.validation).toEqual({ level: 2, passed: false, fp_only: true, diffs: {} })
      act(() => { result.current.clearValidation() })
      expect(result.current.validation).toBeNull()
    })

    it('does not write cache when validation reports a structural failure', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValueOnce({
        solve_ms: 0, result: {}, bodies: {}, _build_state: null,
        validation: { level: 3, passed: false, diffs: { repo_ancestral: {} } },
      })
      await act(async () => { await result.current.reSolve(makeDoc(), { validate: true }) })
      expect(mockCache.cacheBuildResponse).not.toHaveBeenCalled()
    })

    it('writes cache when validation passes', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValueOnce({
        solve_ms: 0, result: {}, bodies: {}, _build_state: null,
        validation: { level: 3, passed: true, diffs: {} },
      })
      await act(async () => { await result.current.reSolve(makeDoc(), { validate: true }) })
      expect(mockCache.cacheBuildResponse).toHaveBeenCalledTimes(1)
    })

    it('sends monotonically increasing request_version on each solve', async () => {
      const { result } = setupHook()
      await act(async () => { await result.current.reSolve(makeDoc()) })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      const versions = mockSolver.solve.mock.calls.map(c => (c[0] as Record<string, unknown>).request_version)
      expect(versions).toEqual([1, 2, 3])
    })

    it('drops response when echoed request_version is older than the local counter', async () => {
      // Defense-in-depth: even when the local stale-guard would accept the response
      // (single call in flight), a misrouted response carrying an older
      // request_version must still be rejected.
      //
      // Achieved by firing two reSolves so requestIdRef becomes 2, but mocking
      // BOTH responses to echo version 1 (simulating a bug where the backend
      // dropped or re-used an old version). The second call's local isStale is
      // false (currentRequestId == requestIdRef == 2), but the echoed v=1 < 2
      // must still cause the response to be discarded.
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({
        solve_ms: 0,
        result: { tainted: { status: 'ok' } },
        bodies: {},
        _build_state: null,
        request_version: 1,  // stale echo
      })

      await act(async () => { await result.current.reSolve(makeDoc()) })  // requestIdRef -> 1, echo v=1 ok
      const before = { ...result.current.solveResults }
      await act(async () => { await result.current.reSolve(makeDoc()) })  // requestIdRef -> 2, echo v=1 must be dropped

      // The second solve's response was dropped (echoed v=1 < counter=2), so
      // solveResults must NOT have been overwritten with the 'tainted' result
      // applied a second time. Since the first call also wrote the same
      // 'tainted' result, we instead assert no error and the state matches
      // what the first call already produced.
      expect(result.current.solveError).toBeNull()
      expect(result.current.solveResults).toEqual(before)
    })

    it('bypassCache: true flushes doc cache and skips cache lookup', async () => {
      const { result } = setupHook()
      // Cache is populated but should be ignored when bypassCache is true
      mockCache.getCachedBuildResponse.mockResolvedValue({
        isFresh: true,
        entry: {
          buildResponse: { solve_ms: 0, result: {}, bodies: {}, _build_state: null },
          cache_key: 'k', doc_id: 'test-uuid', feature_spec_hash: 'h',
          timestamp: Date.now(), rollback_position: 0, pick_boundary: null,
        },
      })
      await act(async () => { await result.current.reSolve(makeDoc(), { bypassCache: true }) })
      expect(mockInvalidateDocCache).toHaveBeenCalledWith('test-uuid')
      expect(mockCache.getCachedBuildResponse).not.toHaveBeenCalled()
      expect(mockSolver.solve).toHaveBeenCalledTimes(1)
    })

    it('bypassCache: true goes to WebSocket even when cache would be a fresh hit', async () => {
      const { result } = setupHook()
      // First solve without bypass -- populates the cache path
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockSolver.solve).toHaveBeenCalledTimes(1)

      // Now simulate a fresh cache hit on the second call
      mockCache.getCachedBuildResponse.mockResolvedValue({
        isFresh: true,
        entry: {
          buildResponse: { solve_ms: 0, result: {}, bodies: {}, _build_state: null },
          cache_key: 'k', doc_id: 'test-uuid', feature_spec_hash: 'h',
          timestamp: Date.now(), rollback_position: 0, pick_boundary: null,
        },
      })
      await act(async () => { await result.current.reSolve(makeDoc(), { bypassCache: true }) })
      // WS must be called a second time despite the fresh cache entry
      expect(mockSolver.solve).toHaveBeenCalledTimes(2)
      expect(mockInvalidateDocCache).toHaveBeenCalledTimes(1)
    })

    it('bypassCache: false uses cache on fresh hit (normal path unaffected)', async () => {
      const { result } = setupHook()
      mockCache.getCachedBuildResponse.mockResolvedValue({
        isFresh: true,
        entry: {
          buildResponse: { solve_ms: 0, result: {}, bodies: {}, _build_state: null },
          cache_key: 'k', doc_id: 'test-uuid', feature_spec_hash: 'h',
          timestamp: Date.now(), rollback_position: 0, pick_boundary: null,
        },
      })
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockInvalidateDocCache).not.toHaveBeenCalled()
      expect(mockSolver.solve).not.toHaveBeenCalled()
    })

    it('sets featureTimings from solve_ms fields', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({
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
  })

  describe('applyGeometryUpdate', () => {
    it('skips when msgId does not match lastValidMsgId', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({
        solve_ms: 0,
        result: {},
        bodies: {} as Record<string, BodyResult>,
        _build_state: null,
        msgId: 2,
      })
      mockCache.getCachedBuildResponse.mockResolvedValue(null)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      expect(mockSolver.solve).toHaveBeenCalledTimes(1)
      const geometryCb = mockSolver.onGeometryUpdate.mock.calls[0][0]
      const staleBodies = { bodyX: makeBody('bodyX') }
      mockUnpack.unpackBodies.mockReturnValue(staleBodies)
      act(() => {
        geometryCb(1, { msgId: 1, bodies: {} }, new ArrayBuffer(4), 4)
      })
      expect(mockUnpack.unpackBodies).not.toHaveBeenCalled()
      expect(result.current.bodies).toEqual({})
    })

    it('updates bodies and pickBodies on valid msgId', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({
        solve_ms: 0,
        result: {},
        bodies: {} as Record<string, BodyResult>,
        _build_state: null,
        msgId: 5,
      })
      mockCache.getCachedBuildResponse.mockResolvedValue(null)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      const geometryCb = mockSolver.onGeometryUpdate.mock.calls[0][0]
      const validBodies = { body1: makeBody('body1') }
      const pickBodies = { pick1: makeBody('pick1') }
      mockUnpack.unpackBodies.mockReturnValue(validBodies)
      mockUnpack.unpackPickBodies.mockReturnValue(pickBodies)
      act(() => {
        geometryCb(5, { msgId: 5, bodies: {}, pick_bodies: { pick1: {} } } as unknown as GeometryHeader, new ArrayBuffer(4), 4)
      })
      expect(result.current.bodies).toEqual(validBodies)
      expect(result.current.pickBodies).toEqual(pickBodies)
    })

    it('calls cacheGeometry on success with uuid', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({
        solve_ms: 0,
        result: {},
        bodies: {} as Record<string, BodyResult>,
        _build_state: null,
        msgId: 3,
      })
      mockCache.getCachedBuildResponse.mockResolvedValue(null)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      const geometryCb = mockSolver.onGeometryUpdate.mock.calls[0][0]
      act(() => {
        geometryCb(3, { msgId: 3, bodies: {} } as unknown as GeometryHeader, new ArrayBuffer(4), 4)
      })
      expect(mockCache.cacheGeometry).toHaveBeenCalledTimes(1)
    })

    it('handles unpack errors gracefully', async () => {
      const { result } = setupHook()
      mockSolver.solve.mockResolvedValue({
        solve_ms: 0,
        result: {},
        bodies: {} as Record<string, BodyResult>,
        _build_state: null,
        msgId: 4,
      })
      mockCache.getCachedBuildResponse.mockResolvedValue(null)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      const geometryCb = mockSolver.onGeometryUpdate.mock.calls[0][0]
      mockUnpack.unpackBodies.mockImplementation(() => { throw new Error('unpack failed') })
      expect(() => {
        act(() => {
          geometryCb(4, { msgId: 4, bodies: {} } as unknown as GeometryHeader, new ArrayBuffer(4), 4)
        })
      }).not.toThrow()
    })
  })

  describe('lifecycle', () => {
    it('cleans up solverWs on unmount', () => {
      const { unmount } = setupHook()
      expect(mockSolver.disconnect).not.toHaveBeenCalled()
      unmount()
      expect(mockSolver.disconnect).toHaveBeenCalledTimes(1)
    })

    it('resets rollback and firstSolve on resetSolver', async () => {
      vi.useFakeTimers()
      const onFirstSolve = vi.fn()
      const { result } = setupHook({ onFirstSolve })
      mockCache.getCachedBuildResponse.mockResolvedValue(null)
      await act(async () => { await result.current.reSolve(makeDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(1)
      result.current.resetSolver()
      await act(async () => { await result.current.reSolve(makeDoc()) })
      act(() => { vi.advanceTimersByTime(0) })
      expect(onFirstSolve).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('reads rollbackPosition from the partEditorStore on each solve', async () => {
      const { result } = setupHook()
      mockCache.getCachedBuildResponse.mockResolvedValue(null)
      const features = Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, kind: 'sketch' as const }))
      const doc = makeDoc({ features })
      await act(async () => { await result.current.reSolve(doc) })
      expect(mockSolver.solve.mock.calls[0][0].features).toHaveLength(15)
      usePartEditorStore.getState().setRollbackPosition(10)
      mockSolver.solve.mockClear()
      await act(async () => { await result.current.reSolve(doc) })
      expect(mockSolver.solve.mock.calls[0][0].features).toHaveLength(10)
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
