import JSZip from 'jszip'
import type { DocumentStore } from './types'
import { LOCAL_OWNER } from './IndexedDbDocumentStore'
import { secureFilename } from './secureFilename'

// Bundle import/export. NOT a third store -- these round-trip through whatever
// `DocumentStore` is active. The zip layout matches the server's admin backup
// exactly so the two are interchangeable:
//
//   <user>/<doc>.yaml   document payload, as YAML text
//   <user>/<doc>.png    preview image, alongside (only when present)
//
//   - Export one doc   -> 1-entry zip (the `.oversolved` file).
//   - Export a library -> N-entry zip (the static replacement for admin backup).

// Normalizes any binary input to bytes JSZip can read. A real browser File
// (Blob) exposes arrayBuffer(); jsdom does not, so fall back to Response, which
// jsdom does implement.
async function toBytes(data: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer | Uint8Array> {
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data
  if (typeof data.arrayBuffer === 'function') return data.arrayBuffer()
  return new Response(data).arrayBuffer()
}

// Mirrors admin.py's per-(user, name) collision suffixing so two documents that
// secure-filename to the same stem get `_1`, `_2`, ... and never overwrite. The
// reservation set tracks every produced stem (including suffixes), not just the
// base, so a generated `_1` can never land on a stem another document already
// owns (e.g. a real doc named "Untitled_1" must not be clobbered by a stripped
// empty-name doc's suffixed entry).
function reserveStem(seen: Set<string>, ownerPath: string, stem: string): string {
  const first = `${ownerPath}${stem}`
  if (!seen.has(first)) {
    seen.add(first)
    return stem
  }
  const dot = stem.lastIndexOf('.')
  let n = 1
  while (true) {
    const suffixed = dot > 0
      ? `${stem.slice(0, dot)}_${n}.${stem.slice(dot + 1)}`
      : `${stem}_${n}`
    const candidate = `${ownerPath}${suffixed}`
    if (!seen.has(candidate)) {
      seen.add(candidate)
      return suffixed
    }
    n += 1
  }
}

// secureFilename strips every non-ASCII code point, so a Cyrillic/CJK document
// name sanitizes to '' and would export as '<user>/.yaml', then import back as
// a blank-name document no other path can reach. The store's own default name
// is the fallback on both directions.
const UNTITLED_DOC_NAME = 'Untitled'

// Core producer: returns the raw zip bytes. Kept separate from `exportBundle`
// so it is testable without a Blob (jsdom Blobs are opaque to binary reads).
export async function buildBundleBytes(store: DocumentStore, ids: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  const seen = new Set<string>()
  for (const id of ids) {
    const payload = await store.load(id)
    const owner = payload.owner_username || LOCAL_OWNER
    // Key and stem share the fallback so a literal 'Untitled' doc collides
    // (and suffixes) with a stripped non-ASCII name instead of overwriting it.
    const safe = secureFilename(payload.name) || UNTITLED_DOC_NAME
    const stem = reserveStem(seen, `${owner}/`, safe)
    zip.file(`${owner}/${stem}.yaml`, payload.content)
    if (payload.preview_image) {
      // preview_image is base64 (no data: prefix), matching the save body.
      zip.file(`${owner}/${stem}.png`, payload.preview_image, { base64: true })
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export async function exportBundle(store: DocumentStore, ids: string[]): Promise<Blob> {
  const bytes = await buildBundleBytes(store, ids)
  return new Blob([bytes as BlobPart], { type: 'application/zip' })
}

// Zip-bomb guardrails for import, mirroring admin.py's import-backup path
// (_MAX_ZIP_ENTRIES and its 100MB compressed request pre-check). Static builds
// have no server in front of this code, so these caps are the only ones.
//
// Residual gap: admin.py also caps total DECOMPRESSED size via the central
// directory's per-entry file_size. JSZip does not expose uncompressed sizes
// through public API before decompression (its uncompressedSize field is
// internal), so this port relies on the compressed-input cap plus the entry
// cap; a highly-compressible archive under the input cap can still fan out
// past what the server would admit.
export const MAX_BUNDLE_ENTRIES = 10000
export const MAX_BUNDLE_INPUT_BYTES = 100 * 1024 * 1024

// Ingests a bundle into the active store. The per-user directory is irrelevant
// locally (single user), so the username segment is dropped: every document is
// created under the local store. Returns the ids written.
export async function importBundle(
  store: DocumentStore,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<string[]> {
  // Blob.size is free; only non-Blob inputs are already bytes in memory.
  const inputBytes = data instanceof Blob ? data.size : data.byteLength
  if (inputBytes > MAX_BUNDLE_INPUT_BYTES) throw new Error('Bundle file too large')
  const zip = await JSZip.loadAsync(await toBytes(data))
  const ids: string[] = []
  // Index entries by their <user>/<file> path so a .yaml can find its sibling
  // .png by name.
  const entries = Object.values(zip.files).filter(f => !f.dir)
  if (entries.length > MAX_BUNDLE_ENTRIES) throw new Error('Archive contains too many files')
  const byPath = new Map(entries.map(f => [f.name, f]))

  try {
    for (const entry of entries) {
      if (!entry.name.endsWith('.yaml')) continue
      const content = await entry.async('string')
      const slash = entry.name.lastIndexOf('/')
      const filename = slash >= 0 ? entry.name.slice(slash + 1) : entry.name
      const dir = slash >= 0 ? entry.name.slice(0, slash + 1) : ''
      const docName = filename.slice(0, -'.yaml'.length) || UNTITLED_DOC_NAME

      const { uuid } = await store.create(docName)
      ids.push(uuid)  // tracked before save so rollback covers a mid-entry failure
      let preview_image: string | undefined
      const png = byPath.get(`${dir}${docName}.png`)
      if (png) preview_image = await png.async('base64')
      await store.save(uuid, { content, preview_image })
    }
  } catch (err) {
    // A multi-entry import is not atomic at the store level: a mid-loop failure
    // (quota, offline) must not leave the earlier entries behind as a partial
    // import that a retry would duplicate. Best-effort rollback of everything
    // created so far, including the failing entry's own husk; the caller sees
    // the original error.
    for (const id of ids) await store.remove(id).catch(() => undefined)
    throw err
  }
  return ids
}
