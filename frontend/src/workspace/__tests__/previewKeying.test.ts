import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDocumentState } from '@/hooks/useDocumentState'
import { getPreviewStore } from '@/stores/previewStore'
import { IdbWorkspaceStore } from '../store'
import { resetWorkspaceIdb } from './idbHarness'

// Previews are keyed by (workspace, entry). The save hook writes that pair, the
// U1 tile and the part picker read it, and purge clears it by workspace prefix.
// A C2-era (entry, entry) write would leave every multi-document tile blank and
// every purge leaking.

const h = vi.hoisted(() => ({ loadMock: vi.fn(), saveMock: vi.fn() }))

vi.mock('@/adapters/backend', () => ({
  backendBundle: { documents: { load: h.loadMock, save: h.saveMock } },
}))

const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

describe('document previews are keyed by (workspace, entry)', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    vi.clearAllMocks()
  })

  it('a save writes the workspace key and purge clears it', async () => {
    h.loadMock.mockResolvedValue({ content: 'kind: part\n', name: 'P' })
    h.saveMock.mockResolvedValue(undefined)
    const reSolveRef = { current: null }
    const { result } = renderHook(() =>
      useDocumentState('entry-1', reSolveRef, { solveOnLoad: false, workspace: 'ws-1' }),
    )
    await tick()

    const screenshot = vi.fn(async () => 'data:image/png;base64,QUJD')
    await act(async () => {
      await result.current.saveDoc('entry-1', result.current.doc!, screenshot)
    })

    expect(await getPreviewStore().get('ws-1', 'entry-1')).toBe('QUJD')
    // The old (entry, entry) key is never written, so purge cannot leak it.
    expect(await getPreviewStore().get('entry-1', 'entry-1')).toBeUndefined()

    await new IdbWorkspaceStore().purge('ws-1')
    expect(await getPreviewStore().get('ws-1', 'entry-1')).toBeUndefined()
  })
})

describe('copies carry the source preview', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
  })

  it('a cloned entry gets its source thumbnail under the new id', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Widget', { docKind: 'part' })
    const [source] = await store.listEntries(workspace)
    await getPreviewStore().put(workspace, source.id, 'SU1H')

    const cloneId = await store.cloneEntry(workspace, source.id)

    expect(cloneId).not.toBe(source.id)
    expect(await getPreviewStore().get(workspace, cloneId)).toBe('SU1H')
  })

  it('a duplicated workspace gets its thumbnails under the new ids and workspace', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Widget', { docKind: 'part' })
    const [source] = await store.listEntries(workspace)
    await getPreviewStore().put(workspace, source.id, 'SU1H')

    const { workspace: copy } = await store.duplicate(workspace)
    const [copied] = await store.listEntries(copy)

    expect(copied.id).not.toBe(source.id)
    expect(await getPreviewStore().get(copy, copied.id)).toBe('SU1H')
    // The source key is untouched: a copy does not move its preview.
    expect(await getPreviewStore().get(workspace, source.id)).toBe('SU1H')
  })
})
