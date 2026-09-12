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
  mime?: string  // open, files only, the wire type
  // The open app classification C1 registers ('step' today, dwg/image later).
  // Kept apart from `mime` so a files view can name the kind without guessing
  // it back out of a media type, and round-tripped like every other open string.
  fileKind?: string
}

// From uuid to referenced uuids. Sorted and deduplicated at every write.
export type ReferenceEdges = Record<string, string[]>

// Keyed on the local entry id and the source entry id, never on a path (a
// rename inside the source must not break the correlation). The origin entry id
// is what lets two separate import runs meet on the same source entry.
export interface ProvenanceRecord {
  entry: string  // local entry the copy landed as
  origin: string  // opaque origin locator, from the import gesture
  // The source entry's id, the re-import lookup key. A record read from a
  // pre-C6 manifest has none and is therefore not updatable.
  originEntry?: string
  // The import run that landed this copy, shared by every record of one
  // importBag call. Two copies of one source meet on this, so an update maps
  // the clicked copy's closure to its own locals and leaves the other alone.
  originGroup?: string
  // The source's display name (folder, archive or file). The locator is opaque
  // and per-gesture so two same-named sources stay distinct; this is the part a
  // user recognizes. Display only.
  originName?: string
  originWorkspace?: string  // source workspace id, when the bag carried one
  rev?: number  // source rev, when the source tracks one
  hash?: string  // source content hash at copy time, never the local copy's
  copiedAt?: number  // epoch ms of the last copy or update, display only
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
  fileKind?: string
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
  fileKind?: string
  // Working-copy revision and last-edit time, surfaced by carriers that keep
  // them (IdbCarrier). Optional so MemoryCarrier and the C0 tests stay valid.
  rev?: number
  updatedAt?: number
  // The serialized payload bytes (R1): derived at write time, never serialized.
  // Lets U1 and U3 report size without materializing a payload.
  size?: number
  // sha256 of the payload (C5), the bundle cache's invalidation signal. Optional
  // only for a carrier that does not track it (the in-memory tree).
  contentHash?: string
}
