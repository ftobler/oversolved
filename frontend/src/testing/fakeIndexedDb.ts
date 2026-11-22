import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

// Swap in a fresh in-memory IndexedDB so each test starts from an empty store.
// Importing this module also installs the fake-indexeddb global (auto import).
export function resetFakeIndexedDb(): void {
  globalThis.indexedDB = new IDBFactory()
}
