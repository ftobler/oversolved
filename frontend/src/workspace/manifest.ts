import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  ManifestEntry,
  ReferenceEdges,
  WorkspaceManifest,
} from './types'
import { DOCUMENTS_DIR, FILES_DIR, FORMAT_VERSION, isReservedPath } from './paths'
import { canonicalizeReferences } from './refs'

export function emptyManifest(workspace: string): WorkspaceManifest {
  return {
    format: FORMAT_VERSION,
    workspace,
    entries: {},
    references: {},
    trash: [],
  }
}

// The entries map rebuilt in its canonical order: keys sorted, optional fields
// omitted rather than written as null, and each row in fixed key order.
export function buildManifestIndex(entries: Record<string, ManifestEntry>): Record<string, ManifestEntry> {
  const index: Record<string, ManifestEntry> = {}
  for (const id of Object.keys(entries).sort()) {
    index[id] = canonicalEntry(entries[id])
  }
  return index
}

function canonicalEntry(entry: ManifestEntry): ManifestEntry {
  const out: ManifestEntry = { path: entry.path, kind: entry.kind, name: entry.name }
  if (entry.docKind !== undefined) out.docKind = entry.docKind
  if (entry.mime !== undefined) out.mime = entry.mime
  if (entry.fileKind !== undefined) out.fileKind = entry.fileKind
  return out
}

function canonicalStringList(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function canonicalizeManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  const out: WorkspaceManifest = {
    format: manifest.format,
    workspace: manifest.workspace,
    entries: buildManifestIndex(manifest.entries),
    references: canonicalizeReferences(manifest.references),
    trash: canonicalStringList(manifest.trash),
  }
  // Present only when set, after trash: a manifest written before the cover
  // existed serializes exactly the bytes it always did (D9).
  if (manifest.cover !== undefined) out.cover = manifest.cover
  return out
}

export function serializeManifest(manifest: WorkspaceManifest): string {
  assertManifest(manifest)
  // A fresh plain object in the fixed top-level key order, with every nested
  // map freshly built, so the library can emit neither reordering nor anchors.
  return stringifyYaml(canonicalizeManifest(manifest), {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: false,
    aliasDuplicateObjects: false,
  })
}

export function parseManifest(text: string): WorkspaceManifest {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new Error(`Manifest is not valid YAML: ${errorMessage(err)}`)
  }
  const manifest = coerceManifest(raw)
  assertManifest(manifest)
  // A choice naming an entry the archive does not carry is a stale reference,
  // not a broken manifest: a hand-edited zip must still import, so the key is
  // dropped and the workspace falls back to the automatic cover.
  if (manifest.cover !== undefined && manifest.entries[manifest.cover] === undefined) delete manifest.cover
  return canonicalizeManifest(manifest)
}

function coerceManifest(raw: unknown): WorkspaceManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Manifest is not a mapping')
  }
  const src = raw as Record<string, unknown>
  // A manifest written while imports kept an origin link carries a provenance
  // key. It is dropped, not validated: the origin link is gone (2026-11-16) and
  // an older library must still open.
  const manifest: WorkspaceManifest = {
    format: src.format as number,
    workspace: src.workspace as string,
    entries: (src.entries === undefined ? {} : src.entries) as Record<string, ManifestEntry>,
    references: (src.references === undefined ? {} : src.references) as ReferenceEdges,
    trash: (src.trash === undefined ? [] : src.trash) as string[],
  }
  // Left as written so assertManifest can refuse a non-string by name.
  if (src.cover !== undefined) manifest.cover = src.cover as string
  return manifest
}

export function assertManifest(manifest: WorkspaceManifest): void {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('Manifest must be an object')
  if (manifest.format !== FORMAT_VERSION) {
    throw new Error(`Unsupported manifest format: ${String(manifest.format)}`)
  }
  if (typeof manifest.workspace !== 'string' || manifest.workspace.length === 0) {
    throw new Error('Manifest workspace id must be a non-empty string')
  }
  assertEntryMap(manifest.entries)
  assertReferences(manifest.references)
  assertTrash(manifest.trash)
  assertCover(manifest.cover)
  assertNoInvalidScalars(manifest, 'manifest')
}

function assertEntryMap(entries: Record<string, ManifestEntry>): void {
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('Manifest entries must be a mapping')
  }
  // Path is display but must still be unique: two rows naming one file would
  // make deserialize read whichever landed last.
  const seenPaths = new Set<string>()
  for (const [id, row] of Object.entries(entries)) {
    if (id.length === 0) throw new Error('Manifest entry id must be non-empty')
    assertEntryRow(id, row)
    if (seenPaths.has(row.path)) throw new Error(`Duplicate entry path: ${row.path}`)
    seenPaths.add(row.path)
  }
}

function assertEntryRow(id: string, row: ManifestEntry): void {
  if (typeof row !== 'object' || row === null) throw new Error(`Entry ${id} must be an object`)
  const { path, kind, name, docKind, mime, fileKind } = row
  if (typeof path !== 'string' || path.length === 0) throw new Error(`Entry ${id} has no path`)
  if (!path.startsWith(`${DOCUMENTS_DIR}/`) && !path.startsWith(`${FILES_DIR}/`)) {
    throw new Error(`Entry ${id} path is outside documents/ and files/: ${path}`)
  }
  if (isReservedPath(path)) throw new Error(`Entry ${id} path is reserved: ${path}`)
  if (kind !== 'document' && kind !== 'file') {
    throw new Error(`Entry ${id} has an unknown kind: ${String(kind)}`)
  }
  if (typeof name !== 'string' || name.length === 0) throw new Error(`Entry ${id} has no name`)
  const payload = row as unknown as Record<string, unknown>
  if (payload.text !== undefined || payload.bytes !== undefined) {
    throw new Error(`Entry ${id} carries payload in the manifest`)
  }
  if (docKind !== undefined && typeof docKind !== 'string') {
    throw new Error(`Entry ${id} docKind must be a string`)
  }
  if (mime !== undefined && typeof mime !== 'string') {
    throw new Error(`Entry ${id} mime must be a string`)
  }
  if (fileKind !== undefined && typeof fileKind !== 'string') {
    throw new Error(`Entry ${id} fileKind must be a string`)
  }
  if (kind === 'document' && mime !== undefined) {
    throw new Error(`Document entry ${id} must not carry a mime`)
  }
  if (kind === 'document' && fileKind !== undefined) {
    throw new Error(`Document entry ${id} must not carry a fileKind`)
  }
  if (kind === 'file' && docKind !== undefined) {
    throw new Error(`File entry ${id} must not carry a docKind`)
  }
}

function assertReferences(references: ReferenceEdges): void {
  if (typeof references !== 'object' || references === null || Array.isArray(references)) {
    throw new Error('Manifest references must be a mapping')
  }
  for (const [from, targets] of Object.entries(references)) {
    if (from.length === 0) throw new Error('Reference source id must be non-empty')
    if (!Array.isArray(targets)) throw new Error(`References from ${from} must be an array`)
    for (const to of targets) {
      if (typeof to !== 'string') throw new Error(`Reference target from ${from} must be a string`)
    }
  }
}

function assertTrash(trash: string[]): void {
  if (!Array.isArray(trash)) throw new Error('Manifest trash must be an array')
  for (const id of trash) {
    if (typeof id !== 'string') throw new Error('Manifest trash must hold entry ids')
  }
}

// Whether the cover names a row is a parse-time question, not an invariant: a
// stale id is dropped rather than refused. Its shape still has to be an id.
function assertCover(cover: string | undefined): void {
  if (cover !== undefined && (typeof cover !== 'string' || cover.length === 0)) {
    throw new Error('Manifest cover must be a non-empty string')
  }
}

// The manifest has no floats: numbers are integers or ISO-8601 strings. This
// also rejects an explicit null or undefined anywhere in the value.
function assertNoInvalidScalars(value: unknown, where: string): void {
  if (value === null || value === undefined) throw new Error(`${where} contains a null or undefined value`)
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))) {
    throw new Error(`${where} contains a non-integer number: ${String(value)}`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoInvalidScalars(item, `${where}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoInvalidScalars(child, `${where}.${key}`)
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
