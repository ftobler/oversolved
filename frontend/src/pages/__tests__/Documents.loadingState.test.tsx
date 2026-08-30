import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { getLocalStore } from '@/stores/documentStore'
import type { DocSummary } from '@/stores/documentStore'
import { render, screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import Documents from '@/pages/Documents'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function wrap() {
  return render(
    <BrowserRouter>
      <Documents />
    </BrowserRouter>
  )
}

describe('Documents loading state', () => {
  it('keeps the spinner visible while the list fetch is pending, and clears it only once it settles', async () => {
    // A controllable promise standing in for the store's list() call: it lets the
    // test observe the component mid-flight, before the fetch resolves.
    let resolveList: (docs: DocSummary[]) => void = () => {}
    const pending = new Promise<DocSummary[]>(resolve => { resolveList = resolve })
    vi.spyOn(getLocalStore(), 'list').mockReturnValue(pending)

    wrap()

    // fetchDocuments is fire-and-forget: render() has already flushed the mount
    // effect by the time it returns, so this assertion is synchronous -- no
    // waitFor. On the old code, setLoading(true) and setLoading(false) both fire
    // in that same effect tick and React batches them into one net update, so
    // the spinner would already be gone here even though the fetch is still
    // pending; the fix keeps loading true until the fetch's own .then() runs.
    expect(screen.getByText('Loading documents...')).toBeInTheDocument()

    resolveList([])

    await waitForElementToBeRemoved(() => screen.queryByText('Loading documents...'))
    await waitFor(() => {
      expect(screen.getByText('No documents yet.')).toBeInTheDocument()
    })
  })
})
