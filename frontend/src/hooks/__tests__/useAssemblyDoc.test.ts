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
    saveGates: [] as ReturnType<typeof make>[],
    saves: [] as Array<{ uuid: string; content: string; preview_image?: string }>,
    renameGates: [] as ReturnType<typeof make>[],
    renames: [] as Array<{ uuid: string; name: string }>,
    previewPut: vi.fn(async () => {}),
  }
})

vi.mock('@/stores/previewStore', () => ({
  getPreviewStore: () => ({ put: h.previewPut }),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: (uuid: string) => (h.loads[uuid] ??= h.make()).promise,
      // Deferred like the loads: a manual save spends multiple awaits
      // (screenshot, then the store), and tests need to hold it open.
      save: (uuid: string, body: { content: string; preview_image?: string }) => {
        const gate = h.make()
        h.saveGates.push(gate)
        h.saves.push({ uuid, ...body })
        return gate.promise
      },
      rename: (uuid: string, name: string) => {
        const gate = h.make()
        h.renameGates.push(gate)
        h.renames.push({ uuid, name })
        return gate.promise
      },
    },
  },
}))

import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('useAssemblyDoc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loads = {}
    h.saveGates = []
    h.saves = []
    h.renameGates = []
    h.renames = []
    h.previewPut.mockClear()
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    useUnsavedChangesStore.getState().setDirty(false)
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
      undoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'Add part' as const }],
      redoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'Add mate' as const }],
    })

    const { result } = renderHook(() => useAssemblyDoc('D'))
    await tick()
    await act(async () => { h.loads.D.reject(new Error('boom')) })
    await tick()

    expect(result.current.error).toBeTruthy()
    expect(result.current.loading).toBe(false)
    // A failed load must leave no document for a live editor to sit over.
    expect(result.current.doc).toBeNull()
    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(0)
  })

  // A rejected reload after a successful load is the dangerous case: the
  // previous document was on screen, and leaving it there under the error made
  // the toolbar and tree look live over a doc that failed to load.
  it('nulls the document when a reload fails, so no stale editor survives', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useAssemblyDoc(id), {
      initialProps: { id: 'E1' },
    })
    await tick()
    await act(async () => { h.loads.E1.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()
    expect(result.current.doc).not.toBeNull()

    rerender({ id: 'E2' })
    await tick()
    await act(async () => { h.loads.E2.reject(new Error('boom')) })
    await tick()

    expect(result.current.error).toBeTruthy()
    expect(result.current.doc).toBeNull()
    expect(result.current.docName).toBe('')
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
      undoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'Edit mate' as const }],
      redoStack: [{ doc: { kind: 'assembly', features: [] }, label: 'Move part' as const }],
    })
    expect(useAssemblyStore.getState().undoStack).toHaveLength(1)

    renderHook(() => useAssemblyDoc('second'))
    await tick()
    await act(async () => { h.loads.second.resolve({ content: 'kind: assembly\nfeatures: []', name: 'AsmB' }) })
    await tick()

    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(0)
  })

  // The manual save is the sole persistence point and beforeunload reads the
  // dirty flag, so a save may only clear that flag when the document it
  // serialized is still the current one: an edit landing inside the save's
  // async windows postdates the stored bytes and must keep the warning alive.
  it('keeps the dirty flag when an edit lands between the screenshot and the save resolving', async () => {
    const { result } = renderHook(() => useAssemblyDoc('SA'))
    await tick()
    await act(async () => { h.loads.SA.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()

    let releaseScreenshot!: (value: string | null) => void
    const screenshotGate = new Promise<string | null>(resolve => { releaseScreenshot = resolve })
    const screenshot = vi.fn(() => screenshotGate)

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('SA', result.current.doc!, screenshot)
    })
    // The bytes were serialized synchronously; the save is parked on the shot.
    expect(screenshot).toHaveBeenCalledTimes(1)
    expect(h.saveGates).toHaveLength(0)
    await act(async () => { releaseScreenshot(null) })
    expect(h.saveGates).toHaveLength(1)

    // What AssemblyEditor's mutate does during the real windows: installs a
    // fresh doc object into docRef and re-flags dirty.
    await act(async () => {
      const edited = { ...result.current.doc! }
      result.current.docRef.current = edited
      result.current.setDoc(edited)
      useUnsavedChangesStore.getState().setDirty(true)
    })

    await act(async () => { h.saveGates[0].resolve(undefined) })
    const ok = await savePromise
    expect(ok).toBe(true)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('clears the dirty flag when nothing was edited during the save', async () => {
    const { result } = renderHook(() => useAssemblyDoc('SB'))
    await tick()
    await act(async () => { h.loads.SB.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()
    useUnsavedChangesStore.getState().setDirty(true)

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('SB', result.current.doc!)
    })
    await act(async () => { h.saveGates[0].resolve(undefined) })
    const ok = await savePromise
    expect(ok).toBe(true)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('chains an overlapping save so the newer bytes land after the stale ones', async () => {
    const { result } = renderHook(() => useAssemblyDoc('CH'))
    await tick()
    await act(async () => { h.loads.CH.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()

    let releaseShot!: (value: string | null) => void
    const shotGate = new Promise<string | null>(resolve => { releaseShot = resolve })

    // Save 1 snapshots pre-edit bytes and parks on the screenshot.
    let save1!: Promise<boolean>
    await act(async () => {
      save1 = result.current.saveDoc('CH', result.current.doc!, vi.fn(() => shotGate))
    })
    expect(h.saveGates).toHaveLength(0)

    // The edit lands mid-flight and save 2 fires while save 1 holds the slot.
    let save2!: Promise<boolean>
    await act(async () => {
      const edited = { ...result.current.doc!, marker: 'EDITED' } as NonNullable<typeof result.current.doc>
      result.current.docRef.current = edited
      result.current.setDoc(edited)
      useUnsavedChangesStore.getState().setDirty(true)
      save2 = result.current.saveDoc('CH', edited)
    })
    // The chained save must not reach the store while save 1 is in flight.
    expect(h.saveGates).toHaveLength(0)

    await act(async () => { releaseShot(null) })
    expect(h.saveGates).toHaveLength(1)
    await act(async () => { h.saveGates[0].resolve(undefined) })
    const ok1 = await save1
    expect(ok1).toBe(true)
    // Save 1 landed its PRE-EDIT bytes; the edit postdates them, so the dirty
    // flag survives even though a newer save is queued.
    expect(h.saves[0].content).not.toContain('EDITED')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    await act(async () => { h.saveGates[1].resolve(undefined) })
    const ok2 = await save2
    expect(ok2).toBe(true)
    expect(h.saves).toHaveLength(2)
    expect(h.saves[1].content).toContain('EDITED')
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // A failed store write is reported, not swallowed: the caller keys its exit
  // guard off the boolean, and the page shows the error banner.
  it('returns false and surfaces the error when the store save rejects', async () => {
    const { result } = renderHook(() => useAssemblyDoc('SF'))
    await tick()
    await act(async () => { h.loads.SF.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()

    // A failed write must leave the dirty flag set: clearing it would let the
    // exit guard walk away from edits the store never accepted.
    useUnsavedChangesStore.getState().setDirty(true)
    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('SF', result.current.doc!)
    })
    await act(async () => { h.saveGates[0].reject(new Error('disk full')) })

    expect(await savePromise).toBe(false)
    expect(result.current.error).toBe('disk full')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('renames the document and reflects the new name without a reload', async () => {
    const { result } = renderHook(() => useAssemblyDoc(undefined))

    let renamePromise!: Promise<boolean>
    await act(async () => {
      renamePromise = result.current.renameDoc('R', 'Renamed bracket')
    })
    await act(async () => { h.renameGates[0].resolve(undefined) })

    expect(await renamePromise).toBe(true)
    expect(h.renames[0]).toEqual({ uuid: 'R', name: 'Renamed bracket' })
    expect(result.current.docName).toBe('Renamed bracket')
    expect(result.current.error).toBeNull()
  })

  it('returns false and surfaces the error when the store rename rejects', async () => {
    const { result } = renderHook(() => useAssemblyDoc(undefined))

    let renamePromise!: Promise<boolean>
    await act(async () => {
      renamePromise = result.current.renameDoc('R', 'Taken')
    })
    await act(async () => { h.renameGates[0].reject(new Error('name already exists')) })

    expect(await renamePromise).toBe(false)
    expect(result.current.error).toBe('name already exists')
    // The visible name must not advance to a name the store rejected.
    expect(result.current.docName).toBe('')
  })

  // Previews are keyed by (workspace, entry) so a multi-document workspace's
  // tile and picker read the same record the save wrote; only the base64 half
  // of the data URL is stored.
  it('stores the screenshot preview under the workspace and uuid on save', async () => {
    const { result } = renderHook(() => useAssemblyDoc('SP', 'ws1'))
    await tick()
    await act(async () => { h.loads.SP.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('SP', result.current.doc!, async () => 'data:image/png;base64,SHOT')
    })
    await act(async () => { h.saveGates[0].resolve(undefined) })

    expect(await savePromise).toBe(true)
    expect(h.previewPut).toHaveBeenCalledWith('ws1', 'SP', 'SHOT')
  })

  it('falls back to the uuid as the preview workspace when none is given', async () => {
    const { result } = renderHook(() => useAssemblyDoc('SP2'))
    await tick()
    await act(async () => { h.loads.SP2.resolve({ content: 'kind: assembly\nfeatures: []', name: 'Asm' }) })
    await tick()

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('SP2', result.current.doc!, async () => 'data:image/png;base64,X')
    })
    await act(async () => { h.saveGates[0].resolve(undefined) })

    expect(await savePromise).toBe(true)
    expect(h.previewPut).toHaveBeenCalledWith('SP2', 'SP2', 'X')
  })
})
