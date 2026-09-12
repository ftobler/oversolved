import type {
  EntryContent,
  ManifestEntry,
  WorkspaceEntry,
  WorkspaceManifest,
  WorkspaceTree,
} from './types'
import { assertPathFree, dirOf, pathFor } from './paths'
import { assertManifest } from './manifest'

export function createTree(manifest: WorkspaceManifest): WorkspaceTree {
  assertManifest(manifest)
  // Contents are loaded per entry, not fabricated, so a populated manifest
  // would produce a tree that immediately fails assertTree. Refuse it instead.
  if (Object.keys(manifest.entries).length > 0) {
    throw new Error('createTree expects an empty manifest; use deserializeTree or putEntry')
  }
  return { manifest: cloneManifest(manifest), contents: new Map() }
}

export function cloneTree(tree: WorkspaceTree): WorkspaceTree {
  const contents = new Map<string, EntryContent>()
  for (const [id, content] of tree.contents) {
    contents.set(id, content.bytes !== undefined
      ? { bytes: new Uint8Array(content.bytes) }
      : { text: content.text })
  }
  return { manifest: cloneManifest(tree.manifest), contents }
}

function cloneManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    format: manifest.format,
    workspace: manifest.workspace,
    entries: Object.fromEntries(
      Object.entries(manifest.entries).map(([id, row]) => [id, { ...row }]),
    ),
    references: Object.fromEntries(
      Object.entries(manifest.references).map(([from, targets]) => [from, [...targets]]),
    ),
    provenance: manifest.provenance.map(record => ({ ...record })),
    trash: [...manifest.trash],
  }
}

// The aggregate for one entry: the manifest row plus its payload. Bytes are
// copied out so a caller cannot alias the tree's own content.
export function entryById(tree: WorkspaceTree, id: string): WorkspaceEntry {
  const row = requireRow(tree, id)
  const content = requireContent(tree, id)
  const entry: WorkspaceEntry = { id, kind: row.kind, name: row.name }
  if (row.docKind !== undefined) entry.docKind = row.docKind
  if (row.mime !== undefined) entry.mime = row.mime
  if (content.text !== undefined) entry.text = content.text
  if (content.bytes !== undefined) entry.bytes = new Uint8Array(content.bytes)
  return entry
}

// Writes both halves in one call so manifest and content cannot drift. An
// existing id keeps its path: path is display and only rename/move change it.
export function putEntry(tree: WorkspaceTree, entry: WorkspaceEntry): void {
  // Validate the payload before touching either half, so a malformed entry
  // cannot leave manifest and content drifted apart.
  const content = contentForEntry(entry)
  const existing = tree.manifest.entries[entry.id]
  const path = existing
    ? existing.path
    : pathFor(entry.kind, entry.name, candidate => hasPath(tree, candidate))
  const row: ManifestEntry = { path, kind: entry.kind, name: entry.name }
  if (entry.docKind !== undefined) row.docKind = entry.docKind
  if (entry.mime !== undefined) row.mime = entry.mime
  tree.manifest.entries[entry.id] = row
  tree.contents.set(entry.id, content)
}

function contentForEntry(entry: WorkspaceEntry): EntryContent {
  if (entry.kind === 'document') {
    if (entry.text === undefined) throw new Error(`Document entry ${entry.id} has no text`)
    return { text: entry.text }
  }
  if (entry.bytes === undefined) throw new Error(`File entry ${entry.id} has no bytes`)
  return { bytes: new Uint8Array(entry.bytes) }
}

export function addEntry(tree: WorkspaceTree, entry: WorkspaceEntry): void {
  if (tree.manifest.entries[entry.id]) throw new Error(`Entry already exists: ${entry.id}`)
  const path = pathFor(entry.kind, entry.name, candidate => hasPath(tree, candidate))
  // The derived path is the identity; the raw name was sanitized into it.
  assertPathFree(path, candidate => hasPath(tree, candidate))
  putEntry(tree, entry)
}

// Soft delete: metadata, path and content stay; the id only leaves list and
// solve. The manifest trash list stays authoritative for identity (C3 owns any
// physical relocation).
export function removeEntry(tree: WorkspaceTree, id: string): void {
  requireRow(tree, id)
  if (!tree.manifest.trash.includes(id)) tree.manifest.trash.push(id)
}

export function restoreEntry(tree: WorkspaceTree, id: string): void {
  requireRow(tree, id)
  tree.manifest.trash = tree.manifest.trash.filter(trashed => trashed !== id)
}

export function isTrashed(tree: WorkspaceTree, id: string): boolean {
  return tree.manifest.trash.includes(id)
}

// Rename recomputes the path in the entry's current directory; move only sets
// the path. Neither touches references, because references are uuid keyed (I3).
export function renameEntry(tree: WorkspaceTree, id: string, name: string): void {
  const row = requireRow(tree, id)
  const path = pathFor(row.kind, name, candidate => hasPath(tree, candidate, id), dirOf(row.path))
  assertPathFree(path, candidate => hasPath(tree, candidate, id))
  row.path = path
  row.name = name
}

export function moveEntry(tree: WorkspaceTree, id: string, path: string): void {
  const row = requireRow(tree, id)
  assertPathFree(path, candidate => hasPath(tree, candidate, id))
  row.path = path
}

export function assertTree(tree: WorkspaceTree): void {
  assertManifest(tree.manifest)
  for (const id of Object.keys(tree.manifest.entries)) {
    if (!tree.contents.has(id)) throw new Error(`Entry ${id} has no content`)
  }
  for (const id of tree.contents.keys()) {
    if (!(id in tree.manifest.entries)) throw new Error(`Content entry ${id} has no manifest row`)
  }
  for (const [id, content] of tree.contents) {
    const kind = tree.manifest.entries[id].kind
    const hasText = content.text !== undefined
    const hasBytes = content.bytes !== undefined
    // The payload half must match the manifest's kind, not merely be one of the
    // two: otherwise a serialize/deserialize/reserialize cycle could swap the
    // payload type and break I4.
    if (kind === 'document') {
      if (!hasText || hasBytes) throw new Error(`Document entry ${id} must carry text and no bytes`)
      if (typeof content.text !== 'string') throw new Error(`Entry ${id} text must be a string`)
    } else {
      if (!hasBytes || hasText) throw new Error(`File entry ${id} must carry bytes and no text`)
      if (!(content.bytes instanceof Uint8Array)) throw new Error(`Entry ${id} bytes must be a Uint8Array`)
    }
  }
}

function requireRow(tree: WorkspaceTree, id: string): ManifestEntry {
  const row = tree.manifest.entries[id]
  if (!row) throw new Error(`Entry not found: ${id}`)
  return row
}

function requireContent(tree: WorkspaceTree, id: string): EntryContent {
  const content = tree.contents.get(id)
  if (!content) throw new Error(`Entry content not found: ${id}`)
  return content
}

function hasPath(tree: WorkspaceTree, path: string, exceptId?: string): boolean {
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (id === exceptId) continue
    if (row.path === path) return true
  }
  return false
}
