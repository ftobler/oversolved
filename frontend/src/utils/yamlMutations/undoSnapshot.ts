import type { PartDoc, PartFeature } from '@/types/cad'

/**
 * Snapshot clone for the undo stack. Deep-clones every field EXCEPT the
 * immutable import payloads: an `import_step` feature's `file_data` is inline
 * base64 that can be megabytes, and the undo stack retains up to MAX_UNDO_DEPTH
 * entries, so cloning it into every entry costs O(payload) time per edit and
 * 50x the payload in retained memory. Measured on a 6 MB synthetic STEP doc
 * (clone-measure): a full structuredClone is ~4 ms, this is ~0.01 ms, and a
 * 50-entry stack holds ~306 MB vs a single shared string.
 *
 * Sharing the payload reference is safe because the bytes are immutable:
 * `file_data` is only ever written when a feature is created (applyAddImportStep),
 * and no mutation edits an existing payload in place (a re-import appends a NEW
 * feature with a fresh payload). Every other field, including the feature
 * objects themselves, is still deep-cloned, so a later edit of the restored doc
 * cannot corrupt the payload through a shared mutable reference.
 *
 * structuredClone cannot express "everything but X", so the payloads are
 * detached to a side table first (the stub keeps `file_data: undefined`) and
 * re-attached by reference after the clone, keyed by array position so the
 * shared-reference logic is per-payload across multiple imports.
 */
export function cloneDocForUndo(doc: PartDoc): PartDoc {
  const sourceFeatures = doc.features
  // No features means no payload can exist; a plain clone is already scoped.
  if (sourceFeatures === undefined) return structuredClone(doc)

  const payloads = new Array<{ index: number; fileData: string }>()
  const stripped = sourceFeatures.map((f, index) => {
    if (f.kind === 'import_step' && typeof f.file_data === 'string') {
      payloads.push({ index, fileData: f.file_data })
      return { ...f, file_data: undefined } as PartFeature
    }
    return f
  })
  const cloned = structuredClone({ ...doc, features: stripped })
  const clonedFeatures = cloned.features ?? []
  for (const { index, fileData } of payloads) {
    clonedFeatures[index].file_data = fileData
  }
  return cloned
}
