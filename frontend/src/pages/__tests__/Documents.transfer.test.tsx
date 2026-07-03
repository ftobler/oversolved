import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { freshLocalDb, renderDocuments, gotoCloudDomain } from './documentsHarness'
import { getLocalStore } from '@/stores/documentStore'

// doc-domain-move slice 4: the per-tile cross-domain copy verbs. Home is the
// local IndexedDB library; the cloud domain is the HTTP store (backed here by the
// fetch stub). Copy is a one-way mirror -- the source stays put on its side.

// A complete fake Response: checkResponse() reads .text() on a non-ok body, so a
// bare { ok, json } is not enough.
function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok, status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}

const authOk = res({ user: { id: 1, username: 'admin', must_change_password: false } })
const prefsOk = res({ document_sort: 'date_newest_first' })

describe('Documents cross-domain copy', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
  })

  // No global RTL auto-cleanup in this setup, so unmount between tests --
  // otherwise a prior test's mounted Documents lingers and confuses queries.
  afterEach(() => {
    cleanup()
  })

  it('Copy to Cloud pushes a local tile up to the cloud store', async () => {
    const local = getLocalStore()
    const { uuid } = await local.create('Bracket')
    await local.save(uuid, { content: 'profile: square' })

    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url === '/api/documents' && init?.method === 'POST') return Promise.resolve(res({ uuid: 'cloud-new' }))
      if (url.startsWith('/api/documents/') && init?.method === 'PUT') return Promise.resolve(res({}))
      // The cloud list is never reached on the local domain.
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    // The local home tile renders, and -- signed in, so the cloud domain exists --
    // it offers Copy to Cloud.
    const copyBtn = await screen.findByTitle('Copy to Cloud')
    fireEvent.click(copyBtn)

    await waitFor(() => {
      // create (POST /api/documents) then save (PUT /api/documents/cloud-new).
      expect(fetchMock).toHaveBeenCalledWith('/api/documents', expect.objectContaining({ method: 'POST' }))
      expect(fetchMock).toHaveBeenCalledWith('/api/documents/cloud-new', expect.objectContaining({ method: 'PUT' }))
    })

    // The source local tile stays put (a copy, not a move).
    expect(screen.getByText('local/Bracket')).toBeInTheDocument()
    expect((await local.load(uuid)).content).toBe('profile: square')
  })

  it('Copy to Local pulls a cloud tile down into the local store', async () => {
    const fetchMock = vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url.startsWith('/api/documents/c1')) return Promise.resolve(res({ content: 'profile: circle', name: 'CloudDoc' }))
      if (url.startsWith('/api/documents')) {
        return Promise.resolve(res({
          documents: [{
            uuid: 'c1', name: 'CloudDoc', created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z', is_owner: true, owner_username: 'admin',
          }],
        }))
      }
      return Promise.resolve(res({}, false, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()
    await gotoCloudDomain()

    await waitFor(() => expect(screen.getByText('admin/CloudDoc')).toBeInTheDocument())

    const copyBtn = screen.getByTitle('Copy to Local')
    fireEvent.click(copyBtn)

    // The pulled copy now lives in the local home library.
    await waitFor(async () => {
      const localDocs = await getLocalStore().list()
      expect(localDocs.map(d => d.name)).toContain('CloudDoc')
    })
  })

  it('a guest (no session) sees no cross-domain copy verb', async () => {
    const local = getLocalStore()
    const { uuid } = await local.create('Solo')
    await local.save(uuid, { content: 'x' })

    const fetchMock = vi.fn((url: string): Promise<Response> => {
      // 401 on /api/auth/me => still a guest, no cloud domain.
      if (url === '/api/auth/me') return Promise.resolve(res({}, false, 401))
      if (url === '/api/users/me/preferences') return Promise.resolve(res({}, false, 401))
      return Promise.resolve(res({ documents: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    await waitFor(() => expect(screen.getByText('local/Solo')).toBeInTheDocument())
    expect(screen.queryByTitle('Copy to Cloud')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Copy to Local')).not.toBeInTheDocument()
  })
})

// doc-domain-move: move (copy + delete source) and bulk sync-all.
describe('Documents cross-domain move + sync-all', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
  })

  afterEach(() => {
    cleanup()
  })

  // A signed-in session that answers the push round-trip (create + save).
  function pushFetchMock() {
    return vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url === '/api/auth/me') return Promise.resolve(authOk)
      if (url === '/api/users/me/preferences') return Promise.resolve(prefsOk)
      if (url === '/api/documents' && init?.method === 'POST') return Promise.resolve(res({ uuid: 'cloud-new' }))
      if (url.startsWith('/api/documents/') && init?.method === 'PUT') return Promise.resolve(res({}))
      return Promise.resolve(res({ documents: [] }))
    })
  }

  it('Move to Cloud pushes the tile up then removes the local source', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const local = getLocalStore()
    const { uuid } = await local.create('Bracket')
    await local.save(uuid, { content: 'profile: square' })

    const fetchMock = pushFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    const moveBtn = await screen.findByTitle('Move to Cloud')
    fireEvent.click(moveBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/documents', expect.objectContaining({ method: 'POST' }))
      expect(fetchMock).toHaveBeenCalledWith('/api/documents/cloud-new', expect.objectContaining({ method: 'PUT' }))
    })

    // Destructive on the source side: the local doc is gone after the move.
    await waitFor(async () => {
      expect((await local.list()).length).toBe(0)
    })
  })

  it('Move to Cloud does nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const local = getLocalStore()
    const { uuid } = await local.create('Bracket')
    await local.save(uuid, { content: 'profile: square' })

    const fetchMock = pushFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    const moveBtn = await screen.findByTitle('Move to Cloud')
    fireEvent.click(moveBtn)

    expect(fetchMock).not.toHaveBeenCalledWith('/api/documents', expect.objectContaining({ method: 'POST' }))
    expect((await local.list()).length).toBe(1)  // source untouched
  })

  it('Sync all pushes every local document up to the cloud', async () => {
    const local = getLocalStore()
    const a = await local.create('A'); await local.save(a.uuid, { content: 'a' })
    const b = await local.create('B'); await local.save(b.uuid, { content: 'b' })

    const fetchMock = pushFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderDocuments()

    const syncBtn = await screen.findByTitle('Sync all to Cloud')
    fireEvent.click(syncBtn)

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/documents' && (init as RequestInit | undefined)?.method === 'POST',
      )
      expect(posts.length).toBe(2)  // one create per local doc
    })
  })

})
