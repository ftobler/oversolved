import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
import { resetDbConnection } from '@/stores/documentStore/idb'
import Documents from '@/pages/Documents'

// Shared setup for the Documents suites after the store-home inversion
// (doc-domain-move): home is the local IndexedDB library on BOTH builds, so every
// Documents render mounts on the local store first -- it needs a clean fake IDB.
// Sharing / public / trash / server-side search are cloud-domain concepts now and
// are only reachable by switching to the Cloud domain.

// A clean IndexedDB per test so a prior test's docs do not leak in.
export function freshLocalDb() {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

export function renderDocuments() {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <Documents />
      </AuthProvider>
    </BrowserRouter>
  )
}

// Switch to the Cloud domain. The Cloud section (with its "My Documents" entry)
// appears once the signed-in session resolves; clicking it picks the cloud domain.
// The cloud store is HTTP-backed, so the suites' fetch stubs back it.
export async function gotoCloudDomain() {
  const cloudDocs = await screen.findByText('My Documents')
  await act(async () => {
    fireEvent.click(cloudDocs)
  })
}
