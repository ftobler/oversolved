import type {
  DocumentStore, DocSummary, DocumentPayload, SaveInput, ListOptions, DocMeta,
  TrashAdapter, TrashDoc,
} from './types'
import { DirectoryLibrary, allocateStem, type IndexEntry } from './directoryLibrary'
import { suggestedCloneName } from './cloneName'
import { randomUuid } from '@/utils/randomUuid'

// A folder the user picked, as the document library.
//
// This is the second shipped DocumentStore, and the whole acceptance bar is
// that it passes contract.test.ts unchanged alongside the IndexedDB one. No new
// behaviour is contracted here: `list / load / save / remove / create / rename
// / duplicate / clone / thumbnailUrl` mean exactly what they already meant, and
// the only difference is that a document is now a file the user owns -- one
// they can back up, diff, mail, or put in git, none of which an origin-scoped
// IndexedDB record allows.
//
// The single-file case ("open this one document") is the degenerate version of
// this, not a separate feature: see singleFileLibrary.ts, which hands this
// store a one-file directory.
//
// Owner labelling matches every other local store: there is no account system,
// so the library belongs to the browser holding it and `is_owner` is always
// true. The label names the folder, which is the one thing about a
// directory-backed library the user can actually check.
export const DIRECTORY_OWNER = 'folder'

function toSummary(entry: IndexEntry, preview?: string): DocSummary {
  return {
    uuid: entry.uuid,
    name: entry.name,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    is_owner: true,
    owner_username: DIRECTORY_OWNER,
    is_public: entry.is_public,
    preview_image: preview,
    meta: { ...entry.meta },
  }
}

// Stems already spoken for in ONE folder level, so a new, renamed, deleted or
// recovered document cannot land on another's file. The library folder and the
// trash folder have independent name spaces: deleting Bracket frees the name
// Bracket in the folder the user is looking at, which is the only reading that
// matches what they see.
function takenStems(
  entries: IndexEntry[], where: 'library' | 'trash', except?: string,
): Set<string> {
  const trashed = where === 'trash'
  return new Set(entries
    .filter(e => e.uuid !== except && !!e.deleted_at === trashed)
    .map(e => e.stem))
}

function findLive(entries: IndexEntry[], id: string): IndexEntry | undefined {
  return entries.find(e => e.uuid === id && !e.deleted_at)
}

export class FileSystemDirectoryStore implements DocumentStore {
  // Previews are real PNG files, and `list()` runs on every debounced keystroke
  // in the documents search box. Re-reading every preview off disk for that
  // would turn a search into a full-library read, so decoded previews are held
  // against the rev they were read at: a save bumps rev and the next list
  // re-reads exactly the document that changed.
  private previews = new Map<string, { rev: number; data?: string }>()

  private readonly library: DirectoryLibrary

  constructor(library: DirectoryLibrary) {
    this.library = library
  }

  get label(): string {
    return this.library.label
  }

  private async preview(entry: IndexEntry): Promise<string | undefined> {
    const cached = this.previews.get(entry.uuid)
    if (cached && cached.rev === entry.meta.rev) return cached.data
    const data = await this.library.readPreview(entry)
    this.previews.set(entry.uuid, { rev: entry.meta.rev, data })
    return data
  }

  async list(opts: ListOptions = {}): Promise<DocSummary[]> {
    const entries = await this.library.read()
    // Soft-deleted documents live on in the Trash, never in the library list.
    let docs = entries.filter(e => !e.deleted_at)
    // Single-user model: 'owned' = everything, 'public' = the public ones,
    // 'shared' has no meaning locally (always empty).
    if (opts.filter === 'public') docs = docs.filter(d => d.is_public)
    else if (opts.filter === 'shared') docs = []
    if (opts.search) {
      const needle = opts.search.toLowerCase()
      docs = docs.filter(d => d.name.toLowerCase().includes(needle))
    }
    const sorted = [...docs]
    if (opts.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (opts.sort === 'modified_asc') sorted.sort((a, b) => a.meta.updatedAt - b.meta.updatedAt)
    else sorted.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
    return Promise.all(sorted.map(async e => toSummary(e, await this.preview(e))))
  }

  async load(id: string): Promise<DocumentPayload> {
    const entry = findLive(await this.library.read(), id)
    // A trashed document is gone as far as the library is concerned: load
    // rejects just as if the file had been deleted (the store contract expects
    // this, and the Trash view reads through the TrashAdapter instead).
    if (!entry) throw new Error(`Document not found: ${id}`)
    return {
      content: await this.library.readContent(entry),
      name: entry.name,
      owner_username: DIRECTORY_OWNER,
      is_public: entry.is_public,
      preview_image: await this.preview(entry),
    }
  }

  async save(id: string, input: SaveInput): Promise<void> {
    await this.library.update(async (entries, io) => {
      const existing = findLive(entries, id)
      if (existing) {
        // No-op save: identical bytes must not churn meta.rev (the assembly
        // bundle-cache key), restamp updated_at, or re-flag a synced doc dirty.
        // Reading the file to decide costs one read and saves a write plus a
        // spurious modification time on a file the user may be watching in git.
        const onDisk = await io.readContent(existing)
        const previewUnchanged = input.preview_image === undefined ||
          input.preview_image === await io.readPreview(existing)
        if (onDisk === input.content && previewUnchanged) return { result: undefined }
        const updated = stamp(existing, {
          has_preview: existing.has_preview || input.preview_image !== undefined,
        })
        await io.writeDoc(updated, input.content, input.preview_image)
        this.previews.delete(id)
        return { entries: replace(entries, updated), result: undefined }
      }
      // Upsert rather than reject, matching every other store: the editor may
      // save into an id whose create() has not landed yet, and losing the
      // user's bytes is worse than holding a document the library never named.
      const created = newEntry(id, 'Untitled', allocateStem('Untitled', takenStems(entries, 'library')), {
        is_public: false,
        rev: 1,
        has_preview: input.preview_image !== undefined,
      })
      await io.writeDoc(created, input.content, input.preview_image)
      this.previews.delete(id)
      return { entries: [...entries, created], result: undefined }
    })
  }

  // Soft delete: the files move into `.oversolved-trash/` and the entry is
  // tombstoned, so the folder the user looks at shows exactly the documents the
  // library lists, and an accidental click is still recoverable. A missing
  // record is a no-op (already gone).
  async remove(id: string): Promise<void> {
    await this.library.update(async (entries, io) => {
      const entry = findLive(entries, id)
      if (!entry) return { result: undefined }
      const stem = allocateStem(entry.name, takenStems(entries, 'trash'))
      await io.moveDoc(entry, 'trash', stem)
      const trashed: IndexEntry = { ...entry, stem, deleted_at: new Date(Date.now()).toISOString() }
      this.previews.delete(id)
      return { entries: replace(entries, trashed), result: undefined }
    })
  }

  async create(name: string, opts: { is_public?: boolean } = {}): Promise<{ uuid: string }> {
    return this.library.update(async (entries, io) => {
      // The file exists from create, not from the first save: an empty document
      // the folder does not show would be a library the user cannot see.
      const entry = newEntry(randomUuid(), name, allocateStem(name, takenStems(entries, 'library')), {
        is_public: opts.is_public ?? false,
        // rev 0 on create; the first save bumps it to 1 (a new doc is a local
        // change nothing has synced anywhere, hence dirty).
        rev: 0,
        has_preview: false,
      })
      await io.writeDoc(entry, '')
      return { entries: [...entries, entry], result: { uuid: entry.uuid } }
    })
  }

  // Reject-on-missing is the canonical unknown-id semantic: a rename of an id
  // that does not exist must fail loudly rather than invent state, matching
  // load() and duplicate(). save()'s upsert above is the ONE exception.
  async rename(id: string, name: string): Promise<void> {
    await this.library.update(async (entries, io) => {
      const entry = findLive(entries, id)
      if (!entry) throw new Error(`Document not found: ${id}`)
      const stem = allocateStem(name, takenStems(entries, 'library', id))
      await io.renameDoc(entry, stem)
      // A rename is a local change like a save: bump rev, restamp updated_at,
      // flag dirty so it re-sorts by "modified".
      return { entries: replace(entries, stamp(entry, { name, stem })), result: undefined }
    })
  }

  async duplicate(id: string): Promise<{ uuid: string }> {
    return this.copyInto(id, name => `${name} (copy)`)
  }

  // No other owners on a local device, so cloning is just a local copy, except
  // that the caller may have had the user name it.
  async clone(id: string, name?: string): Promise<{ uuid: string }> {
    return this.copyInto(id, srcName => name?.trim() || suggestedCloneName(srcName))
  }

  // One serialized slot for the whole copy, unlike the IndexedDB store's
  // create-then-save pair: with a real filesystem underneath there is no
  // compensating delete to get right, because a failure never writes the index
  // and an orphan .yaml is adopted rather than stranded.
  private async copyInto(id: string, nameFor: (srcName: string) => string): Promise<{ uuid: string }> {
    return this.library.update(async (entries, io) => {
      const src = findLive(entries, id)
      if (!src) throw new Error(`Document not found: ${id}`)
      const name = nameFor(src.name)
      const copy = newEntry(randomUuid(), name, allocateStem(name, takenStems(entries, 'library')), {
        is_public: src.is_public,
        rev: 1,
        has_preview: src.has_preview,
      })
      await io.writeDoc(copy, await io.readContent(src), await io.readPreview(src))
      return { entries: [...entries, copy], result: { uuid: copy.uuid } }
    })
  }

  // No separate thumbnail resource: the grid uses the inline preview_image
  // carried on each summary instead.
  thumbnailUrl(_id: string): string | null {
    return null
  }
}

// The recover/purge face of the same directory's soft delete: what the store
// tombstones into `.oversolved-trash/` is exactly what this lists. Shares ONE
// DirectoryLibrary with the store, because recovering a document moves files
// between the two halves and both must see the same index.
export class FileSystemDirectoryTrashAdapter implements TrashAdapter {
  private readonly library: DirectoryLibrary

  constructor(library: DirectoryLibrary) {
    this.library = library
  }

  async list(): Promise<TrashDoc[]> {
    const entries = (await this.library.read()).filter(e => e.deleted_at)
    entries.sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''))  // newest deletion first
    return Promise.all(entries.map(async e => ({
      uuid: e.uuid,
      name: e.name,
      deleted_at: e.deleted_at ?? '',
      created_at: e.created_at,
      owner_id: 0,
      owner_username: DIRECTORY_OWNER,
      preview_image: await this.library.readPreview(e),
    })))
  }

  // Lift the tombstone and move the files back up into the library folder. The
  // stem is reallocated: another document may have taken the name while this
  // one was in the trash, and a recover must never overwrite it.
  async recover(id: string): Promise<void> {
    await this.library.update(async (entries, io) => {
      const entry = entries.find(e => e.uuid === id && e.deleted_at)
      if (!entry) return { result: undefined }
      const stem = allocateStem(entry.name, takenStems(entries, 'library'))
      await io.moveDoc(entry, 'library', stem)
      const restored: IndexEntry = { ...entry, stem }
      delete restored.deleted_at
      return { entries: replace(entries, restored), result: undefined }
    })
  }

  // The soft delete's hard end: the files go for good.
  async purge(id: string): Promise<void> {
    await this.library.update(async (entries, io) => {
      const entry = entries.find(e => e.uuid === id && e.deleted_at)
      if (!entry) return { result: undefined }
      await io.deleteDoc(entry)
      return { entries: entries.filter(e => e.uuid !== id), result: undefined }
    })
  }
}

function newEntry(
  uuid: string, name: string, stem: string,
  opts: { is_public: boolean; rev: number; has_preview: boolean },
): IndexEntry {
  const now = Date.now()
  return {
    uuid,
    stem,
    name,
    is_public: opts.is_public,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    meta: { id: uuid, rev: opts.rev, updatedAt: now, dirty: true },
    has_preview: opts.has_preview,
  }
}

// The local-change stamp every mutating operation shares: bump rev, restamp
// updated_at, flag dirty. `baseRev` is never touched by a local change -- only
// a future sync engine sets it.
//
// `updatedAt` is nudged past the previous value rather than taken raw from the
// clock: two saves inside one millisecond are ordinary in tests and in an
// autosave burst, and "newest first" has to stay a strict order.
function stamp(entry: IndexEntry, patch: Partial<IndexEntry>): IndexEntry {
  const at = Math.max(Date.now(), entry.meta.updatedAt + 1)
  const meta: DocMeta = { ...entry.meta, rev: entry.meta.rev + 1, updatedAt: at, dirty: true }
  return { ...entry, ...patch, updated_at: new Date(at).toISOString(), meta }
}

function replace(entries: IndexEntry[], updated: IndexEntry): IndexEntry[] {
  return entries.map(e => (e.uuid === updated.uuid ? updated : e))
}

// Convenience for the composition root: one library, its two faces.
export function openDirectoryLibrary(dir: FileSystemDirectoryHandle): {
  documents: FileSystemDirectoryStore
  trash: FileSystemDirectoryTrashAdapter
  library: DirectoryLibrary
} {
  const library = new DirectoryLibrary(dir)
  return {
    documents: new FileSystemDirectoryStore(library),
    trash: new FileSystemDirectoryTrashAdapter(library),
    library,
  }
}
