import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { readWorkspaceMeta, replaceWorkspaceRows, type WorkspaceEntryRecord, type WorkspaceMetaRecord } from '../idbCarrier'
import { deserializeTree } from '../serializer'
import { buildZipBytes } from '../zipCarrier'
import { importBag, readZipBag } from '../import'
import { subscribeWorkspaceStore } from '../storeEvents'
import { bytesOf, documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// `cover` is workspace metadata like the name: it lives on the meta row, never
// on the checkpoint, and it survives export/import and duplicate through the
// manifest. The automatic choice is the fallback, not a stored value.

const summaryOf = async (store: IdbWorkspaceStore, workspace: string) =>
  (await store.list()).find(summary => summary.workspace === workspace)!

async function seedWorkspace(workspace: string, records: WorkspaceEntryRecord[]): Promise<void> {
  const meta: WorkspaceMetaRecord = {
    workspace,
    name: 'Cover',
    createdAt: 0,
    updatedAt: 0,
    references: {},
    trash: [],
  }
  await replaceWorkspaceRows(workspace, meta, records)
}

function documentRecord(id: string, docKind: string, updatedAt: number): WorkspaceEntryRecord {
  return {
    workspace: 'ws-cover',
    id,
    path: `documents/${id}.yaml`,
    kind: 'document',
    name: id,
    docKind,
    text: 'kind: part\n',
    rev: 1,
    contentHash: 'h',
    updatedAt,
  }
}

describe('IdbWorkspaceStore cover entry', () => {
  beforeEach(resetWorkspaceIdb)

  it('setCover stores the choice and a null clears it back to automatic', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    await store.addEntry(workspace, { id: 'a', kind: 'document', name: 'A', docKind: 'part', text: 'kind: part\n' })

    await store.setCover(workspace, 'a')
    let summary = await summaryOf(store, workspace)
    expect(summary.coverEntry).toBe('a')
    expect(summary.coverChoice).toBe('a')
    expect((await readWorkspaceMeta(workspace))?.cover).toBe('a')

    await store.setCover(workspace, null)
    summary = await summaryOf(store, workspace)
    expect(summary.coverChoice).toBeUndefined()
    expect(summary.coverEntry).toBeDefined()
    expect((await readWorkspaceMeta(workspace))?.cover).toBeUndefined()
  })

  it('setCover refuses an unknown, trashed or file entry', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    await store.addEntry(workspace, { id: 'f', kind: 'file', name: 'f.step', bytes: bytesOf([1, 2, 3]) })
    await store.addEntry(workspace, { id: 'a', kind: 'document', name: 'A', docKind: 'part', text: 'kind: part\n' })

    await expect(store.setCover(workspace, 'ghost')).rejects.toThrow(/no cover preview/)
    await expect(store.setCover(workspace, 'f')).rejects.toThrow(/no cover preview/)

    await store.removeEntry(workspace, 'a')
    await expect(store.setCover(workspace, 'a')).rejects.toThrow(/no cover preview/)
    expect((await readWorkspaceMeta(workspace))?.cover).toBeUndefined()
  })

  // Workspace metadata, not document state: the dirty dot compares entry revs,
  // and the choice is not part of the checkpoint, so Discard leaves it alone.
  it('setCover never lights the dirty dot and a discard keeps the choice', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    const before = await store.open(workspace)

    await store.setCover(workspace, workspace)
    const after = await store.open(workspace)
    expect(after.ahead).toBe(before.ahead)
    expect(after.workingRev).toBe(before.workingRev)

    await store.discard(workspace)
    expect((await summaryOf(store, workspace)).coverChoice).toBe(workspace)
  })

  // The view repaints from the store revision, so the write has to announce
  // itself exactly once: without the bump the card keeps the old preview.
  it('setCover notifies the store subscribers once per write', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    let notifications = 0
    const unsubscribe = subscribeWorkspaceStore(() => { notifications++ })
    try {
      await store.setCover(workspace, workspace)
      expect(notifications).toBe(1)
      await store.setCover(workspace, null)
      expect(notifications).toBe(2)
    } finally {
      unsubscribe()
    }
  })

  it('a trashed cover falls back and comes back when the entry is restored', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    await store.addEntry(workspace, { id: 'a', kind: 'document', name: 'A', docKind: 'part', text: 'kind: part\n' })
    await store.setCover(workspace, 'a')

    await store.removeEntry(workspace, 'a')
    let summary = await summaryOf(store, workspace)
    expect(summary.coverEntry).not.toBe('a')
    expect(summary.coverChoice).toBeUndefined()

    await store.restoreEntry(workspace, 'a')
    summary = await summaryOf(store, workspace)
    expect(summary.coverEntry).toBe('a')
    expect(summary.coverChoice).toBe('a')
  })

  // The trash is a soft delete, so a trashed cover's row is still there and the
  // choice is kept. A row the tree no longer holds is different: the cover can
  // no longer name it, and keeping the id would be a dangling reference.
  it('a whole-tree save that drops the cover row clears the choice', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    await store.addEntry(workspace, { id: 'a', kind: 'document', name: 'A', docKind: 'part', text: 'kind: part\n' })
    await store.setCover(workspace, 'a')

    const opened = await store.open(workspace)
    delete opened.tree.manifest.entries.a
    opened.tree.contents.delete('a')
    await store.save(workspace, opened.tree)

    expect((await readWorkspaceMeta(workspace))?.cover).toBeUndefined()
    const summary = await summaryOf(store, workspace)
    expect(summary.coverChoice).toBeUndefined()
    expect(summary.coverEntry).toBe(workspace)
  })

  it('duplicate remaps the cover to the copy of the same document', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    await store.addEntry(workspace, { id: 'a', kind: 'document', name: 'A', docKind: 'part', text: 'kind: part\n' })
    await store.setCover(workspace, 'a')

    const { workspace: copy } = await store.duplicate(workspace, 'Cover copy')
    const opened = await store.open(copy)
    const cover = opened.tree.manifest.cover
    expect(cover).toBeDefined()
    expect(cover).not.toBe('a')
    expect(opened.tree.manifest.entries[cover!].name).toBe('A')
    expect((await summaryOf(store, copy)).coverEntry).toBe(cover)
  })

  it('export then import into a new workspace keeps the cover', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Cover', { docKind: 'part' })
    await store.addEntry(workspace, { id: 'a', kind: 'document', name: 'A', docKind: 'part', text: 'kind: part\n' })
    await store.setCover(workspace, 'a')

    const tree = deserializeTree(await store.export(workspace))
    const result = await importBag(await readZipBag(await buildZipBytes(tree)), {}, store)

    const summary = await summaryOf(store, result.workspace)
    // A manifest-carrying bag keeps its entry ids, so the choice names the same
    // document it did before the round-trip.
    expect(summary.coverEntry).toBe('a')
    expect(summary.coverChoice).toBe('a')
  })

  it('importing into a live workspace keeps the destination cover', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace: destination } = await store.create('Destination', { docKind: 'part' })
    await store.addEntry(destination, { id: 'd', kind: 'document', name: 'D', docKind: 'part', text: 'kind: part\n' })
    await store.setCover(destination, 'd')

    const { workspace: source } = await store.create('Source', { docKind: 'part' })
    await store.addEntry(source, { id: 's', kind: 'document', name: 'S', docKind: 'part', text: 'kind: part\n' })
    await store.setCover(source, 's')
    const tree = deserializeTree(await store.export(source))

    await importBag(await readZipBag(await buildZipBytes(tree)), { into: destination }, store)

    const summary = await summaryOf(store, destination)
    expect(summary.coverEntry).toBe('d')
    expect(summary.coverChoice).toBe('d')
    expect(await store.listEntries(destination)).toContainEqual(expect.objectContaining({ name: 'S' }))
  })

  // A bag whose manifest names a payload it does not carry prunes that row on
  // import; the cover is a row reference, so it goes with it.
  it('a pruned import drops a cover naming the missing payload', async () => {
    const store = new IdbWorkspaceStore()
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      documentEntry('b', 'B', { text: 'kind: part\n' }),
    ])
    tree.manifest.cover = 'a'
    const bag = await readZipBag(await buildZipBytes(tree))
    bag.items = bag.items.filter(item => !item.path.endsWith('A.yaml'))

    const result = await importBag(bag, {}, store)

    const summary = await summaryOf(store, result.workspace)
    expect(summary.coverChoice).toBeUndefined()
    expect(summary.coverEntry).toBe('b')
  })

  // The report's regression: a workspace holding two parts and one assembly,
  // where the assembly is neither the lowest uuid nor the most recently edited.
  // The old rule took the lowest-id document, which was a part.
  it('the automatic cover is the assembly even when it is the newest uuid and the oldest record', async () => {
    const store = new IdbWorkspaceStore()
    await seedWorkspace('ws-cover', [
      documentRecord('a-part', 'part', 30),
      documentRecord('b-part', 'part', 20),
      documentRecord('z-assembly', 'assembly', 10),
    ])

    const summary = await summaryOf(store, 'ws-cover')
    expect(summary.coverEntry).toBe('z-assembly')
    expect(summary.coverChoice).toBeUndefined()
  })

  it('without an assembly the automatic cover is the newest part', async () => {
    const store = new IdbWorkspaceStore()
    await seedWorkspace('ws-cover', [
      documentRecord('a-part', 'part', 10),
      documentRecord('b-part', 'part', 30),
    ])

    expect((await summaryOf(store, 'ws-cover')).coverEntry).toBe('b-part')
  })
})
