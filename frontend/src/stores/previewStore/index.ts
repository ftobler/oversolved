import type { PreviewStore } from './types'
import { IndexedDbPreviewStore } from './IndexedDbPreviewStore'

export type { PreviewKey, PreviewRecord, PreviewStore } from './types'
export { previewKey } from './types'
export { MemoryPreviewStore } from './memoryPreviewStore'
export { IndexedDbPreviewStore, resetPreviewDbConnection } from './IndexedDbPreviewStore'
export { usePreview } from './usePreview'

// The one preview store, a lazy singleton so importing a type from this barrel
// never opens a database connection. Tests install a fresh fake IDB and reset
// the connection instead.
let instance: PreviewStore | null = null

export function getPreviewStore(): PreviewStore {
  if (!instance) instance = new IndexedDbPreviewStore()
  return instance
}
