import type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta,
  TrashAdapter, TrashDoc,
} from './types'
import { parseDocKind } from '@/workspace/kinds'
import { idbGet, idbGetAll, idbPut, idbDelete, idbReadModifyWrite } from './idb'
import { suggestedCloneName } from './cloneName'
import { randomUuid } from '@/utils/randomUuid'

// In a fully local, single-user build there is no account system. Documents are
// all owned by this browser; the owner label is cosmetic (the documents grid
// renders `${owner}/${name}`).
export const LOCAL_OWNER = 'local'

// The on-disk record. Holds the document text and the sync `meta` envelope
// alongside the list-grid metadata. Stored as one value per uuid so a single
// get/put touches everything for a document.
interface StoredDoc {
  uuid: string
  name: string
  content: string
  // Denormalized from content on save so list() does not parse every document
  // body just to paint a tile. Absent on records written before the field, which
  // toSummary parses from the content it already has in hand.
  kind?: string
  is_public: boolean
  created_at: string
  updated_at: string
  meta: DocMeta
  // Soft-delete tombstone (local trash). Set by remove(), cleared by recover();
  // a record with this set is hidden from list()/load() but kept on disk so the
  // local Trash view can list, recover or permanently purge it.
  deleted_at?: string
}

function newUuid(): string {
  return randomUuid()
}

function toSummary(rec: StoredDoc): DocSummary {
  return {
    uuid: rec.uuid,
    name: rec.name,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    is_owner: true,
    owner_username: LOCAL_OWNER,
    is_public: rec.is_public,
    // A record written before `kind` existed has no stored value; the content is
    // already loaded by idbGetAll, so read it without coercion rather than
    // report undefined.
    kind: rec.kind ?? parseDocKind(rec.content),
    meta: rec.meta,
  }
}

// IndexedDB-backed store: the document library. Offline is not a degraded mode
// here, it is the only mode -- this is the whole persistence layer, scoped to
// the origin serving the app.
export class IndexedDbDocumentStore implements DocumentStore {
  async list(opts: ListOptions = {}): Promise<DocSummary[]> {
    const all = await idbGetAll<StoredDoc>()
    // Soft-deleted documents live on in the Trash, never in the library list.
    let docs = all.filter(d => !d.deleted_at)
    // Single-user model: 'owned' = everything, 'public' = the public ones,
    // 'shared' has no meaning locally (always empty).
    if (opts.filter === 'public') docs = docs.filter(d => d.is_public)
    else if (opts.filter === 'shared') docs = []
    if (opts.search) {
      const needle = opts.search.toLowerCase()
      docs = docs.filter(d => d.name.toLowerCase().includes(needle))
    }
    const sorted = [...docs]
    if (opts.sort === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    } else if (opts.sort === 'modified_asc') {
      sorted.sort((a, b) => a.meta.updatedAt - b.meta.updatedAt)
    } else {
      // default + 'modified': newest first
      sorted.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
    }
    return sorted.map(toSummary)
  }

  async load(id: string): Promise<DocumentPayload> {
    const rec = await idbGet<StoredDoc>(id)
    // A trashed record is gone as far as the library is concerned: load rejects
    // just as if it were hard-deleted (the shared store contract expects this).
    if (!rec || rec.deleted_at) throw new Error(`Document not found: ${id}`)
    return {
      content: rec.content,
      name: rec.name,
      owner_username: LOCAL_OWNER,
      is_public: rec.is_public,
      kind: rec.kind ?? parseDocKind(rec.content),
    }
  }

  // Read + modify + write in one readwrite transaction (idbReadModifyWrite):
  // a concurrent save/rename against the same id (another tab, another
  // in-flight call) must not be able to land its put between this read and
  // this write, or it would be silently overwritten by this one (lost update).
  async save(id: string, input: SaveInput): Promise<void> {
    await idbReadModifyWrite<StoredDoc>(id, existing => {
      // No-op save: identical bytes must not churn meta.rev (the assembly
      // bundle-cache key via currentRevs), restamp updatedAt, or re-flag a
      // synced doc dirty. Skipping the whole write keeps those stable; a
      // missing (or tombstoned) record still falls through to the write below.
      if (existing && !existing.deleted_at && existing.content === input.content) return undefined
      const now = Date.now()
      const prevRev = existing?.meta.rev ?? 0
      // Sync-readiness rules: bump rev, stamp updatedAt, flag dirty. baseRev is
      // never touched by a local save -- only a future sync engine sets it.
      const meta: DocMeta = {
        id,
        rev: prevRev + 1,
        updatedAt: now,
        dirty: true,
        baseRev: existing?.meta.baseRev,
      }
      return {
        uuid: id,
        name: existing?.name ?? 'Untitled',
        content: input.content,
        // Content without a kind keeps the record's prior kind: a created part
        // carries its kind as metadata and its body may still be empty.
        kind: parseDocKind(input.content) ?? existing?.kind,
        is_public: existing?.is_public ?? false,
        created_at: existing?.created_at ?? new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        meta,
      }
    })
  }

  // Soft delete: stamp a tombstone and keep the record so the Trash can recover
  // or purge it. A missing record is a no-op (already gone). Delete is reversible
  // by design -- an accidental click on your only copy has no undo anywhere else.
  async remove(id: string): Promise<void> {
    await idbReadModifyWrite<StoredDoc>(id, existing => {
      if (!existing || existing.deleted_at) return undefined  // no-op: gone or already trashed
      return { ...existing, deleted_at: new Date(Date.now()).toISOString() }
    })
  }

  async create(name: string, opts: { is_public?: boolean } = {}): Promise<{ uuid: string }> {
    const uuid = newUuid()
    const now = Date.now()
    const rec: StoredDoc = {
      uuid,
      name,
      content: '',
      is_public: opts.is_public ?? false,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      // rev 0 on create; the first save bumps it to 1 (a new doc is a local
      // change nothing has synced anywhere, hence dirty).
      meta: { id: uuid, rev: 0, updatedAt: now, dirty: true },
    }
    await idbPut(rec)
    return { uuid }
  }

  // Reject-on-missing is the canonical unknown-id semantic (review-17 L12): a
  // rename of an id that does not exist must fail loudly rather than invent
  // state, matching load() and duplicate(). save()'s phantom-'Untitled' upsert
  // above is the ONE deliberate exception, kept because the editor may save
  // into an id whose create() raced the first save -- do not align these two
  // without revisiting that intent.
  async rename(id: string, name: string): Promise<void> {
    const renamed = await idbReadModifyWrite<StoredDoc>(id, existing => {
      if (!existing) return undefined
      // A rename is a local change like a save: bump rev, restamp updatedAt, flag
      // dirty so it re-sorts by "modified" and a sync engine pushes it. baseRev
      // stays put (only an actual sync sets it).
      const now = Date.now()
      const meta: DocMeta = {
        ...existing.meta,
        rev: existing.meta.rev + 1,
        updatedAt: now,
        dirty: true,
      }
      return { ...existing, name, updated_at: new Date(now).toISOString(), meta }
    })
    if (!renamed) throw new Error(`Document not found: ${id}`)
  }

  async duplicate(id: string): Promise<{ uuid: string }> {
    return this.copyInto(id, name => `${name} (copy)`)
  }

  // No other owners on a local device, so cloning is just a local copy, except
  // that the caller may have had the user name it.
  async clone(id: string, name?: string): Promise<{ uuid: string }> {
    return this.copyInto(id, srcName => name?.trim() || suggestedCloneName(srcName))
  }

  private async copyInto(id: string, nameFor: (srcName: string) => string): Promise<{ uuid: string }> {
    const src = await idbGet<StoredDoc>(id)
    // A tombstoned record is gone as far as the library is concerned: duplicating
    // it would resurrect a trashed document as a live copy behind load()'s and
    // list()'s backs, which reject/hide trashed records.
    if (!src || src.deleted_at) throw new Error(`Document not found: ${id}`)
    const { uuid } = await this.create(nameFor(src.name), { is_public: src.is_public })
    try {
      await this.save(uuid, { content: src.content })
    } catch (err) {
      // Compensating delete for the non-atomic create+save pair: without it a
      // failed save strands an empty orphan copy in the library.
      await this.remove(uuid).catch(() => undefined)
      throw err
    }
    return { uuid }
  }

  // No separate thumbnail resource: the view reads the preview store itself.
  // Keeps the interface's (id) signature so a store that does serve thumbnails
  // can drop straight in.
  thumbnailUrl(_id: string): string | null {
    return null
  }

  // Engine-facing primitive (NOT part of DocumentStore). A future sync engine
  // calls this on push-ack: the document now matches what the target holds.
  async markSynced(id: string): Promise<void> {
    await idbReadModifyWrite<StoredDoc>(id, existing => {
      if (!existing) return undefined
      const meta: DocMeta = { ...existing.meta, baseRev: existing.meta.rev, dirty: false }
      return { ...existing, meta }
    })
  }
}

function toTrashDoc(rec: StoredDoc): TrashDoc {
  return {
    uuid: rec.uuid,
    name: rec.name,
    deleted_at: rec.deleted_at ?? '',
    created_at: rec.created_at,
    owner_id: 0,
    owner_username: LOCAL_OWNER,
  }
}

// The recover/purge side of the IndexedDB store's soft delete. It reads the same
// object store as IndexedDbDocumentStore -- the records that store tombstoned
// with remove() are exactly what this lists. Split out as its own TrashAdapter
// so the Trash view is the only screen holding a purge().
export class IndexedDbTrashAdapter implements TrashAdapter {
  async list(): Promise<TrashDoc[]> {
    const all = await idbGetAll<StoredDoc>()
    return all
      .filter(d => d.deleted_at)
      .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''))  // newest deletion first
      .map(toTrashDoc)
  }

  // Lift the tombstone: the document returns to the library at its prior place.
  async recover(id: string): Promise<void> {
    await idbReadModifyWrite<StoredDoc>(id, existing => {
      if (!existing || !existing.deleted_at) return undefined
      const restored = { ...existing }
      delete restored.deleted_at
      return restored
    })
  }

  // The soft delete's hard end: drop the record for good.
  async purge(id: string): Promise<void> {
    await idbDelete(id)
  }
}
