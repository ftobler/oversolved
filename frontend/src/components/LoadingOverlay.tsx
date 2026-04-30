import { useSolverStore } from '../stores/solverStore'
import './LoadingOverlay.css'

interface LoadingOverlayProps {
  isDocumentLoading?: boolean
}

export default function LoadingOverlay({ isDocumentLoading = false }: LoadingOverlayProps) {
  const isSolving = useSolverStore(s => s.isSolving)
  const isVisible = isDocumentLoading || isSolving
  const message = isDocumentLoading ? 'Loading document...' : isSolving ? 'Solving...' : ''

  return (
    <div className={`loading-overlay${isVisible ? ' visible' : ''}`}>
      <div className="loading-overlay-content">
        <div className="md3-spinner-container">
          <div className="md3-spinner-rotator">
            <svg className="md3-spinner-svg" viewBox="0 0 48 48">
              <circle
                className="md3-spinner-path"
                cx="24"
                cy="24"
                r="18"
                fill="none"
                strokeWidth="4"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
        {message && <p className="loading-message">{message}</p>}
      </div>
    </div>
  )
}
