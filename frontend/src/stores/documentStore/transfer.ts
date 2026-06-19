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
  const { uuid } = await dest.create(doc.name)
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
