import type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta,
} from '../types'
import { suggestedCloneName } from '../cloneName'
import { randomUuid } from '@/utils/randomUuid'

// The contract suite's second conformer: a whole DocumentStore in a Map.
//
// It exists to keep contract.test.ts a CONTRACT. With one implementation the
// suite degrades into IndexedDbDocumentStore's own unit test, and the interface
// stops being load-bearing -- the next person to touch the store has no signal
// that a behaviour they changed was ever promised to anyone. Two conformers make
// the promise visible: a change that suits IndexedDB and nothing else fails here.
//
// So it is written from the interface, not from the IndexedDB store: plain
// objects and array operations rather than a port of that file's read-modify-
// write dance. Where the two agree, they agree because the contract says so.
//
// Not shipped (it lives under __tests__), but the shape is deliberately a real
// store rather than a stub of one, so it can also stand in for persistence in a
// test that only needs documents to exist somewhere.
interface MemDoc {
  uuid: string
  name: string
  content: string
  preview_image?: string
  is_public: boolean
  created_at: string
  updated_at: string
  meta: DocMeta
}

// Single-user, like every store here: there is no other owner to be.
const OWNER = 'memory'

export class InMemoryDocumentStore implements DocumentStore {
  private docs = new Map<string, MemDoc>()
  // Wall-clock ms is too coarse to order two saves in the same tick, and the
  // contract cares about `meta.rev` moving. A monotonic counter folded into the
  // timestamp keeps both `rev` and "newest first" strictly ordered.
  private tick = 0

  private now(): number {
    return Date.now() + this.tick++
  }

  private require(id: string): MemDoc {
    const rec = this.docs.get(id)
    if (!rec) throw new Error(`Document not found: ${id}`)
    return rec
  }

  async list(opts: ListOptions = {}): Promise<DocSummary[]> {
    let docs = [...this.docs.values()]
    if (opts.filter === 'public') docs = docs.filter(d => d.is_public)
    else if (opts.filter === 'shared') docs = []  // no other owners to share from
    if (opts.search) {
      const needle = opts.search.toLowerCase()
      docs = docs.filter(d => d.name.toLowerCase().includes(needle))
    }
    if (opts.sort === 'name') docs.sort((a, b) => a.name.localeCompare(b.name))
    else if (opts.sort === 'modified_asc') docs.sort((a, b) => a.meta.updatedAt - b.meta.updatedAt)
    else docs.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
    return docs.map(d => ({
      uuid: d.uuid,
      name: d.name,
      created_at: d.created_at,
      updated_at: d.updated_at,
      is_owner: true,
      owner_username: OWNER,
      is_public: d.is_public,
      preview_image: d.preview_image,
      meta: { ...d.meta },
    }))
  }

  async load(id: string): Promise<DocumentPayload> {
    const rec = this.require(id)
    return {
      content: rec.content,
      name: rec.name,
      owner_username: OWNER,
      is_public: rec.is_public,
      preview_image: rec.preview_image,
    }
  }

  async save(id: string, input: SaveInput): Promise<void> {
    const rec = this.docs.get(id)
    const at = this.now()
    if (!rec) {
      // Upsert rather than reject, matching the IndexedDB store: the editor can
      // save into an id whose create() has not landed yet, and losing those
      // bytes is worse than holding a record the library never named.
      this.docs.set(id, {
        uuid: id,
        name: 'Untitled',
        content: input.content,
        preview_image: input.preview_image,
        is_public: false,
        created_at: new Date(at).toISOString(),
        updated_at: new Date(at).toISOString(),
        meta: { id, rev: 1, updatedAt: at, dirty: true },
      })
      return
    }
    rec.content = input.content
    if (input.preview_image !== undefined) rec.preview_image = input.preview_image
    rec.updated_at = new Date(at).toISOString()
    rec.meta = { ...rec.meta, rev: rec.meta.rev + 1, updatedAt: at, dirty: true }
  }

  async remove(id: string): Promise<void> {
    this.docs.delete(id)
  }

  async create(name: string, opts: { is_public?: boolean } = {}): Promise<{ uuid: string }> {
    const uuid = randomUuid()
    const at = this.now()
    this.docs.set(uuid, {
      uuid,
      name,
      content: '',
      is_public: !!opts.is_public,
      created_at: new Date(at).toISOString(),
      updated_at: new Date(at).toISOString(),
      meta: { id: uuid, rev: 0, updatedAt: at, dirty: true },
    })
    return { uuid }
  }

  async rename(id: string, name: string): Promise<void> {
    const rec = this.require(id)
    const at = this.now()
    rec.name = name
    rec.updated_at = new Date(at).toISOString()
    rec.meta = { ...rec.meta, rev: rec.meta.rev + 1, updatedAt: at, dirty: true }
  }

  async duplicate(id: string): Promise<{ uuid: string }> {
    return this.copyInto(id, name => `${name} (copy)`)
  }

  async clone(id: string, name?: string): Promise<{ uuid: string }> {
    return this.copyInto(id, srcName => name?.trim() || suggestedCloneName(srcName))
  }

  private async copyInto(id: string, nameFor: (srcName: string) => string): Promise<{ uuid: string }> {
    const src = this.require(id)
    const { uuid } = await this.create(nameFor(src.name), { is_public: src.is_public })
    await this.save(uuid, { content: src.content, preview_image: src.preview_image })
    return { uuid }
  }

  thumbnailUrl(_id: string): string | null {
    return null  // previews ride inline on the summary
  }
}
