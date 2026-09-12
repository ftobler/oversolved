import type { FileRegistry } from './types'
import { IndexedDbFileRegistry } from './IndexedDbFileRegistry'

export type { FileEntry, FileMeta, FileInput, FileRegistry } from './types'
export { toFileMeta } from './types'
export { MemoryFileRegistry } from './memoryFileRegistry'
export { IndexedDbFileRegistry } from './IndexedDbFileRegistry'
export { fileIdsInSpec, fileIdsInParts, resolveFiles } from './resolve'
export { useFileMeta } from './useFileMeta'

// The one file registry: IndexedDB, scoped to the origin. A lazy singleton so
// importing a type from this barrel never opens a database connection; tests
// install a fresh fake IDB and reset the connection instead.
let instance: FileRegistry | null = null

export function getFileRegistry(): FileRegistry {
  if (!instance) instance = new IndexedDbFileRegistry()
  return instance
}
