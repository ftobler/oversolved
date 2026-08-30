import type { DocMeta } from './types'
import { secureFilename } from './secureFilename'
import { randomUuid } from '@/utils/randomUuid'

// The on-disk shape of a directory-backed library, and the bookkeeping that
// keeps it honest. FileSystemDirectoryStore is the DocumentStore built on top;
// everything about WHERE bytes land lives here.
//
//   Bracket.yaml              the document, byte-identical to the YAML export
//   Bracket.png               its preview, alongside (only when one exists)
//   .oversolved-index.json    the library's registry (uuid, name, sync meta)
//   .oversolved-trash/        soft-deleted documents, same two files each
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
// The index is library bookkeeping, NOT part of any document. Losing it costs
// uuid stability and nothing else: `reconcile` below adopts every .yaml it
// finds. That is what keeps the atomicity objection answered -- a document save
// is one file write, committed by `close()`, and the only multi-file operations
// are library-level ones whose partial state is a visible extra file rather
// than a corrupt document.

export const INDEX_FILE = '.oversolved-index.json'
export const TRASH_DIR = '.oversolved-trash'
export const DOC_EXT = '.yaml'
export const PREVIEW_EXT = '.png'
const INDEX_VERSION = 1

// The name a document gets when its own name sanitizes to nothing (a purely
// non-ASCII name) -- the same fallback the bundle format uses, so a document
// survives a round trip through either.
export const UNTITLED_DOC_NAME = 'Untitled'

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
  // Soft-delete tombstone. A tombstoned entry's files live under TRASH_DIR, so
  // the library folder shows exactly the documents the library lists.
  deleted_at?: string
}

export interface LibraryIndex {
  version: number
  docs: IndexEntry[]
}

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
): Promise<void> {
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
// must be a real .png a file manager can preview. These two convert at the
// boundary and nowhere else.
//
// Note that this decode/re-encode is only byte-stable for a CANONICAL base64
// string. Every producer in the app is one (canvas.toDataURL), and the bundle
// format's zip entries have canonicalized the same way since it was written.
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

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

// ─── the library ───

// Owns the directory handle, the index, and every write ordering rule. Both the
// DocumentStore and its TrashAdapter face are built on ONE of these, because a
// delete moves files between the two halves and they must share an index.
export class DirectoryLibrary {
  // Every index read-modify-write is chained onto this promise. The File System
  // Access API has no transaction, so two overlapping saves would otherwise
  // interleave their read and write of the index and one would silently clobber
  // the other -- the same lost update `idbReadModifyWrite` exists to prevent,
  // solved the only way this API allows.
  private queue: Promise<unknown> = Promise.resolve()

  readonly dir: FileSystemDirectoryHandle

  constructor(dir: FileSystemDirectoryHandle) {
    this.dir = dir
  }

  get label(): string {
    return this.dir.name
  }

  // Serializes `job` behind every mutation already queued. Failures do not
  // poison the chain: the next job runs regardless of how this one ended.
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async trashDir(): Promise<FileSystemDirectoryHandle> {
    return this.dir.getDirectoryHandle(TRASH_DIR, { create: true })
  }

  private dirFor(entry: IndexEntry): Promise<FileSystemDirectoryHandle> {
    return entry.deleted_at ? this.trashDir() : Promise.resolve(this.dir)
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
  // every read: a git checkout, a Dropbox sync or another editor is simply what
  // the folder looks like now.
  //
  //   file with no entry   -> adopted under a fresh uuid, named after the file
  //   entry with no file   -> dropped (the user deleted it outside the app)
  //
  // Adoption persists, so an externally added file keeps the same uuid on the
  // next read and the route to it does not break under the user.
  private async reconcile(index: LibraryIndex): Promise<{ index: LibraryIndex; changed: boolean }> {
    const onDisk = await this.listStems(this.dir)
    const inTrash = await this.listStems(await this.trashDir())
    const kept: IndexEntry[] = []
    let changed = false

    for (const entry of index.docs) {
      const present = entry.deleted_at ? inTrash : onDisk
      if (!present.has(entry.stem)) {
        changed = true
        continue  // the file is gone: so is the document
      }
      const has_preview = present.get(entry.stem)!
      if (has_preview !== entry.has_preview) {
        kept.push({ ...entry, has_preview })
        changed = true
        continue
      }
      kept.push(entry)
    }

    const claimed = new Set(kept.filter(e => !e.deleted_at).map(e => e.stem))
    for (const [stem, has_preview] of onDisk) {
      if (claimed.has(stem)) continue
      kept.push(adopt(stem, has_preview))
      changed = true
    }
    // Files sitting in the trash folder with no entry are not adopted: they are
    // deleted documents, and resurrecting them into the library on every read
    // would make delete un-stick.
    return { index: { version: INDEX_VERSION, docs: kept }, changed }
  }

  // Stem -> has-a-sibling-preview, for one directory level.
  private async listStems(dir: FileSystemDirectoryHandle): Promise<Map<string, boolean>> {
    const docs = new Set<string>()
    const previews = new Set<string>()
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file') continue
      if (handle.name.endsWith(DOC_EXT)) docs.add(handle.name.slice(0, -DOC_EXT.length))
      else if (handle.name.endsWith(PREVIEW_EXT)) previews.add(handle.name.slice(0, -PREVIEW_EXT.length))
    }
    return new Map([...docs].map(stem => [stem, previews.has(stem)]))
  }

  // The read side: the reconciled index, with any adoption already persisted.
  // Callers get a deep-enough copy that mutating a returned entry cannot reach
  // back into a later read.
  async read(): Promise<IndexEntry[]> {
    return this.enqueue(async () => {
      const { index, changed } = await this.reconcile(await this.loadIndex())
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
      const { index, changed } = await this.reconcile(await this.loadIndex())
      const { entries, result } = await mutate(index.docs.map(cloneEntry), this.io())
      if (entries) await this.saveIndex({ version: INDEX_VERSION, docs: entries })
      else if (changed) await this.saveIndex(index)
      return result
    })
  }

  // ─── document bytes ───

  private io(): LibraryIo {
    return {
      readContent: entry => this.readContent(entry),
      readPreview: entry => this.readPreview(entry),
      writeDoc: (entry, content, preview) => this.writeDoc(entry, content, preview),
      moveDoc: (entry, to, stem) => this.moveDoc(entry, to, stem),
      renameDoc: (entry, stem) => this.renameDoc(entry, stem),
      deleteDoc: entry => this.deleteDoc(entry),
    }
  }

  async readContent(entry: IndexEntry): Promise<string> {
    const dir = await this.dirFor(entry)
    const text = await readTextFile(dir, entry.stem + DOC_EXT)
    if (text === null) throw new Error(`Document file missing: ${entry.stem}${DOC_EXT}`)
    return text
  }

  async readPreview(entry: IndexEntry): Promise<string | undefined> {
    if (!entry.has_preview) return undefined
    const dir = await this.dirFor(entry)
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
  private async writeDoc(entry: IndexEntry, content: string, preview?: string): Promise<void> {
    const dir = await this.dirFor(entry)
    await writeFile(dir, entry.stem + DOC_EXT, content)
    if (preview !== undefined) await writeFile(dir, entry.stem + PREVIEW_EXT, base64ToBytes(preview))
  }

  // Between the library folder and the trash folder, in either direction, and
  // under a destination stem the caller allocated against THAT folder's names.
  // The two levels have independent name spaces: the library folder is what the
  // user looks at, so deleting Bracket must free the name Bracket there, and
  // recovering it later must find a name still free rather than overwrite
  // whatever took it.
  //
  // Copy then delete, because `FileSystemFileHandle.move()` is newer than the
  // pickers this feature already depends on and is not in every Chromium the
  // app supports. A crash between the two leaves a duplicate, never a loss.
  private async moveDoc(entry: IndexEntry, to: 'library' | 'trash', stem: string): Promise<void> {
    const from = entry.deleted_at ? await this.trashDir() : this.dir
    const dest = to === 'trash' ? await this.trashDir() : this.dir
    const content = await readTextFile(from, entry.stem + DOC_EXT)
    if (content === null) throw new Error(`Document file missing: ${entry.stem}${DOC_EXT}`)
    await writeFile(dest, stem + DOC_EXT, content)
    if (entry.has_preview) {
      try {
        const handle = await from.getFileHandle(entry.stem + PREVIEW_EXT)
        await writeFile(dest, stem + PREVIEW_EXT, await fileBytes(await handle.getFile()))
      } catch {
        // No preview to carry across; the document still moves.
      }
    }
    await removeFile(from, entry.stem + DOC_EXT)
    await removeFile(from, entry.stem + PREVIEW_EXT)
  }

  // A rename is a real file rename: the filename IS the document name in a
  // directory library, so leaving the old stem in place would make the folder
  // disagree with the app about what a document is called. Same copy-then-
  // delete shape as moveDoc, and for the same reason.
  private async renameDoc(entry: IndexEntry, stem: string): Promise<void> {
    if (stem === entry.stem) return
    const dir = await this.dirFor(entry)
    const content = await readTextFile(dir, entry.stem + DOC_EXT)
    if (content === null) throw new Error(`Document file missing: ${entry.stem}${DOC_EXT}`)
    await writeFile(dir, stem + DOC_EXT, content)
    if (entry.has_preview) {
      try {
        const handle = await dir.getFileHandle(entry.stem + PREVIEW_EXT)
        await writeFile(dir, stem + PREVIEW_EXT, await fileBytes(await handle.getFile()))
      } catch {
        // No preview to carry across; the rename still lands.
      }
    }
    await removeFile(dir, entry.stem + DOC_EXT)
    await removeFile(dir, entry.stem + PREVIEW_EXT)
  }

  private async deleteDoc(entry: IndexEntry): Promise<void> {
    const dir = await this.dirFor(entry)
    await removeFile(dir, entry.stem + DOC_EXT)
    await removeFile(dir, entry.stem + PREVIEW_EXT)
  }
}

// The byte-level operations a mutation may perform inside the library's
// serialized slot. Handed to `update`'s callback rather than reachable on the
// library, so a write cannot accidentally be issued outside the lock.
export interface LibraryIo {
  readContent(entry: IndexEntry): Promise<string>
  readPreview(entry: IndexEntry): Promise<string | undefined>
  writeDoc(entry: IndexEntry, content: string, preview?: string): Promise<void>
  moveDoc(entry: IndexEntry, to: 'library' | 'trash', stem: string): Promise<void>
  renameDoc(entry: IndexEntry, stem: string): Promise<void>
  deleteDoc(entry: IndexEntry): Promise<void>
}

// ─── naming ───

// The stem a document name lands on, given the stems already spoken for.
// Mirrors the bundle format's collision suffixing so two documents named the
// same get `_1`, `_2`, ... and one can never overwrite the other. The taken set
// holds every PRODUCED stem including suffixes, so a generated `Bracket_1` can
// not land on a real document already called that.
export function allocateStem(name: string, taken: Set<string>): string {
  const base = secureFilename(name) || UNTITLED_DOC_NAME
  if (!taken.has(base)) return base
  let n = 1
  while (taken.has(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

// A file found in the folder that no index entry claims. Its name is its name:
// the point of a directory library is that the filename IS the document name,
// so an externally dropped Bracket.yaml opens as "Bracket".
function adopt(stem: string, has_preview: boolean): IndexEntry {
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
  }
}

function isEntry(value: unknown): value is IndexEntry {
  const e = value as Partial<IndexEntry> | null
  return !!e && typeof e.uuid === 'string' && typeof e.stem === 'string' &&
    typeof e.name === 'string' && !!e.meta && typeof e.meta.rev === 'number'
}

function cloneEntry(entry: IndexEntry): IndexEntry {
  return { ...entry, meta: { ...entry.meta } }
}
