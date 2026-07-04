// Trash (soft-delete) capability: listing, recovering and permanently deleting
// trashed documents is a server-side lifecycle that only the PDM backend tracks.
// The static build has no trash -- `remove()` on the local IndexedDB store is a
// hard delete -- so the capability is ABSENT (`backendBundle.trash` is null and
// the Trash view does not exist). Soft-delete lifecycle requires a server, so the
// capability is absent on the static build (scope / lifecycle split).
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
