import { suggestedCloneName } from '../cloneName'

// A faithful in-memory stand-in for the Flask `/api/documents` endpoints in
// oversolved/blueprints/documents.py, just complete enough to exercise the
// same observable behavior as the local store. Every status code, name rule
// and deletion semantic here mirrors the real backend on purpose: the HTTP
// leg of contract.test.ts must run against the cloud's actual behavior, not a
// drifted sketch of it. Drift pins in contract.test.ts hold this file to the
// blueprints code.
//
// It is still NOT the real backend -- the wire-shape tests in
// HttpDocumentStore.test.ts guard the exact protocol; this only lets the HTTP
// store run the same behavioral assertions as the IDB store.
export function mountFakeDocumentsServer(): () => void {
  interface Rec {
    uuid: string
    name: string
    content: string
    preview_image?: string
    is_public: boolean
    created_at: string
    updated_at: string
    // Soft-delete tombstone, exactly like documents.deleted_at: set by DELETE,
    // hidden from list(), but the row keeps serving GET to the owner because
    // DocumentStore.retrieve() does not filter it.
    deleted_at?: string
  }
  const docs = new Map<string, Rec>()
  let clock = 1000
  const stamp = () => new Date(clock++).toISOString()
  const original = globalThis.fetch

  // The unified error shape of api_error (oversolved/blueprints/__init__.py).
  const apiError = (status: number, error: string, code: string) =>
    respond(status, { ok: false, error, code })

  const respond = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response)

  const toSummary = (r: Rec) => ({
    uuid: r.uuid,
    name: r.name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    is_owner: true,
    owner_username: 'server-user',
    is_public: r.is_public,
  })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString()
    const url = new URL(raw, 'http://test')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const path = url.pathname

    if (path === '/api/documents') {
      if (method === 'POST') {
        const name = (body.name ?? '').trim()
        if (!name) return apiError(400, 'Document name required', 'BAD_REQUEST')  // create_document
        const uuid = crypto.randomUUID()
        docs.set(uuid, {
          uuid, name, content: '',
          is_public: body.is_public ?? false,
          created_at: stamp(), updated_at: stamp(),
        })
        return respond(201, { uuid, name })  // real route returns 201
      }
      // GET list with server-side filter / search / sort.
      let list = [...docs.values()].filter(d => !d.deleted_at)  // trash never lists
      const filter = url.searchParams.get('filter')
      const search = url.searchParams.get('search')
      const sort = url.searchParams.get('sort')
      if (filter === 'public') list = list.filter(d => d.is_public)
      else if (filter === 'shared') list = []
      if (search) {
        const needle = search.toLowerCase()
        list = list.filter(d => d.name.toLowerCase().includes(needle))
      }
      // _SORT_ORDERS has keys modified/modified_asc; everything else falls
      // back to name asc, which is therefore also the default.
      if (sort === 'modified') list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      else if (sort === 'modified_asc') list.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      else list.sort((a, b) => a.name.localeCompare(b.name))
      return respond(200, { documents: list.map(toSummary) })
    }

    const dup = path.match(/^\/api\/documents\/([^/]+)\/duplicate$/)
    if (dup && method === 'POST') {
      const src = docs.get(dup[1])
      if (!src) return apiError(404, 'Document not found', 'NOT_FOUND')
      const uuid = crypto.randomUUID()
      const name = `${src.name} (Copy)`  // duplicate_document's casing
      docs.set(uuid, {
        ...src, uuid, name,
        created_at: stamp(), updated_at: stamp(),
      })
      return respond(201, { uuid, name })
    }

    const clone = path.match(/^\/api\/documents\/([^/]+)\/clone$/)
    if (clone && method === 'POST') {
      const src = docs.get(clone[1])
      if (!src) return apiError(404, 'Document not found', 'NOT_FOUND')
      const uuid = crypto.randomUUID()
      // clone_document: an explicit name is taken verbatim (the user saw and
      // chose it); the fallback suggestion is uniquified with (Clone N)
      // against the caller's existing names.
      let name: string
      const requested = typeof body?.name === 'string' ? body.name.trim() : ''
      if (requested) {
        name = requested
      } else {
        name = suggestedCloneName(src.name)
        const existingNames = new Set([...docs.values()].map(d => d.name))
        let counter = 1
        while (existingNames.has(name)) {
          name = `${src.name} (Clone ${counter})`
          counter += 1
        }
      }
      docs.set(uuid, {
        ...src, uuid, name,
        created_at: stamp(), updated_at: stamp(),
      })
      return respond(201, { uuid, name })
    }

    const one = path.match(/^\/api\/documents\/([^/]+)$/)
    if (one) {
      const id = one[1]
      const rec = docs.get(id)
      // require_doc_permission 404s any verb whose uuid has no row before the
      // view body runs, so every per-document method shares this gate.
      if (!rec) return apiError(404, 'Document not found', 'NOT_FOUND')
      if (method === 'GET') {
        // No deleted_at filter here, matching DocumentStore.retrieve(): a
        // trashed row still serves GET to its owner until purge.
        return respond(200, {
          uuid: rec.uuid,
          content: rec.content, name: rec.name,
          created_at: rec.created_at, updated_at: rec.updated_at,
          owner_username: 'server-user', permission: 'owner',
          is_public: rec.is_public, preview_image: rec.preview_image,
        })
      }
      if (method === 'PUT') {
        // Mirror update_document's content guards: a missing or non-string
        // content would 500 on the real backend; callers expect a clean 400.
        if (body.content === undefined) {
          return apiError(400, 'Missing "content" field', 'BAD_REQUEST')
        }
        if (typeof body.content !== 'string') {
          return apiError(400, '"content" must be a string', 'BAD_REQUEST')
        }
        rec.content = body.content
        if (body.preview_image !== undefined) rec.preview_image = body.preview_image
        rec.updated_at = stamp()  // update_content restamps updated_at
        return respond(200, { uuid: rec.uuid, status: 'stored' })
      }
      if (method === 'PATCH') {
        // Mirror rename_document's name guards: a non-string name would crash
        // strip() into a 500, and an absent/blank name is rejected with 400.
        const name = body?.name
        if (name !== undefined && typeof name !== 'string') {
          return apiError(400, '"name" must be a string', 'BAD_REQUEST')
        }
        const trimmed = (name ?? '').toString().trim()
        if (!trimmed) return apiError(400, 'Document name required', 'BAD_REQUEST')
        rec.name = trimmed
        rec.updated_at = stamp()  // rename restamps updated_at
        return respond(200, { uuid: rec.uuid, name: rec.name })
      }
      if (method === 'DELETE') {
        // Soft delete like delete_document: tombstone the row, keep it served
        // to the trash, never hard-delete here.
        rec.deleted_at = stamp()
        return respond(200, {
          uuid: rec.uuid,
          status: 'moved_to_trash',
          deleted_at: rec.deleted_at,
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        })
      }
    }
    return apiError(404, 'Document not found', 'NOT_FOUND')
  }) as typeof fetch

  return () => { globalThis.fetch = original }
}
