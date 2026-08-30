import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { render } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IndexedDbDocumentStore } from '@/stores/documentStore/IndexedDbDocumentStore'
import Documents from '@/pages/Documents'

// Shared setup for the Documents suites. The page reads the real IndexedDB store
// through the backend bundle, so these run against the shipped persistence path
// rather than a mocked one -- there is no network layer left to stub, and a fake
// store here would only test the fake.

// A clean IndexedDB per test so a prior test's documents do not leak in.
export function freshLocalDb() {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

// Seeds documents through the same store the page renders from, so a test sets
// up state the way the app would rather than by writing records by hand.
export function seedStore() {
  return new IndexedDbDocumentStore()
}

export function renderDocuments() {
  return render(
    <BrowserRouter>
      <Documents />
    </BrowserRouter>
  )
}
