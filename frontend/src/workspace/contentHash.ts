// Content hashing for the workspace: one hash per entry, and the composite key a
// part bundle caches under. A content hash is the bundle cache's invalidation
// signal (A11) because it changes when the content does and only then, which a
// revision cannot express across an undo.
import type { EntryKind } from './types'
import { sha256Hex, sha256HexBytes } from '@/kernel/sha256'

export interface HashableEntry {
  kind: EntryKind
  text?: string
  bytes?: Uint8Array
}

// The hash of one entry's payload. A document hashes its text; a file hashes its
// bytes. The kind decides which slot is authoritative, so a stray extra slot
// never changes the hash.
export function hashRecord(entry: HashableEntry): string {
  if (entry.kind === 'document') return sha256Hex(entry.text ?? '')
  return sha256HexBytes(entry.bytes ?? new Uint8Array(0))
}

// The key one part bundle is cached under: the part document's content hash plus
// the content hashes of the file entries it references. Folding the file hashes
// in is what makes replacing a referenced STEP's bytes invalidate the bundle
// even though the document text never changed. Deeper (transitive) staleness is
// the separate dependency-graph work.
export function partBundleKey(docHash: string, fileHashes: string[]): string {
  return sha256Hex([docHash, ...[...fileHashes].sort()].join('|'))
}

// The key one rigid sub-assembly composite caches under: the assembly document's
// own content hash plus every child's bundle key, sorted so instance order does
// not re-key it. It is recursive by construction: a child that is itself an
// assembly contributes its own composite key, so editing a deep part invalidates
// every ancestor by pull, never push.
export function assemblyBundleKey(assemblyHash: string, childKeys: string[]): string {
  return sha256Hex([assemblyHash, ...[...childKeys].sort()].join('|'))
}
