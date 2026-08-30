import { describe, it, expect, beforeEach } from 'vitest'
import {
  openDirectoryLibrary, FileSystemDirectoryStore, FileSystemDirectoryTrashAdapter,
} from '../FileSystemDirectoryStore'
import { INDEX_FILE, TRASH_DIR } from '../directoryLibrary'
import { fakeDirectory, type FakeDirectoryHandle } from './fakeFileSystemDirectory'
import { InMemoryDocumentStore } from './InMemoryDocumentStore'

// What the shared contract does NOT promise, and this store nonetheless has to
// get right: the on-disk layout, per-file save atomicity, and what happens when
// the folder changes underneath the app. contract.test.ts covers the interface.

let dir: FakeDirectoryHandle & FileSystemDirectoryHandle
let store: FileSystemDirectoryStore
let trash: FileSystemDirectoryTrashAdapter

beforeEach(() => {
  dir = fakeDirectory('cad')
  const opened = openDirectoryLibrary(dir)
  store = opened.documents
  trash = opened.trash
})

describe('on-disk layout', () => {
  // A `.png` the user put in the folder occupies that stem. Handing it to a new
  // document would have the first save with a preview overwrite their image.
  it('does not claim a stem an unrelated file already occupies', async () => {
    dir.putText('Bracket.png', 'MY OWN IMAGE')
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'x', preview_image: btoa('\x89PNG') })
    expect(dir.snapshot()['Bracket.png']).toBe('MY OWN IMAGE')
    expect(dir.fileNames()).toContain('Bracket_1.yaml')
  })

  // The point of the feature: a folder of files the user already understands,
  // not an opaque archive. One document is one plain .yaml.
  it('writes one plain .yaml per document, named after the document', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'kind: part\nfeatures: []\n' })
    expect(dir.snapshot()['Bracket.yaml']).toBe('kind: part\nfeatures: []\n')
  })

  // Byte-identity with the export button is what makes "the on-disk format is
  // not a new format" true rather than aspirational: a file written here opens
  // in the same editor, diffs in the same git, and imports back unchanged.
  it('writes exactly the bytes the YAML export would have downloaded', async () => {
    const content = 'kind: assembly\nfeatures:\n  - id: O1\n    kind: origin\n'
    const memory = new InMemoryDocumentStore()
    const inMemory = await memory.create('Rig')
    await memory.save(inMemory.uuid, { content })
    const exported = (await memory.load(inMemory.uuid)).content

    const { uuid } = await store.create('Rig')
    await store.save(uuid, { content })
    expect(dir.snapshot()['Rig.yaml']).toBe(exported)
  })

  it('creates the file at create time, not at first save', async () => {
    await store.create('Empty')
    expect(dir.fileNames()).toContain('Empty.yaml')
  })

  it('keeps the preview as a real .png sibling', async () => {
    const png = btoa('\x89PNG\r\n\x1a\n')
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'x', preview_image: png })
    expect(dir.fileNames()).toEqual([INDEX_FILE, 'Bracket.png', 'Bracket.yaml'].sort())
    expect((await store.load(uuid)).preview_image).toBe(png)
  })

  // The bundle format carries a vestigial <user>/ level, kept only so older
  // bundles keep importing. A folder the user picked holds one library, and a
  // `local/` level inside it would be an artifact of a server that is gone.
  it('sheds the bundle format per-user directory level', async () => {
    await store.create('Bracket')
    expect(dir.fileNames().some(n => n.includes('/'))).toBe(false)
  })

  // A name that is not a filename still has to become one, and two documents
  // that sanitize to the same stem must never overwrite each other.
  it('sanitizes names into stems and suffixes collisions', async () => {
    const a = await store.create('My Bracket')
    const b = await store.create('My/Bracket')
    expect(dir.fileNames()).toContain('My_Bracket.yaml')
    expect(dir.fileNames()).toContain('My_Bracket_1.yaml')
    await store.save(a.uuid, { content: 'first' })
    await store.save(b.uuid, { content: 'second' })
    expect((await store.load(a.uuid)).content).toBe('first')
    expect((await store.load(b.uuid)).content).toBe('second')
  })

  // In a directory library the filename IS the document name, so a rename that
  // left the old file behind would make the folder disagree with the app.
  it('renames the file on disk, taking the preview with it', async () => {
    const png = btoa('\x89PNG')
    const { uuid } = await store.create('Old')
    await store.save(uuid, { content: 'body', preview_image: png })
    await store.rename(uuid, 'New')
    expect(dir.fileNames()).toEqual([INDEX_FILE, 'New.png', 'New.yaml'].sort())
    const loaded = await store.load(uuid)
    expect(loaded.content).toBe('body')
    expect(loaded.preview_image).toBe(png)
  })

  it('keeps the document uuid stable across a rename', async () => {
    const { uuid } = await store.create('Old')
    await store.rename(uuid, 'New')
    expect((await store.list()).map(d => d.uuid)).toEqual([uuid])
  })
})

describe('save atomicity', () => {
  // The objection this feature must not reintroduce. createWritable() buffers
  // into a swap file and only commits on close(), so an interrupted save leaves
  // the PREVIOUS contents intact -- never a truncated document.
  it('leaves the previous contents intact when a save fails mid-write', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'good version' })
    dir.failNextWrite = 'quota exceeded'
    await expect(store.save(uuid, { content: 'doomed version' })).rejects.toThrow('quota exceeded')
    expect(dir.snapshot()['Bracket.yaml']).toBe('good version')
    expect((await store.load(uuid)).content).toBe('good version')
  })

  // A failed save must not advance the revision either: rev is the assembly
  // bundle cache key, and bumping it for bytes that never landed would evict a
  // cache entry that is still correct.
  it('does not advance meta.rev when the write failed', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })
    const before = (await store.list())[0].meta!.rev
    dir.failNextWrite = 'quota exceeded'
    await expect(store.save(uuid, { content: 'v2' })).rejects.toThrow()
    expect((await store.list())[0].meta!.rev).toBe(before)
  })

  // Identical bytes must not churn rev, restamp the file, or touch its
  // modification time -- which in a directory library is something the user can
  // see, in git and in their file manager.
  it('skips the write entirely when the bytes are unchanged', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'same' })
    const before = (await store.list())[0].meta!.rev
    dir.failNextWrite = 'a write would have happened'
    await store.save(uuid, { content: 'same' })
    expect((await store.list())[0].meta!.rev).toBe(before)
    dir.failNextWrite = null
  })

  // There is no cross-file transaction in this API, so overlapping saves would
  // otherwise interleave their read and write of the index and one would lose.
  it('serializes concurrent writes so none is lost', async () => {
    const names = ['A', 'B', 'C', 'D', 'E']
    const created = await Promise.all(names.map(n => store.create(n)))
    expect(new Set(created.map(c => c.uuid)).size).toBe(5)
    expect((await store.list()).map(d => d.name).sort()).toEqual(names)
    expect(dir.fileNames().filter(n => n.endsWith('.yaml')).length).toBe(5)
  })
})

describe('the folder changing underneath the app', () => {
  // There is no change notification on a directory handle, so every read
  // reconciles: a git checkout, a Dropbox sync or another editor is simply what
  // the folder looks like now.
  it('adopts a .yaml that appeared from outside, named after the file', async () => {
    dir.putText('Gearbox.yaml', 'kind: part\n')
    const list = await store.list()
    expect(list.map(d => d.name)).toEqual(['Gearbox'])
    expect((await store.load(list[0].uuid)).content).toBe('kind: part\n')
  })

  // Adoption has to persist, or the route the user is sitting on would break on
  // the next list.
  it('keeps an adopted document at the same uuid across reads', async () => {
    dir.putText('Gearbox.yaml', 'kind: part\n')
    const first = (await store.list())[0].uuid
    expect((await store.list())[0].uuid).toBe(first)
    expect(dir.snapshot()[INDEX_FILE]).toContain(first)
  })

  // Reconcile runs in front of writes as well as reads, so its result has to
  // survive a mutation that decides to write nothing of its own -- otherwise
  // the index and the folder agree after a read but not after a write.
  it('persists an adoption found by a write that then no-ops', async () => {
    dir.putText('Gearbox.yaml', 'kind: part\n')
    await store.remove('no-such-doc')  // a no-op mutation, nothing of its own to write
    const index = dir.snapshot()[INDEX_FILE]
    expect(index).toContain('Gearbox')
    expect(index).toContain((await store.list())[0].uuid)
  })

  // The headline use case: a file edited by git, an editor or a sync client.
  // `meta.rev` is the assembly bundle cache key, so a document whose bytes
  // changed without a rev bump renders its PRE-edit geometry with no error.
  it('bumps rev when a document file is edited from outside', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })
    const before = (await store.list())[0]

    dir.putText('Bracket.yaml', 'edited by something else')
    const after = (await store.list())[0]
    expect(after.uuid).toBe(uuid)  // same document, not a re-adoption
    expect(after.meta!.rev).toBeGreaterThan(before.meta!.rev)
    expect(after.updated_at).not.toBe(before.updated_at)
    expect((await store.load(uuid)).content).toBe('edited by something else')
  })

  // A rewrite that preserves the length is the case a size check alone misses.
  it('notices an outside edit that did not change the file length', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })
    const before = (await store.list())[0]
    dir.touch('Bracket.yaml')
    expect((await store.list())[0].meta!.rev).toBeGreaterThan(before.meta!.rev)
  })

  // The other half of that: this app's OWN writes must not read as outside
  // edits, or every save would bump rev twice and every list would rewrite the
  // index.
  it('does not mistake its own writes for outside edits', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })
    const settled = (await store.list())[0].meta!.rev
    expect((await store.list())[0].meta!.rev).toBe(settled)
    expect((await store.list())[0].meta!.rev).toBe(settled)
  })

  it('drops a document whose file was deleted from outside', async () => {
    const { uuid } = await store.create('Bracket')
    await dir.removeEntry('Bracket.yaml')
    expect(await store.list()).toEqual([])
    await expect(store.load(uuid)).rejects.toThrow()
  })

  // The index is bookkeeping, not data: losing it costs uuid stability and
  // nothing else, because every document is still a file sitting right there.
  it('rebuilds the whole library by adoption when the index is lost', async () => {
    const a = await store.create('Bracket')
    await store.save(a.uuid, { content: 'shape' })
    await dir.removeEntry(INDEX_FILE)
    const list = await store.list()
    expect(list.map(d => d.name)).toEqual(['Bracket'])
    expect((await store.load(list[0].uuid)).content).toBe('shape')
  })

  it('rebuilds by adoption when the index is corrupt rather than reporting empty', async () => {
    await store.create('Bracket')
    dir.putText(INDEX_FILE, '{ not json')
    expect((await store.list()).map(d => d.name)).toEqual(['Bracket'])
  })

  // Silence about an unreadable folder is the dangerous failure: an empty
  // library is exactly the state the reconciler treats as "adopt everything",
  // so a read error has to surface rather than look like an empty folder.
  it('propagates a read failure instead of reporting an empty library', async () => {
    const broken = {
      name: 'broken',
      getFileHandle: async () => { throw new Error('permission revoked') },
      getDirectoryHandle: async () => broken,
      removeEntry: async () => undefined,
      values: async function* () {},
    } as unknown as FileSystemDirectoryHandle
    await expect(openDirectoryLibrary(broken).documents.list()).rejects.toThrow('permission revoked')
  })
})

describe('trash', () => {
  // Reading a folder must not write to it: browsing a library should leave it
  // byte-for-byte as the user left it, and a read-only handle would otherwise
  // fail the whole read rather than degrade.
  it('does not create the trash folder just by listing', async () => {
    await store.list()
    await store.create('Bracket')
    await store.list()
    expect(dir.dirNames()).toEqual([])
    await store.remove((await store.list())[0].uuid)
    expect(dir.dirNames()).toEqual([TRASH_DIR])
  })

  it('moves a deleted document into the trash folder, out of the library view', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'shape' })
    await store.remove(uuid)
    expect(dir.fileNames()).toEqual([INDEX_FILE])
    expect(dir.snapshot()[`${TRASH_DIR}/Bracket.yaml`]).toBe('shape')
    expect(await store.list()).toEqual([])
    await expect(store.load(uuid)).rejects.toThrow()
    expect((await trash.list()).map(d => d.name)).toEqual(['Bracket'])
  })

  it('recovers a trashed document back into the library folder', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'shape' })
    await store.remove(uuid)
    await trash.recover(uuid)
    expect(dir.snapshot()['Bracket.yaml']).toBe('shape')
    expect(dir.snapshot()[`${TRASH_DIR}/Bracket.yaml`]).toBeUndefined()
    expect((await store.load(uuid)).content).toBe('shape')
    expect(await trash.list()).toEqual([])
  })

  // Another document may have taken the name while this one sat in the trash,
  // and a recover must never overwrite it.
  it('recovers under a fresh stem when the name was taken meanwhile', async () => {
    const first = await store.create('Bracket')
    await store.save(first.uuid, { content: 'original' })
    await store.remove(first.uuid)
    const second = await store.create('Bracket')
    await store.save(second.uuid, { content: 'replacement' })
    await trash.recover(first.uuid)
    expect((await store.load(first.uuid)).content).toBe('original')
    expect((await store.load(second.uuid)).content).toBe('replacement')
    expect(dir.snapshot()['Bracket.yaml']).toBe('replacement')
  })

  // An editor autosave can land after the grid deleted the document. Falling
  // through to save()'s upsert minted a SECOND entry under the same uuid: two
  // rows sharing a React key, the user's bytes stranded in an `Untitled.yaml`,
  // and a later recover overwriting them. It resurrects instead, which is what
  // the IndexedDB store does with the same sequence.
  it('a save into a trashed id resurrects it rather than minting a twin', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'v1' })
    await store.remove(uuid)
    await store.save(uuid, { content: 'v2' })

    const list = await store.list()
    expect(list.map(d => d.name)).toEqual(['Bracket'])
    expect(list.map(d => d.uuid)).toEqual([uuid])
    expect((await store.load(uuid)).content).toBe('v2')
    expect(await trash.list()).toEqual([])
    expect(dir.snapshot()['Bracket.yaml']).toBe('v2')
    expect(dir.snapshot()[`${TRASH_DIR}/Bracket.yaml`]).toBeUndefined()
  })

  it('resurrects under a fresh stem when the name was taken meanwhile', async () => {
    const first = await store.create('Bracket')
    await store.save(first.uuid, { content: 'v1' })
    await store.remove(first.uuid)
    const second = await store.create('Bracket')
    await store.save(second.uuid, { content: 'replacement' })

    await store.save(first.uuid, { content: 'v2' })
    expect((await store.load(first.uuid)).content).toBe('v2')
    expect((await store.load(second.uuid)).content).toBe('replacement')
    expect(dir.snapshot()['Bracket.yaml']).toBe('replacement')
  })

  // The Trash view shows a name, so it has to be the current one. The
  // IndexedDB store renames a tombstoned record too.
  it('renames a trashed document in place', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'shape' })
    await store.remove(uuid)
    await store.rename(uuid, 'Gearbox')
    expect((await trash.list()).map(d => d.name)).toEqual(['Gearbox'])
    expect(dir.snapshot()[`${TRASH_DIR}/Gearbox.yaml`]).toBe('shape')
    await trash.recover(uuid)
    expect(dir.snapshot()['Gearbox.yaml']).toBe('shape')
  })

  it('purge deletes the files for good', async () => {
    const { uuid } = await store.create('Bracket')
    await store.remove(uuid)
    await trash.purge(uuid)
    expect(dir.snapshot()[`${TRASH_DIR}/Bracket.yaml`]).toBeUndefined()
    expect(await trash.list()).toEqual([])
    expect(dir.snapshot()[INDEX_FILE]).not.toContain(uuid)
  })

  // A file in the trash folder is a DELETED document, so losing the index must
  // not make it unlistable and unrecoverable. It comes back as a tombstone: the
  // Trash can see it, and the library still cannot.
  it('adopts a trash-folder file as already deleted when the index is lost', async () => {
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'precious' })
    await store.remove(uuid)
    await dir.removeEntry(INDEX_FILE)

    expect(await store.list()).toEqual([])  // delete still sticks
    const trashed = await trash.list()
    expect(trashed.map(d => d.name)).toEqual(['Bracket'])
    await trash.recover(trashed[0].uuid)
    expect(dir.snapshot()['Bracket.yaml']).toBe('precious')
  })

  // Before those files were adopted they were invisible to stem allocation
  // too, so the next same-named delete overwrote them.
  it('does not overwrite an unindexed trash file with a new delete', async () => {
    const first = await store.create('Bracket')
    await store.save(first.uuid, { content: 'precious' })
    await store.remove(first.uuid)
    await dir.removeEntry(INDEX_FILE)

    const second = await store.create('Bracket')
    await store.save(second.uuid, { content: 'unrelated' })
    await store.remove(second.uuid)
    expect(Object.values(dir.snapshot())).toContain('precious')
    expect((await trash.list()).map(d => d.name).sort()).toEqual(['Bracket', 'Bracket'])
  })
})
