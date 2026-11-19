// The bytes behind an import_step's file id are part of what makes that
// feature dirty. The persisted feature names only `file_id`, so a replace of
// the entry's payload (the workspace's Replace bytes gesture, an MCP run that
// reuses a doc id with new bytes) left the spec byte-identical and the
// cross-solve checkpoint cache served the previous read.
//
// The digest rides on the feature only in the in-memory build/checkpoint spec;
// it is never written to the document. The document loader keeps its schema,
// and every solve derives the field from the file map it was actually handed.

import { sha256HexBytes } from './sha256'

/** The solve-only spec field holding the digest of an import's bytes. */
export const IMPORT_BYTES_SPEC_KEY = '_file_sha256'

// The two fields this module reads. Everything else on the feature passes
// through untouched, so the caller keeps its own feature type.
export interface ImportFeatureShape {
  kind?: unknown
  file_id?: unknown
}

// The Worker's per-generation file cache hands the same buffer to every solve
// in that generation, so memoising on the array keeps a large STEP file hashed
// once per read. Replacing the entry's bytes is a new array, hence a new
// digest, which is exactly the invalidation signal the cache needs.
const digests = new WeakMap<Uint8Array, string>()

function digestOf(bytes: Uint8Array): string {
  let digest = digests.get(bytes)
  if (digest === undefined) {
    digest = sha256HexBytes(bytes)
    digests.set(bytes, digest)
  }
  return digest
}

/**
 * The features with a digest folded into every import_step that has bytes in
 * this solve's file map. The input array and its feature objects are left
 * untouched; an array with no resolvable import is returned as is.
 */
export function featuresWithImportDigests<T extends ImportFeatureShape>(
  features: readonly T[],
  files: ReadonlyMap<string, Uint8Array> | undefined,
): readonly T[] {
  if (!files || files.size === 0) return features
  let out: Array<T> | null = null
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    if (feature.kind !== 'import_step') continue
    const fileId = feature.file_id
    if (typeof fileId !== 'string') continue
    const bytes = files.get(fileId)
    if (bytes === undefined) continue
    if (out === null) out = features.slice()
    out[i] = { ...feature, [IMPORT_BYTES_SPEC_KEY]: digestOf(bytes) }
  }
  return out ?? features
}
