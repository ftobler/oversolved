// The storage seam: the one interface every document persistence call site
// routes through. Three implementations back it: IndexedDB (the browser's own
// storage, and the default), a folder the user picked through the File System
// Access API, and that folder's degenerate case, a single opened file. Which
// one is live is a user choice made in the documents sidebar; callers hold the
// forwarding pair from adapters/library.ts and never learn it changed.
//
// That is the point of keeping the interface rather than calling idb.ts
// directly. The contract suite runs this interface against every conformer, so
// an implementation cannot quietly drift from the others.
//
// Compute is not part of this seam: sketch solve, OCCT and STEP I/O all run in
// the browser via WASM, so persistence is the only thing a backend would ever
// have provided.

// Per-document modification tracking. Carried from day one so a future sync
// engine is purely additive: it reads `dirty` / compares `rev` vs `baseRev`,
// pushes, and on ack sets `baseRev = rev`. `rev` doubles as the assembly bundle
// cache key, so every store must bump it on save -- a store that pinned it
// would serve stale geometry after an edit.
export interface DocMeta {
  id: string
  rev: number          // monotonic local revision, bumped on every save
  updatedAt: number    // epoch ms, set on every save
  dirty: boolean       // local change not yet pushed to a sync target
  baseRev?: number     // last rev known synced (conflict detection)
}

// The lightweight document descriptor surfaced by `list()`: what the documents
// grid paints a tile from, plus the optional sync `meta` envelope so both the UI
// and a future sync engine can read tracking state without loading the payload.
export interface DocSummary {
  uuid: string
  name: string
  created_at: string
  updated_at: string
  // Record fields, not UI state: nothing renders these. `is_owner` is always
  // true and `owner_username` a fixed label -- the library belongs to the
  // browser holding it -- but a store keeps them because the exported bundle
  // format has a per-user directory level, and dropping them would make every
  // bundle written so far un-importable. `is_public` likewise: no view offers
  // it today, and the store still round-trips it so an older document does not
  // lose the flag by being opened.
  is_owner: boolean
  owner_username: string
  is_public: boolean
  // The document's open kind, so the editor can route and a picker can exclude
  // assemblies from a part list. It is the record's docKind, not a coerced
  // value: absent or unknown stays absent here and the reader refuses by name.
  kind?: string
  meta?: DocMeta
}

// The full document as round-tripped today: YAML/JSON text plus identity. No
// format migration in this seam -- `content` is exactly what the store holds.
export interface DocumentPayload {
  content: string
  name: string
  owner_username?: string
  is_public?: boolean
  // The record's open kind, as on DocSummary. DocumentPage interprets it with
  // the kinds gate, so an absent or unknown value refuses by name instead of
  // quietly reading as a part.
  kind?: string
}

// What a save carries: the document text. Previews are derived and now live in
// the preview store keyed by (workspace, entry), never on the record.
export interface SaveInput {
  content: string
}

// List filters, applied by the store over its own records.
export interface ListOptions {
  sort?: string
  filter?: string
  search?: string
}

export interface DocumentStore {
  list(opts?: ListOptions): Promise<DocSummary[]>
  load(id: string): Promise<DocumentPayload>
  save(id: string, input: SaveInput): Promise<void>
  remove(id: string): Promise<void>
  create(name: string, opts?: { is_public?: boolean }): Promise<{ uuid: string }>
  rename(id: string, name: string): Promise<void>
  duplicate(id: string): Promise<{ uuid: string }>
  // Copy a document under a fresh id, from the editor rather than the library
  // grid: `name` is what the user confirmed in the clone prompt, and omitting it
  // lets the store fall back to its own suggested name. Kept distinct from
  // `duplicate` (which always auto-names) because the two are different user
  // gestures, not because the storage differs.
  clone(id: string, name?: string): Promise<{ uuid: string }>
  // A URL the grid can point an <img> at for a thumbnail, or null when the
  // view reads the preview store itself. Kept on the seam so a store that does
  // serve thumbnails as resources can drop straight in.
  thumbnailUrl(id: string): string | null
}

// The recover/purge half of a store's soft delete. `remove()` above only
// tombstones a document; this is where the tombstoned records are listed,
// brought back, or destroyed for good. It is a separate port because the Trash
// view is the only screen that needs it -- every other caller works with live
// documents and should not be handed a purge().
export interface TrashDoc {
  uuid: string
  name: string
  deleted_at: string
  created_at: string
  owner_id: number
  owner_username: string
}

export interface TrashAdapter {
  list(): Promise<TrashDoc[]>
  recover(uuid: string): Promise<void>
  // Permanent delete from the trash (the soft-delete's hard end).
  purge(uuid: string): Promise<void>
}
