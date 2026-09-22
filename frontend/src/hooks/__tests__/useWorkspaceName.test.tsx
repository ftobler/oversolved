import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// The breadcrumb's middle crumb reads its name through this hook. The meta read
// is asynchronous and the hook is also the re-read seam for a rename, so what
// matters is the gate (never show another workspace's name) and that a store
// revision re-reads.
const h = vi.hoisted(() => {
  const make = () => {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  return { make, reads: {} as Record<string, ReturnType<typeof make>> }
})

vi.mock('@/workspace/idbCarrier', () => ({
  readWorkspaceMeta: (workspace: string) => (h.reads[workspace] ??= h.make()).promise,
}))

import { useWorkspaceName } from '@/hooks/useWorkspaceName'
import { bumpWorkspaceStoreRevision } from '@/workspace/storeEvents'

describe('useWorkspaceName', () => {
  beforeEach(() => {
    h.reads = {}
  })

  it('is undefined until the read lands, then the stored name', async () => {
    const { result } = renderHook(() => useWorkspaceName('ws1'))

    // The first render cannot know the name yet; returning one would flash the
    // wrong crumb.
    expect(result.current).toBeUndefined()

    await act(async () => { h.reads.ws1.resolve({ name: 'Brackets' }) })
    await waitFor(() => expect(result.current).toBe('Brackets'))
  })

  it('never reads and stays undefined without a workspace', () => {
    const { result } = renderHook(() => useWorkspaceName(undefined))
    expect(result.current).toBeUndefined()
    expect(Object.keys(h.reads)).toHaveLength(0)
  })

  it('falls back to undefined when the meta read fails', async () => {
    const { result } = renderHook(() => useWorkspaceName('ws1'))

    await act(async () => { h.reads.ws1.reject(new Error('no idb')) })

    // The crumb falls back to the workspace id; the hook must not throw.
    await waitFor(() => expect(result.current).toBeUndefined())
  })

  it('re-reads after a store revision so a rename reaches the trail', async () => {
    const { result } = renderHook(() => useWorkspaceName('ws1'))
    await act(async () => { h.reads.ws1.resolve({ name: 'Old' }) })
    await waitFor(() => expect(result.current).toBe('Old'))

    h.reads.ws1 = h.make()
    await act(async () => { bumpWorkspaceStoreRevision() })
    await act(async () => { h.reads.ws1.resolve({ name: 'Renamed' }) })

    await waitFor(() => expect(result.current).toBe('Renamed'))
  })

  it('does not show the previous workspace name while the new read is pending', async () => {
    const { result, rerender } = renderHook(({ ws }: { ws: string }) => useWorkspaceName(ws), {
      initialProps: { ws: 'ws1' },
    })
    await act(async () => { h.reads.ws1.resolve({ name: 'One' }) })
    await waitFor(() => expect(result.current).toBe('One'))

    rerender({ ws: 'ws2' })
    expect(result.current).toBeUndefined()

    await act(async () => { h.reads.ws2.resolve({ name: 'Two' }) })
    await waitFor(() => expect(result.current).toBe('Two'))
  })
})
