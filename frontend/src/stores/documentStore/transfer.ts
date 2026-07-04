import type { DocumentStore } from './types'

// Copy one document from `src` into `dest`, returning the NEW uuid in `dest`.
//
// Store-agnostic by design: it speaks only the DocumentStore contract
// (load/create/save), so the same helper bridges either direction across the
// local/cloud boundary. The source is never mutated -- this is a copy, not a
// move (a move is copy + remove(src), gated separately because it is destructive
// on one side). The two cross-domain verbs build directly on this:
//   push  (local -> cloud): copyDocument(local, cloud, id), then local.markSynced?.(id)
//   clone (cloud -> local): copyDocument(cloud, local, id)
export async function copyDocument(
  src: DocumentStore,
  dest: DocumentStore,
  id: string,
): Promise<{ uuid: string }> {
  const doc = await src.load(id)  // throws on a missing id, propagated to the caller
  const { uuid } = await dest.create(doc.name, { is_public: doc.is_public })
  await dest.save(uuid, { content: doc.content, preview_image: doc.preview_image })
  return { uuid }
}

// markSynced is the engine-facing sync primitive on IndexedDbDocumentStore,
// deliberately NOT part of the DocumentStore contract. push duck-types it so a
// store that does not track sync state simply skips the ack.
interface SyncTrackingStore {
  markSynced(id: string): Promise<void>
}

function hasMarkSynced(s: DocumentStore): s is DocumentStore & SyncTrackingStore {
  return typeof (s as Partial<SyncTrackingStore>).markSynced === 'function'
}

// Push (local -> cloud): copy the document up, then record the LOCAL doc as
// synced (baseRev = rev, dirty = false) so it stops reading as a local-only
// change. The cloud `create` is where server-side ownership attribution attaches;
// the local home stays identity-free. The local doc is left intact (mirror, not
// move). Pull (cloud -> local) needs no ack, so call `copyDocument` directly.
export async function pushDocument(
  local: DocumentStore,
  cloud: DocumentStore,
  id: string,
): Promise<{ uuid: string }> {
  const result = await copyDocument(local, cloud, id)
  if (hasMarkSynced(local)) await local.markSynced(id)
  return result
}

// Move across the domain boundary = copy, then delete the source. Destructive on
// the source side (unlike copy/push), so the UI gates it behind a confirm. The copy
// runs first and throws on a missing id BEFORE any dest mutation, so a failed copy
// never removes the source; only once the copy has landed is the source removed.
// Direction-agnostic like copyDocument -- it moves either way across the boundary.
export async function moveDocument(
  src: DocumentStore,
  dest: DocumentStore,
  id: string,
): Promise<{ uuid: string }> {
  const result = await copyDocument(src, dest, id)
  await src.remove(id)
  return result
}

// Bulk push: mirror every local document that has unsynced local changes up to the
// cloud, acking each. The "sync all" counterpart to the per-doc push verb -- both
// coexist (the git-push analogy: bulk local-to-cloud, acking each). Selection uses the DocMeta
// dirty flag (set on save, cleared by markSynced), so a doc already mirrored is
// skipped and a re-run pushes nothing new. A store that does not track meta has no
// dirty flag -> treated as always-dirty (push everything). It cannot yet UPDATE an
// existing cloud doc in place (no cross-store identity map), so a re-edited doc
// lands as a new cloud copy; in-place update waits on the real sync engine.
export async function syncAllDocuments(
  local: DocumentStore,
  cloud: DocumentStore,
): Promise<{ pushed: string[] }> {
  const summaries = await local.list({ filter: 'owned' })
  const pushed: string[] = []
  for (const s of summaries) {
    if (s.meta && !s.meta.dirty) continue  // already mirrored, nothing to push
    await pushDocument(local, cloud, s.uuid)
    pushed.push(s.uuid)
  }
  return { pushed }
}
