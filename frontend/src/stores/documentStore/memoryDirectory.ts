// An in-memory File System Access directory: real handles, no disk.
//
// Two callers, on purpose. The single-file library uses it for the bookkeeping
// that must exist but must not be written next to a document the user picked
// (the index, the preview, the trash folder). The test double
// (__tests__/fakeFileSystemDirectory.ts) builds on it to run the whole
// directory store without a filesystem. Keeping one implementation is what
// makes the second of those a fair test of the first: a fake that was laxer
// than this would let the store lean on behaviour real Chromium does not have.
//
// Written to the spec's shape rather than to either caller's needs:
// `getFileHandle` rejects with a NotFoundError DOMException when the file is
// absent and `create` was not asked for, `createWritable` buffers and only
// commits on `close()`, `values()` is an async iterator, and a File reports the
// modification time of its last commit.

export function notFound(name: string): DOMException {
  return new DOMException(`A requested file or directory could not be found: ${name}`, 'NotFoundError')
}

// Wall-clock milliseconds are far too coarse to separate two writes, and the
// directory store's outside-edit detection keys on the modification time, so
// this stamps a strictly increasing counter instead of a clock.
let clock = 1_700_000_000_000

export function nextMtime(): number {
  return ++clock
}

export interface StoredFile {
  bytes: Uint8Array
  mtime: number
}

// The File a real getFile() hands back, minus the parts nothing reads.
// Constructed directly rather than as a Blob because jsdom's Blob implements
// neither text() nor arrayBuffer(), so a jsdom File would model the browser API
// LESS accurately than this does -- and would push a workaround into production
// code that a real browser never needs.
export function fileFrom(stored: StoredFile, name: string): File {
  const bytes = stored.bytes
  return {
    name,
    size: bytes.byteLength,
    type: '',
    lastModified: stored.mtime,
    async text() { return new TextDecoder().decode(bytes) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
  } as unknown as File
}

export async function toBytes(data: string | Blob | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(await data.arrayBuffer())
}

// The commit point is `close()` and only `close()`: that is what makes a
// document save atomic per file, and what a test interrupting a write relies on.
class MemoryWritable {
  private chunks: Uint8Array[] = []
  private done = false
  private readonly commit: (data: Uint8Array) => void

  constructor(commit: (data: Uint8Array) => void) {
    this.commit = commit
  }

  async write(data: string | Blob | Uint8Array | ArrayBuffer): Promise<void> {
    this.chunks.push(await toBytes(data))
  }

  async close(): Promise<void> {
    if (this.done) return
    this.done = true
    const merged = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const chunk of this.chunks) { merged.set(chunk, at); at += chunk.length }
    this.commit(merged)
  }

  // Discards the swap buffer: the previous contents stand.
  async abort(): Promise<void> {
    this.done = true
    this.chunks = []
  }
}

export class MemoryDirectory {
  readonly kind = 'directory' as const
  readonly name: string
  protected files = new Map<string, StoredFile>()
  protected dirs = new Map<string, MemoryDirectory>()

  constructor(name: string) {
    this.name = name
  }

  // Overridden by the test double to inject a write failure; the base is a
  // plain hook with nothing in it.
  protected beforeWrite(_name: string): void {}

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FileSystemFileHandle> {
    if (!this.files.has(name) && !opts.create) throw notFound(name)
    return {
      kind: 'file',
      name,
      getFile: async () => {
        const stored = this.files.get(name)
        if (!stored) throw notFound(name)
        return fileFrom(stored, name)
      },
      createWritable: async () => {
        this.beforeWrite(name)
        return new MemoryWritable(bytes => { this.files.set(name, { bytes, mtime: nextMtime() }) })
      },
    } as unknown as FileSystemFileHandle
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<MemoryDirectory> {
    const existing = this.dirs.get(name)
    if (existing) return existing
    if (!opts.create) throw notFound(name)
    const created = this.makeChild(name)
    this.dirs.set(name, created)
    return created
  }

  // So a subclass's subdirectories are subclasses too, and keep its hooks.
  protected makeChild(name: string): MemoryDirectory {
    return new MemoryDirectory(name)
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound(name)
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for (const name of [...this.files.keys()]) yield await this.getFileHandle(name)
    for (const dir of [...this.dirs.values()]) yield dir as unknown as FileSystemHandle
  }
}
