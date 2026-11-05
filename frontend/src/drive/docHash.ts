// The one canonical document hash the drive layer uses for journal entries,
// repro payloads and replay verification. It reuses the checkpoint
// machinery's serializer (stableJson, key-sorted and Map-normalized) and hash
// (sha256Hex) rather than inventing a second one: the dirty fingerprint
// (session/dirty.ts) stays the save-path hash over the YAML text, and this
// stays the content hash over the document structure.

import type { PartDoc } from '@/types/cad'
import { sha256Hex } from '@/kernel/sha256'
import { stableJson } from '@/kernel/builderHash'

/** The canonical content hash of a document (or any JSON-shaped value). */
export function docHashOf(doc: unknown): string {
  return sha256Hex(stableJson(doc))
}

/**
 * The hash of what the author wrote, invariant under the solver write-back.
 * That write-back bakes solved geometry into each feature's `initial` and
 * reconciles `part_style`, so neither field says anything about the authored
 * document a step seeds from or a journal entry compares against. The
 * projection is shallow on purpose: `stableJson` only reads the features, and a
 * deep clone would cost the whole document on every step.
 */
export function authoredHashOf(doc: PartDoc): string {
  const { part_style: _partStyle, ...authored } = doc
  if (Array.isArray(doc.features)) {
    authored.features = doc.features.map((feature) => {
      if (!('initial' in feature)) return feature
      const { initial: _initial, ...authoredFeature } = feature
      return authoredFeature as typeof feature
    })
  }
  return docHashOf(authored)
}
