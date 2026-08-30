import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import JSZip from 'jszip'
import { IndexedDbDocumentStore, LOCAL_OWNER } from '../IndexedDbDocumentStore'
import { buildBundleBytes, importBundle, MAX_BUNDLE_ENTRIES, MAX_BUNDLE_INPUT_BYTES } from '../bundle'
import { resetDbConnection } from '../idb'
import { secureFilename } from '../secureFilename'
beforeEach(() => {
  resetFakeIndexedDb()
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
    resetFakeIndexedDb()
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

  it('rolls back every entry created so far when a mid-import save fails', async () => {
    const zip = new JSZip()
    zip.file('u/One.yaml', 'features: [1]')
    zip.file('u/Two.yaml', 'features: [2]')
    const bytes = await zip.generateAsync({ type: 'uint8array' })

    const store = new IndexedDbDocumentStore()
    let saves = 0
    vi.spyOn(store, 'save').mockImplementation(async () => {
      saves += 1
      if (saves >= 2) throw new Error('quota exceeded')  // the second entry's save dies
    })

    await expect(importBundle(store, bytes)).rejects.toThrow(/quota/)

    // Without compensation "One" would survive as a partial import; both
    // entries must be gone so a retry starts clean.
    expect(await store.list()).toHaveLength(0)
  })

  it('rejects an archive over the entry-count cap cleanly', async () => {
    // Mirrors admin.py's zip-bomb entry cap; static builds have no server
    // fallback, so this is the only guard.
    const zip = new JSZip()
    for (let i = 0; i <= MAX_BUNDLE_ENTRIES; i++) zip.file(`u/doc-${i}.yaml`, 'x')
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })

    const store = new IndexedDbDocumentStore()
    await expect(importBundle(store, bytes)).rejects.toThrow(/too many files/i)
    expect(await store.list()).toHaveLength(0)  // rejected before any document lands
  })

  it('rejects an input over the compressed-size cap before any zip parse', async () => {
    // The input cap is checked on Blob.size before loadAsync, so the guard is
    // free of parse work; a faked size keeps the test from allocating 100MB.
    const oversized = Object.create(Blob.prototype) as Blob
    Object.defineProperty(oversized, 'size', { value: MAX_BUNDLE_INPUT_BYTES + 1 })

    const store = new IndexedDbDocumentStore()
    await expect(importBundle(store, oversized)).rejects.toThrow(/too large/i)
    expect(await store.list()).toHaveLength(0)
  })

  it('falls back to Untitled for names that strip to an empty stem', async () => {
    // Cyrillic/CJK names survive neither werkzeug's ascii encoding nor this
    // port; without the fallback they export as '<user>/.yaml' and import back
    // as blank-name documents no other path can reach.
    const store = new IndexedDbDocumentStore()
    const a = await store.create('деталь')
    await store.save(a.uuid, { content: 'x' })
    const bytes = await buildBundleBytes(store, [a.uuid])
    expect(await entryNames(bytes)).toEqual([`${LOCAL_OWNER}/Untitled.yaml`])

    // And the round trip lands on a reachable name again.
    resetFakeIndexedDb()
    resetDbConnection()
    const target = new IndexedDbDocumentStore()
    const imported = await importBundle(target, bytes)
    expect(await target.load(imported[0])).toMatchObject({ name: 'Untitled' })
  })

  it('suffixes multiple empty-stem names and never overwrites a real Untitled doc', async () => {
    const store = new IndexedDbDocumentStore()
    const a = await store.create('部品')
    await store.save(a.uuid, { content: 'first' })
    const b = await store.create('Деталь')
    await store.save(b.uuid, { content: 'second' })
    const c = await store.create('Untitled')
    await store.save(c.uuid, { content: 'third' })

    const bytes = await buildBundleBytes(store, [a.uuid, b.uuid, c.uuid])
    expect(await entryNames(bytes)).toEqual([
      `${LOCAL_OWNER}/Untitled.yaml`,
      `${LOCAL_OWNER}/Untitled_1.yaml`,
      `${LOCAL_OWNER}/Untitled_2.yaml`,
    ])
    const target = new IndexedDbDocumentStore()
    const contents: string[] = []
    for (const id of await importBundle(target, bytes)) {
      contents.push((await target.load(id)).content)
    }
    expect(contents.sort()).toEqual(['first', 'second', 'third'])
  })

  it('never lets a suffixed stripped-name entry overwrite a real doc sharing that stem', async () => {
    // Corner from review-17: a real doc named "Untitled_1" secure-filenames to
    // "Untitled_1", while two stripped non-ASCII names both fall back to
    // "Untitled". An old per-base counter would suffix the second stripped name
    // to "Untitled_1", clobbering the real doc. The reservation set keys on the
    // produced stem, so the suffix skips to "Untitled_2".
    const store = new IndexedDbDocumentStore()
    const real = await store.create('Untitled_1')
    await store.save(real.uuid, { content: 'real' })
    const a = await store.create('部品')
    await store.save(a.uuid, { content: 'first' })
    const b = await store.create('Деталь')
    await store.save(b.uuid, { content: 'second' })

    const bytes = await buildBundleBytes(store, [real.uuid, a.uuid, b.uuid])
    expect(await entryNames(bytes)).toEqual([
      `${LOCAL_OWNER}/Untitled.yaml`,
      `${LOCAL_OWNER}/Untitled_1.yaml`,
      `${LOCAL_OWNER}/Untitled_2.yaml`,
    ])

    // Round-trip preserves all three contents, no overwritten entry.
    resetFakeIndexedDb()
    resetDbConnection()
    const target = new IndexedDbDocumentStore()
    const contents: string[] = []
    for (const id of await importBundle(target, bytes)) {
      contents.push((await target.load(id)).content)
    }
    expect(contents.sort()).toEqual(['first', 'real', 'second'])
  })

  it('imports a legacy blank-stem entry (.yaml) as Untitled instead of an unreachable blank name', async () => {
    const zip = new JSZip()
    zip.file('u/.yaml', 'features: [legacy]')
    const bytes = await zip.generateAsync({ type: 'uint8array' })

    const store = new IndexedDbDocumentStore()
    const ids = await importBundle(store, bytes)
    expect(await store.load(ids[0])).toMatchObject({ name: 'Untitled' })
  })

  it('secureFilename mirrors werkzeug for common cases', () => {
    expect(secureFilename('box')).toBe('box')
    expect(secureFilename('My Part')).toBe('My_Part')
    expect(secureFilename('../etc/passwd')).toBe('etc_passwd')
    expect(secureFilename('a/b/c')).toBe('a_b_c')
    expect(secureFilename('  spaced  name ')).toBe('spaced_name')
  })
})
