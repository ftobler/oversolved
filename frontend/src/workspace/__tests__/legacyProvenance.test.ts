import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { readWorkspaceMeta, writeWorkspaceMeta, type WorkspaceMetaRecord } from '../idbCarrier'
import { importBag, readZipBag } from '../import'
import { buildZipFromEntries } from '../zipCarrier'
import { serializeTree } from '../serializer'
import { MANIFEST_PATH } from '../paths'
import { STORE_WORKSPACE_META, idbGetFrom } from '@/stores/documentStore/idb'
import { resetWorkspaceIdb } from './idbHarness'

// A library written while imports kept an origin link carries provenance in a
// manifest and in the workspace meta row. Both must keep opening; the next save
// omits the key, so a legacy library quietly becomes a plain one.

const legacyManifest =
  'format: 1\n' +
  'workspace: legacy-src\n' +
  'entries:\n' +
  '  a:\n' +
  '    path: documents/A.yaml\n' +
  '    kind: document\n' +
  '    name: A\n' +
  '    docKind: part\n' +
  'references: {}\n' +
  'provenance:\n' +
  '  - entry: a\n' +
  '    origin: folder:cad\n' +
  '    originEntry: a\n' +
  '    hash: abc\n' +
  '    copiedAt: 1\n' +
  'trash: []\n'

async function manifestText(store: IdbWorkspaceStore, workspace: string): Promise<string> {
  const found = (await store.export(workspace)).find(file => file.path === MANIFEST_PATH)!
  return typeof found.data === 'string' ? found.data : new TextDecoder().decode(found.data)
}

describe('a legacy workspace with provenance', () => {
  beforeEach(resetWorkspaceIdb)

  it('loads a manifest that carries provenance and saves it back without the key', async () => {
    const bytes = await buildZipFromEntries([
      { path: MANIFEST_PATH, data: legacyManifest },
      { path: 'documents/A.yaml', data: 'kind: part\n' },
    ])
    const store = new IdbWorkspaceStore()

    const result = await importBag(await readZipBag(bytes), {}, store)

    const entries = await store.listEntries(result.workspace)
    expect(entries.map(entry => entry.name)).toEqual(['A'])
    expect(await manifestText(store, result.workspace)).not.toContain('provenance')
  })

  it('loads an IDB meta row that carries provenance and saves it back without the key', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Legacy', { docKind: 'part' })
    const meta = (await readWorkspaceMeta(workspace))!
    const legacy = {
      ...meta,
      provenance: [{ entry: workspace, origin: 'folder:cad', originEntry: workspace }],
      savedProvenance: [{ entry: workspace, origin: 'folder:cad' }],
    }
    await writeWorkspaceMeta(legacy as unknown as WorkspaceMetaRecord)

    const opened = await store.open(workspace)
    expect(Object.keys(opened.tree.manifest.entries)).toEqual([workspace])
    await store.save(workspace, opened.tree)

    const raw = await idbGetFrom<Record<string, unknown>>(STORE_WORKSPACE_META, workspace)
    expect(raw).toBeDefined()
    expect(raw).not.toHaveProperty('provenance')
    expect(raw).not.toHaveProperty('savedProvenance')
  })

  it('keeps the saved tree byte-stable across a legacy load and save', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Legacy', { docKind: 'part' })
    const meta = (await readWorkspaceMeta(workspace))!
    await writeWorkspaceMeta({ ...meta, provenance: [{ entry: workspace, origin: 'file:x' }] } as unknown as WorkspaceMetaRecord)

    const opened = await store.open(workspace)
    await store.save(workspace, opened.tree)

    const again = await store.open(workspace)
    expect(serializeTree(again.tree)).toEqual(serializeTree(opened.tree))
  })
})
