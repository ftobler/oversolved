import type { DocMeta } from './types'
import { secureFilename, uniqueStem, UNTITLED_DOC_NAME } from './secureFilename'
import { randomUuid } from '@/utils/randomUuid'
import { base64ToBytes } from '@/kernel/occ/stepIo'

// The on-disk shape of a directory-backed library, and the bookkeeping that
// keeps it honest. FileSystemDirectoryStore is the DocumentStore built on top;
// everything about WHERE bytes land lives here.
//
//   Bracket.yaml              the document, byte-identical to the YAML export
//   .oversolved-index.json    the library's registry (uuid, name, sync meta)
//   .oversolved-previews/     one <stem>.png thumbnail per document
//   .oversolved-trash/        soft-deleted documents, and their previews
//
// Two decisions this layout makes, both of which the plan left open:
//
// **One document is one plain YAML file.** Not a per-document zip. A folder of
// files is only worth having if the files are the ones the user already knows:
// diffable, greppable, committable to git, openable in an editor. The zip would
// have carried the preview inside the document, at the cost of making every
// document an opaque archive -- which is what IndexedDB already was.
//
// **The per-user directory level from the bundle format is shed.** It is
// vestigial there (kept so older bundles keep importing); a real folder the
// user picked has exactly one library in it, and a `local/` level inside it
// would be an artifact of a server that no longer exists.
//
// Previews do NOT sit beside the document the way the bundle format puts them,
// and that is the third decision. The folder is the user's, and the only names
// this app may own in it are the ones it announced: `<their document>.yaml` and
// entries starting with `.oversolved-`. A `<stem>.png` sibling would silently
// claim a name they may already be using -- point the app at a folder holding
// `Bracket.yaml` and an unrelated `Bracket.png` and the first thumbnail save
// overwrites their image. Previews are bookkeeping, like the index, so they
// live with it.
//
// The index is library bookkeeping, NOT part of any document: no document's
// content is in it, and `reconcile` below rebuilds it from what is on disk,
// live documents and trashed ones alike. What losing it costs is the uuids
// (every document is re-adopted under a new one, so open routes break) and the
// sync `meta` envelope, which restarts from the adoption default.
//
// The atomicity objection is answered by the document itself staying ONE file:
// its text is written by a single `createWritable()`, committed by `close()`,
// so an interrupted save leaves the previous contents rather than a truncated
// document. A save carrying a preview writes a second file after that one, and
// a delete writes at the destination before removing the source; those are the
// multi-file operations, and their partial state is a stale thumbnail or a
// duplicate, never a corrupt document.

export const INDEX_FILE = '.oversolved-index.json'
export const TRASH_DIR = '.oversolved-trash'
export const PREVIEWS_DIR = '.oversolved-previews'
export const DOC_EXT = '.yaml'
export const PREVIEW_EXT = '.png'
const INDEX_VERSION = 1

// One document's registry row. `stem` is the on-disk realization of `name`:
// they differ whenever the name needs sanitizing or a collision suffix, and the
// UI always shows `name`.
export interface IndexEntry {
  uuid: string
  stem: string
  name: string
  is_public: boolean
  created_at: string
  updated_at: string
  meta: DocMeta
  has_preview: boolean
  // The document file as reconcile last saw it. A directory library's whole
  // point is that other tools write these files, and nothing notifies us when
  // one does, so the fingerprint is how an outside edit is detected at all:
  // without it an edited document keeps its old `rev`, and `rev` is the
  // assembly bundle cache key, so the app would serve pre-edit geometry.
  size: number
  mtime: number
  // Soft-delete tombstone. A tombstoned entry's files live under TRASH_DIR, so
  // the library folder shows exactly the documents the library lists.
  deleted_at?: string
}

export interface LibraryIndex {
  version: number
  docs: IndexEntry[]
}

// A document file as the filesystem reports it. Size and mtime together are
// enough to notice an edit made by anything that is not this app; neither alone
// is (a same-length rewrite, a preserved mtime from a checkout).
//
// Every write returns one, and the caller MUST fold it into the entry it
// stores: an entry whose fingerprint does not match the file this app just
// wrote would read as an outside edit on the very next reconcile, bumping rev
// forever.
export interface DiskFile {
  size: number
  mtime: number
}

// One directory level, as read. Handles rather than fingerprints: reading a
// name is one directory entry, reading a size and modification time is a stat
// per file, and only the read path needs every one of them (see `reconcile`).
interface DirectoryContents {
  docs: Map<string, FileSystemFileHandle>
  previews: Set<string>
}

async function fingerprint(handle: FileSystemFileHandle): Promise<DiskFile> {
  const file = await handle.getFile()
  return { size: file.size, mtime: file.lastModified }
}

interface Reconciled {
  index: LibraryIndex
  changed: boolean
  onDisk: DirectoryContents
  inTrash: DirectoryContents
}

// Stands in for one of this app's own directories before anything has been put
// in it, so a read path can ask what it holds without creating it. Every entry
// is absent, which is the truth, and `removeFile` already treats absent as the
// outcome it wanted.
const EMPTY_DIR = {
  kind: 'directory' as const,
  name: '',
  async *values() {},
  async getFileHandle(name: string) { throw notFound(name) },
  async getDirectoryHandle(name: string) { throw notFound(name) },
  async removeEntry(name: string) { throw notFound(name) },
} as unknown as FileSystemDirectoryHandle

function emptyIndex(): LibraryIndex {
  return { version: INDEX_VERSION, docs: [] }
}

// ─── file primitives ───

// Absent reads as absent. Anything else -- a revoked permission, an I/O error,
// a directory where a file was expected -- propagates: swallowing those would
// make a readable-but-broken library look like an empty one, and an empty
// library is exactly what the index reconciler treats as "adopt everything".
function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError'
}

function notFound(name: string): DOMException {
  return new DOMException(`A requested file or directory could not be found: ${name}`, 'NotFoundError')
}

async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  let handle: FileSystemFileHandle
  try {
    handle = await dir.getFileHandle(name)
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
  return (await handle.getFile()).text()
}

// Writes through `createWritable()`, which buffers into a swap file and swings
// it into place on `close()`. That is what makes a document save atomic per
// file: an interrupted save (tab closed, quota, crash) leaves the PREVIOUS
// contents intact, never a truncated document. The File System Access API
// offers no cross-file transaction at all, which is exactly why one document
// has to stay one file.
async function writeFile(
  dir: FileSystemDirectoryHandle, name: string, data: string | Uint8Array<ArrayBuffer>,
): Promise<DiskFile> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(data)
  } catch (err) {
    // Abort discards the swap file rather than committing a partial write.
    await writable.abort?.().catch(() => undefined)
    throw err
  }
  await writable.close()
  // Read back rather than predict: the fingerprint has to be what a later
  // reconcile will see, and only the filesystem knows the mtime it stamped.
  const written = await handle.getFile()
  return { size: written.size, mtime: written.lastModified }
}

async function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!isNotFound(err)) throw err  // already gone is the outcome we wanted
  }
}

// base64 is how a preview travels through the seam (DocumentPayload carries the
// bytes of a PNG with no data: prefix, matching the save body), but on disk it
// must be a real .png a file manager can preview. The decode is the kernel's
// (`base64ToBytes`, shared with STEP ingestion); the encode is here because
// nothing else needed it.
//
// Note that this decode/re-encode is only byte-stable for a CANONICAL base64
// string. Every producer in the app is one (canvas.toDataURL), and the bundle
// format's zip entries have canonicalized the same way since it was written.

async function fileBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer())
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = await fileBytes(file)
  let binary = ''
  // Chunked so a large preview cannot blow the argument limit of String.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// Web Locks is what makes the exclusion cross-tab. It is absent in jsdom and in
// a handful of older engines, and there is no substitute (a lock FILE would
// need the very atomicity this is standing in for), so its absence degrades to
// the per-instance chain the caller already holds. That is exactly today's
// single-tab guarantee, which is the honest floor.
async function withCrossTabLock<T>(name: string, job: () => Promise<T>): Promise<T> {
  const locks = navigator.locks
  if (!locks || typeof locks.request !== 'function') return job()
  return locks.request(name, job) as Promise<T>
}

// ─── the library ───

// Owns the directory handle, the index, and every write ordering rule. Both the
// DocumentStore and its TrashAdapter face are built on ONE of these, because a
// delete moves files between the two halves and they must share an index.
export class DirectoryLibrary {
  // Every index read-modify-write is chained onto this promise. The File System
  // Access API has no transaction of any kind, so two overlapping operations
  // would otherwise interleave their read and write of the index and one would
  // silently clobber the other: the lost update `idbReadModifyWrite` exists to
  // prevent, in a place where nothing equivalent is on offer.
  //
  // This chain covers one DirectoryLibrary only, which is not enough. Every tab
  // reconnects to the remembered folder at boot (libraryStore.restore), so the
  // same folder is routinely open in several tabs, each with its own instance
  // and its own chain. The Web Locks API is origin-scoped and therefore does
  // cover them: `lockName` below is the mutex, and the local chain stays
  // underneath it as the fallback for a context without Web Locks.
  private queue: Promise<unknown> = Promise.resolve()

  readonly dir: FileSystemDirectoryHandle

  constructor(dir: FileSystemDirectoryHandle) {
    this.dir = dir
  }

  get label(): string {
    return this.dir.name
  }

  // Named per folder, so two libraries over different folders do not serialize
  // against each other. Folder names collide (two `cad` directories), and the
  // consequence of that is only over-serialization, never a missed exclusion.
  private get lockName(): string {
    return `oversolved-library:${this.dir.name}`
  }

  // Serializes `job` behind every operation already queued, in this tab and in
  // every other tab holding the same folder. Failures do not poison the chain:
  // the next job runs regardless of how this one ended.
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const guarded = () => withCrossTabLock(this.lockName, job)
    const run = this.queue.then(guarded, guarded)
    this.queue = run.catch(() => undefined)
    return run
  }

  // `create: false` everywhere except an actual delete. Reading a folder must
  // not write to it: merely browsing a library the user opened should leave it
  // byte-for-byte as they left it, and a handle downgraded to read-only would
  // otherwise fail the whole read rather than degrade.
  private async ownDir(name: string, { create }: { create: boolean }): Promise<FileSystemDirectoryHandle> {
    if (create) return this.dir.getDirectoryHandle(name, { create: true })
    try {
      return await this.dir.getDirectoryHandle(name)
    } catch (err) {
      if (isNotFound(err)) return EMPTY_DIR
      throw err
    }
  }

  private trashDir(opts: { create: boolean }): Promise<FileSystemDirectoryHandle> {
    return this.ownDir(TRASH_DIR, opts)
  }

  // Where a document's text lives: the folder the user picked, or the trash.
  private docDir(entry: IndexEntry, opts = { create: false }): Promise<FileSystemDirectoryHandle> {
    return entry.deleted_at ? this.trashDir(opts) : Promise.resolve(this.dir)
  }

  // Where its preview lives, which is never beside it in the user's folder. A
  // TRASHED document keeps both files together in the trash, so that a deleted
  // `Bracket` and a newly created one can hold the same stem without colliding
  // -- the two levels have separate name spaces, and one shared previews
  // directory would put them back in the same one.
  private previewDir(entry: IndexEntry, opts = { create: false }): Promise<FileSystemDirectoryHandle> {
    return entry.deleted_at ? this.trashDir(opts) : this.ownDir(PREVIEWS_DIR, opts)
  }

  // ─── index ───

  private async loadIndex(): Promise<LibraryIndex> {
    const raw = await readTextFile(this.dir, INDEX_FILE)
    if (!raw) return emptyIndex()
    try {
      const parsed = JSON.parse(raw) as Partial<LibraryIndex>
      if (!Array.isArray(parsed.docs)) return emptyIndex()
      // A future version writing a shape this code cannot read must not be
      // silently downgraded; adopting the .yaml files is the safe reading.
      if (parsed.version !== INDEX_VERSION) return emptyIndex()
      return { version: INDEX_VERSION, docs: parsed.docs.filter(isEntry) }
    } catch {
      return emptyIndex()  // hand-edited or truncated: rebuild by adoption
    }
  }

  private async saveIndex(index: LibraryIndex): Promise<void> {
    await writeFile(this.dir, INDEX_FILE, JSON.stringify(index, null, 2) + '\n')
  }

  // Reconciles the index against what is actually on disk, in both directions.
  // There is no change notification on a directory handle, so this runs on
  // every read AND in front of every write: a git checkout, a Dropbox sync or
  // another editor is simply what the folder looks like now.
  //
  //   file with no entry     -> adopted under a fresh uuid, named after the file
  //   entry with no file     -> dropped (deleted outside the app)
  //   file changed underneath -> rev bumped, so caches keyed on rev let go
  //
  // Adoption persists, so an externally added file keeps the same uuid on the
  // next read and the route to it does not break under the user. A file in the
  // trash folder is adopted as ALREADY DELETED: it is a deleted document, so
  // recovering it must stay possible without it reappearing in the library.
  //
  // `restat` is what separates the two callers. Noticing a CHANGED file costs a
  // stat per document, and only a read has to notice: a write is about not
  // clobbering, which needs the folder's names and nothing more, and the edit
  // it did not stat is seen by the next read anyway. Statting on both made a
  // bulk ingest (importBundle: two operations per document) quadratic in stat
  // calls. Adoption still stats, but only the files actually being adopted,
  // which in the steady state is none.
  private async reconcile(index: LibraryIndex, { restat }: { restat: boolean }): Promise<Reconciled> {
    const trash = await this.trashDir({ create: false })
    const onDisk = await this.listStems(this.dir, await this.ownDir(PREVIEWS_DIR, { create: false }))
    const inTrash = await this.listStems(trash, trash)
    const kept: IndexEntry[] = []
    let changed = false

    for (const entry of index.docs) {
      const present = entry.deleted_at ? inTrash : onDisk
      const handle = present.docs.get(entry.stem)
      if (!handle) {
        changed = true
        continue  // the file is gone: so is the document
      }
      const has_preview = present.previews.has(entry.stem)
      // Bytes we did not write. The document is whatever the file now says, and
      // a rev bump is what tells every cache keyed on it to let go.
      const file = restat ? await fingerprint(handle) : null
      if (file && (file.size !== entry.size || file.mtime !== entry.mtime)) {
        kept.push(restamp({ ...entry, has_preview, ...file }))
        changed = true
        continue
      }
      if (has_preview !== entry.has_preview) {
        kept.push({ ...entry, has_preview })
        changed = true
        continue
      }
      kept.push(entry)
    }

    changed = await adoptOrphans(onDisk, kept, false) || changed
    changed = await adoptOrphans(inTrash, kept, true) || changed
    return { index: { version: INDEX_VERSION, docs: kept }, changed, onDisk, inTrash }
  }

  // A level is a documents directory plus wherever ITS previews live. For the
  // library those are two different directories, which is the whole point: the
  // user's folder holds their documents and nothing this app invented a name
  // for. In the trash they are the same directory.
  private async listStems(
    docsDir: FileSystemDirectoryHandle, previewsDir: FileSystemDirectoryHandle,
  ): Promise<DirectoryContents> {
    const docs = new Map<string, FileSystemFileHandle>()
    for await (const handle of docsDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith(DOC_EXT)) continue
      docs.set(handle.name.slice(0, -DOC_EXT.length), handle as FileSystemFileHandle)
    }
    const previews = new Set<string>()
    for await (const handle of previewsDir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith(PREVIEW_EXT)) continue
      previews.add(handle.name.slice(0, -PREVIEW_EXT.length))
    }
    return { docs, previews }
  }

  // The read side: the reconciled index, with any adoption already persisted.
  // Callers get a deep-enough copy that mutating a returned entry cannot reach
  // back into a later read.
  async read(): Promise<IndexEntry[]> {
    return this.enqueue(async () => {
      // The read path is the one that has to notice an outside edit, so this is
      // the sweep that stats every document file.
      const { index, changed } = await this.reconcile(await this.loadIndex(), { restat: true })
      if (changed) await this.saveIndex(index)
      return index.docs.map(cloneEntry)
    })
  }

  // The write side: read-reconcile-mutate-write, serialized against every other
  // mutation. `mutate` returns the new entry list, or undefined to skip its own
  // write (a no-op save still gets to decide that inside the critical section).
  // Its `io` argument is how a mutation puts document bytes on disk WITHIN the
  // same serialized slot, so a save and an index update cannot interleave.
  //
  // A mutation that writes nothing still persists what reconcile found.
  // Otherwise a file that appeared underneath the app is adopted, thrown away,
  // and adopted again under a different uuid on every no-op call until some
  // read happens to land -- so the index and the folder agree after a read but
  // not after a write, which is a distinction nothing else in here makes.
  async update<T>(
    mutate: (entries: IndexEntry[], io: LibraryIo) => Promise<{ entries?: IndexEntry[]; result: T }>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.reconcile(await this.loadIndex(), { restat: false })
      const { index, changed } = state
      const { entries, result } = await mutate(index.docs.map(cloneEntry), this.io(state))
      if (entries) await this.saveIndex({ version: INDEX_VERSION, docs: entries })
      else if (changed) await this.saveIndex(index)
      return result
    })
  }

  // ─── document bytes ───

  private io(state: Reconciled): LibraryIo {
    return {
      // The document stems each level already holds. Only `.yaml` files count:
      // this app writes nothing else into the user's folder, so nothing else in
      // it can collide with a document.
      documentStems: where => new Set((where === 'trash' ? state.inTrash : state.onDisk).docs.keys()),
      readContent: entry => this.readContent(entry),
      readPreview: entry => this.readPreview(entry),
      writeDoc: (entry, content, preview) => this.writeDoc(entry, content, preview),
      moveDoc: (entry, to, stem) => this.moveDoc(entry, to, stem),
      renameDoc: (entry, stem) => this.renameDoc(entry, stem),
      deleteDoc: entry => this.deleteDoc(entry),
    }
  }

  async readContent(entry: IndexEntry): Promise<string> {
    const dir = await this.docDir(entry)
    const text = await readTextFile(dir, entry.stem + DOC_EXT)
    if (text === null) throw new Error(`Document file missing: ${entry.stem}${DOC_EXT}`)
    return text
  }

  async readPreview(entry: IndexEntry): Promise<string | undefined> {
    if (!entry.has_preview) return undefined
    const dir = await this.previewDir(entry)
    try {
      const handle = await dir.getFileHandle(entry.stem + PREVIEW_EXT)
      return await fileToBase64(await handle.getFile())
    } catch {
      return undefined  // a preview that vanished costs a thumbnail, nothing more
    }
  }

  // Document text FIRST, preview second. The document is the thing that must
  // never be lost; a preview written against older text is a stale thumbnail,
  // while text written after a preview failure would be a document the user
  // cannot tell is saved.
  private async writeDoc(entry: IndexEntry, content: string, preview?: string): Promise<DiskFile> {
    const dir = await this.docDir(entry, { create: true })
    const written = await writeFile(dir, entry.stem + DOC_EXT, content)
    if (preview !== undefined) {
      const previews = await this.previewDir(entry, { create: true })
      await writeFile(previews, entry.stem + PREVIEW_EXT, base64ToBytes(preview))
    }
    return written
  }

  // The one file relocation, shared by a move between levels and a rename in
  // place. Both are copy-then-delete, because `FileSystemFileHandle.move()` is
  // newer than the pickers this feature already depends on and is not in every
  // Chromium the app supports.
  //
  // The document and its preview travel separately: a live document's preview
  // is in `.oversolved-previews/` while a trashed one's sits beside its text in
  // the trash, so a delete moves the pair across two different directory pairs.
  //
  // A crash between copy and delete leaves a duplicate, never a loss, and that
  // is the right trade. A REFUSED delete is different: we are still standing to
  // handle it, and without the rollback the copy stays behind, gets adopted on
  // the next reconcile, and a relocation that FAILED shows up as a document at
  // the destination.
  private async relocate(
    entry: IndexEntry, stem: string,
    dirs: {
      doc: { from: FileSystemDirectoryHandle; to: FileSystemDirectoryHandle }
      preview: { from: FileSystemDirectoryHandle; to: FileSystemDirectoryHandle }
    },
  ): Promise<DiskFile> {
    const content = await readTextFile(dirs.doc.from, entry.stem + DOC_EXT)
    if (content === null) throw new Error(`Document file missing: ${entry.stem}${DOC_EXT}`)
    const written = await writeFile(dirs.doc.to, stem + DOC_EXT, content)
    if (entry.has_preview) {
      try {
        const handle = await dirs.preview.from.getFileHandle(entry.stem + PREVIEW_EXT)
        await writeFile(dirs.preview.to, stem + PREVIEW_EXT, await fileBytes(await handle.getFile()))
      } catch {
        // No preview to carry across; the document still moves.
      }
    }
    try {
      await removeFile(dirs.doc.from, entry.stem + DOC_EXT)
      await removeFile(dirs.preview.from, entry.stem + PREVIEW_EXT)
    } catch (err) {
      await removeFile(dirs.doc.to, stem + DOC_EXT).catch(() => undefined)
      await removeFile(dirs.preview.to, stem + PREVIEW_EXT).catch(() => undefined)
      throw err
    }
    return written
  }

  // Between the library folder and the trash folder, in either direction, and
  // under a destination stem the caller allocated against THAT level's names.
  // The two levels have independent name spaces: the library folder is what the
  // user looks at, so deleting Bracket must free the name Bracket there, and
  // recovering it later must find a name still free rather than overwrite
  // whatever took it.
  private async moveDoc(entry: IndexEntry, to: 'library' | 'trash', stem: string): Promise<DiskFile> {
    // The one place the trash folder is brought into existence: an actual
    // delete, which is a write the user asked for.
    const trash = to === 'trash'
      ? await this.trashDir({ create: true })
      : await this.trashDir({ create: false })
    const previews = entry.has_preview && to === 'library'
      ? await this.ownDir(PREVIEWS_DIR, { create: true })
      : await this.ownDir(PREVIEWS_DIR, { create: false })
    return this.relocate(entry, stem, {
      doc: to === 'trash' ? { from: this.dir, to: trash } : { from: trash, to: this.dir },
      preview: to === 'trash' ? { from: previews, to: trash } : { from: trash, to: previews },
    })
  }

  // A rename is a real file rename: the filename IS the document name in a
  // directory library, so leaving the old stem in place would make the folder
  // disagree with the app about what a document is called.
  private async renameDoc(entry: IndexEntry, stem: string): Promise<DiskFile> {
    if (stem === entry.stem) return { size: entry.size, mtime: entry.mtime }
    const doc = await this.docDir(entry)
    const preview = await this.previewDir(entry, { create: entry.has_preview })
    return this.relocate(entry, stem, {
      doc: { from: doc, to: doc },
      preview: { from: preview, to: preview },
    })
  }

  private async deleteDoc(entry: IndexEntry): Promise<void> {
    await removeFile(await this.docDir(entry), entry.stem + DOC_EXT)
    await removeFile(await this.previewDir(entry), entry.stem + PREVIEW_EXT)
  }
}

// The byte-level operations a mutation may perform inside the library's
// serialized slot. Handed to `update`'s callback rather than reachable on the
// library, so a write cannot accidentally be issued outside the lock.
export interface LibraryIo {
  documentStems(where: 'library' | 'trash'): Set<string>
  readContent(entry: IndexEntry): Promise<string>
  readPreview(entry: IndexEntry): Promise<string | undefined>
  // The three writers return the document file's fingerprint as it now stands
  // on disk. Fold it into the entry you store, or the next reconcile reads this
  // app's own write as somebody else's edit.
  writeDoc(entry: IndexEntry, content: string, preview?: string): Promise<DiskFile>
  moveDoc(entry: IndexEntry, to: 'library' | 'trash', stem: string): Promise<DiskFile>
  renameDoc(entry: IndexEntry, stem: string): Promise<DiskFile>
  deleteDoc(entry: IndexEntry): Promise<void>
}

// ─── naming ───

// The stem a document name lands on, given the stems already spoken for in this
// folder level (see `takenStems`: index entries plus every stem the folder uses
// for a file of any kind). Collision suffixing is `uniqueStem`, shared with the
// bundle format so the two agree on what a colliding name becomes.
export function allocateStem(name: string, taken: Set<string>): string {
  return uniqueStem(secureFilename(name) || UNTITLED_DOC_NAME, c => taken.has(c))
}

// A file found in the folder that no index entry claims. Its name is its name:
// the point of a directory library is that the filename IS the document name,
// so an externally dropped Bracket.yaml opens as "Bracket".
function adopt(stem: string, has_preview: boolean, file: DiskFile, deleted: boolean): IndexEntry {
  const now = Date.now()
  const uuid = randomUuid()
  return {
    uuid,
    stem,
    name: stem,
    is_public: false,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    // rev 1, not 0: the file has content, so a bundle cache keyed on rev must
    // not confuse an adopted document with a freshly created empty one.
    meta: { id: uuid, rev: 1, updatedAt: now, dirty: true },
    has_preview,
    size: file.size,
    mtime: file.mtime,
    // A file found in the trash folder is a document that was deleted, and it
    // stays deleted: adopting it live would make delete un-stick, and refusing
    // to adopt it at all (the previous behaviour) left it unlistable,
    // unrecoverable, and liable to be overwritten by the next same-named delete.
    ...(deleted ? { deleted_at: new Date(now).toISOString() } : {}),
  }
}

// Adds an entry for every document file in `contents` that no kept entry
// claims. Returns whether anything was adopted. Stats only the orphans, which
// in a folder this app has been keeping is none.
async function adoptOrphans(
  contents: DirectoryContents, kept: IndexEntry[], deleted: boolean,
): Promise<boolean> {
  const claimed = new Set(kept.filter(e => !!e.deleted_at === deleted).map(e => e.stem))
  let adopted = false
  for (const [stem, handle] of contents.docs) {
    if (claimed.has(stem)) continue
    kept.push(adopt(stem, contents.previews.has(stem), await fingerprint(handle), deleted))
    adopted = true
  }
  return adopted
}

// The local-change stamp for a change this app did not make: bump rev so every
// cache keyed on it lets go, and restamp the modification time the grid sorts
// by. Kept next to reconcile rather than shared with the store's own `stamp`
// because the store's is about a save the user asked for.
//
// Same two-clock split as that one: `updated_at` is what a human reads and
// stays on the wall clock, `meta.updatedAt` is the sort key and is nudged so
// two changes noticed in the same millisecond still order.
function restamp(entry: IndexEntry): IndexEntry {
  const now = Date.now()
  const at = Math.max(now, entry.meta.updatedAt + 1)
  return {
    ...entry,
    updated_at: new Date(now).toISOString(),
    meta: { ...entry.meta, rev: entry.meta.rev + 1, updatedAt: at, dirty: true },
  }
}

function isEntry(value: unknown): value is IndexEntry {
  const e = value as Partial<IndexEntry> | null
  return !!e && typeof e.uuid === 'string' && typeof e.stem === 'string' &&
    typeof e.name === 'string' && !!e.meta && typeof e.meta.rev === 'number' &&
    // An entry written before the fingerprint existed would read as "changed"
    // on every reconcile and bump rev forever, so it is rejected and re-adopted.
    typeof e.size === 'number' && typeof e.mtime === 'number'
}

function cloneEntry(entry: IndexEntry): IndexEntry {
  return { ...entry, meta: { ...entry.meta } }
}
