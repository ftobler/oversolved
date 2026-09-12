import type { ListOptions, WorkspaceCarrier } from './carrier'
import type {
  EntryContent,
  EntryMeta,
  ManifestEntry,
  WorkspaceEntry,
  WorkspaceManifest,
  WorkspaceTree,
} from './types'
import {
  DOCUMENTS_DIR,
  FILES_DIR,
  MANIFEST_PATH,
  RESERVED_PREFIX,
  TRASH_DIR,
  pathFor,
} from './paths'
import { parseManifest, serializeManifest } from './manifest'
import { fingerprintManifest } from './carrierFingerprint'
import { canonicalizeReferences } from './refs'
import { copyBytes } from '@/stores/fileRegistry/types'
import { suggestedCloneName } from '@/stores/documentStore/cloneName'
import { randomUuid } from '@/utils/randomUuid'

// The folder-backed conformer of WorkspaceCarrier. One instance is one folder
// the user picked; the manifest file is the index, `documents/` and `files/`
// are the payloads, and `.oversolved-trash/` is where a soft-deleted payload is
// relocated. DirectoryCarrier is never the working copy (IDB is); it is the
// target of an explicit save, an import, and a carrier-change reload.
//
// Atomicity is per file: `createWritable()` buffers into a swap file and only
// `close()` swings it into place, so an interrupted write leaves the previous
// contents. A whole-tree save writes every payload first and the manifest last,
// so a crash between them leaves the old manifest and the new payloads as
// orphans, never a half-named tree. Reconcile is the sweep that surfaces that
// gap, and it is deliberately presence/absence only: identity belongs to the
// manifest, and a file the manifest does not name is reported, never adopted.
//
// Documents are materialized on open (the solve needs the text warm); file
// bytes stay lazy and `read` fetches them on demand, exactly like IdbCarrier.

export interface ReconcileReport {
  missing: string[]  // manifest entries with no payload at either location
  unknownFiles: string[]  // documents/ or files/ files the manifest does not name
}

interface DiskFile {
  size: number
  mtime: number
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError'
}

const textDecoder = new TextDecoder()

function decode(data: Uint8Array): string {
  return textDecoder.decode(data)
}

function contentData(content: EntryContent): string | Uint8Array {
  if (content.text !== undefined) return content.text
  if (content.bytes !== undefined) return content.bytes
  throw new Error('Entry content is empty')
}

// The logical path is manifest-owned; the physical path only differs for a
// trashed entry in the folder carrier, whose payload moves under TRASH_DIR.
function physicalPath(row: ManifestEntry, trashed: boolean): string {
  return trashed ? `${TRASH_DIR}/${row.path}` : row.path
}

async function fileHandleAt(
  root: FileSystemDirectoryHandle, path: string,
): Promise<FileSystemFileHandle | null> {
  const segments = path.split('/')
  const name = segments.pop()
  if (!name) return null
  let dir = root
  try {
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment)
    return await dir.getFileHandle(name)
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

async function ensureFileHandleAt(
  root: FileSystemDirectoryHandle, path: string,
): Promise<FileSystemFileHandle> {
  const segments = path.split('/')
  const name = segments.pop()
  if (!name) throw new Error(`Not a file path: ${path}`)
  let dir = root
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true })
  return dir.getFileHandle(name, { create: true })
}

async function readBytesAt(root: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null> {
  const handle = await fileHandleAt(root, path)
  if (!handle) return null
  return new Uint8Array(await (await handle.getFile()).arrayBuffer())
}

async function readTextAt(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const bytes = await readBytesAt(root, path)
  return bytes === null ? null : decode(bytes)
}

// Writes through `createWritable()`, which buffers into a swap file and swings
// it into place on `close()`. That is what makes one entry's write atomic.
async function writeFileAt(
  root: FileSystemDirectoryHandle, path: string, data: string | Uint8Array,
): Promise<DiskFile> {
  const handle = await ensureFileHandleAt(root, path)
  const writable = await handle.createWritable()
  try {
    await writable.write(data as unknown as FileSystemWriteChunkType)
  } catch (err) {
    await writable.abort?.().catch(() => undefined)
    throw err
  }
  await writable.close()
  const file = await handle.getFile()
  return { size: file.size, mtime: file.lastModified }
}

async function removeFileAt(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const segments = path.split('/')
  const name = segments.pop()
  if (!name) return
  let dir = root
  try {
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment)
    await dir.removeEntry(name)
  } catch (err) {
    if (!isNotFound(err)) throw err  // already gone is the outcome we wanted
  }
}

// Web Locks is what makes the manifest read-modify-write cross-tab. It is
// absent in jsdom, so its absence degrades to the per-instance chain, which is
// the single-tab guarantee the folder carrier has always had.
async function withCrossTabLock<T>(name: string, job: () => Promise<T>): Promise<T> {
  const locks = navigator.locks
  if (!locks || typeof locks.request !== 'function') return job()
  return locks.request(name, job) as Promise<T>
}

async function collectFiles(dir: FileSystemDirectoryHandle, prefix: string, out: string[]): Promise<void> {
  for await (const handle of dir.values()) {
    const path = prefix ? `${prefix}/${handle.name}` : handle.name
    if (handle.kind === 'file') {
      out.push(path)
      continue
    }
    // The trash and other app bookkeeping are never part of the logical tree.
    if (handle.name.startsWith(RESERVED_PREFIX)) continue
    await collectFiles(handle as FileSystemDirectoryHandle, path, out)
  }
}

export class DirectoryCarrier implements WorkspaceCarrier {
  readonly dir: FileSystemDirectoryHandle
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dir: FileSystemDirectoryHandle) {
    this.dir = dir
  }

  get label(): string {
    return this.dir.name
  }

  // Serializes every manifest read-modify-write behind the ones already queued,
  // in this tab and in every other tab holding the same folder.
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const guarded = () => withCrossTabLock(`oversolved-workspace:${this.dir.name}`, job)
    const run = this.queue.then(guarded, guarded)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async loadManifest(): Promise<WorkspaceManifest> {
    const text = await readTextAt(this.dir, MANIFEST_PATH)
    if (text === null) throw new Error(`Workspace manifest not found: ${MANIFEST_PATH}`)
    return parseManifest(text)
  }

  private async writeManifest(manifest: WorkspaceManifest): Promise<void> {
    await writeFileAt(this.dir, MANIFEST_PATH, serializeManifest(manifest))
  }

  private async mutate<T>(job: (manifest: WorkspaceManifest) => Promise<T> | T): Promise<T> {
    return this.enqueue(async () => {
      const manifest = await this.loadManifest()
      const result = await job(manifest)
      await this.writeManifest(manifest)
      return result
    })
  }

  private async readAt(id: string, manifest: WorkspaceManifest): Promise<Uint8Array | null> {
    const row = manifest.entries[id]
    if (!row) return null
    return (await readBytesAt(this.dir, row.path))
      ?? (await readBytesAt(this.dir, `${TRASH_DIR}/${row.path}`))
  }

  private async entryFrom(id: string, manifest: WorkspaceManifest): Promise<WorkspaceEntry> {
    const row = manifest.entries[id]
    if (!row) throw new Error(`Entry not found: ${id}`)
    const bytes = await this.readAt(id, manifest)
    if (bytes === null) throw new Error(`Entry payload is missing: ${row.path}`)
    const entry = entryOf(row, bytes)
    entry.id = id
    return entry
  }

  async open(): Promise<WorkspaceTree> {
    return this.enqueue(async () => {
      const manifest = await this.loadManifest()
      const contents = new Map<string, EntryContent>()
      for (const [id, row] of Object.entries(manifest.entries)) {
        // Documents are loaded eagerly; file payloads are left for read().
        if (row.kind !== 'document') continue
        const bytes = await this.readAt(id, manifest)
        // A manifest-named document with no payload is a gap to surface, not a
        // blank document: substituting '' would let a reload overwrite the
        // working copy with empties after a git checkout or an outside delete.
        if (bytes === null) throw new Error(`Entry payload is missing: ${row.path}`)
        contents.set(id, { text: decode(bytes) })
      }
      return { manifest, contents }
    })
  }

  // The explicit save: every payload first, the manifest last. A per-entry write
  // is atomic through createWritable/close; the manifest-vs-tree gap is what
  // reconcile exists for.
  async save(tree: WorkspaceTree): Promise<void> {
    await this.enqueue(async () => {
      const trashed = new Set(tree.manifest.trash)
      for (const [id, row] of Object.entries(tree.manifest.entries)) {
        const physical = physicalPath(row, trashed.has(id))
        const content = tree.contents.get(id)
        if (content) {
          await writeFileAt(this.dir, physical, contentData(content))
          continue
        }
        // A file payload left lazy by open() is written back from disk, never
        // zeroed.
        if (row.kind !== 'file') throw new Error(`Document entry ${id} has no text`)
        const existing = await this.readAt(id, tree.manifest)
        if (existing !== null) await writeFileAt(this.dir, physical, existing)
      }
      await this.writeManifest(tree.manifest)
    })
  }

  async list(options: ListOptions = {}): Promise<EntryMeta[]> {
    return this.enqueue(async () => {
      const manifest = await this.loadManifest()
      const out: EntryMeta[] = []
      for (const id of Object.keys(manifest.entries).sort()) {
        if (!options.includeTrashed && manifest.trash.includes(id)) continue
        out.push(metaOf(id, manifest.entries[id]))
      }
      return out
    })
  }

  async read(id: string): Promise<WorkspaceEntry> {
    return this.enqueue(async () => {
      const manifest = await this.loadManifest()
      if (manifest.trash.includes(id)) throw new Error(`Entry is trashed: ${id}`)
      return this.entryFrom(id, manifest)
    })
  }

  // A payload read that ignores the trash, so export can materialize a trashed
  // file's bytes. `read` keeps the live-only check for the carrier contract.
  async readPayload(id: string): Promise<WorkspaceEntry> {
    return this.enqueue(async () => {
      const manifest = await this.loadManifest()
      return this.entryFrom(id, manifest)
    })
  }

  async write(entry: WorkspaceEntry): Promise<void> {
    await this.mutate(async manifest => {
      const row = manifest.entries[entry.id]
      if (!row) throw new Error(`Entry not found: ${entry.id}`)
      if (manifest.trash.includes(entry.id)) throw new Error(`Entry is trashed: ${entry.id}`)
      const content = entry.kind === 'file' && entry.bytes === undefined
        ? await this.readAt(entry.id, manifest)
        : contentOrThrow(entry)
      if (content === null) throw new Error(`File entry ${entry.id} has no bytes`)
      await writeFileAt(this.dir, row.path, content)
      // Rebuild the row rather than patching it, so a dropped docKind/mime does
      // not linger from the previous write.
      const next = rowOf(entry)
      next.path = row.path
      manifest.entries[entry.id] = next
    })
  }

  async add(entry: WorkspaceEntry): Promise<void> {
    await this.mutate(async manifest => {
      if (manifest.entries[entry.id]) throw new Error(`Entry already exists: ${entry.id}`)
      const taken = (candidate: string) => Object.values(manifest.entries).some(row => row.path === candidate)
      const path = pathFor(entry.kind, entry.name, taken)
      manifest.entries[entry.id] = rowOf(entry, path)
      await writeFileAt(this.dir, path, contentOrThrow(entry))
    })
  }

  // Soft delete: copy the payload into the trash and delete the source, then
  // mark the id. A crash between copy and delete leaves a duplicate, never a
  // loss.
  async remove(id: string): Promise<void> {
    await this.mutate(async manifest => {
      const row = manifest.entries[id]
      if (!row) throw new Error(`Entry not found: ${id}`)
      if (manifest.trash.includes(id)) return
      await this.relocate(row.path, false)
      manifest.trash = [...manifest.trash, id].sort()
    })
  }

  async restore(id: string): Promise<void> {
    await this.mutate(async manifest => {
      const row = manifest.entries[id]
      if (!row) throw new Error(`Entry not found: ${id}`)
      if (!manifest.trash.includes(id)) return
      await this.relocate(row.path, true)
      manifest.trash = manifest.trash.filter(entry => entry !== id)
    })
  }

  async clone(id: string, name?: string): Promise<string> {
    let cloneId = ''
    await this.mutate(async manifest => {
      const source = await this.entryFrom(id, manifest)
      cloneId = randomUuid()
      const taken = (candidate: string) => Object.values(manifest.entries).some(row => row.path === candidate)
      const clone: WorkspaceEntry = { id: cloneId, kind: source.kind, name: name ?? suggestedCloneName(source.name) }
      if (source.docKind !== undefined) clone.docKind = source.docKind
      if (source.mime !== undefined) clone.mime = source.mime
      if (source.fileKind !== undefined) clone.fileKind = source.fileKind
      const path = pathFor(clone.kind, clone.name, taken)
      manifest.entries[cloneId] = rowOf(clone, path)
      const bytes = await this.readAt(id, manifest)
      if (bytes === null) throw new Error(`Entry payload is missing: ${source.name}`)
      await writeFileAt(this.dir, path, bytes)
    })
    return cloneId
  }

  async hasEntry(id: string): Promise<boolean> {
    return this.enqueue(async () => (await this.loadManifest()).entries[id] !== undefined)
  }

  async referencesOf(id: string): Promise<string[]> {
    return this.enqueue(async () => [...((await this.loadManifest()).references[id] ?? [])])
  }

  async addReference(from: string, to: string): Promise<void> {
    await this.mutate(manifest => {
      const targets = [...(manifest.references[from] ?? []), to]
      manifest.references = canonicalizeReferences({ ...manifest.references, [from]: targets })
    })
  }

  // Presence and absence only. A manifest entry with no payload is kept and
  // reported missing; a file the manifest does not name is reported and never
  // adopted. Identity is the manifest's.
  async reconcile(): Promise<ReconcileReport> {
    return this.enqueue(async () => {
      const manifest = await this.loadManifest()
      const missing: string[] = []
      for (const [id, row] of Object.entries(manifest.entries)) {
        const present = (await readBytesAt(this.dir, row.path)) !== null
          || (await readBytesAt(this.dir, `${TRASH_DIR}/${row.path}`)) !== null
        if (!present) missing.push(id)
      }
      const disk: string[] = []
      await collectFiles(this.dir, '', disk)
      const named = new Set(Object.values(manifest.entries).map(row => row.path))
      const unknownFiles = disk.filter(path =>
        !named.has(path)
        && (path.startsWith(`${DOCUMENTS_DIR}/`) || path.startsWith(`${FILES_DIR}/`)),
      )
      return { missing: missing.sort(), unknownFiles: unknownFiles.sort() }
    })
  }

  // The carrier-change fingerprint, read from the manifest file alone: opening
  // the tree would load every document's text just to hash the index. A missing
  // or unparseable manifest is null, which the caller reads as a change when a
  // fingerprint was recorded.
  async readManifestFingerprint(): Promise<string | null> {
    return this.enqueue(async () => {
      const text = await readTextAt(this.dir, MANIFEST_PATH)
      if (text === null) return null
      try {
        return await fingerprintManifest(parseManifest(text))
      } catch {
        return null
      }
    })
  }

  // The one relocation, both directions. Copy then delete, because the File
  // System Access API offers no move the app can rely on.
  private async relocate(path: string, toLogical: boolean): Promise<void> {
    const from = toLogical ? `${TRASH_DIR}/${path}` : path
    const to = toLogical ? path : `${TRASH_DIR}/${path}`
    const bytes = await readBytesAt(this.dir, from)
    if (bytes === null) throw new Error(`Entry payload is missing: ${path}`)
    await writeFileAt(this.dir, to, bytes)
    await removeFileAt(this.dir, from)
  }
}

function rowOf(entry: WorkspaceEntry, path?: string): ManifestEntry {
  const row: ManifestEntry = { path: path ?? '', kind: entry.kind, name: entry.name }
  if (entry.docKind !== undefined) row.docKind = entry.docKind
  if (entry.mime !== undefined) row.mime = entry.mime
  if (entry.fileKind !== undefined) row.fileKind = entry.fileKind
  return row
}

function metaOf(id: string, row: ManifestEntry): EntryMeta {
  const meta: EntryMeta = { id, path: row.path, kind: row.kind, name: row.name }
  if (row.docKind !== undefined) meta.docKind = row.docKind
  if (row.mime !== undefined) meta.mime = row.mime
  if (row.fileKind !== undefined) meta.fileKind = row.fileKind
  return meta
}

function entryOf(row: ManifestEntry, bytes: Uint8Array): WorkspaceEntry {
  const entry: WorkspaceEntry = { id: '', kind: row.kind, name: row.name }
  if (row.docKind !== undefined) entry.docKind = row.docKind
  if (row.mime !== undefined) entry.mime = row.mime
  if (row.fileKind !== undefined) entry.fileKind = row.fileKind
  if (row.kind === 'document') entry.text = decode(bytes)
  else entry.bytes = copyBytes(bytes)
  return entry
}

function contentOrThrow(entry: WorkspaceEntry): string | Uint8Array {
  if (entry.kind === 'document') {
    if (entry.text === undefined) throw new Error(`Document entry ${entry.id} has no text`)
    return entry.text
  }
  if (entry.bytes === undefined) throw new Error(`File entry ${entry.id} has no bytes`)
  return entry.bytes
}
