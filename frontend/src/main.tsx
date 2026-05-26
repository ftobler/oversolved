import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto-mono/400.css'
import '@fontsource/material-icons/index.css'
import '@fontsource/material-icons-outlined/index.css'
import '@/index.css'
import App from '@/App.tsx'
import { initializeTools } from '@/tools'
import { ToastProvider } from '@/contexts/ToastContext'

const theme = createTheme({
  palette: { mode: 'dark', background: { default: '#111' } },
})

initializeTools()

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
