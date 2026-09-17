import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  it('refuses every read when no workspace is open', async () => {
    const adapter = new OpenWorkspaceDocumentStore(new IdbWorkspaceStore())
    await expect(adapter.list()).rejects.toThrow(/No workspace is open/)
    await expect(adapter.load('x')).rejects.toThrow(/No workspace is open/)
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
