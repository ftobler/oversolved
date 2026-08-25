import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS, useDocumentState } from '@/hooks/useDocumentState'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }))
vi.mock('@/adapters/documentLoad', () => ({ loadDocumentAnyDomain: loadMock }))

// Deferred store save: a manual save spends multiple awaits (screenshot, then
// the network), so tests need to hold the save open while an edit lands.
const h = vi.hoisted(() => {
  const makeGate = () => {
    let resolve!: (v: unknown) => void
    const promise = new Promise((res) => { resolve = res })
    return { promise, resolve }
  }
  return {
    makeGate,
    saveGates: [] as ReturnType<typeof makeGate>[],
  }
})

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      save: () => {
        const gate = h.makeGate()
        h.saveGates.push(gate)
        return gate.promise
      },
    },
  },
}))

import { backendBundle } from '@/adapters/backend'

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
    loadMock.mockResolvedValue({ data: { content, name: 'Legacy Transform' }, store: {} })
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
    loadMock.mockResolvedValue({ data: { content, name: 'Legacy Delete' }, store: {} })
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
    useUnsavedChangesStore.getState().setDirty(false)
  })

  const loadSimpleDoc = async () => {
    loadMock.mockResolvedValue({ data: { content: 'name: S', name: 'S' }, store: backendBundle.documents })
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
})
