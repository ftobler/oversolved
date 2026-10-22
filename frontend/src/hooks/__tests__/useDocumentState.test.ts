import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS, useDocumentState } from '@/hooks/useDocumentState'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { editorState } from '@/stores/editorState'
import {
  requestRecoveryRestore,
  resetRecoveryRestore,
  takeRecoveryRestore,
} from '@/recovery/restore'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

// Deferred store save: a manual save spends multiple awaits (screenshot, then
// the network), so tests need to hold the save open while an edit lands.
const h = vi.hoisted(() => {
  const loadMock = vi.fn()
  const makeGate = () => {
    let resolve!: (v: unknown) => void
    const promise = new Promise((res) => { resolve = res })
    return { promise, resolve }
  }
  return {
    loadMock,
    makeGate,
    renameMock: vi.fn(),
    saveGates: [] as ReturnType<typeof makeGate>[],
    bodies: [] as string[],
    failSave: false,
  }
})

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: (uuid: string) => h.loadMock(uuid),
      save: (_uuid: string, input: { content: string }) => {
        if (h.failSave) return Promise.reject(new Error('disk full'))
        const gate = h.makeGate()
        h.bodies.push(input.content)
        h.saveGates.push(gate)
        return gate.promise
      },
      rename: (uuid: string, name: string) => h.renameMock(uuid, name),
    },
  },
}))

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('BUILTIN_FEATURE_DEFAULTS', () => {
  it('contains the four standard built-in features', () => {
    expect(BUILTIN_FEATURE_DEFAULTS).toHaveLength(4)
  })

  it('includes Origin, Top, Front, Right', () => {
    const ids = BUILTIN_FEATURE_DEFAULTS.map(f => f.id).sort()
    expect(ids).toEqual(['Front', 'Origin', 'Right', 'Top'])
  })

  it('has correct kinds', () => {
    const origin = BUILTIN_FEATURE_DEFAULTS.find(f => f.id === 'Origin')
    expect(origin?.kind).toBe('origin')
    const planes = BUILTIN_FEATURE_DEFAULTS.filter(f => f.id !== 'Origin')
    expect(planes.every(p => p.kind === 'plane')).toBe(true)
  })
})

describe('BUILTIN_FEATURE_IDS', () => {
  it('is a Set of the same four IDs', () => {
    expect(BUILTIN_FEATURE_IDS.size).toBe(4)
    expect(BUILTIN_FEATURE_IDS.has('Origin')).toBe(true)
    expect(BUILTIN_FEATURE_IDS.has('Top')).toBe(true)
    expect(BUILTIN_FEATURE_IDS.has('Front')).toBe(true)
    expect(BUILTIN_FEATURE_IDS.has('Right')).toBe(true)
  })

  it('does not contain arbitrary IDs', () => {
    expect(BUILTIN_FEATURE_IDS.has('S1')).toBe(false)
    expect(BUILTIN_FEATURE_IDS.has('extrude1')).toBe(false)
  })
})

// The load seam self-heal: a pre-pluralization transform/delete_body doc carries
// the singular `body` key. migrateLegacyBodyPicks runs beside dropDeadAxisConstraints
// on every load, so the loaded doc is plural before it reaches the tree and solver.
describe('useDocumentState legacy body pick migration at load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('rewrites a legacy singular transform body to bodies and re-solves the migrated doc', async () => {
    const content = `version: 1
kind: part
features:
  - id: t1
    kind: transform
    transform:
      body: "@body_ex1"
      operation: new
      translation: [0, 0, 0]
      rotation_angle: 0
      scale: 1
`
    h.loadMock.mockResolvedValue({ content, name: 'Legacy Transform' })
    const reSolveRef = { current: vi.fn() }
    const { result } = renderHook(() => useDocumentState('L', reSolveRef, { solveOnLoad: true }))
    await tick()

    const sub = result.current.doc!.features![0] as unknown as { transform: { bodies: string[]; body?: string } }
    expect(sub.transform.bodies).toEqual(['@body_ex1'])
    expect('body' in sub.transform).toBe(false)
    // The self-heal predates user intent, so the doc still starts clean.
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    // The first solve receives the MIGRATED doc, not the raw legacy one.
    expect(reSolveRef.current).toHaveBeenCalledTimes(1)
    expect(reSolveRef.current).toHaveBeenCalledWith(result.current.doc)
  })

  it('rewrites a legacy singular delete_body body the same way', async () => {
    const content = `version: 1
kind: part
features:
  - id: db1
    kind: delete_body
    delete_body:
      body: "@body_ex1"
`
    h.loadMock.mockResolvedValue({ content, name: 'Legacy Delete' })
    // Stable ref: a fresh object per render would re-trigger the load effect and
    // the test would spin.
    const reSolveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('L', reSolveRef, { solveOnLoad: false }))
    await tick()

    const sub = result.current.doc!.features![0] as unknown as { delete_body: { bodies: string[]; body?: string } }
    expect(sub.delete_body.bodies).toEqual(['@body_ex1'])
    expect('body' in sub.delete_body).toBe(false)
  })
})

// The manual save is the sole persistence point and beforeunload reads the dirty
// flag, so a save must only clear that flag when the document it serialized is
// still the current one: an edit landing inside the save's async windows
// postdates the stored bytes and must keep the reload warning alive.
describe('useDocumentState saveDoc vs concurrent edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.saveGates = []
    h.bodies = []
    useUnsavedChangesStore.getState().setDirty(false)
  })

  const loadSimpleDoc = async () => {
    h.loadMock.mockResolvedValue({ content: 'name: S', name: 'S' })
    const reSolveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('S', reSolveRef, { solveOnLoad: false }))
    await tick()
    return result
  }

  it('keeps the dirty flag when an edit lands between the screenshot and the save resolving', async () => {
    const result = await loadSimpleDoc()

    let releaseScreenshot!: (value: string | null) => void
    const screenshotGate = new Promise<string | null>(resolve => { releaseScreenshot = resolve })
    const screenshot = vi.fn(() => screenshotGate)

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('S', result.current.doc!, screenshot)
    })
    // The bytes were serialized synchronously; the save is parked on the shot.
    expect(screenshot).toHaveBeenCalledTimes(1)
    expect(h.saveGates).toHaveLength(0)
    await act(async () => { releaseScreenshot(null) })
    expect(h.saveGates).toHaveLength(1)

    // What handleMutation does during the real windows: installs a fresh doc
    // object and re-flags dirty.
    await act(async () => {
      const edited = { ...result.current.doc! }
      result.current.docRef.current = edited
      result.current.setDoc(edited)
      useUnsavedChangesStore.getState().setDirty(true)
    })

    await act(async () => { h.saveGates[0].resolve(undefined) })
    const ok = await savePromise
    expect(ok).toBe(true)
    // The saved bytes predate the edit above, so the warning must survive.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('clears the dirty flag when nothing was edited during the save', async () => {
    const result = await loadSimpleDoc()
    useUnsavedChangesStore.getState().setDirty(true)

    let savePromise!: Promise<boolean>
    await act(async () => {
      savePromise = result.current.saveDoc('S', result.current.doc!)
    })
    await act(async () => { h.saveGates[0].resolve(undefined) })
    const ok = await savePromise
    expect(ok).toBe(true)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('chains an overlapping save so the newer bytes land after the stale ones', async () => {
    // The old-world failure (review-18 ST-M1): save 1 snapshots pre-edit
    // bytes, save 2 carries the edited ones, and inverted completion let the
    // STALE PUT land last under dirty=false. Single-flight chaining makes
    // arrival order the landing order instead.
    const result = await loadSimpleDoc()

    let releaseShot!: (value: string | null) => void
    const shotGate = new Promise<string | null>(resolve => { releaseShot = resolve })

    let save1!: Promise<boolean>
    await act(async () => {
      save1 = result.current.saveDoc('S', result.current.doc!, vi.fn(() => shotGate))
    })
    expect(h.saveGates).toHaveLength(0)  // parked on the screenshot, no PUT yet

    // The edit lands mid-flight and a second save fires while save 1 holds
    // the slot.
    let save2!: Promise<boolean>
    await act(async () => {
      const edited = { ...result.current.doc!, name: 'V2' }
      result.current.docRef.current = edited
      result.current.setDoc(edited)
      useUnsavedChangesStore.getState().setDirty(true)
      save2 = result.current.saveDoc('S', edited)
    })
    // The chained save must not reach the store while save 1 is in flight.
    expect(h.saveGates).toHaveLength(0)
    expect(h.bodies).toHaveLength(0)

    await act(async () => { releaseShot(null) })
    expect(h.saveGates).toHaveLength(1)
    await act(async () => { h.saveGates[0].resolve(undefined) })
    const ok1 = await save1
    expect(ok1).toBe(true)
    // Save 1 landed its PRE-EDIT bytes; the edit postdates them, so the dirty
    // flag must survive this completion even though a newer save is queued.
    expect(h.bodies[0]).not.toContain('V2')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    await act(async () => { h.saveGates[1].resolve(undefined) })
    const ok2 = await save2
    expect(ok2).toBe(true)
    // Only now is the store holding the latest bytes AND memory current:
    // exactly at this point may dirty end false.
    expect(h.bodies).toHaveLength(2)
    expect(h.bodies[1]).toContain('V2')
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })
})

// The load seam is the last point before the first solve: the editor store's
// rollback must already describe the document being solved, or a null fresh
// session means "bar at the end" and the load rebuilds rolled-back features.
describe('useDocumentState mirrors the parked rollback before solving', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    editorState.getState().resetEditorState()
    resetRecoveryRestore()
  })

  it('syncs a loaded document bar before the first solve', async () => {
    h.loadMock.mockResolvedValue({
      content: `version: 1
kind: part
rollback: 1
features:
  - id: sk1
    kind: sketch
  - id: sk2
    kind: sketch
`,
      name: 'Parked',
    })
    const seenAtSolve: Array<number | null> = []
    const reSolveRef = { current: vi.fn(() => {
      seenAtSolve.push(editorState.getState().rollbackPosition)
    }) }
    renderHook(() => useDocumentState('P', reSolveRef, { solveOnLoad: true }))
    await tick()

    expect(seenAtSolve).toEqual([1])
  })

  it('syncs a recovery snapshot bar before the first solve', async () => {
    h.loadMock.mockResolvedValue({ content: 'version: 1\nkind: part\nfeatures: []\n', name: 'Stored' })
    const restored = makeDoc(makeSketch('a'), makeSketch('b'))
    restored.rollback = 1
    requestRecoveryRestore({ docId: 'P', doc: restored })
    const seenAtSolve: Array<number | null> = []
    const reSolveRef = { current: vi.fn(() => {
      seenAtSolve.push(editorState.getState().rollbackPosition)
    }) }
    renderHook(() => useDocumentState('P', reSolveRef, { solveOnLoad: true }))
    await tick()

    expect(seenAtSolve).toEqual([1])
  })
})

// The open-time offer's accept path: the parked journal snapshot replaces the
// store's bytes in memory, starts dirty (it is unsaved by definition) and is
// solved like any other load. Nothing is written, so a reload still offers it.
describe('useDocumentState recovery restore at load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRecoveryRestore()
    useUnsavedChangesStore.getState().clearForNewDocument()
  })

  it('adopts the parked snapshot, marks it dirty and solves it', async () => {
    h.loadMock.mockResolvedValue({ content: 'version: 1\nkind: part\nfeatures: []\n', name: 'Stored' })
    const restored = makeDoc(makeSketch('restored'))
    requestRecoveryRestore({ docId: 'R', doc: restored })
    const reSolveRef = { current: vi.fn() }
    const { result } = renderHook(() => useDocumentState('R', reSolveRef, { solveOnLoad: true }))
    await tick()

    expect(result.current.doc).toEqual(restored)
    expect(result.current.docRef.current).toEqual(restored)
    expect(result.current.docName).toBe('Stored')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(reSolveRef.current).toHaveBeenCalledWith(restored)
    // Single use: the handoff is consumed, so a remount reads stored bytes.
    expect(takeRecoveryRestore('R')).toBeNull()
  })

  it('ignores a snapshot parked for another document', async () => {
    h.loadMock.mockResolvedValue({ content: 'version: 1\nkind: part\nfeatures: []\n', name: 'Stored' })
    requestRecoveryRestore({ docId: 'other', doc: makeDoc(makeSketch('other')) })
    const reSolveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('R', reSolveRef, { solveOnLoad: false }))
    await tick()

    // The stored text had no features, so the load added the built-ins: proof
    // the store's bytes were adopted, not the parked snapshot.
    expect(result.current.doc?.features?.map(f => f.id)).toEqual(['Origin', 'Top', 'Front', 'Right'])
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('does not adopt a parked snapshot when the stored document fails validation', async () => {
    // The restore sits behind the loader, so the loader's refusal stays
    // authoritative: the failure keeps its structured report and the snapshot
    // is not adopted over it. The handoff stays parked for a later successful
    // load of the same document.
    const content = 'version: 1\nkind: part\nfeatures:\n  - id: ex1\n    kind: extrude\n    extrude:\n      distance: .nan\n'
    h.loadMock.mockResolvedValue({ content, name: 'Bracket' })
    const restored = makeDoc(makeSketch('restored'))
    requestRecoveryRestore({ docId: 'V', doc: restored })
    const reSolveRef = { current: vi.fn() }
    const { result } = renderHook(() => useDocumentState('V', reSolveRef, { solveOnLoad: true }))
    await tick()

    expect(result.current.doc).toBeNull()
    expect(result.current.error).toContain('features[0].extrude.distance')
    expect(result.current.loadFailure).not.toBeNull()
    expect(reSolveRef.current).not.toHaveBeenCalled()
    expect(takeRecoveryRestore('V')).toEqual(restored)
  })
})

describe('useDocumentState load and operation failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.failSave = false
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('surfaces a load failure and stops loading', async () => {
    h.loadMock.mockRejectedValue(new Error('corrupt document'))
    const reSolveRef = { current: vi.fn() }
    const { result } = renderHook(() => useDocumentState('E', reSolveRef, { solveOnLoad: true }))
    await tick()

    expect(result.current.error).toBe('corrupt document')
    expect(result.current.loading).toBe(false)
    expect(result.current.doc).toBeNull()
    // The failed load must not be handed to the solver.
    expect(reSolveRef.current).not.toHaveBeenCalled()
  })

  it('reports a validation failure by field and keeps the raw text for the raw view', async () => {
    const content = 'version: 1\nkind: part\nfeatures:\n  - id: ex1\n    kind: extrude\n    extrude:\n      distance: .nan\n'
    h.loadMock.mockResolvedValue({ content, name: 'Bracket' })
    const reSolveRef = { current: vi.fn() }
    const { result } = renderHook(() => useDocumentState('V', reSolveRef, { solveOnLoad: true }))
    await tick()

    expect(result.current.doc).toBeNull()
    expect(result.current.error).toContain('features[0].extrude.distance')
    expect(result.current.loadFailure?.docName).toBe('Bracket')
    expect(result.current.loadFailure?.rawText).toBe(content)
    expect(result.current.loading).toBe(false)
    // A refused document is never handed to the solver.
    expect(reSolveRef.current).not.toHaveBeenCalled()
  })

  it('clears a previous load error when a later load succeeds', async () => {
    h.loadMock.mockRejectedValueOnce(new Error('first load failed'))
    const reSolveRef = { current: null }
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDocumentState(id, reSolveRef, { solveOnLoad: false }),
      { initialProps: { id: 'A' } },
    )
    await tick()
    expect(result.current.error).toBe('first load failed')

    h.loadMock.mockResolvedValueOnce({ content: 'name: B', name: 'B' })
    rerender({ id: 'B' })
    await tick()

    expect(result.current.error).toBeNull()
    expect(result.current.docName).toBe('B')
  })

  it('drops the previous document when a later load fails', async () => {
    h.loadMock.mockResolvedValueOnce({ content: 'name: A', name: 'A' })
    const reSolveRef = { current: null }
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDocumentState(id, reSolveRef, { solveOnLoad: false }),
      { initialProps: { id: 'A' } },
    )
    await tick()
    expect(result.current.docName).toBe('A')

    h.loadMock.mockRejectedValueOnce(new Error('B is corrupt'))
    rerender({ id: 'B' })
    await tick()

    expect(result.current.error).toBe('B is corrupt')
    expect(result.current.doc).toBeNull()
    expect(result.current.docRef.current).toBeNull()
    expect(result.current.docName).toBe('')
  })

  it('ignores a superseded load that resolves after a newer one', async () => {
    const resolveLoad: Record<string, (v: unknown) => void> = {}
    h.loadMock.mockImplementation((uuid: string) =>
      new Promise(resolve => { resolveLoad[uuid] = resolve }),
    )
    const reSolveRef = { current: null }
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDocumentState(id, reSolveRef, { solveOnLoad: false }),
      { initialProps: { id: 'A' } },
    )
    await tick()

    rerender({ id: 'B' })
    await tick()

    // B lands first; the stale A resolution arrives afterwards and must not
    // overwrite the newer document.
    await act(async () => { resolveLoad.B({ content: 'name: B', name: 'B' }) })
    await tick()
    await act(async () => { resolveLoad.A({ content: 'name: A', name: 'A' }) })
    await tick()

    expect(result.current.docName).toBe('B')
  })

  it('reports a save failure and returns false', async () => {
    h.loadMock.mockResolvedValue({ content: 'name: S', name: 'S' })
    const reSolveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('S', reSolveRef, { solveOnLoad: false }))
    await tick()

    h.failSave = true
    let ok!: boolean
    await act(async () => { ok = await result.current.saveDoc('S', result.current.doc!) })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('disk full')
  })

  it('renameDoc updates the name on success and reports failure', async () => {
    h.loadMock.mockResolvedValue({ content: 'name: S', name: 'S' })
    const reSolveRef = { current: null }
    const { result } = renderHook(() => useDocumentState('S', reSolveRef, { solveOnLoad: false }))
    await tick()

    h.renameMock.mockResolvedValue(undefined)
    await act(async () => { await result.current.renameDoc('S', 'Renamed') })
    expect(result.current.docName).toBe('Renamed')

    h.renameMock.mockRejectedValue(new Error('locked'))
    let ok!: boolean
    await act(async () => { ok = await result.current.renameDoc('S', 'Other') })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('locked')
  })
})

// The section is a momentary inspection view: opening a document starts uncut
// rather than inheriting a plane whose picked face may not exist in the new one.
describe('useDocumentState section reset on load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  })

  it('turns the section off when a document loads', async () => {
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, offset: 12 })
    h.loadMock.mockResolvedValue({ content: 'version: 1\nkind: part\nfeatures: []\n', name: 'Fresh' })

    renderHook(() => useDocumentState('S', { current: vi.fn() }, { solveOnLoad: false }))

    expect(useSectionStore.getState().enabled).toBe(false)
    expect(useSectionStore.getState().offset).toBe(0)
  })
})
