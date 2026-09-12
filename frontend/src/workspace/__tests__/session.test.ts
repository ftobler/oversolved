import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { createWorkspaceSession } from '../session'
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
})
