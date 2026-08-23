import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'

type Severity = 'success' | 'error' | 'info' | 'warning'

interface ToastState {
  open: boolean
  message: string
  severity: Severity
}

interface ToastContextValue {
  notify: (message: string, severity?: Severity) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ToastState>({
    open: false,
    message: '',
    severity: 'info',
  })

  const notify = useCallback((message: string, severity: Severity = 'info') => {
    setState({ open: true, message, severity })
  }, [])

  const handleClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') return
    setState(prev => ({ ...prev, open: false }))
  }

  // notify is already useCallback-stable; memoizing the value object too keeps its
  // identity stable across renders (e.g. snackbar open/close) that don't touch notify.
  const value = useMemo(() => ({ notify }), [notify])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        open={state.open}
        autoHideDuration={5000}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={handleClose}
          severity={state.severity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {state.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotify(): (message: string, severity?: Severity) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useNotify must be used inside ToastProvider')
  return ctx.notify
}
