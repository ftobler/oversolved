import { describe, it, expect, beforeEach } from 'vitest'
import { STORE_WORKSPACE_ENTRIES } from '@/stores/documentStore/idb'
import { IdbCarrier } from '../idbCarrier'
import { interpretEntry } from '../kinds'
import { deserializeTree, serializeTree } from '../serializer'
import { addReference } from '../refs'
import type { WorkspaceEntry, WorkspaceTree } from '../types'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'

async function makeCarrier(entries: WorkspaceEntry[]): Promise<IdbCarrier> {
  const tree = treeWith(entries)
  await seedWorkspace(tree)
  const carrier = new IdbCarrier(tree.manifest.workspace)
  await carrier.save(tree)
  return carrier
}

// Export needs every payload, so the lazy file bytes are read before serialize,
// exactly as IdbWorkspaceStore.export does.
async function materialize(carrier: IdbCarrier, tree: WorkspaceTree): Promise<void> {
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'file' || tree.contents.has(id)) continue
    const entry = await carrier.read(id)
    tree.contents.set(id, { bytes: entry.bytes ?? new Uint8Array(0) })
  }
}

describe('IdbCarrier', () => {
  beforeEach(resetWorkspaceIdb)

  it('open loads document text but defers file bytes (A5)', async () => {
    const carrier = await makeCarrier([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3])),
    ])
    const tree = await carrier.open()
    expect(tree.contents.has('a')).toBe(true)
    expect(tree.contents.has('b')).toBe(false)
    expect((await carrier.read('b')).bytes).toEqual(bytesOf([1, 2, 3]))
  })

  it('a content edit writes exactly one entry record and never the manifest', async () => {
    const carrier = await makeCarrier([documentEntry('a', 'A', { text: 'kind: part\n' })])
    const puts: string[] = []
    const original = IDBObjectStore.prototype.put
    const patched = function (this: IDBObjectStore, ...args: unknown[]) {
      puts.push(this.name)
      return (original as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
    }
    IDBObjectStore.prototype.put = patched as typeof IDBObjectStore.prototype.put
    try {
      await carrier.write(documentEntry('a', 'A', { text: 'kind: part\n# edited\n' }))
    } finally {
      IDBObjectStore.prototype.put = original
    }
    expect(puts).toEqual([STORE_WORKSPACE_ENTRIES])
  })

  it('checkpoint adopts the working copy and discard restores it', async () => {
    const carrier = await makeCarrier([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })])
    expect(await carrier.maxWorkingRev()).toBe(1)
    expect(await carrier.maxSavedRev()).toBe(0)

    await carrier.checkpoint()
    expect(await carrier.maxSavedRev()).toBe(1)

    await carrier.write(documentEntry('a', 'A', { text: 'kind: part\n# v2\n' }))
    expect(await carrier.maxWorkingRev()).toBe(2)

    const restored = await carrier.discard()
    expect(await carrier.maxWorkingRev()).toBe(1)
    expect(restored.contents.get('a')?.text).toBe('kind: part\n# v1\n')
  })

  it('an unknown docKind refuses interpretation but survives byte-identically (I6, I9)', async () => {
    const text = 'kind: drawing\n# keep me\n'
    const carrier = await makeCarrier([documentEntry('a', 'Draft', { text, docKind: 'drawing' })])

    const entry = await carrier.read('a')
    expect(entry.docKind).toBe('drawing')
    expect(interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind }).ok).toBe(false)

    const first = serializeTree(await carrier.open())
    const reopened = deserializeTree(first)
    expect(reopened.manifest.entries.a.docKind).toBe('drawing')
    expect(reopened.contents.get('a')?.text).toBe(text)
    expect(serializeTree(reopened)).toEqual(first)
  })

  it('a trashed entry is absent from list but byte-identical after export and re-import (I4, I9)', async () => {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
    ])
    addReference(tree, 'a', 'b')
    await seedWorkspace(tree)
    const carrier = new IdbCarrier(tree.manifest.workspace)
    await carrier.save(tree)
    await carrier.remove('a')

    expect((await carrier.list()).map(item => item.id)).toEqual(['b'])
    const opened = await carrier.open()
    expect(opened.manifest.trash).toContain('a')
    await materialize(carrier, opened)

    const exported = serializeTree(opened)
    const reopened = deserializeTree(exported)
    expect(reopened.manifest.trash).toContain('a')
    expect(reopened.contents.get('a')?.text).toBe('kind: part\n')
    expect(reopened.contents.get('b')?.bytes).toEqual(bytesOf([1, 2, 3]))
    expect(serializeTree(reopened)).toEqual(exported)
  })
})
