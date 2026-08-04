import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS, useDocumentState } from '@/hooks/useDocumentState'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }))
vi.mock('@/adapters/documentLoad', () => ({ loadDocumentAnyDomain: loadMock }))

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
