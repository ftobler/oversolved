import type { EntryContent, EntryKind, SerializedFile, WorkspaceTree } from './types'
import { MANIFEST_PATH } from './paths'
import { parseManifest, serializeManifest } from './manifest'
import { assertTree } from './tree'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// The manifest first, then one file per entry in ascending uuid order. The path
// comes from the manifest row, never re-derived, and payloads are verbatim.
export function serializeTree(tree: WorkspaceTree): SerializedFile[] {
  assertTree(tree)
  const files: SerializedFile[] = [{ path: MANIFEST_PATH, data: serializeManifest(tree.manifest) }]
  for (const id of Object.keys(tree.manifest.entries).sort()) {
    const row = tree.manifest.entries[id]
    const content = tree.contents.get(id)
    if (!content) throw new Error(`Entry ${id} has no content`)
    files.push({ path: row.path, data: serializeContent(content) })
  }
  return files
}

export function deserializeTree(files: SerializedFile[]): WorkspaceTree {
  const byPath = new Map<string, SerializedFile>()
  for (const file of files) {
    if (byPath.has(file.path)) throw new Error(`Duplicate file path: ${file.path}`)
    byPath.set(file.path, file)
  }
  const manifestFile = byPath.get(MANIFEST_PATH)
  if (!manifestFile) throw new Error(`Manifest file is missing: ${MANIFEST_PATH}`)
  const manifest = parseManifest(asText(manifestFile.data))
  const tree: WorkspaceTree = { manifest, contents: new Map() }
  for (const id of Object.keys(manifest.entries)) {
    const row = manifest.entries[id]
    const file = byPath.get(row.path)
    if (!file) throw new Error(`Entry ${id} file is missing: ${row.path}`)
    tree.contents.set(id, contentFor(row.kind, file.data))
  }
  assertTree(tree)
  return tree
}

function serializeContent(content: EntryContent): string | Uint8Array {
  if (content.text !== undefined) return content.text
  if (content.bytes !== undefined) return new Uint8Array(content.bytes)
  throw new Error('Entry content is empty')
}

function contentFor(kind: EntryKind, data: string | Uint8Array): EntryContent {
  if (kind === 'document') {
    return { text: typeof data === 'string' ? data : textDecoder.decode(data) }
  }
  return { bytes: typeof data === 'string' ? textEncoder.encode(data) : new Uint8Array(data) }
}

function asText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : textDecoder.decode(data)
}
