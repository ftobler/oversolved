import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { createWorkspaceSession } from '../session'
import { IdbCarrier, readWorkspaceMeta, writeWorkspaceMeta } from '../idbCarrier'
import { getFileRegistry } from '@/stores/fileRegistry'
import { bytesOf } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// The session binds every read to one workspace: the scoped replacement for the
// library-wide forwarding store. File resolution is entry-first, registry-second.

describe('workspace session', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  it('binds list, read, write and references to the open workspace', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    const session = createWorkspaceSession(workspace, store)

    expect(session.workspace).toBe(workspace)
    expect(await session.listEntries()).toHaveLength(1)
    await session.writeEntry({ id: workspace, kind: 'document', name: 'Ws', docKind: 'part', text: 'kind: part\n# x\n' })
    expect((await session.readEntry(workspace)).text).toBe('kind: part\n# x\n')
    expect(await session.referencesOf(workspace)).toEqual([])
  })

  it('resolveFile prefers a live workspace entry over the flat registry', async () => {
    const store = new IdbWorkspaceStore()
    const file = await getFileRegistry().create({
      name: 'f.step', kind: 'step', mime: 'application/step', bytes: bytesOf([9, 9, 9]),
    })
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: file.id, kind: 'file', name: 'f.step', mime: 'application/step', fileKind: 'step', bytes: bytesOf([1, 2, 3]),
    })

    const session = createWorkspaceSession(workspace, store)
    expect(await session.resolveFile(file.id)).toEqual(bytesOf([1, 2, 3]))
  })

  it('resolveFile falls back to the registry for bytes not yet adopted', async () => {
    const store = new IdbWorkspaceStore()
    const file = await getFileRegistry().create({
      name: 'f.step', kind: 'step', mime: 'application/step', bytes: bytesOf([4, 5, 6]),
    })
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    const session = createWorkspaceSession(workspace, store)

    expect(await session.resolveFile(file.id)).toEqual(bytesOf([4, 5, 6]))
    expect(await session.resolveFile('missing')).toBeUndefined()
  })

  // The dirty dot compares the working rev against the checkpoint rev, so
  // savedRevs has to answer the checkpoint, never the working copy.
  it('savedRevs reads the checkpoint map off the workspace meta', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    const meta = (await readWorkspaceMeta(workspace))!
    await writeWorkspaceMeta({ ...meta, savedRevs: { doc: 42 } })

    const revs = await createWorkspaceSession(workspace, store).savedRevs()
    expect(revs.get('doc')).toBe(42)
  })

  // A meta written before the savedRevs map existed has to fall back to the
  // checkpoint rows, or the dirty dot would compare against the working rev.
  it('savedRevs falls back to the checkpoint rows when the meta carries no map', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Ws', docKind: 'part', text: '# edit\n' })
    const meta = (await readWorkspaceMeta(workspace))!
    await writeWorkspaceMeta({ ...meta, savedRevs: undefined })

    const revs = await createWorkspaceSession(workspace, store).savedRevs()
    expect(revs.get(workspace)).toBe(1)
  })

  it('provenance reads every stored record', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    const meta = (await readWorkspaceMeta(workspace))!
    await writeWorkspaceMeta({ ...meta, provenance: [{ entry: workspace, origin: 'folder:gone' }] })

    expect(await createWorkspaceSession(workspace, store).provenance())
      .toEqual([{ entry: workspace, origin: 'folder:gone' }])
  })

  // A caller decorates or sorts the records it is handed, and the meta row outlives
  // the call. provenance therefore hands back copies: a mutation must not leak back
  // into the next read.
  it('provenance hands back copies, so mutating the result cannot touch the stored meta', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    const meta = (await readWorkspaceMeta(workspace))!
    await writeWorkspaceMeta({ ...meta, provenance: [{ entry: workspace, origin: 'folder:src' }] })

    const records = await createWorkspaceSession(workspace, store).provenance()
    records[0].origin = 'mutated'

    expect((await readWorkspaceMeta(workspace))!.provenance[0].origin).toBe('folder:src')
  })

  // A workspace whose meta row was never written (or predates the field) still has
  // to answer: the workspace view reads provenance unconditionally.
  it('provenance is empty when the workspace holds no meta', async () => {
    const store = new IdbWorkspaceStore()
    expect(await createWorkspaceSession('never-created', store).provenance()).toEqual([])
  })

  it('referenceEdges returns the whole edge map in one read', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    await new IdbCarrier(workspace).addReference(workspace, 'other')

    expect(await createWorkspaceSession(workspace, store).referenceEdges())
      .toEqual({ [workspace]: ['other'] })
  })
})
