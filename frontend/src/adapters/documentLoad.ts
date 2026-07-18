import { backendBundle } from '@/adapters/backend'
import type { DocumentPayload, DocumentStore } from '@/stores/documentStore'

// Cross-domain document resolution (doc-domain-move): prefer the local home
// copy, fall back to the cloud domain when the uuid lives only there (e.g. a
// server document not yet pulled local, or a part instanced straight from the
// picker's cloud category). Whichever store answers is returned so the caller
// can target edits back at the SAME domain. This is the one shared fallback
// rule; refine it here, not per call site.
export async function loadDocumentAnyDomain(
  uuid: string,
): Promise<{ data: DocumentPayload; store: DocumentStore }> {
  try {
    const data = await backendBundle.documents.load(uuid)
    return { data, store: backendBundle.documents }
  } catch (localErr) {
    const cloud = backendBundle.cloudDocuments
    if (!cloud) throw localErr
    const data = await cloud.load(uuid)
    return { data, store: cloud }
  }
}
