// Sharing capability: handing a document to other users is a PDM (server) job.
// The HTTP build talks to /api/documents/<uuid>/share*; the static build has no
// concept of other users (the local IndexedDB library belongs to the device),
// so the capability is ABSENT -- `sharingAdapter` is null and the share UI does
// not exist. Sharing is user-to-user version handover, never an editing
// dependency (see static-build-notes.md Topic 7).
import { http } from '@/utils/core/httpClient'
import { backend, type Backend } from '@/config/capabilities'

export interface ShareInfo {
  id: number
  username: string | null
  permission: string
  shared_with_user_id: number | null
}

export interface SharingAdapter {
  listShares(uuid: string): Promise<ShareInfo[]>
  // Grant / update a share. No username => link sharing (anyone with the link).
  share(uuid: string, opts: { username?: string; permission: string }): Promise<{ shares?: ShareInfo[] }>
  // Revoke a share as the owner. No username => revoke link sharing.
  unshare(uuid: string, username?: string | null): Promise<{ shares?: ShareInfo[] }>
  // Recipient leaving a share. Per the ownership razor this is "remove from my
  // view", NOT a delete of the owner's document.
  leaveShare(uuid: string): Promise<void>
}

class HttpSharingAdapter implements SharingAdapter {
  async listShares(uuid: string): Promise<ShareInfo[]> {
    const data = await http.getJson<{ shares: ShareInfo[] }>(`/api/documents/${uuid}/shares`)
    return data.shares || []
  }

  async share(uuid: string, opts: { username?: string; permission: string }): Promise<{ shares?: ShareInfo[] }> {
    return http.postJson<{ shares?: ShareInfo[] }>(`/api/documents/${uuid}/share`, opts)
  }

  async unshare(uuid: string, username?: string | null): Promise<{ shares?: ShareInfo[] }> {
    // DELETE with a body to name the share (or {} for link sharing) -- outside
    // the plain http helper shape, so the raw fetch lives here in the adapter.
    const res = await fetch(`/api/documents/${uuid}/share`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(username ? { username } : {}),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(data.error || 'Failed to remove share')
    }
    return await res.json().catch(() => ({})) as { shares?: ShareInfo[] }
  }

  async leaveShare(uuid: string): Promise<void> {
    await http.deleteJson(`/api/documents/${uuid}/share`)
  }
}

// Pure factory (testable without touching the env). Null when there is no
// server to share through.
export function createSharingAdapter(b: Backend): SharingAdapter | null {
  return b === 'static' ? null : new HttpSharingAdapter()
}

// Boot-time singleton, chosen from the build flag.
export const sharingAdapter: SharingAdapter | null = createSharingAdapter(backend)
