import JSZip from 'jszip'
import type { DocumentStore } from './types'
import { LOCAL_OWNER } from './IndexedDbDocumentStore'
import { secureFilename, uniqueStem, UNTITLED_DOC_NAME } from './secureFilename'

// Bundle import/export. NOT a second store -- these round-trip through whatever
// `DocumentStore` is wired in. For the browser-storage library a bundle is the
// only way to get documents onto disk or onto another machine; for a
// directory-backed one it is a snapshot of files that are already there:
//
//   <user>/<doc>.yaml   document payload, as YAML text
//   <user>/<doc>.png    preview image, alongside (only when present)
//
//   - Export one doc   -> 1-entry zip (the `.oversolved` file).
//   - Export a library -> N-entry zip (the whole-library backup).
//
// The per-user directory level is vestigial (there is one library), but it is
// kept in the layout so older bundles keep importing unchanged. The directory
// store sheds it: a folder the user picked has no reason to carry a level named
// after a server's account model. See directoryLibrary.ts.

// Normalizes any binary input to bytes JSZip can read. A real browser File
// (Blob) exposes arrayBuffer(); jsdom does not, so fall back to Response, which
// jsdom does implement.
async function toBytes(data: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer | Uint8Array> {
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data
  if (typeof data.arrayBuffer === 'function') return data.arrayBuffer()
  return new Response(data).arrayBuffer()
}

// Per-(user, name) collision suffixing, so two documents that secure-filename to
// the same stem get `_1`, `_2`, ... and never overwrite. Reservations are keyed
// on the full owner path rather than the bare stem, which is why this wraps
// `uniqueStem` rather than calling it directly: two owners may each hold a
// document that sanitizes to the same name. The suffixing rule itself is shared
// with the directory library, so a document exported from a folder and imported
// back keeps its name.
function reserveStem(seen: Set<string>, ownerPath: string, stem: string): string {
  const chosen = uniqueStem(stem, candidate => seen.has(`${ownerPath}${candidate}`))
  seen.add(`${ownerPath}${chosen}`)
  return chosen
}

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

// Zip-bomb guardrails for import. Nothing stands in front of this code -- the
// file goes straight from the user's disk into the browser -- so these caps are
// the only ones.
//
// Residual gap: total DECOMPRESSED size is not capped. JSZip does not expose
// uncompressed sizes through public API before decompression (its
// uncompressedSize field is internal), so this relies on the compressed-input
// cap plus the entry cap; a highly-compressible archive under the input cap can
// still fan out past either.
export const MAX_BUNDLE_ENTRIES = 10000
export const MAX_BUNDLE_INPUT_BYTES = 100 * 1024 * 1024

// Ingests a bundle into the store. The per-user directory segment is dropped
// (there is one library), so a bundle exported anywhere imports here. Returns
// the ids written.
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
