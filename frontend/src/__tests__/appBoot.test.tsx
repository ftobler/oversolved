import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { ToastProvider } from '@/contexts/ToastContext'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { resetPreviewDbConnection } from '@/stores/previewStore'
import { getWorkspaceStore } from '@/workspace/store'
import App from '@/App'

// Boot smoke test: the whole app, from the route table down, with nothing
// mocked but the router's history.
//
// It exists because every other suite mounts a page directly, so no test would
// notice the app failing to come up -- an unresolvable import in the provider
// stack, a route that no longer exists, or a page that needs a context nobody
// provides any more. Landing on /workspaces and seeing a stored workspace proves
// the browser-only path end to end: boot -> route -> IndexedDB -> rendered tile,
// with no network anywhere.
describe('app boot', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetDbConnection()
    resetPreviewDbConnection()
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

  it('lands on the workspace library and lists what IndexedDB holds', async () => {
    await getWorkspaceStore().create('Bracket', { docKind: 'part' })

    boot('/workspaces')

    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
  })

  it('redirects the root path to the workspace library', async () => {
    boot('/')
    await waitFor(() => expect(screen.getByText('No workspaces yet.')).toBeInTheDocument())
  })
})
