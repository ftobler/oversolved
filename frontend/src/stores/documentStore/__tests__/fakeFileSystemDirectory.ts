// An in-memory File System Access API, enough of it to run a real
// DocumentStore against.
//
// jsdom implements none of this API, and the pickers are Chromium-only anyway,
// so there is nothing to stub out of the environment -- the store takes a
// directory handle as a constructor argument precisely so a test can hand it
// one of these. Written to the spec's shape rather than to the store's needs:
// `getFileHandle` rejects with a NotFoundError DOMException when the file is
// absent and `create` was not asked for, `createWritable` buffers and only
// commits on `close()`, `values()` is an async iterator. A store that leaned on
// a laxer fake would break on real Chromium.
//
// It also exposes the two things a filesystem test needs and a real one cannot
// give: `snapshot()` to assert on the bytes actually on disk, and
// `failNextWrite` / interrupted writables to prove the atomicity claim.

function notFound(name: string): DOMException {
  return new DOMException(`A requested file or directory could not be found: ${name}`, 'NotFoundError')
}

// Wall-clock milliseconds are far too coarse to separate two writes in a test,
// and the store's outside-edit detection keys on the modification time, so the
// fake stamps a strictly increasing counter instead of a clock.
let clock = 1_700_000_000_000

function tick(): number {
  return ++clock
}

interface StoredFile {
  bytes: Uint8Array
  mtime: number
}

class FakeWritable {
  private chunks: Uint8Array[] = []
  private done = false
  private readonly commit: (data: Uint8Array) => void

  constructor(commit: (data: Uint8Array) => void) {
    this.commit = commit
  }

  async write(data: string | Blob | Uint8Array | ArrayBuffer): Promise<void> {
    this.chunks.push(await toBytes(data))
  }

  // The commit point. Everything written so far becomes the file's contents
  // here and only here, which is what makes a save atomic per file.
  async close(): Promise<void> {
    if (this.done) return
    this.done = true
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Uint8Array(total)
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

async function toBytes(data: string | Blob | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(await data.arrayBuffer())
}

// The File a real getFile() hands back, minus the parts nothing reads. jsdom's
// own Blob implements NEITHER text() nor arrayBuffer() (and is not a BodyInit
// undici's Response recognises either), so constructing a jsdom File here would
// model the browser API less accurately than this object does -- and would
// quietly push a Response-shaped workaround into production code that a real
// browser never needs.
function fakeFile(entry: StoredFile, name: string): File {
  const bytes = entry.bytes
  return {
    name,
    size: bytes.byteLength,
    type: '',
    lastModified: entry.mtime,
    async text() { return new TextDecoder().decode(bytes) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
  } as unknown as File
}

class FakeFileHandle {
  readonly kind = 'file' as const
  readonly name: string
  private readonly read: () => StoredFile | undefined
  private readonly write: (data: Uint8Array) => void
  private readonly guard: () => void

  constructor(
    name: string,
    read: () => StoredFile | undefined,
    write: (data: Uint8Array) => void,
    guard: () => void,
  ) {
    this.name = name
    this.read = read
    this.write = write
    this.guard = guard
  }

  async getFile(): Promise<File> {
    const stored = this.read()
    if (!stored) throw notFound(this.name)
    return fakeFile(stored, this.name)
  }

  async createWritable(): Promise<FakeWritable> {
    this.guard()
    return new FakeWritable(data => this.write(data))
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const
  private files = new Map<string, StoredFile>()
  private dirs = new Map<string, FakeDirectoryHandle>()
  // Set to a message to make the next createWritable throw, standing in for a
  // quota error or a revoked permission mid-save.
  failNextWrite: string | null = null

  readonly name: string

  constructor(name: string = 'library') {
    this.name = name
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFileHandle> {
    if (!this.files.has(name) && !opts.create) throw notFound(name)
    return new FakeFileHandle(
      name,
      () => this.files.get(name),
      data => { this.files.set(name, { bytes: data, mtime: tick() }) },
      () => {
        const failure = this.failNextWrite
        if (failure) {
          this.failNextWrite = null
          throw new Error(failure)
        }
      },
    )
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDirectoryHandle> {
    const existing = this.dirs.get(name)
    if (existing) return existing
    if (!opts.create) throw notFound(name)
    const created = new FakeDirectoryHandle(name)
    this.dirs.set(name, created)
    return created
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound(name)
  }

  async *values(): AsyncIterableIterator<FakeFileHandle | FakeDirectoryHandle> {
    for (const name of [...this.files.keys()]) yield await this.getFileHandle(name)
    for (const dir of [...this.dirs.values()]) yield dir
  }

  // ─── test-only inspection ───

  // What is actually on disk, as text, one entry per file. Subdirectories are
  // prefixed with their name so a trashed document is distinguishable.
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    const decoder = new TextDecoder()
    for (const [name, stored] of this.files) out[name] = decoder.decode(stored.bytes)
    for (const [dirName, dir] of this.dirs) {
      for (const [name, text] of Object.entries(dir.snapshot())) out[`${dirName}/${name}`] = text
    }
    return out
  }

  fileNames(): string[] {
    return [...this.files.keys()].sort()
  }

  dirNames(): string[] {
    return [...this.dirs.keys()].sort()
  }

  // Seeds a file the way an external tool would: a git checkout, another
  // editor, a Dropbox sync.
  putText(name: string, text: string): void {
    this.files.set(name, { bytes: new TextEncoder().encode(text), mtime: tick() })
  }

  // The other half of an outside edit: a tool that rewrote a file without
  // changing its length. Only the modification time moves.
  touch(name: string): void {
    const stored = this.files.get(name)
    if (stored) this.files.set(name, { ...stored, mtime: tick() })
  }
}

// The store's constructor takes the DOM's FileSystemDirectoryHandle. The fake
// implements the subset that matters and nothing else, so the cast is asserted
// once here rather than at every call site.
export function fakeDirectory(name = 'library'): FakeDirectoryHandle & FileSystemDirectoryHandle {
  return new FakeDirectoryHandle(name) as unknown as FakeDirectoryHandle & FileSystemDirectoryHandle
}
