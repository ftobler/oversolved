import { describe, it, expect, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { IdbWorkspaceStore } from '../store'
import { readZipBag, importBag, MAX_PREVIEW_BYTES } from '../import'
import { getPreviewStore } from '@/stores/previewStore'
import { resetWorkspaceIdb } from './idbHarness'

// J7. A pre-branch library bundle carries its thumbnails as `<doc>.png` beside
// `<doc>.yaml`. Adoption used to count those as reserved siblings and throw the
// bytes away, so every adopted document opened with no preview. They now seed
// the preview store instead -- and only the preview store: a thumbnail is
// derived data and must never become a workspace entry (I5).

// The four PNG magic bytes, and their base64 (what the store holds: base64 with
// no data: prefix).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const PNG_BASE64 = 'iVBORw=='

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, data] of Object.entries(files)) zip.file(path, data)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('adoption seeds previews from a legacy bundle sidecar', () => {
  beforeEach(resetWorkspaceIdb)

  it('gives each imported document its sidecar preview and lands no .png in the tree', async () => {
    const bytes = await zipOf({
      'library/Box.yaml': 'kind: part\n',
      'library/Box.png': PNG_BYTES,
      'library/Bracket.yaml': 'kind: part\n',
      'library/Bracket.png': PNG_BYTES,
    })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'legacy'), { origin: 'legacy' }, store)

    const entries = await store.listEntries(result.workspace)
    // The tree holds the two documents and nothing else: the sidecars are still
    // dropped and still counted, exactly as before.
    expect(entries).toHaveLength(2)
    expect(entries.some(entry => entry.name.endsWith('.png'))).toBe(false)
    expect(result.skippedReserved).toBe(2)

    const box = entries.find(entry => entry.name === 'Box')!
    const bracket = entries.find(entry => entry.name === 'Bracket')!
    expect(await getPreviewStore().get(result.workspace, box.id)).toBe(PNG_BASE64)
    expect(await getPreviewStore().get(result.workspace, bracket.id)).toBe(PNG_BASE64)
  })

  it('a document with no sidecar gets no preview', async () => {
    const bytes = await zipOf({
      'library/Box.yaml': 'kind: part\n',
      'library/Box.png': PNG_BYTES,
      'library/Plain.yaml': 'kind: part\n',
    })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'legacy'), { origin: 'legacy' }, store)

    const entries = await store.listEntries(result.workspace)
    const plain = entries.find(entry => entry.name === 'Plain')!
    expect(await getPreviewStore().get(result.workspace, plain.id)).toBeUndefined()
  })

  it('a join keys the preview to the re-minted entry id, not the bag id', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Destination')
    const bytes = await zipOf({
      'library/Box.yaml': 'kind: part\n',
      'library/Box.png': PNG_BYTES,
    })
    const result = await importBag(await readZipBag(bytes, 'legacy'), { origin: 'legacy', into: workspace }, store)
    expect(result.mode).toBe('join')

    const entries = await store.listEntries(workspace)
    const box = entries.find(entry => entry.name === 'Box')!
    expect(await getPreviewStore().get(workspace, box.id)).toBe(PNG_BASE64)
  })

  it('skips a sidecar too large to be a thumbnail, as the pre-D6 drop did', async () => {
    // Highly compressible, so the archive stays small while the decompressed
    // sidecar does not -- the shape the input cap cannot see.
    const oversized = new Uint8Array(MAX_PREVIEW_BYTES + 1)
    const bytes = await zipOf({ 'library/Box.yaml': 'kind: part\n', 'library/Box.png': oversized })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'legacy'), { origin: 'legacy' }, store)

    const entries = await store.listEntries(result.workspace)
    const box = entries.find(entry => entry.name === 'Box')!
    expect(await getPreviewStore().get(result.workspace, box.id)).toBeUndefined()
    // Still dropped from the tree and still counted, exactly as before.
    expect(entries.some(entry => entry.name.endsWith('.png'))).toBe(false)
    expect(result.skippedReserved).toBe(1)
  })

  it('a stray png with no sibling document stays a file entry and seeds nothing', async () => {
    const bytes = await zipOf({ 'library/logo.png': PNG_BYTES })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'zip'), { origin: 'zip' }, store)

    const [entry] = await store.listEntries(result.workspace)
    expect(entry).toMatchObject({ kind: 'file', mime: 'image/png' })
    expect(await getPreviewStore().get(result.workspace, entry.id)).toBeUndefined()
  })
})
