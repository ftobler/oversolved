// Trash (soft-delete) capability for the CLOUD domain: listing, recovering and
// permanently deleting documents removed from the server is a lifecycle only
// the PDM backend tracks. Without a server this capability (`backendBundle.trash`)
// is ABSENT -- there is no cloud trash to manage. The LOCAL home library has its
// own always-present trash (IndexedDbTrashAdapter in documentStore/); this module
// covers the cloud side only.
import { http } from '@/utils/core/httpClient'
import { type Backend } from '@/config/capabilities'

export interface TrashDoc {
  uuid: string
  name: string
  deleted_at: string
  created_at: string
  owner_id: number
  owner_username: string
  preview_image?: string  // inline base64 PNG (local trash); the HTTP trash leaves it undefined
}

export interface TrashAdapter {
  list(): Promise<TrashDoc[]>
  recover(uuid: string): Promise<void>
  // Permanent delete from the trash (the soft-delete's hard end).
  purge(uuid: string): Promise<void>
}

class HttpTrashAdapter implements TrashAdapter {
  async list(): Promise<TrashDoc[]> {
    const data = await http.getJson<{ documents: TrashDoc[] }>('/api/documents/trash')
    return data.documents || []
  }

  async recover(uuid: string): Promise<void> {
    await http.postJson(`/api/documents/${uuid}/recover`)
  }

  async purge(uuid: string): Promise<void> {
    await http.deleteJson(`/api/documents/${uuid}/trash`)
  }
}

// Pure factory (testable without touching the env). Null when there is no server
// with a trash to manage. Assembled into the `backendBundle` composition root
// (adapters/backend.ts), not a singleton here.
export function createTrashAdapter(b: Backend): TrashAdapter | null {
  return b === 'static' ? null : new HttpTrashAdapter()
}
