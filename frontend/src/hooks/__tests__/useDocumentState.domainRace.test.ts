import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// A controllable two-domain backend bundle: each load returns a deferred promise
// keyed by uuid so a test can resolve/reject them out of order and reproduce a
// load race across the local/cloud domain fallback (doc-domain-move).
const h = vi.hoisted(() => {
  const make = () => {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  return {
    make,
    localLoads: {} as Record<string, ReturnType<typeof make>>,
    cloudLoads: {} as Record<string, ReturnType<typeof make>>,
    localSave: vi.fn(() => Promise.resolve()),
    cloudSave: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: (uuid: string) => (h.localLoads[uuid] ??= h.make()).promise,
      save: h.localSave,
    },
    cloudDocuments: {
      load: (uuid: string) => (h.cloudLoads[uuid] ??= h.make()).promise,
      save: h.cloudSave,
    },
  },
}))

import { useDocumentState } from '@/hooks/useDocumentState'
import type { PartDoc } from '@/types/cad'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('useDocumentState domain load race', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.localLoads = {}
    h.cloudLoads = {}
  })

  // Regression for the storeRef-corruption race introduced by the cloud fallback:
  // navigating to a new uuid while a prior load is in flight must not let the stale
  // load overwrite the doc OR retarget save/rename at the wrong domain's store.
  it('a superseded slow load neither clobbers the doc nor corrupts the save target', async () => {
    const reSolveRef = { current: null }
    const { result, rerender } = renderHook(
      ({ uuid }) => useDocumentState(uuid, reSolveRef, { solveOnLoad: false }),
      { initialProps: { uuid: 'A' as string } },
    )

    // A's effect requests the local home copy first.
    await tick()
    expect(h.localLoads.A).toBeDefined()

    // A is not local -> the hook falls back to the CLOUD domain (slow load).
    await act(async () => { h.localLoads.A.reject(new Error('not in local')) })
    await tick()
    expect(h.cloudLoads.A).toBeDefined()

    // The user navigates to B before A's cloud load resolves.
    rerender({ uuid: 'B' })
    await tick()
    expect(h.localLoads.B).toBeDefined()

    // B resolves fast from the LOCAL home.
    await act(async () => { h.localLoads.B.resolve({ content: 'name: B', name: 'B-name' }) })
    await tick()

    // Now the stale A cloud load resolves LAST -- it must be ignored.
    await act(async () => { h.cloudLoads.A.resolve({ content: 'name: A', name: 'A-name' }) })
    await tick()

    // B won the render; A did not clobber it.
    expect(result.current.docName).toBe('B-name')

    // The save target is B's store (local home), not A's stale cloud store.
    const doc: PartDoc = { oversolved: 1, kind: 'part', features: [] }
    await act(async () => { await result.current.saveDoc('B', doc) })
    expect(h.localSave).toHaveBeenCalled()
    expect(h.cloudSave).not.toHaveBeenCalled()
  })

  // isCloudDoc drives whether the share UI is offered: a local-home doc is not
  // shareable (no server record), a cloud-domain doc is.
  it('reports isCloudDoc false for a local doc and true for a cloud doc', async () => {
    const reSolveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('L', reSolveRef, { solveOnLoad: false }))
    await tick()
    await act(async () => { h.localLoads.L.resolve({ content: 'name: L', name: 'L' }) })
    await tick()
    expect(result.current.isCloudDoc).toBe(false)

    const cloud = renderHook(() => useDocumentState('C', reSolveRef, { solveOnLoad: false }))
    await tick()
    await act(async () => { h.localLoads.C.reject(new Error('not in local')) })
    await tick()
    await act(async () => { h.cloudLoads.C.resolve({ content: 'name: C', name: 'C' }) })
    await tick()
    expect(cloud.result.current.isCloudDoc).toBe(true)
  })
})
