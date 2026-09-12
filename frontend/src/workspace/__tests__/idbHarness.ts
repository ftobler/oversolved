import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { resetPreviewDbConnection } from '@/stores/previewStore/IndexedDbPreviewStore'
import { replaceWorkspaceRows } from '../idbCarrier'
import type { WorkspaceTree } from '../types'

// A fresh in-memory IndexedDB and dropped connections, so each test starts from
// an empty `oversolved` and `oversolved-previews` database.
export function resetWorkspaceIdb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
  resetPreviewDbConnection()
}

// Give a workspace an empty meta row so a carrier can save into it. Mirrors what
// IdbWorkspaceStore.create writes before any content exists.
export async function seedWorkspace(tree: WorkspaceTree): Promise<void> {
  await replaceWorkspaceRows(tree.manifest.workspace, {
    workspace: tree.manifest.workspace,
    name: 'ws',
    createdAt: 0,
    updatedAt: 0,
    references: {},
    provenance: [],
    trash: [],
  }, [])
}
