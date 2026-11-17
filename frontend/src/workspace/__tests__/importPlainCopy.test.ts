import { describe, it, expect, beforeEach } from 'vitest'
import { getWorkspaceStore, type WorkspaceStore } from '../store'
import { importBag, readDirectoryBag, readZipBag } from '../import'
import { importPickedFile } from '../importFile'
import { buildZipBytes } from '../zipCarrier'
import { MANIFEST_PATH } from '../paths'
import { readWorkspaceMeta } from '../idbCarrier'
import { STORE_HANDLES, idbGetAllFrom } from '@/stores/documentStore/idb'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// An import is a plain copy (2026-11-16). Nothing links a landed entry back to
// the file, folder or archive it came from: the workspace meta row and the
// manifest carry no provenance key, and no handle is remembered to pull from.

async function expectPlainCopy(store: WorkspaceStore, workspace: string): Promise<void> {
  const meta = (await readWorkspaceMeta(workspace))!
  expect('provenance' in meta).toBe(false)

  // The handle store is where a later explicit pull would have found its
  // source; an import writes nothing there.
  expect(await idbGetAllFrom(STORE_HANDLES)).toEqual([])

  const found = (await store.export(workspace)).find(file => file.path === MANIFEST_PATH)!
  const text = typeof found.data === 'string' ? found.data : new TextDecoder().decode(found.data)
  expect(text).not.toContain('provenance')
}

describe('an import lands a plain copy', () => {
  beforeEach(resetWorkspaceIdb)

  it('imports a picked file with no origin record', async () => {
    const bytes = new TextEncoder().encode('kind: part\n')
    const file = {
      name: 'widget.yaml',
      size: bytes.byteLength,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    } as unknown as File

    const result = await importPickedFile(file)
    const store = getWorkspaceStore()

    expect(await store.listEntries(result.workspace)).toHaveLength(1)
    await expectPlainCopy(store, result.workspace)
  })

  it('imports a picked directory with no origin record', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    const store = getWorkspaceStore()

    const result = await importBag(
      await readDirectoryBag(dir as unknown as FileSystemDirectoryHandle), {}, store,
    )

    const entries = await store.listEntries(result.workspace)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('Gearbox')
    await expectPlainCopy(store, result.workspace)
  })

  // I1: the source is only ever read. Importing a folder copies its bytes in and
  // leaves the folder exactly as it was found.
  it('never writes back to the folder it read', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    const before = dir.snapshot()

    await importBag(await readDirectoryBag(dir as unknown as FileSystemDirectoryHandle), {}, getWorkspaceStore())

    expect(dir.snapshot()).toEqual(before)
    expect(dir.fileNames()).toEqual(['Gearbox.yaml'])
  })

  it('imports an archive with no origin record', async () => {
    const bytes = await buildZipBytes(treeWith([
      documentEntry('a', 'Bracket', { text: 'kind: part\n' }),
    ], 'src'))
    const store = getWorkspaceStore()

    const result = await importBag(await readZipBag(bytes), {}, store)

    expect(await store.listEntries(result.workspace)).toHaveLength(1)
    await expectPlainCopy(store, result.workspace)
  })
})
