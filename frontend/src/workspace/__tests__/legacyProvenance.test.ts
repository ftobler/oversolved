import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { readWorkspaceMeta } from '../idbCarrier'
import { importBag, readZipBag } from '../import'
import { buildZipFromEntries } from '../zipCarrier'
import { serializeTree } from '../serializer'
import { MANIFEST_PATH } from '../paths'
import { STORE_WORKSPACE_META, idbGetFrom, idbPutTo } from '@/persistence/idb'
import { resetWorkspaceIdb } from './idbHarness'

// A library written while imports kept an origin link carries provenance in a
// manifest and in the workspace meta row. Both must keep opening without
// validating the records, and every later write omits the key, so a legacy
// library quietly becomes a plain one.

function manifestCarrying(provenance: string): string {
  return (
    'format: 1\n' +
    'workspace: legacy-src\n' +
    'entries:\n' +
    '  a:\n' +
    '    path: documents/A.yaml\n' +
    '    kind: document\n' +
    '    name: A\n' +
    '    docKind: part\n' +
    'references: {}\n' +
    provenance +
    'trash: []\n'
  )
}

async function manifestText(store: IdbWorkspaceStore, workspace: string): Promise<string> {
  const found = (await store.export(workspace)).find(file => file.path === MANIFEST_PATH)!
  return typeof found.data === 'string' ? found.data : new TextDecoder().decode(found.data)
}

// The meta row a pre-change writer would have left: the seeded row goes in raw,
// because writeWorkspaceMeta already strips the legacy keys.
async function seedLegacyMeta(workspace: string, legacy: Record<string, unknown>): Promise<void> {
  const meta = (await readWorkspaceMeta(workspace))!
  await idbPutTo(STORE_WORKSPACE_META, { ...meta, ...legacy })
}

describe('a legacy workspace with provenance', () => {
  beforeEach(resetWorkspaceIdb)

  it('loads a manifest that carries provenance and saves it back without the key', async () => {
    const bytes = await buildZipFromEntries([
      {
        path: MANIFEST_PATH,
        data: manifestCarrying(
          'provenance:\n' +
          '  - entry: a\n' +
          '    origin: folder:cad\n' +
          '    originEntry: a\n' +
          '    hash: abc\n' +
          '    copiedAt: 1\n',
        ),
      },
      { path: 'documents/A.yaml', data: 'kind: part\n' },
    ])
    const store = new IdbWorkspaceStore()

    const result = await importBag(await readZipBag(bytes), {}, store)

    const entries = await store.listEntries(result.workspace)
    expect(entries.map(entry => entry.name)).toEqual(['A'])
    expect(await manifestText(store, result.workspace)).not.toContain('provenance')
  })

  // The loader drops the key, it does not police its value: a manifest from a
  // writer that put a number or a malformed record there still opens.
  it.each([
    ['a number instead of a list', 'provenance: 5\n'],
    ['a record that is not a record', 'provenance:\n  - entry: 1\n'],
  ])('loads a manifest whose provenance is %s and drops it', async (_what, provenance) => {
    const bytes = await buildZipFromEntries([
      { path: MANIFEST_PATH, data: manifestCarrying(provenance) },
      { path: 'documents/A.yaml', data: 'kind: part\n' },
    ])
    const store = new IdbWorkspaceStore()

    const result = await importBag(await readZipBag(bytes), {}, store)

    expect((await store.listEntries(result.workspace)).map(entry => entry.name)).toEqual(['A'])
    expect(await manifestText(store, result.workspace)).not.toContain('provenance')
  })

  it('loads an IDB meta row that carries provenance and saves it back without the key', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Legacy', { docKind: 'part' })
    await seedLegacyMeta(workspace, {
      provenance: [{ entry: workspace, origin: 'folder:cad', originEntry: workspace }],
      savedProvenance: [{ entry: workspace, origin: 'folder:cad' }],
    })

    const opened = await store.open(workspace)
    expect(Object.keys(opened.tree.manifest.entries)).toEqual([workspace])
    await store.save(workspace, opened.tree)

    const raw = await idbGetFrom<Record<string, unknown>>(STORE_WORKSPACE_META, workspace)
    expect(raw).toBeDefined()
    expect(raw).not.toHaveProperty('provenance')
    expect(raw).not.toHaveProperty('savedProvenance')
  })

  // A structure edit reads the stored row inside one transaction, so it does not
  // pass through readWorkspaceMeta. Trashing an entry must still omit the keys
  // rather than writing the legacy row straight back.
  it('trashing an entry on a legacy meta row writes no provenance back', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Legacy', { docKind: 'part' })
    await seedLegacyMeta(workspace, {
      provenance: [{ entry: workspace, origin: 'folder:cad' }],
      savedProvenance: [{ entry: workspace, origin: 'folder:cad' }],
    })

    await store.removeEntry(workspace, workspace)

    const raw = await idbGetFrom<Record<string, unknown>>(STORE_WORKSPACE_META, workspace)
    expect(raw).not.toHaveProperty('provenance')
    expect(raw).not.toHaveProperty('savedProvenance')
    expect(raw?.trash).toEqual([workspace])
  })

  it('keeps the saved tree byte-stable across a legacy load and save', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Legacy', { docKind: 'part' })
    await seedLegacyMeta(workspace, { provenance: [{ entry: workspace, origin: 'file:x' }] })

    const opened = await store.open(workspace)
    await store.save(workspace, opened.tree)

    const again = await store.open(workspace)
    expect(serializeTree(again.tree)).toEqual(serializeTree(opened.tree))
  })
})
