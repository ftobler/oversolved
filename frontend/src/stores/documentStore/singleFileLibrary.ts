import { DOC_EXT } from './directoryLibrary'
import { openDirectoryLibrary } from './FileSystemDirectoryStore'
import { MemoryDirectory } from './memoryDirectory'

// "Open this one file, edit it, save it back" -- the degenerate case of the
// directory library, not a second implementation of anything.
//
// A single file-backed document has no library around it, so it does not fit
// the DocumentStore seam on its own; forcing it through would distort an
// interface (list / create / duplicate / trash) that the directory store was
// careful to satisfy honestly. What DOES fit is the other reading: a library
// that happens to contain exactly one document. Everything above this line
// (the store, the index reconciliation, the atomic per-file save) is then
// reused unchanged, and the seam keeps meaning what it meant.
//
// The one file is real. Its bookkeeping is not: the index, the preview and the
// trash live in memory, because writing sidecar files next to a document the
// user picked would litter a folder they never handed us. The consequence is
// that the document's uuid is fresh each session, which is the right trade --
// a route is a session-scoped thing and the FILE is the identity here.
//
// Operations that need a second file are refused rather than faked. Creating,
// duplicating or deleting a document inside a one-file library is not a
// storage limitation to work around, it is a request that does not mean
// anything; the Documents page hides those affordances for this library kind,
// and these errors are the backstop if one is ever reached another way.

const ONE_FILE_ONLY = 'This library is a single file. Open a folder to keep more than one document.'

// The bookkeeping directory: an index, a preview and a trash folder that exist
// for the store's sake and must never be written next to a document the user
// picked. Shared with the test double, so the store cannot lean on behaviour
// real Chromium does not have. See memoryDirectory.ts.

// The directory the single-file library runs on: exactly one real file, plus
// memory for everything else. `name` is the document's stem, so the sidebar
// entry reads as the document the user opened.
class SingleFileDirectory {
  readonly kind = 'directory' as const
  readonly name: string
  private readonly stem: string
  private readonly file: FileSystemFileHandle
  private readonly memory: MemoryDirectory

  constructor(stem: string, file: FileSystemFileHandle) {
    this.stem = stem
    this.name = stem
    // Presented under the canonical `<stem>.yaml` name whatever the real file
    // is called, so a picked Bracket.yml or BRACKET.YAML is still the one
    // document this directory contains. Writes land in the real file either
    // way: only the name this layer answers to is normalized.
    this.file = renamed(file, stem + DOC_EXT)
    this.memory = new MemoryDirectory(stem)
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FileSystemFileHandle> {
    if (name === this.stem + DOC_EXT) return this.file
    // A second document would need a second file, and there is no folder here
    // to put one in. Refusing on creation is what makes create/duplicate fail
    // loudly instead of writing a document that exists only until reload.
    if (name.endsWith(DOC_EXT) && opts.create) throw new Error(ONE_FILE_ONLY)
    return this.memory.getFileHandle(name, opts)
  }

  getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<MemoryDirectory> {
    return this.memory.getDirectoryHandle(name, opts)
  }

  async removeEntry(name: string): Promise<void> {
    // Deleting the document would mean deleting the user's file, and this
    // handle has no parent directory to delete it from. Their file manager is
    // the right place for that, not a trash view inside a one-file library.
    if (name === this.stem + DOC_EXT) throw new Error(ONE_FILE_ONLY)
    await this.memory.removeEntry(name)
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    yield this.file as unknown as FileSystemHandle
    yield* this.memory.values()
  }
}

function renamed(file: FileSystemFileHandle, name: string): FileSystemFileHandle {
  if (file.name === name) return file
  return {
    kind: 'file',
    name,
    getFile: () => file.getFile(),
    createWritable: (opts?: FileSystemCreateWritableOptions) => file.createWritable(opts),
  } as unknown as FileSystemFileHandle
}

// The document name a picked file gets: its own filename without the
// extension, because in a file-backed library the filename IS the name.
export function stemOf(fileName: string): string {
  return fileName.replace(/\.(yaml|yml)$/i, '') || fileName
}

export function openSingleFileLibrary(file: FileSystemFileHandle) {
  const stem = stemOf(file.name)
  const dir = new SingleFileDirectory(stem, file) as unknown as FileSystemDirectoryHandle
  return { ...openDirectoryLibrary(dir), label: stem }
}
