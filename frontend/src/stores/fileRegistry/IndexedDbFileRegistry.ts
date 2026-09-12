import type { FileEntry, FileInput, FileMeta, FileRegistry } from './types'
import { copyBytes, copyEntry, toFileMeta } from './types'
import { idbClearFiles, idbDeleteFile, idbGetAllFiles, idbGetFile, idbPutFile } from '@/stores/documentStore/idb'
import { randomUuid } from '@/utils/randomUuid'
import { bumpFileRegistryRevision } from './events'

// The IndexedDB half of the file registry, sharing the app's `oversolved`
// database (STORE_FILES). Ids are minted here and never change, so C2 can
// re-home each record into a workspace without any call site seeing a new id.
export class IndexedDbFileRegistry implements FileRegistry {
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
    await idbPutFile(entry)
    bumpFileRegistryRevision()
    return copyEntry(entry)
  }

  async put(entry: FileEntry): Promise<void> {
    await idbPutFile(entry)
    bumpFileRegistryRevision()
  }

  // A structural copy of the bytes, so a caller cannot mutate the stored buffer
  // through the returned record.
  async get(id: string): Promise<FileEntry | undefined> {
    const rec = await idbGetFile<FileEntry>(id)
    return rec ? copyEntry(rec) : undefined
  }

  async getBytes(id: string): Promise<Uint8Array | undefined> {
    const rec = await idbGetFile<FileEntry>(id)
    if (!rec) return undefined
    return copyBytes(rec.bytes)
  }

  async has(id: string): Promise<boolean> {
    return (await idbGetFile<FileEntry>(id)) !== undefined
  }

  async remove(id: string): Promise<void> {
    await idbDeleteFile(id)
    bumpFileRegistryRevision()
  }

  async list(): Promise<FileMeta[]> {
    const records = await idbGetAllFiles<FileEntry>()
    return records.map(toFileMeta).sort((a, b) => a.name.localeCompare(b.name))
  }

  async clear(): Promise<void> {
    await idbClearFiles()
    bumpFileRegistryRevision()
  }
}
