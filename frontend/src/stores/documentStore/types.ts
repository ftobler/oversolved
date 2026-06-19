// The storage adapter seam: the one interface that lets Oversolved run either
// HTTP-backed (Flask PDM) or fully local (IndexedDB, zero backend). Every
// document persistence call site routes through a `DocumentStore` so the
// backend choice is a single boot-time decision, not smeared across the app.
//
// The interactive compute (sketch solve, OCCT, STEP I/O) already lives in the
// browser via WASM, so going static is a storage problem, not a compute one.
// See feature plan: static-deploy-adapter.

// Per-document modification tracking. Carried from day one so a future cloud
// sync engine is purely additive: it reads `dirty` / compares `rev` vs
// `baseRev`, pushes, and on ack sets `baseRev = rev`. The IDB-only build
// maintains these fields; the HTTP build leaves them undefined (the server is
// the source of truth there).
export interface DocMeta {
  id: string
  rev: number          // monotonic local revision, bumped on every save
  updatedAt: number    // epoch ms, set on every save
  dirty: boolean       // local change not yet pushed to a server
  baseRev?: number     // last rev known synced to a server (conflict detection)
}

// The lightweight document descriptor surfaced by `list()`. Mirrors the shape
// the documents grid already consumes from `/api/documents`, plus the optional
// sync `meta` envelope so both the UI and a future engine can read tracking
// state without loading the payload.
export interface DocSummary {
  uuid: string
  name: string
  created_at: string
  updated_at: string
  is_owner: boolean
  owner_username: string
  is_public: boolean
  preview_image?: string  // base64 PNG, set by IDB store; HTTP store leaves it undefined
  meta?: DocMeta
}

// The full document as round-tripped today: YAML/JSON text plus identity. No
// format migration in this seam -- `content` is exactly what the server stores.
export interface DocumentPayload {
  content: string
  name: string
  owner_username?: string
  permission?: string
  is_public?: boolean
  preview_image?: string  // base64 PNG, no data: prefix (matches save body)
}

// What a save carries: the document text and an optional fresh preview.
export interface SaveInput {
  content: string
  preview_image?: string
}

// List filters. The HTTP store forwards these as query params (server-side
// sort/filter/search); a local store applies them in-memory.
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
  // A network URL the grid can point an <img> at for a thumbnail, or null when
  // the store has no server-rendered thumbnail (the local store inlines a
  // base64 preview_image on the summary instead). Keeps the view from hardcoding
  // an /api path it would otherwise reach past the adapter to build.
  thumbnailUrl(id: string): string | null
}
