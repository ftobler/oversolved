import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'

type Severity = 'success' | 'error' | 'info' | 'warning'

interface ToastState {
  id: number
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
    id: 0,
    open: false,
    message: '',
    severity: 'info',
  })

  const notify = useCallback((message: string, severity: Severity = 'info') => {
    // A fresh id per notification keys the Snackbar remount below; MUI only arms
    // its auto-hide effect on mount, so bumping open/message alone would let a
    // back-to-back toast inherit the previous toast's leftover timer window.
    setState(prev => ({ id: prev.id + 1, open: true, message, severity }))
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
      {/* Remount per notification so each toast gets its own full auto-hide
          timer instead of the remainder of the previous one's window. */}
      <Snackbar
        key={state.id}
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

// eslint-disable-next-line react-refresh/only-export-components -- module also exports the notify hooks alongside the ToastProvider component
export function useNotify(): (message: string, severity?: Severity) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useNotify must be used inside ToastProvider')
  return ctx.notify
}

// Lenient variant for optional-feedback sites (pick-rejection toasts) that can
// render in test harnesses without a provider: no provider means no toast, and
// that must not crash the render. Production always sits under ToastProvider.
// The no-op fallback is module-stable so a provider-less caller's `notify`
// identity never churns a useMemo/effect dependency.
const noopNotify = () => undefined
// eslint-disable-next-line react-refresh/only-export-components -- the safe notify hook is a sibling of useNotify, same rule exemption
export function useNotifySafe(): (message: string, severity?: Severity) => void {
  const ctx = useContext(ToastContext)
  return ctx ? ctx.notify : noopNotify
}
