import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OpenWorkspaceDocumentStore, activeDocumentStore } from '../openWorkspace'
import { IdbWorkspaceStore } from '@/workspace/store'
import { createWorkspaceSession } from '@/workspace/session'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'

// The scoped document face the editors read. The point is that `load(entryId)`
// resolves inside the open workspace and never falls back to a library-wide
// list, and that a call with no open workspace refuses by name.

beforeEach(resetWorkspaceIdb)

afterEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
})

describe('OpenWorkspaceDocumentStore', () => {
  it('refuses every verb when no workspace is open', async () => {
    const adapter = new OpenWorkspaceDocumentStore(new IdbWorkspaceStore())
    await expect(adapter.list()).rejects.toThrow(/No workspace is open/)
    await expect(adapter.load('x')).rejects.toThrow(/No workspace is open/)
    await expect(adapter.save('x', { content: '' })).rejects.toThrow(/No workspace is open/)
    await expect(adapter.rename('x', 'y')).rejects.toThrow(/No workspace is open/)
    await expect(adapter.clone('x')).rejects.toThrow(/No workspace is open/)
  })

  it('resolves an entry id inside the open workspace, not a workspace id', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Bracket', docKind: 'part', text: 'kind: part\n# body\n' })
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))

    const adapter = new OpenWorkspaceDocumentStore(store)
    const loaded = await adapter.load(workspace)
    expect(loaded.name).toBe('Bracket')
    expect(loaded.kind).toBe('document')
    expect(loaded.docKind).toBe('part')
    expect(loaded.content).toBe('kind: part\n# body\n')

    // The same id addressed as a workspace no longer resolves; entry ids are the
    // only address inside a workspace.
    await expect(adapter.load('no-such-entry')).rejects.toThrow()
  })

  // The payload keeps the entry's structural kind so the interpretation gate can
  // refuse a file as a file. Reporting `kind: 'document'` for everything is what
  // made a file reached by a typed URL refuse as "has no kind" instead.
  it('carries the structural kind of a file entry, not a document kind', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'file-1', kind: 'file', name: 'bracket.step', fileKind: 'step', bytes: new Uint8Array([1, 2, 3]),
    })
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))

    const loaded = await new OpenWorkspaceDocumentStore(store).load('file-1')
    expect(loaded.kind).toBe('file')
    expect(loaded.docKind).toBeUndefined()
    expect(loaded.name).toBe('bracket.step')
  })

  it('renames one entry without renaming the workspace', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Original', { docKind: 'part' })
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))

    const adapter = new OpenWorkspaceDocumentStore(store)
    await adapter.rename(workspace, 'Renamed')

    const [summary] = await store.list()
    expect(summary.name).toBe('Original')
    expect((await store.readEntry(workspace, workspace)).name).toBe('Renamed')
  })

  it('clones an entry under a fresh id', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))

    const adapter = new OpenWorkspaceDocumentStore(store)
    const { uuid } = await adapter.clone(workspace)
    expect(uuid).not.toBe(workspace)
    expect((await store.listEntries(workspace)).map(e => e.id).sort()).toEqual([uuid, workspace].sort())
  })

  it('the shared singleton is the active scoped face', () => {
    expect(activeDocumentStore).toBeInstanceOf(OpenWorkspaceDocumentStore)
  })
})

// The listing half of the scoped document face: entries are filtered to
// documents before they are searched or sorted, so a file entry never reaches
// the grid even when its name matches the query.
async function seedDocuments(store: IdbWorkspaceStore): Promise<{ workspace: string; base: number }> {
  const { workspace } = await store.create('Bracket', { docKind: 'part' })
  await store.renameEntry(workspace, workspace, 'Delta')
  const base = Date.now()
  const now = vi.spyOn(Date, 'now')
  try {
    now.mockReturnValue(base + 1000)
    await store.addEntry(workspace, { id: 'alpha', kind: 'document', name: 'Alpha', docKind: 'part', text: 'kind: part\n' })
    now.mockReturnValue(base + 2000)
    await store.addEntry(workspace, { id: 'bravo', kind: 'document', name: 'Bravo', docKind: 'assembly', text: 'kind: assembly\n' })
    now.mockReturnValue(base + 3000)
    await store.addEntry(workspace, { id: 'charlie', kind: 'document', name: 'Charlie', docKind: 'part', text: 'kind: part\n' })
    now.mockReturnValue(base + 4000)
    await store.addEntry(workspace, { id: 'zulu', kind: 'file', name: 'Zulu.step', mime: 'application/step', fileKind: 'step', bytes: new Uint8Array([1]) })
  } finally {
    now.mockRestore()
  }
  return { workspace, base }
}

describe('OpenWorkspaceDocumentStore.list', () => {
  it('lists only documents, newest first by default', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await seedDocuments(store)
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))

    expect((await new OpenWorkspaceDocumentStore(store).list()).map(s => s.name))
      .toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta'])
  })

  it('maps a document row to its exact summary', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace, base } = await seedDocuments(store)
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))

    expect(await new OpenWorkspaceDocumentStore(store).list({ search: 'charl' })).toEqual([{
      uuid: 'charlie',
      name: 'Charlie',
      kind: 'part',
      updated_at: new Date(base + 3000).toISOString(),
      meta: { rev: 1 },
    }])
  })

  it('searches names case-insensitively only among documents', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await seedDocuments(store)
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))
    const adapter = new OpenWorkspaceDocumentStore(store)

    expect((await adapter.list({ search: 'BRa' })).map(s => s.name)).toEqual(['Bravo'])
    // The file matches the needle but is not a document, so it never lists.
    expect(await adapter.list({ search: 'zulu' })).toEqual([])
  })

  // A carrier that keeps no revision or timestamp (MemoryCarrier does not) must
  // still map to a sortable summary, never a NaN date or an undefined rev.
  it('maps a row with no rev or updatedAt to epoch and revision zero', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))
    const bare = { listEntries: async () => [{ id: 'doc', path: 'documents/D.yaml', kind: 'document', name: 'D' }] }

    const summaries = await new OpenWorkspaceDocumentStore(bare as unknown as IdbWorkspaceStore).list()
    expect(summaries).toEqual([{
      uuid: 'doc',
      name: 'D',
      kind: undefined,
      updated_at: new Date(0).toISOString(),
      meta: { rev: 0 },
    }])
  })

  it('sorts by name and by ascending modification', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await seedDocuments(store)
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))
    const adapter = new OpenWorkspaceDocumentStore(store)

    expect((await adapter.list({ sort: 'name' })).map(s => s.name))
      .toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
    expect((await adapter.list({ sort: 'modified_asc' })).map(s => s.name))
      .toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie'])
  })
})

describe('OpenWorkspaceDocumentStore.save', () => {
  async function seedOneDocument(store: IdbWorkspaceStore): Promise<string> {
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'doc', kind: 'document', name: 'Widget', docKind: 'part', text: 'kind: part\n# old\n',
    })
    useWorkspaceSessionStore.getState().setSession(createWorkspaceSession(workspace, store))
    return workspace
  }

  it('rewrites the content and keeps the entry name', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await seedOneDocument(store)

    await new OpenWorkspaceDocumentStore(store).save('doc', { content: 'kind: assembly\n# new\n' })

    expect(await store.readEntry(workspace, 'doc')).toEqual({
      id: 'doc', kind: 'document', name: 'Widget', docKind: 'assembly', text: 'kind: assembly\n# new\n',
    })
  })

  it('keeps the stored docKind when the new content names none', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await seedOneDocument(store)

    await new OpenWorkspaceDocumentStore(store).save('doc', { content: '# no kind at all\n' })

    const entry = await store.readEntry(workspace, 'doc')
    expect(entry.docKind).toBe('part')
    expect(entry.text).toBe('# no kind at all\n')
  })

  it('adopts a stamped kind even when it is not a known editor kind', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await seedOneDocument(store)

    await new OpenWorkspaceDocumentStore(store).save('doc', { content: 'kind: drawing\n' })

    expect((await store.readEntry(workspace, 'doc')).docKind).toBe('drawing')
  })
})
