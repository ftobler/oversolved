// The one canonical document hash the drive layer uses for journal entries,
// repro payloads and replay verification. It reuses the checkpoint
// machinery's serializer (stableJson, key-sorted and Map-normalized) and hash
// (sha256Hex) rather than inventing a second one: the dirty fingerprint
// (session/dirty.ts) stays the save-path hash over the YAML text, and this
// stays the content hash over the document structure.

import { sha256Hex } from '@/kernel/sha256'
import { stableJson } from '@/kernel/builderHash'

/** The canonical content hash of a document (or any JSON-shaped value). */
export function docHashOf(doc: unknown): string {
  return sha256Hex(stableJson(doc))
}
