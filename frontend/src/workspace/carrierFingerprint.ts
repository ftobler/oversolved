import type { WorkspaceManifest } from './types'
import { serializeManifest } from './manifest'

// The carrier-under-working-copy fingerprint. It hashes the canonical manifest
// bytes, not the raw file, so a semantically equal manifest reformatted by an
// external editor does not read as a change. SHA-256 via WebCrypto is the
// normal path; the FNV-1a fallback keeps a test or embedder without a subtle
// crypto from losing the whole compare.
export async function fingerprintManifest(manifest: WorkspaceManifest): Promise<string> {
  const bytes = new TextEncoder().encode(serializeManifest(manifest))
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    return hex(new Uint8Array(digest))
  }
  return fnv1aHex(bytes)
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

// 32-bit FNV-1a, rendered as eight hex digits. Not cryptographic: it only has to
// be stable and cheap for the contexts that cannot reach WebCrypto.
function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
