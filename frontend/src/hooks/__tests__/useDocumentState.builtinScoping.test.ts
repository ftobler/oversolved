// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ─── Mock backend ───
const h = vi.hoisted(() => {
  const make = () => {
    let resolve!: (v: unknown) => void
    const promise = new Promise((res) => { resolve = res })
    return { promise, resolve }
  }
  return {
    make,
    loads: {} as Record<string, ReturnType<typeof make>>,
  }
})

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: (uuid: string) => (h.loads[uuid] ??= h.make()).promise,
    },
  },
}))

import { useDocumentState } from '@/hooks/useDocumentState'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('useDocumentState builtin scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loads = {}
  })

  it('prepends built-ins for kind: "part" with empty features', async () => {
    const solveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('A', solveRef, { solveOnLoad: false }))
    await tick()
    await act(async () => { h.loads.A.resolve({ content: 'kind: part\nfeatures: []', name: 'Part' }) })
    await tick()
    const ids = result.current.doc?.features?.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right'])
  })

  it('prepends built-ins for legacy docs with no kind field', async () => {
    const solveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('B', solveRef, { solveOnLoad: false }))
    await tick()
    await act(async () => { h.loads.B.resolve({ content: 'features: []', name: 'Legacy' }) })
    await tick()
    const ids = result.current.doc?.features?.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right'])
  })

  it('refuses an assembly payload at the part loader instead of seating it', async () => {
    const solveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('C', solveRef, { solveOnLoad: false }))
    await tick()
    await act(async () => { h.loads.C.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Assembly' }) })
    await tick()
    // The loader owns the content/editor mismatch now: the part editor never
    // sees an assembly, and the failure names the offending field.
    expect(result.current.doc).toBeNull()
    expect(result.current.error).toContain('"Assembly" at kind')
    expect(result.current.loadFailure?.field).toBe('kind')
  })

  it('does not alter features when already present on a part doc', async () => {
    const solveRef = { current: null }
    const content = 'kind: part\nfeatures:\n  - id: S1\n    kind: sketch\n    plane: "@builtin_plane_top"'
    const { result } = renderHook(() => useDocumentState('D', solveRef, { solveOnLoad: false }))
    await tick()
    await act(async () => { h.loads.D.resolve({ content, name: 'HasSketch' }) })
    await tick()
    const ids = result.current.doc?.features?.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['S1'])
  })
})
