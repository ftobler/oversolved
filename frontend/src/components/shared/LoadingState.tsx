import { Spinner } from '@/components/shared/Spinner'
import '@/components/shared/LoadingState.css'

interface LoadingStateProps {
  label?: string
}

// The in-column wait indicator: a spinner and the verb being waited on. Every
// surface that would otherwise paint an empty or finished state over a pending
// fetch renders this instead, so wait is always visible and never reads as
// "nothing here" or "done".
export function LoadingState({ label = 'Loading...' }: LoadingStateProps) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-state-spinner">
        <Spinner className="loading-state-svg" circleClassName="loading-state-path" />
      </span>
      <span className="loading-state-label">{label}</span>
    </div>
  )
}
