import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { STORE_WORKSPACE_ENTRIES } from '@/stores/documentStore/idb'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { EntryReferencedError } from '../errors'
import { resetWorkspaceIdb } from './idbHarness'

const assemblyText = (partId: string): string =>
  `kind: assembly\nfeatures:\n  - kind: part_instance\n    instance:\n      handle: h1\n      doc_id: ${partId}\n      doc_rev: 1\n`

const originalPut = IDBObjectStore.prototype.put

// A storage that rejects the entry row itself, the way a full quota or a closed
// connection would, so only the edges that belong to stored text may remain.
function failEntryWrites(): void {
  const patched = function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === STORE_WORKSPACE_ENTRIES) throw new Error('injected entry failure')
    return (originalPut as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
  }
  IDBObjectStore.prototype.put = patched as typeof IDBObjectStore.prototype.put
}

describe('a rejected entry write leaves the reference edges alone', () => {
  beforeEach(resetWorkspaceIdb)
  afterEach(() => {
    IDBObjectStore.prototype.put = originalPut
  })

  it('keeps the edge to the part the stored assembly still names', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: assemblyText(workspace),
    })
    const carrier = new IdbCarrier(workspace)
    expect(await carrier.referencesOf('asm-1')).toEqual([workspace])

    // The text that drops the instance never lands, so its edge must not go.
    failEntryWrites()
    await expect(store.writeEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: 'kind: assembly\nfeatures: []\n',
    })).rejects.toThrow('injected entry failure')
    IDBObjectStore.prototype.put = originalPut

    expect((await store.readEntry(workspace, 'asm-1')).text).toBe(assemblyText(workspace))
    expect(await carrier.referencesOf('asm-1')).toEqual([workspace])
    // The delete guard reads those edges, so the part stays undeletable.
    await expect(store.removeEntry(workspace, workspace)).rejects.toBeInstanceOf(EntryReferencedError)
  })

  it('drops the edge once the dropping text is stored', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: assemblyText(workspace),
    })

    await store.writeEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: 'kind: assembly\nfeatures: []\n',
    })

    expect(await new IdbCarrier(workspace).referencesOf('asm-1')).toEqual([])
    await expect(store.removeEntry(workspace, workspace)).resolves.toBeUndefined()
  })
})
