import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

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

import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('useAssemblyDoc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loads = {}
  })

  it('loads an assembly document with kind preserved', async () => {
    const { result } = renderHook(() => useAssemblyDoc('A'))
    await tick()
    await act(async () => { h.loads.A.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()
    expect(result.current.doc?.kind).toBe('assembly')
    expect(result.current.docName).toBe('Asm')
    expect(result.current.loading).toBe(false)
  })

  it('prepends assembly built-ins (not part built-ins) to an empty-feature assembly', async () => {
    const { result } = renderHook(() => useAssemblyDoc('B'))
    await tick()
    await act(async () => { h.loads.B.resolve({ content: 'kind: assembly\nfeatures: []', name: 'EmptyAsm' }) })
    await tick()
    const feats = result.current.doc?.features ?? []
    const ids = feats.map(f => f.id)
    // Assembly gets its OWN coordinate frame, never the part built-ins.
    expect(ids).toEqual(['AssemblyOrigin', 'AssemblyTop', 'AssemblyFront', 'AssemblyRight'])
    expect(ids).not.toContain('Origin')
    expect(feats[0].kind).toBe('origin')
    expect(feats.slice(1).every(f => f.kind === 'plane')).toBe(true)
  })

  it('returns features when present on assembly doc', async () => {
    const content = 'kind: assembly\nfeatures:\n  - id: O1\n    kind: origin\n  - id: P1\n    kind: plane'
    const { result } = renderHook(() => useAssemblyDoc('C'))
    await tick()
    await act(async () => { h.loads.C.resolve({ content, name: 'Planes' }) })
    await tick()
    const ids = result.current.doc?.features?.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['O1', 'P1'])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('returns null doc and sets loading when uuid is undefined', async () => {
    const { result } = renderHook(() => useAssemblyDoc(undefined))
    await tick()
    await tick()
    expect(result.current.doc).toBeNull()
    expect(result.current.loading).toBe(true)
  })
})
