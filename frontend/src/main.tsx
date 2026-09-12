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
import App from '@/App.tsx'
import { initializeTools } from '@/tools'
import { preloadViewportLabelFont } from '@/components/Viewport/labelFont'
import { ToastProvider } from '@/contexts/ToastContext'
import { useStoragePersistenceStore } from '@/stores/storagePersistenceStore'

const theme = createTheme({
  palette: { mode: 'dark', background: { default: '#111' } },
})

initializeTools()
// Read the storage grant, do not ask for it. Until it is granted the browser
// may evict the whole library under disk pressure, which is what the
// disclaimer's storage paragraph reports; asking can prompt, so that waits for
// the acknowledgement click.
useStoragePersistenceStore.getState().ensureChecked()
// Off the gesture on purpose: the first 3D label to mount would otherwise
// suspend the whole Canvas on the font fetch. See preloadViewportLabelFont.
preloadViewportLabelFont()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
)
