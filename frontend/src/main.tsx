import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
// The cube gizmo paints its face labels with `bold` (700) via canvas fillText.
// Without a declared 700 face the browser would synthesise bold from Medium,
// which smears at the gizmo's 10px. Self-hosted through the package, same as
// the others -- no external reference.
import '@fontsource/roboto/700.css'
import '@fontsource/roboto-mono/400.css'
import '@fontsource/material-icons/index.css'
import '@fontsource/material-icons-outlined/index.css'
import '@/index.css'
import App from '@/App'
import { initializeTools } from '@/tools'
import { preloadViewportLabelFont } from '@/components/Viewport/labelFont'
import { ToastProvider } from '@/contexts/ToastContext'
import { useStoragePersistenceStore } from '@/stores/storagePersistenceStore'
import { installGlobalErrorHandlers } from '@/recovery/globalErrors'
import { warmSolverWorker } from '@/kernel/worker/solverClient'
import { warmAnchorSolverWorker } from '@/kernel/worker/anchorSolverClient'

const theme = createTheme({
  palette: { mode: 'dark', background: { default: '#111' } },
})

initializeTools()
// Uncaught throws and unhandled rejections become local crash reports (stack,
// build, doc snapshot, mutation tail); the worker clients report their own
// traps the same way. Never removed: the app installs this for its lifetime.
installGlobalErrorHandlers()
// Read the storage grant, do not ask for it. Until it is granted the browser
// may evict the whole library under disk pressure, which is what the
// disclaimer's storage paragraph reports; asking can prompt, so that waits for
// the acknowledgement click.
useStoragePersistenceStore.getState().ensureChecked()
// Off the gesture on purpose: the first 3D label to mount would otherwise
// suspend the whole Canvas on the font fetch. See preloadViewportLabelFont.
preloadViewportLabelFont()
// Spawn both solver workers now: each starts its wasm load on spawn (OCC and
// the sketch solver in one, the mate solver in the other), so the kernel is
// compiled by the time the first document opens instead of after it.
warmSolverWorker()
warmAnchorSolverWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
)
