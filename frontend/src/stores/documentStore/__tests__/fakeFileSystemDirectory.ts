import { MemoryDirectory, nextMtime } from '../memoryDirectory'

// The directory handle the store tests run on: the production in-memory
// directory (memoryDirectory.ts, which the single-file library also uses) plus
// the three things a filesystem test needs and a real filesystem cannot give.
//
// Sharing the implementation is deliberate. A fake written separately drifts
// laxer than the API it stands for -- an absent file that resolves instead of
// throwing NotFoundError, a `write()` that lands without `close()` -- and the
// store then leans on behaviour real Chromium does not have.
export class FakeDirectoryHandle extends MemoryDirectory {
  // Set to a message to make the next createWritable throw, standing in for a
  // quota error or a permission revoked mid-save.
  failNextWrite: string | null = null

  protected override beforeWrite(_name: string): void {
    const failure = this.failNextWrite
    if (failure) {
      this.failNextWrite = null
      throw new Error(failure)
    }
  }

  protected override makeChild(name: string): MemoryDirectory {
    return new FakeDirectoryHandle(name)
  }

  // What is actually on disk, as text, one entry per file. Subdirectories are
  // prefixed with their name so a trashed document is distinguishable.
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    const decoder = new TextDecoder()
    for (const [name, stored] of this.files) out[name] = decoder.decode(stored.bytes)
    for (const [dirName, dir] of this.dirs) {
      const child = dir as FakeDirectoryHandle
      for (const [name, text] of Object.entries(child.snapshot())) out[`${dirName}/${name}`] = text
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
    this.files.set(name, { bytes: new TextEncoder().encode(text), mtime: nextMtime() })
  }

  // The other half of an outside edit: a tool that rewrote a file without
  // changing its length. Only the modification time moves.
  touch(name: string): void {
    const stored = this.files.get(name)
    if (stored) this.files.set(name, { ...stored, mtime: nextMtime() })
  }
}

// The store's constructor takes the DOM's FileSystemDirectoryHandle. The fake
// implements the subset that matters and nothing else, so the cast is asserted
// once here rather than at every call site.
export function fakeDirectory(name = 'library'): FakeDirectoryHandle & FileSystemDirectoryHandle {
  return new FakeDirectoryHandle(name) as unknown as FakeDirectoryHandle & FileSystemDirectoryHandle
}
