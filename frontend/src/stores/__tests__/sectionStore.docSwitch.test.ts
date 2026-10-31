// The section is a momentary inspection view, not a saved view: a document
// loaded after another one starts uncut. Its source may name a face that only
// existed in the previous document, so keeping it would show a stale cut or a
// "source gone" reason the user never asked for.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDocumentState } from '@/hooks/useDocumentState'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

const h = vi.hoisted(() => ({ loadMock: vi.fn() }))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: (uuid: string) => h.loadMock(uuid),
      save: vi.fn(),
      rename: vi.fn(),
    },
  },
}))

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

describe('sectionStore across a document switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSectionStore.setState({
      ...DEFAULT_SECTION_STATE,
      enabled: true,
      plane: { kind: 'query', query: '?04;face', pickKey: 'ex1/body_ex1#face#0' },
      offset: 12,
      picking: true,
      pickError: 'stale',
    })
  })

  it('clears the source, offset and armed pick when another document loads', async () => {
    h.loadMock.mockResolvedValue({ content: 'version: 1\nkind: part\nfeatures: []\n', name: 'Next' })
    const reSolveRef = { current: vi.fn() }

    renderHook(() => useDocumentState('Next', reSolveRef, { solveOnLoad: false }))
    await tick()

    const state = useSectionStore.getState()
    expect(state.enabled).toBe(false)
    expect(state.plane).toEqual({ kind: 'builtin', id: 'front' })
    expect(state.offset).toBe(0)
    expect(state.picking).toBe(false)
    expect(state.pickError).toBeNull()
  })
})
