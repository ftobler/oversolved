// The closed structural union. An entry is a document (text) or a file
// (bytes). There is no third thing, and that is what keeps a preview, mesh,
// bundle or cache from ever being a legal entry (I5).
export type EntryKind = 'document' | 'file'

export interface EntryContent {
  text?: string  // documents only
  bytes?: Uint8Array  // files only
}

// One manifest index row. This is what list() reads, so it carries every field
// a list/tree/picker needs without opening content (A5).
export interface ManifestEntry {
  path: string  // reserved-dir-relative, e.g. documents/Bracket.yaml
  kind: EntryKind  // closed
  name: string  // display name; may differ from the path stem
  docKind?: string  // open, documents only
  mime?: string  // open, files only
}

// From uuid to referenced uuids. Sorted and deduplicated at every write.
export type ReferenceEdges = Record<string, string[]>

// Minimal at C0; C6 fills origin/rev/hash. Keyed on the local entry id and an
// opaque origin descriptor, never on a path (a rename must not break it).
export interface ProvenanceRecord {
  entry: string  // local entry the copy landed as
  origin: string  // opaque origin descriptor, from the import gesture
  rev?: number  // source rev, C6
  hash?: string  // source content hash, C6
}

export interface WorkspaceManifest {
  format: number  // FORMAT_VERSION, currently 1
  workspace: string  // workspace uuid, re-minted on adoption
  entries: Record<string, ManifestEntry>
  references: ReferenceEdges
  provenance: ProvenanceRecord[]
  trash: string[]  // entry ids, soft-deleted, serialized
}

// The aggregate view callers use. entryById composes it from the manifest row
// plus content; putEntry splits it back. The tree stores the two halves, not
// this shape, so there is one source of truth per half.
export interface WorkspaceEntry {
  id: string
  kind: EntryKind
  name: string
  docKind?: string
  mime?: string
  text?: string
  bytes?: Uint8Array
}

export interface WorkspaceTree {
  manifest: WorkspaceManifest
  contents: Map<string, EntryContent>
}

// One file of the canonical tree, as a file/folder/zip carrier would write it.
export interface SerializedFile {
  path: string
  data: string | Uint8Array
}

export interface EntryMeta {
  id: string
  path: string
  kind: EntryKind
  name: string
  docKind?: string
  mime?: string
}
