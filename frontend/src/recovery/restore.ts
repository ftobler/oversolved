// The handoff from the open-time restore offer to the editor's load seam. The
// offer is answered before the editor mounts (the page holds the editor back),
// so the accepted snapshot is parked here and consumed by the loader: the
// restored content replaces what the store would have loaded, is marked dirty,
// and is never written to IndexedDB until the user saves it explicitly. That is
// what keeps a restore recallable (the journal row survives) and the working
// copy untouched by a recovery path.
import type { PartDoc } from '@/types/cad'

export interface PendingRecoveryRestore {
  docId: string
  doc: PartDoc
}

let pending: PendingRecoveryRestore | null = null

export function requestRecoveryRestore(restore: PendingRecoveryRestore): void {
  pending = restore
}

/**
 * Consume the parked snapshot when it names this document; a mismatch leaves it
 * parked (another editor's load is not the one the user answered for). The
 * consumed handoff is single-use, so a remount of the same editor loads the
 * store's bytes and cannot silently re-apply a restore the user has since
 * saved over.
 */
export function takeRecoveryRestore(docId: string): PartDoc | null {
  if (pending === null || pending.docId !== docId) return null
  const doc = pending.doc
  pending = null
  return doc
}

/** Test seam: drop a parked handoff between cases. */
export function resetRecoveryRestore(): void {
  pending = null
}
