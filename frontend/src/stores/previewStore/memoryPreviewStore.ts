import type { PreviewKey, PreviewRecord, PreviewStore } from './types'
import { previewKey } from './types'
import { bumpPreviewRevision } from './events'

// The contract suite's in-memory conformer. Not shipped, but a real store
// rather than a stub, so contract.test.ts pins the interface rather than
// IndexedDB's incidental behaviour.
export class MemoryPreviewStore implements PreviewStore {
  private readonly records = new Map<string, PreviewRecord>()

  async get(workspace: string, entry: string): Promise<string | undefined> {
    return this.records.get(previewKey(workspace, entry))?.image
  }

  async getMany(keys: PreviewKey[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const key of keys) {
      const record = this.records.get(previewKey(key.workspace, key.entry))
      if (record) out.set(previewKey(key.workspace, key.entry), record.image)
    }
    return out
  }

  async put(workspace: string, entry: string, image: string): Promise<void> {
    this.records.set(previewKey(workspace, entry), { workspace, entry, image, updatedAt: Date.now() })
    bumpPreviewRevision()
  }

  async remove(workspace: string, entry: string): Promise<void> {
    this.records.delete(previewKey(workspace, entry))
    bumpPreviewRevision()
  }

  async clearWorkspace(workspace: string): Promise<void> {
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(`${workspace}:`)) this.records.delete(key)
    }
    bumpPreviewRevision()
  }
}
