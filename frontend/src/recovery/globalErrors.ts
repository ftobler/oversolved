// The app-level crash paths: window `error` events (uncaught throws in timers
// and event handlers, which a React boundary never sees) and
// `unhandledrejection`. Worker traps hook in at their own clients, because a
// worker error fires on the Worker object and never reaches the window.
//
// Each lands as a local crash report carrying whatever the registered editor
// holds at that moment, so the report can replay the failure without the user
// having to reproduce it first.
import { errorParts, recordCrashReport } from '@/recovery/crashReports'

// The window surface this binds. Structural so a test can pass a plain target;
// the real caller passes window.
export interface GlobalErrorTarget {
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export function installGlobalErrorHandlers(target: GlobalErrorTarget = window): () => void {
  const onError = (event: Event): void => {
    // A resource load failure (a 404 font, an image) also dispatches `error` at
    // the window. It carries neither a message nor a thrown value and is not a
    // crash, so it is left alone.
    const err = event as ErrorEvent
    if (!err.message && !err.error) return
    const parts = errorParts(err)
    void recordCrashReport({ source: 'error', message: parts.message, stack: parts.stack })
  }

  const onRejection = (event: Event): void => {
    const parts = errorParts((event as PromiseRejectionEvent).reason ?? event)
    void recordCrashReport({ source: 'rejection', message: parts.message, stack: parts.stack })
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
