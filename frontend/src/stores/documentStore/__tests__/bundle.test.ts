import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import JSZip from 'jszip'
import { IndexedDbDocumentStore, LOCAL_OWNER } from '../IndexedDbDocumentStore'
import { buildBundleBytes, importBundle } from '../bundle'
import { resetDbConnection } from '../idb'
import { secureFilename } from '../secureFilename'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
})

async function entryNames(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  return Object.keys(zip.files).filter(n => !zip.files[n].dir).sort()
}

describe('bundle export/import', () => {
  it('round-trips a multi-doc set through a store (ids + payloads + previews)', async () => {
    const store = new IndexedDbDocumentStore()
    const a = await store.create('Bracket')
    await store.save(a.uuid, { content: 'features: [a]', preview_image: 'aGVsbG8=' })
    const b = await store.create('Gearbox')
    await store.save(b.uuid, { content: 'features: [b]' })

    const bytes = await buildBundleBytes(store, [a.uuid, b.uuid])

    // Import into a fresh store and assert payloads survived.
    globalThis.indexedDB = new IDBFactory()
    resetDbConnection()
    const target = new IndexedDbDocumentStore()
    const ids = await importBundle(target, bytes)
    expect(ids).toHaveLength(2)

    const summaries = await target.list({ sort: 'name' })
    expect(summaries.map(s => s.name)).toEqual(['Bracket', 'Gearbox'])
    const bracket = summaries.find(s => s.name === 'Bracket')!
    const loaded = await target.load(bracket.uuid)
    expect(loaded.content).toBe('features: [a]')
    expect(loaded.preview_image).toBe('aGVsbG8=')
  })

  it('emits zip entry paths matching the admin backup layout (<user>/<name>.yaml + .png)', async () => {
    const store = new IndexedDbDocumentStore()
    const a = await store.create('My Part')
    await store.save(a.uuid, { content: 'x', preview_image: 'aGk=' })
    const bytes = await buildBundleBytes(store, [a.uuid])
    expect(await entryNames(bytes)).toEqual([
      `${LOCAL_OWNER}/My_Part.png`,
      `${LOCAL_OWNER}/My_Part.yaml`,
    ])
  })

  it('single-doc export is one yaml entry when there is no preview', async () => {
    const store = new IndexedDbDocumentStore()
    const a = await store.create('Solo')
    await store.save(a.uuid, { content: 'x' })
    const bytes = await buildBundleBytes(store, [a.uuid])
    expect(await entryNames(bytes)).toEqual([`${LOCAL_OWNER}/Solo.yaml`])
  })

  it('suffixes colliding secure-filename stems (_1, _2) like admin.py', async () => {
    const store = new IndexedDbDocumentStore()
    // Both secure-filename to "My_Part" -> must not overwrite.
    const a = await store.create('My Part')
    await store.save(a.uuid, { content: 'first' })
    const b = await store.create('My/Part')
    await store.save(b.uuid, { content: 'second' })
    const bytes = await buildBundleBytes(store, [a.uuid, b.uuid])
    expect(await entryNames(bytes)).toEqual([
      `${LOCAL_OWNER}/My_Part.yaml`,
      `${LOCAL_OWNER}/My_Part_1.yaml`,
    ])
  })

  it('ingests a server-produced zip (arbitrary username dir, raw png) -> local docs', async () => {
    // Simulate exactly what /api/admin/backup writes: a real username dir and a
    // PNG stored as raw bytes. importBundle must drop the user segment and
    // base64-encode the preview into the local store.
    const zip = new JSZip()
    zip.file('florin/Box.yaml', 'features: [server]')
    zip.file('florin/Box.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))  // PNG magic
    const bytes = await zip.generateAsync({ type: 'uint8array' })

    const store = new IndexedDbDocumentStore()
    const ids = await importBundle(store, bytes)
    expect(ids).toHaveLength(1)
    const loaded = await store.load(ids[0])
    expect(loaded.name).toBe('Box')
    expect(loaded.content).toBe('features: [server]')
    expect(loaded.preview_image).toBe(btoa('\x89PNG'))
  })

  it('secureFilename mirrors werkzeug for common cases', () => {
    expect(secureFilename('box')).toBe('box')
    expect(secureFilename('My Part')).toBe('My_Part')
    expect(secureFilename('../etc/passwd')).toBe('etc_passwd')
    expect(secureFilename('a/b/c')).toBe('a_b_c')
    expect(secureFilename('  spaced  name ')).toBe('spaced_name')
  })
})
