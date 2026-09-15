import { describe, it, expect, beforeEach } from 'vitest'
import { STORE_WORKSPACE_META } from '@/stores/documentStore/idb'
import { IdbCarrier } from '../idbCarrier'
import { readDirectoryTree, writeDirectoryTree } from '../directoryCarrier'
import { MemoryDirectory } from '@/stores/documentStore/memoryDirectory'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'

describe('I7: an IndexedDB save is atomic across keys', () => {
  beforeEach(resetWorkspaceIdb)

  it('a failure after the entry writes leaves every record at its old value', async () => {
    const workspace = 'ws-atomic'
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# old a\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n# old b\n' }),
    ], workspace)
    await seedWorkspace(tree)
    const carrier = new IdbCarrier(workspace)
    await carrier.save(tree)

    // The same manifest, new payloads: save queues both entry puts, then the
    // meta put throws, which aborts the whole transaction.
    const next = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# new a\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n# new b\n' }),
    ], workspace)

    const original = IDBObjectStore.prototype.put
    const patched = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === STORE_WORKSPACE_META) throw new Error('injected meta failure')
      return (original as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
    }
    IDBObjectStore.prototype.put = patched as typeof IDBObjectStore.prototype.put
    try {
      await expect(carrier.save(next)).rejects.toThrow('injected meta failure')
    } finally {
      IDBObjectStore.prototype.put = original
    }

    const reopened = await carrier.open()
    expect(reopened.contents.get('a')?.text).toBe('kind: part\n# old a\n')
    expect(reopened.contents.get('b')?.text).toBe('kind: part\n# old b\n')
  })
})

// A directory can only promise per-file atomicity: createWritable buffers and
// close swings the swap file into place, so an interrupted write leaves the
// previous contents. The manifest is written last, so a crash before it leaves
// the old manifest and the new files as orphans that reconcile surfaces.
class FlakyDirectory extends MemoryDirectory {
  failOn: { name: string | null }

  constructor(name: string, failOn = { name: null as string | null }) {
    super(name)
    this.failOn = failOn
  }

  protected override beforeWrite(name: string): void {
    if (this.failOn.name === name) {
      this.failOn.name = null
      throw new Error('disk full')
    }
  }

  protected override makeChild(name: string): MemoryDirectory {
    return new FlakyDirectory(name, this.failOn)
  }
}

describe('I7: a folder write is atomic per entry', () => {
  it('an interrupted entry write leaves the previous file wholly intact', async () => {
    const dir = new FlakyDirectory('ws')
    const handle = dir as unknown as FileSystemDirectoryHandle
    const before = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# old a\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n# old b\n' }),
    ], 'ws')
    await writeDirectoryTree(handle, before)

    const after = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# new a\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n# new b\n' }),
    ], 'ws')
    dir.failOn.name = 'A.yaml'
    await expect(writeDirectoryTree(handle, after)).rejects.toThrow('disk full')

    // The manifest was never rewritten, so the old tree still reads whole.
    const reopened = await readDirectoryTree(handle)
    expect(reopened.contents.get('a')?.text).toBe('kind: part\n# old a\n')
    expect(reopened.contents.get('b')?.text).toBe('kind: part\n# old b\n')
  })
})

// A store save has one destination now, so the folder above is an export
// endpoint: what it promises on a torn write is its own, and store.save's
// atomicity is the IndexedDB transaction the first describe pins. The archive
// has nothing left to promise -- bytes are built whole in memory and handed to
// the download, so there is no partial archive to leave behind.
