import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto-mono/400.css'
import '@fontsource/material-icons/index.css'
import '@fontsource/material-icons-outlined/index.css'
import './index.css'
import App from './App.tsx'
import { initializeTools } from './tools'
import './utils/apiFetch'

initializeTools()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
