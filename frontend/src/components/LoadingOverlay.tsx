import { useSolverStore } from '../stores/solverStore'
import './LoadingOverlay.css'

export default function LoadingOverlay() {
  const isSolving = useSolverStore(s => s.isSolving)

  return (
    <div className={`loading-overlay${isSolving ? ' visible' : ''}`}>
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
    </div>
  )
}
