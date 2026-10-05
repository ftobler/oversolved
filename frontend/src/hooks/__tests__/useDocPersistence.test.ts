// Direct coverage for the persistence seam both editors now share. The
// per-editor suites exercise saveDoc/renameDoc/cloneDoc through their hooks;
// these pin the mechanism itself, so the extraction cannot quietly weaken the
// single-flight chain or the identity-guarded dirty retention.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { PartDoc } from '@/types/cad'

const h = vi.hoisted(() => {
  const makeGate = () => {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  return {
    makeGate,
    saveGates: [] as ReturnType<typeof makeGate>[],
    saves: [] as Array<{ uuid: string; content: string }>,
    renameGates: [] as ReturnType<typeof makeGate>[],
    renames: [] as Array<{ uuid: string; name: string }>,
    clones: [] as Array<[uuid: string, name?: string]>,
    previewPut: vi.fn(async () => {}),
  }
})

vi.mock('@/stores/previewStore', () => ({
  getPreviewStore: () => ({ put: h.previewPut }),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(),
      save: (uuid: string, body: { content: string }) => {
        const gate = h.makeGate()
        h.saveGates.push(gate)
        h.saves.push({ uuid, ...body })
        return gate.promise
      },
      rename: (uuid: string, name: string) => {
        const gate = h.makeGate()
        h.renameGates.push(gate)
        h.renames.push({ uuid, name })
        return gate.promise
      },
      clone: (...args: [uuid: string, name?: string]) => {
        h.clones.push(args)
        return Promise.resolve({ uuid: `${args[0]}-copy` })
      },
    },
  },
}))

import { useDocPersistence } from '@/hooks/useDocPersistence'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

describe('useDocPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.saveGates = []
    h.saves = []
    h.renameGates = []
    h.renames = []
    h.clones = []
    useUnsavedChangesStore.getState().setDirty(false)
  })

  const renderPersist = (workspace?: string) => {
    const docRef = { current: { version: 1, kind: 'part', features: [] } as unknown as PartDoc }
    const setError = vi.fn()
    const setDocName = vi.fn()
    const view = renderHook(() => useDocPersistence<PartDoc>({ docRef, setError, setDocName, workspace }))
    return { ...view, docRef, setError, setDocName }
  }

  it('keeps the dirty flag when the doc identity changes during the save', async () => {
    const { result, docRef } = renderPersist()

    let releaseScreenshot!: (value: string | null) => void
    const shotGate = new Promise<string | null>(resolve => { releaseScreenshot = resolve })

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('S', docRef.current!, vi.fn(() => shotGate))
    })
    expect(h.saveGates).toHaveLength(0)

    await act(async () => { releaseScreenshot(null) })
    expect(h.saveGates).toHaveLength(1)

    // A mutation installs a fresh doc object and re-flags dirty mid-save.
    await act(async () => {
      docRef.current = { ...docRef.current!, version: 2 }
      useUnsavedChangesStore.getState().setDirty(true)
    })

    await act(async () => { h.saveGates[0].resolve(undefined) })
    expect(await savePromise).toBe(true)
    // The saved bytes predate the edit, so the warning must survive.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('clears the dirty flag when no edit landed during the save', async () => {
    const { result, docRef } = renderPersist()
    useUnsavedChangesStore.getState().setDirty(true)

    let savePromise!: Promise<boolean>
    await act(async () => { savePromise = result.current.saveDoc('S', docRef.current!) })
    await act(async () => { h.saveGates[0].resolve(undefined) })
    expect(await savePromise).toBe(true)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('chains overlapping saves so arrival order is landing order', async () => {
    const { result, docRef } = renderPersist()

    let releaseShot!: (value: string | null) => void
    const shotGate = new Promise<string | null>(resolve => { releaseShot = resolve })

    let save1!: Promise<boolean>
    await act(async () => {
      save1 = result.current.saveDoc('S', docRef.current!, vi.fn(() => shotGate))
    })
    expect(h.saveGates).toHaveLength(0)

    // The edit lands and a second save fires while save 1 holds the slot.
    let save2!: Promise<boolean>
    await act(async () => {
      docRef.current = { ...docRef.current!, version: 2 }
      save2 = result.current.saveDoc('S', docRef.current!)
    })
    expect(h.saveGates).toHaveLength(0)

    await act(async () => { releaseShot(null) })
    expect(h.saveGates).toHaveLength(1)
    await act(async () => { h.saveGates[0].resolve(undefined) })
    expect(await save1).toBe(true)

    await act(async () => { h.saveGates[1].resolve(undefined) })
    expect(await save2).toBe(true)
    expect(h.saves).toHaveLength(2)
    expect(h.saves[0].content).not.toContain('version: 2')
    expect(h.saves[1].content).toContain('version: 2')
  })

  it('returns false and surfaces the error when the write rejects', async () => {
    const { result, docRef, setError } = renderPersist()
    useUnsavedChangesStore.getState().setDirty(true)

    let savePromise!: Promise<boolean>
    await act(async () => { savePromise = result.current.saveDoc('S', docRef.current!) })
    await act(async () => { h.saveGates[0].reject(new Error('disk full')) })

    expect(await savePromise).toBe(false)
    expect(setError).toHaveBeenCalledWith('disk full')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  // The chain slot is released in a finally, so a rejected save must not wedge
  // the queue: a save started behind it still reaches the store.
  it('lets a save queued behind a rejected save proceed', async () => {
    const { result, docRef } = renderPersist()

    let save1!: Promise<boolean>
    await act(async () => { save1 = result.current.saveDoc('S', docRef.current!) })
    let save2!: Promise<boolean>
    await act(async () => { save2 = result.current.saveDoc('S', docRef.current!) })
    // Save 2 is queued behind save 1, so neither has reached the store yet.
    expect(h.saveGates).toHaveLength(1)

    await act(async () => { h.saveGates[0].reject(new Error('disk full')) })
    expect(await save1).toBe(false)

    // The finally release lets the queued save proceed to its own store write.
    await act(async () => {})
    expect(h.saveGates).toHaveLength(2)
    await act(async () => { h.saveGates[1].resolve(undefined) })
    expect(await save2).toBe(true)
    expect(h.saves).toHaveLength(2)
  })

  it('stores the preview under the workspace and uuid, falling back to the uuid', async () => {
    const withWs = renderPersist('ws1')
    let save1!: Promise<boolean>
    await act(async () => {
      save1 = withWs.result.current.saveDoc('S', withWs.docRef.current!, async () => 'data:image/png;base64,SHOT')
    })
    await act(async () => { h.saveGates[0].resolve(undefined) })
    expect(await save1).toBe(true)
    expect(h.previewPut).toHaveBeenCalledWith('ws1', 'S', 'SHOT')

    h.previewPut.mockClear()
    const noWs = renderPersist()
    let save2!: Promise<boolean>
    await act(async () => {
      save2 = noWs.result.current.saveDoc('S2', noWs.docRef.current!, async () => 'data:image/png;base64,X')
    })
    await act(async () => { h.saveGates[1].resolve(undefined) })
    expect(await save2).toBe(true)
    expect(h.previewPut).toHaveBeenCalledWith('S2', 'S2', 'X')
  })

  it('renames on success and reports failure without advancing the name', async () => {
    const { result, setDocName, setError } = renderPersist()

    let rename1!: Promise<boolean>
    await act(async () => { rename1 = result.current.renameDoc('S', 'Renamed') })
    await act(async () => { h.renameGates[0].resolve(undefined) })
    expect(await rename1).toBe(true)
    expect(h.renames[0]).toEqual({ uuid: 'S', name: 'Renamed' })
    expect(setDocName).toHaveBeenCalledWith('Renamed')

    setDocName.mockClear()
    let rename2!: Promise<boolean>
    await act(async () => { rename2 = result.current.renameDoc('S', 'Taken') })
    await act(async () => { h.renameGates[1].reject(new Error('locked')) })
    expect(await rename2).toBe(false)
    expect(setError).toHaveBeenCalledWith('locked')
    expect(setDocName).not.toHaveBeenCalled()
  })

  it('forwards the clone name for the part path and keeps the one-arg call for the assembly path', async () => {
    const { result } = renderPersist()
    const named = await result.current.cloneDoc('SRC', 'copy name')
    const anonymous = await result.current.cloneDoc('ASM')
    // The assembly path must keep store.clone(id) exactly: an explicit undefined
    // second argument changed the call arity and broke the assembly seam once.
    expect(h.clones).toEqual([['SRC', 'copy name'], ['ASM']])
    expect(named).toEqual({ uuid: 'SRC-copy' })
    expect(anonymous).toEqual({ uuid: 'ASM-copy' })
  })
})
