import { describe, it, expect } from 'vitest'
import { copyDocument, pushDocument } from '../transfer'
import type { DocumentStore, DocumentPayload, SaveInput, ListOptions, DocSummary } from '../types'

// A throwaway in-memory store. copyDocument speaks only the DocumentStore
// contract, so a fake is enough to prove it is store-agnostic -- no IndexedDB or
// HTTP needed.
class FakeStore implements DocumentStore {
  private docs = new Map<string, DocumentPayload>()
  private seq = 0
  readonly tag: string
  constructor(tag: string) {
    this.tag = tag
  }

  seed(id: string, payload: DocumentPayload) {
    this.docs.set(id, payload)
  }

  async list(_opts?: ListOptions): Promise<DocSummary[]> {
    return [...this.docs.entries()].map(([uuid, d]) => ({
      uuid, name: d.name, created_at: '', updated_at: '',
      is_owner: true, owner_username: 'x', is_public: !!d.is_public,
    }))
  }
  async load(id: string): Promise<DocumentPayload> {
    const d = this.docs.get(id)
    if (!d) throw new Error(`not found: ${id}`)
    return { ...d }
  }
  async save(id: string, input: SaveInput): Promise<void> {
    const prev = this.docs.get(id)
    this.docs.set(id, { name: prev?.name ?? 'Untitled', ...prev, content: input.content, preview_image: input.preview_image })
  }
  async remove(id: string): Promise<void> { this.docs.delete(id) }
  async create(name: string): Promise<{ uuid: string }> {
    const uuid = `${this.tag}-${++this.seq}`
    this.docs.set(uuid, { content: '', name })
    return { uuid }
  }
  async rename(id: string, name: string): Promise<void> {
    const d = this.docs.get(id)
    if (d) d.name = name
  }
  async duplicate(id: string): Promise<{ uuid: string }> {
    const d = await this.load(id)
    const { uuid } = await this.create(`${d.name} copy`)
    await this.save(uuid, { content: d.content })
    return { uuid }
  }
}

describe('copyDocument', () => {
  it('copies content + preview + name into a new uuid in dest', async () => {
    const a = new FakeStore('a')
    const b = new FakeStore('b')
    a.seed('a-doc', { content: 'profile: square', name: 'Bracket', preview_image: 'iVBORw0' })

    const { uuid } = await copyDocument(a, b, 'a-doc')

    expect(uuid).not.toBe('a-doc')  // a fresh identity in dest
    const copied = await b.load(uuid)
    expect(copied.content).toBe('profile: square')
    expect(copied.name).toBe('Bracket')
    expect(copied.preview_image).toBe('iVBORw0')
  })

  it('leaves the source untouched (copy, not move)', async () => {
    const a = new FakeStore('a')
    const b = new FakeStore('b')
    a.seed('a-doc', { content: 'orig', name: 'Orig' })

    await copyDocument(a, b, 'a-doc')

    const stillThere = await a.load('a-doc')
    expect(stillThere.content).toBe('orig')
    expect((await a.list()).length).toBe(1)
  })

  it('throws when the source id is missing', async () => {
    const a = new FakeStore('a')
    const b = new FakeStore('b')
    await expect(copyDocument(a, b, 'nope')).rejects.toThrow(/not found/)
    expect((await b.list()).length).toBe(0)  // nothing partially created in dest
  })
})

// A local store that tracks the engine-facing markSynced primitive (as the real
// IndexedDbDocumentStore does, but it is NOT on the DocumentStore contract).
class SyncFakeStore extends FakeStore {
  syncedIds: string[] = []
  async markSynced(id: string): Promise<void> {
    this.syncedIds.push(id)
  }
}

describe('pushDocument', () => {
  it('copies local -> cloud and acks the local doc as synced', async () => {
    const local = new SyncFakeStore('local')
    const cloud = new FakeStore('cloud')
    local.seed('l-doc', { content: 'profile: square', name: 'Bracket' })

    const { uuid } = await pushDocument(local, cloud, 'l-doc')

    // The cloud domain gained a fresh copy...
    const copied = await cloud.load(uuid)
    expect(copied.content).toBe('profile: square')
    expect(copied.name).toBe('Bracket')
    // ...and the local doc was marked synced (push-ack), but left intact.
    expect(local.syncedIds).toEqual(['l-doc'])
    expect((await local.load('l-doc')).content).toBe('profile: square')
  })

  it('skips the ack when the local store does not track sync state', async () => {
    const local = new FakeStore('local')  // no markSynced
    const cloud = new FakeStore('cloud')
    local.seed('l-doc', { content: 'orig', name: 'Orig' })

    const { uuid } = await pushDocument(local, cloud, 'l-doc')

    expect((await cloud.load(uuid)).content).toBe('orig')  // copy still happens, no throw
  })
})
