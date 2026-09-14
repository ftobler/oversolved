import { describe, it, expect, beforeEach } from 'vitest'
import {
  STORE_WORKSPACE_ENTRIES,
  STORE_WORKSPACE_ENTRY_META,
  STORE_WORKSPACE_SAVED,
  idbTransaction,
} from '@/stores/documentStore/idb'
import { IdbCarrier, readWorkspaceMeta, workspaceEntryRecords, writeWorkspaceMeta } from '../idbCarrier'
import { IdbWorkspaceStore } from '../store'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'

// A workspace-scoped read must never scan the whole store, because getAll on the
// working copy clones every workspace's payload bytes out of IndexedDB. These
// cases pin the per-workspace indexes: list() and open() go through the mirror
// (and the (workspace, kind) index for document text), and a scoped record read
// returns only its own workspace's rows.

function instrumentReads() {
  const reads: string[] = []
  const originalStore = IDBObjectStore.prototype.getAll
  const originalIndex = IDBIndex.prototype.getAll
  IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
    reads.push(this.name)
    return (originalStore as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
  } as typeof IDBObjectStore.prototype.getAll
  IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: unknown[]) {
    reads.push(`${this.objectStore.name}:${this.name}`)
    return (originalIndex as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
  } as typeof IDBIndex.prototype.getAll
  return {
    reads,
    restore() {
      IDBObjectStore.prototype.getAll = originalStore
      IDBIndex.prototype.getAll = originalIndex
    },
  }
}

async function makeCarrier(entries: Parameters<typeof treeWith>[0], workspace = 'ws-index'): Promise<IdbCarrier> {
  const tree = treeWith(entries, workspace)
  await seedWorkspace(tree)
  const carrier = new IdbCarrier(tree.manifest.workspace)
  await carrier.save(tree)
  return carrier
}

describe('per-workspace IndexedDB indexes', () => {
  beforeEach(resetWorkspaceIdb)

  it('list reads the payload-free mirror, never the working copy', async () => {
    const carrier = await makeCarrier([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3])),
    ])

    const { reads, restore } = instrumentReads()
    let listed
    try {
      listed = await carrier.list()
    } finally {
      restore()
    }

    expect(listed?.map(entry => entry.id).sort()).toEqual(['a', 'b'])
    expect(reads).toContain(`${STORE_WORKSPACE_ENTRY_META}:by_workspace`)
    expect(reads).not.toContain(STORE_WORKSPACE_ENTRIES)
  })

  it('open stays payload-free for files and reads only document text', async () => {
    const carrier = await makeCarrier([
      documentEntry('a', 'A', { text: 'kind: part\n# body\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
    ])

    const { reads, restore } = instrumentReads()
    let tree
    try {
      tree = await carrier.open()
    } finally {
      restore()
    }

    expect(tree?.manifest.entries.b).toMatchObject({ kind: 'file', name: 'b.step', mime: 'application/step' })
    expect(tree?.contents.has('b')).toBe(false)
    expect(tree?.contents.get('a')?.text).toBe('kind: part\n# body\n')
    expect(reads).not.toContain(STORE_WORKSPACE_ENTRIES)
    expect(reads).toContain(`${STORE_WORKSPACE_ENTRIES}:by_workspace_kind`)
  })

  it('workspaceEntryRecords returns only the named workspace rows', async () => {
    await makeCarrier([documentEntry('a1', 'A1', { text: 'kind: part\n' })], 'A')
    await makeCarrier([documentEntry('b1', 'B1', { text: 'kind: part\n' })], 'B')

    const records = await workspaceEntryRecords('A')
    expect(records.map(record => record.workspace)).toEqual(['A'])
    expect(records.map(record => record.id)).toEqual(['a1'])
  })

  it('stamps the checkpoint rev map on the meta and falls back to the rows', async () => {
    const carrier = await makeCarrier([documentEntry('a', 'A', { text: 'kind: part\n' })])
    await carrier.checkpoint()
    const saved = await readWorkspaceMeta('ws-index')
    expect(saved?.savedRevs).toEqual({ a: 1 })

    // A meta written before the map existed still answers from the checkpoint
    // rows.
    const withoutMap = { ...saved! }
    delete withoutMap.savedRevs
    await writeWorkspaceMeta(withoutMap)
    expect(await carrier.maxSavedRev()).toBe(1)

    // Once restamped, the map is the only source: emptying the checkpoint rows
    // must not change the answer.
    await carrier.checkpoint()
    await idbTransaction([STORE_WORKSPACE_SAVED], 'readwrite', stores => {
      stores[STORE_WORKSPACE_SAVED].clear()
    })
    expect(await carrier.maxSavedRev()).toBe(1)
  })

  // A workspace rename used to run the whole-tree writer, cloning every entry
  // payload to rename one string. With more than one entry it must write the
  // meta alone and leave the working copy untouched.
  it('renames a multi-entry workspace without reading its entry payloads', async () => {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([9, 9, 9])),
    ], 'ws-rename')
    await seedWorkspace(tree)
    await new IdbCarrier('ws-rename').save(tree)

    const { reads, restore } = instrumentReads()
    try {
      await new IdbWorkspaceStore().rename('ws-rename', 'Renamed')
    } finally {
      restore()
    }

    expect(reads).not.toContain(STORE_WORKSPACE_ENTRIES)
    expect((await readWorkspaceMeta('ws-rename'))?.name).toBe('Renamed')
    const records = await workspaceEntryRecords('ws-rename')
    expect(records.map(record => record.name).sort()).toEqual(['A', 'b.step'])
  })
})
