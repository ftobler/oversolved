import { describe, it, expect, beforeEach } from 'vitest'
import {
  activeDocumentStore, activeTrashAdapter, setActiveLibrary, activeLibrary,
} from '../library'
import { InMemoryDocumentStore } from '@/stores/documentStore/__tests__/InMemoryDocumentStore'
import type { TrashAdapter, TrashDoc } from '@/stores/documentStore'

// The forwarding pair is what every consumer holds forever, so the only thing
// worth pinning here is that it forwards and that the pair switches together.

function emptyTrash(name: string): TrashAdapter {
  return {
    async list(): Promise<TrashDoc[]> {
      return [{
        uuid: name, name, deleted_at: '', created_at: '', owner_id: 0, owner_username: name,
      }]
    },
    async recover() {},
    async purge() {},
  }
}

function library(label: string) {
  const documents = new InMemoryDocumentStore()
  return { kind: 'browser' as const, label, documents, trash: emptyTrash(label) }
}

describe('active library forwarding', () => {
  beforeEach(() => { setActiveLibrary(library('first')) })

  it('forwards to whichever library is active at call time', async () => {
    const { uuid } = await activeDocumentStore.create('Box')
    expect((await activeDocumentStore.list()).map(d => d.uuid)).toEqual([uuid])

    setActiveLibrary(library('second'))
    expect(await activeDocumentStore.list()).toEqual([])
    await expect(activeDocumentStore.load(uuid)).rejects.toThrow()
  })

  // A store and its trash are two faces of one library: nothing may ever hold
  // the folder's documents next to browser storage's trash.
  it('switches the store and its trash together', async () => {
    expect((await activeTrashAdapter.list())[0].name).toBe('first')
    setActiveLibrary(library('second'))
    expect((await activeTrashAdapter.list())[0].name).toBe('second')
  })

  it('reports which library is live', () => {
    expect(activeLibrary().label).toBe('first')
    setActiveLibrary(library('second'))
    expect(activeLibrary().label).toBe('second')
  })
})
