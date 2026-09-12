import JSZip from 'jszip'
import type { ListOptions, WorkspaceCarrier } from './carrier'
import type { EntryMeta, SerializedFile, WorkspaceEntry, WorkspaceTree } from './types'
import { MANIFEST_PATH } from './paths'
import { parseManifest } from './manifest'
import { fingerprintManifest } from './carrierFingerprint'
import { deserializeTree, serializeTree } from './serializer'
import {
  addEntry,
  assertTree,
  entryById,
  isTrashed,
  putEntry,
  removeEntry,
  restoreEntry,
} from './tree'
import { canonicalizeReferences } from './refs'
import { suggestedCloneName } from '@/stores/documentStore/cloneName'
import { randomUuid } from '@/utils/randomUuid'

// The archive conformer of WorkspaceCarrier, over bytes in memory plus an
// optional file handle for save-back. It writes exactly what DirectoryCarrier
// would write: the same serializeTree layout, so unzipping an archive into a
// folder and opening it through DirectoryCarrier yields a byte-identical tree.
//
// I4 pins every metadata field JSZip would otherwise fill from the clock or the
// platform: STORE compression, a fixed 1980-01-01 date, fixed permissions, a
// fixed insertion order (serializeTree's), no implicit directory entries, and
// no comment. Two saves of one tree are therefore byte-equal.
//
// I7 is the whole file: open reads every entry, and every mutation rewrites the
// archive in one generateAsync call. There is no partial zip on disk.

const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0))

interface FileOptions {
  compression: 'STORE'
  date: Date
  unixPermissions: number
  dosPermissions: number
  createFolders: boolean
  comment: string
}

const FILE_OPTS: FileOptions = {
  compression: 'STORE',
  date: FIXED_DATE,
  unixPermissions: 0o644,
  dosPermissions: 0,
  createFolders: false,
  comment: '',
}

// The raw archive the carrier writes. Pure over the tree, so it is testable
// without a handle and reusable as the export payload.
export async function buildZipBytes(tree: WorkspaceTree): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const file of serializeTree(tree)) zip.file(file.path, file.data, FILE_OPTS)
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'STORE',
    platform: 'DOS',
    streamFiles: false,
    comment: '',
    mimeType: 'application/zip',
  })
}

// Every entry of an archive, as serializeTree's shape, in the archive's order.
export async function readZipFiles(bytes: Uint8Array): Promise<SerializedFile[]> {
  const zip = await JSZip.loadAsync(bytes)
  const out: SerializedFile[] = []
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue
    out.push({ path: name, data: await zip.files[name].async('uint8array') })
  }
  return out
}

async function bytesFromBlob(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(await data.arrayBuffer())
}

export class ZipCarrier implements WorkspaceCarrier {
  private bytes: Uint8Array
  private readonly handle?: FileSystemFileHandle

  constructor(bytes: Uint8Array = new Uint8Array(0), handle?: FileSystemFileHandle) {
    this.bytes = bytes
    this.handle = handle
  }

  get blob(): Uint8Array {
    return new Uint8Array(this.bytes)
  }

  // Re-read the archive from the backing file, so a carrier-change check sees an
  // external edit rather than the bytes captured when the target was resolved.
  // A vanished or unreadable file leaves the held bytes in place and reports
  // false; the resolver reads that as an unavailable carrier.
  async refresh(): Promise<boolean> {
    if (!this.handle) return false
    try {
      this.bytes = new Uint8Array(await (await this.handle.getFile()).arrayBuffer())
      return true
    } catch {
      return false
    }
  }

  async open(): Promise<WorkspaceTree> {
    // A fresh deserialize per call, so an open tree can never alias carrier state.
    return deserializeTree(await readZipFiles(this.bytes))
  }

  // The carrier-change fingerprint, read from the archive's manifest entry
  // alone, so a large archive is not fully deserialized just to compare hashes.
  async readManifestFingerprint(): Promise<string | null> {
    try {
      const files = await readZipFiles(this.bytes)
      const manifest = files.find(file => file.path === MANIFEST_PATH)
      if (!manifest) return null
      const text = typeof manifest.data === 'string'
        ? manifest.data
        : new TextDecoder().decode(manifest.data)
      return await fingerprintManifest(parseManifest(text))
    } catch {
      return null
    }
  }

  async save(tree: WorkspaceTree): Promise<void> {
    await this.materialize(tree)
    assertTree(tree)
    this.bytes = await buildZipBytes(tree)
    await this.writeBack()
  }

  async list(options: ListOptions = {}): Promise<EntryMeta[]> {
    const tree = await this.open()
    const out: EntryMeta[] = []
    for (const id of Object.keys(tree.manifest.entries).sort()) {
      if (!options.includeTrashed && isTrashed(tree, id)) continue
      const row = tree.manifest.entries[id]
      const meta: EntryMeta = { id, path: row.path, kind: row.kind, name: row.name }
      if (row.docKind !== undefined) meta.docKind = row.docKind
      if (row.mime !== undefined) meta.mime = row.mime
      if (row.fileKind !== undefined) meta.fileKind = row.fileKind
      out.push(meta)
    }
    return out
  }

  async read(id: string): Promise<WorkspaceEntry> {
    const tree = await this.open()
    if (isTrashed(tree, id)) throw new Error(`Entry is trashed: ${id}`)
    return entryById(tree, id)
  }

  async readPayload(id: string): Promise<WorkspaceEntry> {
    return entryById(await this.open(), id)
  }

  async write(entry: WorkspaceEntry): Promise<void> {
    await this.mutate(tree => {
      if (!tree.manifest.entries[entry.id]) throw new Error(`Entry not found: ${entry.id}`)
      if (isTrashed(tree, entry.id)) throw new Error(`Entry is trashed: ${entry.id}`)
      const previous = entryById(tree, entry.id)
      const merged = entry.kind === 'file' && entry.bytes === undefined
        ? { ...entry, bytes: previous.bytes }
        : entry
      putEntry(tree, merged)
    })
  }

  async add(entry: WorkspaceEntry): Promise<void> {
    await this.mutate(tree => addEntry(tree, entry))
  }

  async remove(id: string): Promise<void> {
    await this.mutate(tree => removeEntry(tree, id))
  }

  async restore(id: string): Promise<void> {
    await this.mutate(tree => restoreEntry(tree, id))
  }

  async clone(id: string, name?: string): Promise<string> {
    const source = await this.read(id)
    const clone: WorkspaceEntry = {
      id: randomUuid(),
      kind: source.kind,
      name: name ?? suggestedCloneName(source.name),
    }
    if (source.docKind !== undefined) clone.docKind = source.docKind
    if (source.mime !== undefined) clone.mime = source.mime
    if (source.fileKind !== undefined) clone.fileKind = source.fileKind
    if (source.text !== undefined) clone.text = source.text
    if (source.bytes !== undefined) clone.bytes = new Uint8Array(source.bytes)
    await this.add(clone)
    return clone.id
  }

  // Accept arbitrary binary input (a File, a fetch body) as the archive.
  async load(data: Blob | ArrayBuffer | Uint8Array): Promise<void> {
    this.bytes = await bytesFromBlob(data)
  }

  private async mutate(job: (tree: WorkspaceTree) => void): Promise<void> {
    const tree = await this.open()
    job(tree)
    assertTree(tree)
    this.bytes = await buildZipBytes(tree)
    await this.writeBack()
  }

  // A lazy file payload an open tree omitted is carried over from the archive
  // being replaced, never dropped.
  private async materialize(tree: WorkspaceTree): Promise<void> {
    let current: WorkspaceTree | null = null
    for (const [id, row] of Object.entries(tree.manifest.entries)) {
      if (row.kind !== 'file' || tree.contents.has(id)) continue
      if (!current) current = await this.open()
      const content = current.contents.get(id)
      if (content) tree.contents.set(id, content)
    }
    tree.manifest.references = canonicalizeReferences(tree.manifest.references)
  }

  private async writeBack(): Promise<void> {
    if (!this.handle) return
    const writable = await this.handle.createWritable()
    try {
      await writable.write(this.bytes as unknown as FileSystemWriteChunkType)
    } catch (err) {
      await writable.abort?.().catch(() => undefined)
      throw err
    }
    await writable.close()
  }
}
