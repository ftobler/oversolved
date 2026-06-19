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
