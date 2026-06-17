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
// secure-filename to the same stem get `_1`, `_2`, ... and never overwrite.
function uniqueStem(counts: Map<string, number>, key: string, stem: string): string {
  const seen = counts.get(key) ?? 0
  counts.set(key, seen + 1)
  if (seen === 0) return stem
  const dot = stem.lastIndexOf('.')
  if (dot > 0) return `${stem.slice(0, dot)}_${seen}.${stem.slice(dot + 1)}`
  return `${stem}_${seen}`
}

// Core producer: returns the raw zip bytes. Kept separate from `exportBundle`
// so it is testable without a Blob (jsdom Blobs are opaque to binary reads).
export async function buildBundleBytes(store: DocumentStore, ids: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  const counts = new Map<string, number>()
  for (const id of ids) {
    const payload = await store.load(id)
    const owner = payload.owner_username || LOCAL_OWNER
    const stem = uniqueStem(counts, `${owner}/${secureFilename(payload.name)}`, secureFilename(payload.name))
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

// Ingests a bundle into the active store. The per-user directory is irrelevant
// locally (single user), so the username segment is dropped: every document is
// created under the local store. Returns the ids written.
export async function importBundle(
  store: DocumentStore,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<string[]> {
  const zip = await JSZip.loadAsync(await toBytes(data))
  const ids: string[] = []
  // Index entries by their <user>/<file> path so a .yaml can find its sibling
  // .png by name.
  const entries = Object.values(zip.files).filter(f => !f.dir)
  const byPath = new Map(entries.map(f => [f.name, f]))

  for (const entry of entries) {
    if (!entry.name.endsWith('.yaml')) continue
    const content = await entry.async('string')
    const slash = entry.name.lastIndexOf('/')
    const filename = slash >= 0 ? entry.name.slice(slash + 1) : entry.name
    const dir = slash >= 0 ? entry.name.slice(0, slash + 1) : ''
    const docName = filename.slice(0, -'.yaml'.length)

    const { uuid } = await store.create(docName)
    let preview_image: string | undefined
    const png = byPath.get(`${dir}${docName}.png`)
    if (png) preview_image = await png.async('base64')
    await store.save(uuid, { content, preview_image })
    ids.push(uuid)
  }
  return ids
}
