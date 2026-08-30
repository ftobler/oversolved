import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { ToastProvider } from '@/contexts/ToastContext'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IndexedDbDocumentStore } from '@/stores/documentStore/IndexedDbDocumentStore'
import App from '@/App'

// Boot smoke test: the whole app, from the route table down, with nothing
// mocked but the router's history.
//
// It exists because every other suite mounts a page directly, so no test would
// notice the app failing to come up -- an unresolvable import in the provider
// stack, a route that no longer exists, or a page that needs a context nobody
// provides any more. Landing on /documents and seeing a stored document proves
// the browser-only path end to end: boot -> route -> IndexedDB -> rendered tile,
// with no network anywhere.
describe('app boot', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetDbConnection()
    localStorage.clear()
  })

  // StrictMode, like main.tsx: it double-invokes effects and setState updaters,
  // so a load effect that is not idempotent shows up here rather than in the
  // browser.
  function boot(path: string) {
    return render(
      <StrictMode>
        <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
          <ToastProvider>
            <MemoryRouter initialEntries={[path]}>
              <App />
            </MemoryRouter>
          </ToastProvider>
        </ThemeProvider>
      </StrictMode>,
    )
  }

  it('lands on the document library and lists what IndexedDB holds', async () => {
    await new IndexedDbDocumentStore().create('Bracket')

    boot('/documents')

    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
  })

  it('redirects the root path to the library', async () => {
    boot('/')
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument())
  })
})
