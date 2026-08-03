import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const h = vi.hoisted(() => {
  const make = () => {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
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
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('useAssemblyDoc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loads = {}
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
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

  // A failed load must not leave a previous document's history in the module
  // store: Ctrl+Z after the error would otherwise restore the old document's
  // content into the one that failed to load.
  it('a failed load clears any previous document history from the store', async () => {
    useAssemblyStore.setState({
      undoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'stale' }],
      redoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'stale redo' }],
    })

    const { result } = renderHook(() => useAssemblyDoc('D'))
    await tick()
    await act(async () => { h.loads.D.reject(new Error('boom')) })
    await tick()

    expect(result.current.error).toBeTruthy()
    expect(result.current.loading).toBe(false)
    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(0)
  })

  // The success path is the real cross-document corruption invariant: a later
  // save in doc B would stringify the doc the Ctrl+Z restored, so A's history
  // surviving into B could write A's content under B's uuid. The failed-load
  // branch is tested above; this pins the same guard on a successful load.
  it('a successful load clears any previous document history from the store', async () => {
    renderHook(() => useAssemblyDoc('first'))
    await tick()
    await act(async () => { h.loads.first.resolve({ content: 'kind: assembly\nfeatures: []', name: 'AsmA' }) })
    await tick()

    // Simulate A's editing history: the entries A's own sessions pushed.
    useAssemblyStore.setState({
      undoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'A edit' }],
      redoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'A redo' }],
    })
    expect(useAssemblyStore.getState().undoStack).toHaveLength(1)

    renderHook(() => useAssemblyDoc('second'))
    await tick()
    await act(async () => { h.loads.second.resolve({ content: 'kind: assembly\nfeatures: []', name: 'AsmB' }) })
    await tick()

    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(0)
  })
})
