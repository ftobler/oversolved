import { describe, it, expect, beforeEach } from 'vitest'
import { STORE_WORKSPACE_META } from '@/stores/documentStore/idb'
import { IdbCarrier } from '../idbCarrier'
import { DirectoryCarrier } from '../directoryCarrier'
import { ZipCarrier } from '../zipCarrier'
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
    const carrier = new DirectoryCarrier(dir as unknown as FileSystemDirectoryHandle)
    const before = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# old a\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n# old b\n' }),
    ], 'ws')
    await carrier.save(before)

    const after = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# new a\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n# new b\n' }),
    ], 'ws')
    dir.failOn.name = 'A.yaml'
    await expect(carrier.save(after)).rejects.toThrow('disk full')

    // The manifest was never rewritten, so the old tree still opens whole.
    const reopened = await carrier.open()
    expect(reopened.contents.get('a')?.text).toBe('kind: part\n# old a\n')
    expect(reopened.contents.get('b')?.text).toBe('kind: part\n# old b\n')
  })
})

describe('I7: a zip write is one whole-file commit', () => {
  it('a failed save leaves the archive handle at its previous bytes', async () => {
    const state = {
      bytes: new Uint8Array(0),
      writes: 0,
      fail: false,
    }
    const handle = {
      kind: 'file' as const,
      name: 'ws.zip',
      async getFile() {
        return { size: state.bytes.byteLength, lastModified: 0, async arrayBuffer() { return state.bytes.buffer } }
      },
      async createWritable() {
        state.writes += 1
        let buffer = new Uint8Array(0)
        return {
          async write(data: Uint8Array) { buffer = new Uint8Array(data) },
          async close() {
            if (state.fail) throw new Error('write failed')
            state.bytes = buffer
          },
          async abort() {},
        }
      },
    } as unknown as FileSystemFileHandle

    const carrier = new ZipCarrier(undefined, handle)
    const tree = treeWith([documentEntry('a', 'A', { text: 'kind: part\n' })], 'ws')
    await carrier.save(tree)
    expect(state.writes).toBe(1)
    const committed = state.bytes

    state.fail = true
    await expect(carrier.save(tree)).rejects.toThrow('write failed')
    expect(state.bytes).toEqual(committed)
  })
})

// A store save has one destination now, so the folder and the archive above are
// exporters: what they promise on a torn write is their own, and store.save's
// atomicity is the IndexedDB transaction the first describe pins.
