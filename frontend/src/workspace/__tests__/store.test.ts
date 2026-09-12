import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { deserializeTree, serializeTree } from '../serializer'
import { getFileRegistry } from '@/stores/fileRegistry'
import { bytesOf } from './fixtures'
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
