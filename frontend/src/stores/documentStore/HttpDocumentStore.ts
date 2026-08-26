import { http } from '@/utils/core/httpClient'
import type { DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions } from './types'

// Cloud rows carry no sync meta of their own (the server has no meta column),
// but meta.rev is the assembly bundle cache key: AssemblyPartPicker records it
// at pick time and currentRevs refreshes it from list(), so a cloud-picked
// part without one would pin doc_rev 0 forever and server-side edits would
// never force its bundle rebuild. updated_at is the server's version field --
// every content/rename/preview write bumps it -- so its epoch ms is mapped
// into the exact local meta shape. A row without a parseable stamp keeps no
// meta at all rather than poisoning the cache key with NaN.
function withServerMeta(row: DocSummary): DocSummary {
  const updatedAt = Date.parse(row.updated_at)
  if (!Number.isFinite(updatedAt)) return row
  return {
    ...row,
    meta: { id: row.uuid, rev: updatedAt, updatedAt, dirty: false },
  }
}

// Wraps the existing `/api/documents` endpoints. This is the verbatim
// extraction of the fetches that used to live inlined across the call sites;
// behavior (URLs, methods, bodies) is preserved exactly so the refactor is a
// no-op for the HTTP deployment. Errors propagate as `HttpError`, so call-site
// catch blocks that inspect `instanceof HttpError` keep working unchanged.
export class HttpDocumentStore implements DocumentStore {
  async list(opts: ListOptions = {}): Promise<DocSummary[]> {
    const params = new URLSearchParams()
    if (opts.sort) params.set('sort', opts.sort)
    if (opts.filter) params.set('filter', opts.filter)
    if (opts.search) params.set('search', opts.search)
    const query = params.toString()
    const data = await http.getJson<{ documents: DocSummary[] }>(
      query ? `/api/documents?${query}` : '/api/documents',
    )
    return (data.documents || []).map(withServerMeta)
  }

  async load(id: string): Promise<DocumentPayload> {
    return http.getJson<DocumentPayload>(`/api/documents/${id}`)
  }

  // Unknown-id semantics: the backend's require_doc_permission answers every
  // verb on a missing uuid with 404 before the view runs, so save/rename/
  // load/remove reject with `HttpError` here -- the typed error all the other
  // methods already propagate. The local store deliberately diverges only for
  // save() (it upserts; see contract.test.ts) while its rename throws, so
  // callers must handle a not-found rejection from rename in both builds.
  async save(id: string, input: SaveInput): Promise<void> {
    const body: SaveInput = { content: input.content }
    if (input.preview_image) body.preview_image = input.preview_image
    await http.putJson(`/api/documents/${id}`, body)
  }

  async remove(id: string): Promise<void> {
    await http.deleteJson(`/api/documents/${id}`)
  }

  async create(name: string, opts: { is_public?: boolean } = {}): Promise<{ uuid: string }> {
    return http.postJson<{ uuid: string }>('/api/documents', { name, is_public: opts.is_public ?? false })
  }

  async rename(id: string, name: string): Promise<void> {
    await http.patchJson(`/api/documents/${id}`, { name })
  }

  async duplicate(id: string): Promise<{ uuid: string }> {
    return http.postJson<{ uuid: string }>(`/api/documents/${id}/duplicate`)
  }

  async clone(id: string, name?: string): Promise<{ uuid: string }> {
    return http.postJson<{ uuid: string }>(`/api/documents/${id}/clone`, name ? { name } : undefined)
  }

  thumbnailUrl(id: string): string {
    return `/api/documents/${id}/thumbnail`
  }
}
