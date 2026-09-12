import { describe, it, expect, beforeEach } from 'vitest'
import { STORE_WORKSPACE_META } from '@/stores/documentStore/idb'
import { IdbCarrier } from '../idbCarrier'
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
