import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { render } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { resetPreviewDbConnection } from '@/stores/previewStore'
import { getWorkspaceStore, type WorkspaceStore } from '@/workspace/store'
import Workspaces from '@/pages/Workspaces'

// Shared setup for the U1 grid suites. The page reads the real workspace seam,
// so these run against the shipped persistence path rather than a mocked one --
// there is no network layer left to stub, and a fake store here would only test
// the fake.

// A clean IndexedDB per test so a prior test's workspaces do not leak in.
export function freshLocalDb() {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
  resetPreviewDbConnection()
}

// The singleton the page renders from, so a test seeds state the way the app
// would rather than by writing records by hand.
export function seedStore(): WorkspaceStore {
  return getWorkspaceStore()
}

export function renderWorkspaces() {
  return render(
    <BrowserRouter>
      <Workspaces />
    </BrowserRouter>
  )
}
