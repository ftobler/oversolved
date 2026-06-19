import { http } from '@/utils/core/httpClient'
import type { DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions } from './types'

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
    return data.documents || []
  }

  async load(id: string): Promise<DocumentPayload> {
    return http.getJson<DocumentPayload>(`/api/documents/${id}`)
  }

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

  thumbnailUrl(id: string): string {
    return `/api/documents/${id}/thumbnail`
  }
}
