import { describe, it, expect, beforeEach } from 'vitest'
import {
  STORE_WORKSPACE_ENTRIES,
  STORE_WORKSPACE_ENTRY_META,
} from '@/stores/documentStore/idb'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { DirectoryCarrier } from '../directoryCarrier'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The U1 grid lists a workspace's counts, cover entry and rev, none of which
// needs a payload. A 200-document workspace must list without reading one byte
// of document text, on the IndexedDB working copy and on the folder carrier.

function manyDocuments(count: number) {
  return Array.from({ length: count }, (_, i) =>
    documentEntry(`d${String(i).padStart(3, '0')}`, `Doc${i}`, { text: `kind: part\n# ${i}\n` }))
}

describe('200-document listing stays metadata-only', () => {
  beforeEach(resetWorkspaceIdb)

  it('WorkspaceStore.list reads the payload-free mirror, not the working copy', async () => {
    const tree = treeWith(manyDocuments(200), 'ws-scale')
    await seedWorkspace(tree)
    await new IdbCarrier('ws-scale').save(tree)

    const reads: string[] = []
    const original = IDBObjectStore.prototype.getAll
    const patched = function (this: IDBObjectStore, ...args: unknown[]) {
      reads.push(this.name)
      return (original as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
    }
    IDBObjectStore.prototype.getAll = patched as typeof IDBObjectStore.prototype.getAll
    let summaries
    try {
      summaries = await new IdbWorkspaceStore().list()
    } finally {
      IDBObjectStore.prototype.getAll = original
    }

    expect(summaries).toHaveLength(1)
    expect(summaries[0].entryCount).toBe(200)
    expect(summaries[0].rev).toBeGreaterThan(0)
    expect(reads).toContain(STORE_WORKSPACE_ENTRY_META)
    expect(reads).not.toContain(STORE_WORKSPACE_ENTRIES)
  })

  it('DirectoryCarrier.list reads only the manifest, not each document file', async () => {
    const dir = fakeDirectory('scale')
    const carrier = new DirectoryCarrier(dir)
    await carrier.save(treeWith(manyDocuments(200), 'scale'))

    dir.reads = 0
    const listed = await carrier.list()
    expect(listed).toHaveLength(200)
    expect(dir.reads).toBe(1)
  })
})
