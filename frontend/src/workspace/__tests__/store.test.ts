import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { deserializeTree, serializeTree } from '../serializer'
import { readZipBag, importBag } from '../import'
import { buildZipBytes } from '../zipCarrier'
import { addReference } from '../refs'
import { getFileRegistry } from '@/stores/fileRegistry'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

const importText = (fileId: string) =>
  `kind: assembly\nfeatures:\n  - kind: import_step\n    file_id: ${fileId}\n`

describe('IdbWorkspaceStore (degenerate workspace)', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  it('create yields a workspace whose sole entry shares its uuid', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })

    const entries = await store.listEntries(workspace, { includeTrashed: true })
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(workspace)
    expect(entries[0].docKind).toBe('part')

    expect(await store.list()).toEqual([
      expect.objectContaining({ workspace, name: 'Bracket', docKind: 'part', entryCount: 1 }),
    ])
  })

  it('save checkpoints the working copy and clears ahead', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v1\n' })

    let opened = await store.open(workspace)
    expect(opened.ahead).toBe(true)
    expect(opened.workingRev).toBeGreaterThan(opened.savedRev)

    await store.save(workspace, opened.tree)
    opened = await store.open(workspace)
    expect(opened.ahead).toBe(false)
    expect(opened.savedRev).toBe(opened.workingRev)

    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n' })
    opened = await store.open(workspace)
    expect(opened.ahead).toBe(true)
    expect(opened.lastEditedAt).toBeGreaterThan(0)
  })

  it('discard restores the checkpoint content', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v1\n' })
    await store.save(workspace, (await store.open(workspace)).tree)
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n' })

    await new IdbCarrier(workspace).discard()

    const opened = await store.open(workspace)
    expect(opened.ahead).toBe(false)
    expect((await store.readEntry(workspace, workspace)).text).toBe('kind: part\n# v1\n')
  })

  it('rename updates the tile and the sole entry', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Old', { docKind: 'part' })
    await store.rename(workspace, 'New')
    expect((await store.list())[0].name).toBe('New')
    expect((await store.readEntry(workspace, workspace)).name).toBe('New')
  })

  it('trash hides the tile, recover restores it, purge erases the workspace', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })

    await store.trash(workspace)
    expect(await store.list()).toEqual([])
    expect((await store.list({ includeTrashed: true })).map(summary => summary.workspace)).toContain(workspace)

    await store.recover(workspace)
    expect((await store.list()).map(summary => summary.workspace)).toContain(workspace)

    await store.purge(workspace)
    await expect(store.open(workspace)).rejects.toThrow(/not found/)
    expect(await store.list()).toEqual([])
  })

  it('entry remove is recoverable and hidden from list', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })

    await store.removeEntry(workspace, workspace)
    expect(await store.listEntries(workspace)).toEqual([])
    expect((await store.listEntries(workspace, { includeTrashed: true })).map(entry => entry.id)).toEqual([workspace])
    await expect(store.readEntry(workspace, workspace)).rejects.toThrow(/trashed/)

    await store.restoreEntry(workspace, workspace)
    expect((await store.listEntries(workspace)).map(entry => entry.id)).toEqual([workspace])
  })

  it('writeEntry adopts a referenced file id into the workspace under the same id', async () => {
    const store = new IdbWorkspaceStore()
    const file = await getFileRegistry().create({ name: 'b.step', kind: 'step', mime: 'application/step', bytes: bytesOf([1, 2, 3]) })
    const { workspace } = await store.create('Asm', { docKind: 'assembly' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Asm', docKind: 'assembly', text: importText(file.id) })

    const adopted = (await store.listEntries(workspace)).find(entry => entry.id === file.id)
    expect(adopted).toMatchObject({ kind: 'file', name: 'b.step', fileKind: 'step', mime: 'application/step' })

    const carrier = new IdbCarrier(workspace)
    expect(await carrier.referencesOf(workspace)).toEqual([file.id])

    const cloneId = await store.cloneEntry(workspace, workspace)
    expect(cloneId).not.toBe(workspace)
    expect(await carrier.referencesOf(cloneId)).toEqual([file.id])
  })

  // The file id resolves in neither the workspace nor the registry, so there is
  // nothing to adopt. The write must still land, and it must not leave an edge
  // pointing at an entry that does not exist.
  it('writes a document whose import_step file id resolves nowhere with no phantom edge', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Asm', { docKind: 'assembly' })

    await expect(store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Asm', docKind: 'assembly', text: importText('ghost-file-id'),
    })).resolves.toBeUndefined()

    expect(await new IdbCarrier(workspace).referencesMap()).toEqual({})
  })

  it('writes a document whose body does not parse without adopting edges', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Broken', { docKind: 'part' })
    const text = '[unparseable\n'

    // Adoption reads the edges out of the text, so a body mid-edit must still
    // persist and simply contribute no edges.
    await expect(store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Broken', docKind: 'part', text,
    })).resolves.toBeUndefined()

    expect((await store.readEntry(workspace, workspace)).text).toBe(text)

    // A body that parses to a list is still not a feature mapping, so it too
    // contributes no edges rather than throwing.
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Broken', docKind: 'part', text: '- a\n- b\n',
    })
    expect(await new IdbCarrier(workspace).referencesMap()).toEqual({})
  })

  it('duplicate copies the workspace under fresh ids and remaps edges', async () => {
    const store = new IdbWorkspaceStore()
    const file = await getFileRegistry().create({ name: 'b.step', kind: 'step', mime: 'application/step', bytes: bytesOf([1, 2, 3]) })
    const { workspace } = await store.create('Asm', { docKind: 'assembly' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Asm', docKind: 'assembly', text: importText(file.id) })

    const { workspace: copy } = await store.duplicate(workspace, 'Asm copy')
    expect(copy).not.toBe(workspace)

    const copied = await store.listEntries(copy)
    expect(copied).toHaveLength(2)
    const copyDoc = copied.find(entry => entry.kind === 'document')!
    const copyFile = copied.find(entry => entry.kind === 'file')!
    expect(copyDoc.id).not.toBe(workspace)
    expect(copyFile.id).not.toBe(file.id)
    expect(await new IdbCarrier(copy).referencesOf(copyDoc.id)).toEqual([copyFile.id])
  })

  // duplicate's id remap has to carry provenance and trash through the same map
  // as the entries and edges; a stale local id in either would describe an entry
  // the copy does not hold.
  it('duplicate remaps provenance and carries the trash through the id remap', async () => {
    const store = new IdbWorkspaceStore()
    const source = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3])),
    ], 'source-ws')
    addReference(source, 'a', 'b')
    const { workspace } = await importBag(
      await readZipBag(await buildZipBytes(source), 'ws'), { origin: 'ws' }, store,
    )

    await store.removeEntry(workspace, 'a')
    const { workspace: copy } = await store.duplicate(workspace, 'Asm copy')

    const opened = await store.open(copy)
    const copyEntryIds = new Set(Object.keys(opened.tree.manifest.entries))
    expect(opened.tree.manifest.provenance).toHaveLength(2)
    for (const record of opened.tree.manifest.provenance) {
      expect(copyEntryIds.has(record.entry)).toBe(true)
    }
    expect(opened.tree.manifest.provenance.map(record => record.originEntry).sort()).toEqual(['a', 'b'])

    expect(opened.tree.manifest.trash).toHaveLength(1)
    const trashedId = opened.tree.manifest.trash[0]
    expect(await store.listEntries(copy)).not.toContainEqual(expect.objectContaining({ id: trashedId }))
    const all = await store.listEntries(copy, { includeTrashed: true })
    expect(all.find(entry => entry.id === trashedId)).toMatchObject({ name: 'A' })
  })

  it('export then re-import is byte-identical, including an adopted file', async () => {
    const store = new IdbWorkspaceStore()
    const file = await getFileRegistry().create({ name: 'b.step', kind: 'step', mime: 'application/step', bytes: bytesOf([1, 2, 3, 4]) })
    const { workspace } = await store.create('Asm', { docKind: 'assembly' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Asm', docKind: 'assembly', text: importText(file.id) })

    const exported = await store.export(workspace)
    const reopened = deserializeTree(exported)
    expect(serializeTree(reopened)).toEqual(exported)
    expect(reopened.contents.get(file.id)?.bytes).toEqual(bytesOf([1, 2, 3, 4]))
  })

  // The trash travels with the carrier and is excluded from list/solve only, so
  // a trashed file's bytes must still materialize for serialization.
  it('export materializes a trashed file entry with its bytes', async () => {
    const store = new IdbWorkspaceStore()
    const file = await getFileRegistry().create({ name: 'b.step', kind: 'step', mime: 'application/step', bytes: bytesOf([9, 8, 7]) })
    const { workspace } = await store.create('Asm', { docKind: 'assembly' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Asm', docKind: 'assembly', text: importText(file.id) })
    // Drop the reference first so the delete travels the unguarded path; the
    // guard under review is not what this test exercises.
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Asm', docKind: 'assembly', text: 'kind: assembly\nfeatures: []\n' })
    await store.removeEntry(workspace, file.id)

    const exported = await store.export(workspace)
    const reopened = deserializeTree(exported)
    expect(reopened.manifest.trash).toContain(file.id)
    expect(reopened.contents.get(file.id)?.bytes).toEqual(bytesOf([9, 8, 7]))
  })
})
