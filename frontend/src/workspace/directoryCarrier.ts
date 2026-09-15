import type {
  EntryContent,
  ManifestEntry,
  WorkspaceManifest,
  WorkspaceTree,
} from './types'
import { MANIFEST_PATH, TRASH_DIR } from './paths'
import { parseManifest, serializeManifest } from './manifest'

// The folder endpoint: a whole tree out, a whole tree in. A folder is never a
// place a workspace lives (IndexedDB is the only one), so there is no entry to
// write into one, nothing to reconcile against and no fingerprint to compare --
// an export writes the canonical layout and an import reads it, and each is one
// gesture that leaves nothing bound behind it.
//
// The layout is the canonical one: the manifest file is the index, `documents/`
// and `files/` hold the payloads, and `.oversolved-trash/` holds a soft-deleted
// payload, exactly as serializeTree names them and the zip writes them.
//
// Atomicity is per file: `createWritable()` buffers into a swap file and only
// `close()` swings it into place, so an interrupted write leaves the previous
// contents. The write puts every payload down first and the manifest last, so a
// crash between them leaves the old manifest and the new payloads as orphans,
// never a half-named tree.

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
// trashed entry, whose payload sits under TRASH_DIR.
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
): Promise<void> {
  const handle = await ensureFileHandleAt(root, path)
  const writable = await handle.createWritable()
  try {
    await writable.write(data as unknown as FileSystemWriteChunkType)
  } catch (err) {
    await writable.abort?.().catch(() => undefined)
    throw err
  }
  await writable.close()
}

// A payload wherever it sits: the logical path, or the trash if the entry is
// soft-deleted. Reading both ways keeps a trashed entry's bytes travelling with
// the tree rather than vanishing on the way through a folder.
async function readPayloadAt(
  dir: FileSystemDirectoryHandle, row: ManifestEntry,
): Promise<Uint8Array | null> {
  return (await readBytesAt(dir, row.path)) ?? (await readBytesAt(dir, `${TRASH_DIR}/${row.path}`))
}

async function loadManifest(dir: FileSystemDirectoryHandle): Promise<WorkspaceManifest> {
  const text = await readTextAt(dir, MANIFEST_PATH)
  if (text === null) throw new Error(`Workspace manifest not found: ${MANIFEST_PATH}`)
  return parseManifest(text)
}

// A folder read whole. Every payload is materialized: this is one import
// gesture, not a working copy, so there is no later read to stay lazy for.
export async function readDirectoryTree(dir: FileSystemDirectoryHandle): Promise<WorkspaceTree> {
  const manifest = await loadManifest(dir)
  const contents = new Map<string, EntryContent>()
  for (const [id, row] of Object.entries(manifest.entries)) {
    const bytes = await readPayloadAt(dir, row)
    // A manifest-named entry with no payload is a gap to surface, not a blank
    // one: substituting an empty payload would import emptiness as content.
    if (bytes === null) throw new Error(`Entry payload is missing: ${row.path}`)
    contents.set(id, row.kind === 'document' ? { text: decode(bytes) } : { bytes })
  }
  return { manifest, contents }
}

// A tree written out: every payload first, the manifest last.
export async function writeDirectoryTree(dir: FileSystemDirectoryHandle, tree: WorkspaceTree): Promise<void> {
  const trashed = new Set(tree.manifest.trash)
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    const content = tree.contents.get(id)
    if (!content) throw new Error(`Entry ${id} has no content`)
    await writeFileAt(dir, physicalPath(row, trashed.has(id)), contentData(content))
  }
  await writeFileAt(dir, MANIFEST_PATH, serializeManifest(tree.manifest))
}
