import type { FileEntry, FileInput, FileMeta, FileRegistry } from './types'
import { copyBytes, copyEntry, toFileMeta } from './types'
import { randomUuid } from '@/utils/randomUuid'
import { bumpFileRegistryRevision } from './events'

// The contract suite's in-memory conformer, written to the interface rather
// than ported from the IndexedDB store. Not shipped (it is imported by tests
// and by a test that only needs files to exist somewhere), but a real store
// rather than a stub, so it keeps contract.test.ts a contract.
export class MemoryFileRegistry implements FileRegistry {
  private entries = new Map<string, FileEntry>()

  async create(input: FileInput): Promise<FileEntry> {
    const now = Date.now()
    const entry: FileEntry = {
      id: randomUuid(),
      name: input.name,
      kind: input.kind,
      mime: input.mime ?? '',
      bytes: copyBytes(input.bytes),
      size: input.bytes.byteLength,
      createdAt: now,
      updatedAt: now,
    }
    this.entries.set(entry.id, entry)
    bumpFileRegistryRevision()
    return copyEntry(entry)
  }

  async put(entry: FileEntry): Promise<void> {
    this.entries.set(entry.id, copyEntry(entry))
    bumpFileRegistryRevision()
  }

  async get(id: string): Promise<FileEntry | undefined> {
    const rec = this.entries.get(id)
    return rec ? copyEntry(rec) : undefined
  }

  async getBytes(id: string): Promise<Uint8Array | undefined> {
    const rec = this.entries.get(id)
    return rec ? copyBytes(rec.bytes) : undefined
  }

  async has(id: string): Promise<boolean> {
    return this.entries.has(id)
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id)
    bumpFileRegistryRevision()
  }

  async list(): Promise<FileMeta[]> {
    return [...this.entries.values()].map(toFileMeta).sort((a, b) => a.name.localeCompare(b.name))
  }

  async clear(): Promise<void> {
    this.entries.clear()
    bumpFileRegistryRevision()
  }
}
