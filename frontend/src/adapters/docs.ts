// Documentation capability: the markdown docs are server assets (docs/*.md,
// served by the Flask backend). The HTTP build reads them from the PDM backend;
// the static build has no source for them (they are not bundled), so the
// capability is simply ABSENT -- `docsSource` is null and the docs tab renders a
// "needs the server build" notice instead of firing a fetch that 404s.
import { http } from '@/utils/core/httpClient'
import { backend, type Backend } from '@/config/capabilities'

export interface DocsSource {
  list(): Promise<string[]>            // available doc names
  load(name: string): Promise<string>  // markdown content for one doc
}

class HttpDocsSource implements DocsSource {
  async list(): Promise<string[]> {
    const data = await http.getJson<{ docs: string[] }>('/api/docs')
    return data.docs || []
  }

  async load(name: string): Promise<string> {
    const data = await http.getJson<{ content: string }>(`/api/docs/${name}`)
    return data.content
  }
}

// Pure factory (testable without touching the env). Null when there is no
// server to serve the docs from.
export function createDocsSource(b: Backend): DocsSource | null {
  return b === 'static' ? null : new HttpDocsSource()
}

// Boot-time singleton, chosen from the build flag.
export const docsSource: DocsSource | null = createDocsSource(backend)
