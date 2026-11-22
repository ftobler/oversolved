// A file registry record. `kind` is the app's open classification ('step'
// today, dwg/image later); `mime` is the wire type for a later download. `size`
// is denormalized so list rows never materialize the bytes.
export interface FileEntry {
  id: string
  name: string
  kind: string
  mime: string
  bytes: Uint8Array
  size: number
  createdAt: number
  updatedAt: number
}

export type FileMeta = Omit<FileEntry, 'bytes'>

export interface FileInput {
  name: string
  kind: string
  mime?: string
  bytes: Uint8Array
}

export interface FileRegistry {
  create(input: FileInput): Promise<FileEntry>  // mints the id
  put(entry: FileEntry): Promise<void>  // id supplied by the caller
  get(id: string): Promise<FileEntry | undefined>
  getBytes(id: string): Promise<Uint8Array | undefined>
  has(id: string): Promise<boolean>
  remove(id: string): Promise<void>
  list(): Promise<FileMeta[]>
  clear(): Promise<void>  // tests and the C2 workspace close
}

// Metadata without the bytes, the form list() and the feature row consume.
export function toFileMeta(entry: FileEntry): FileMeta {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    mime: entry.mime,
    size: entry.size,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

// A fresh buffer, so a caller can never alias the registry's stored bytes.
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

export function copyEntry(entry: FileEntry): FileEntry {
  return { ...entry, bytes: copyBytes(entry.bytes) }
}
