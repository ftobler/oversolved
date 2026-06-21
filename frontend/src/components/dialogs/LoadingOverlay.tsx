import { useSolverStore } from '@/stores/solverStore'
import { Spinner } from '@/components/shared/Spinner'
import '@/components/dialogs/LoadingOverlay.css'

interface LoadingOverlayProps {
  isDocumentLoading?: boolean
}

export default function LoadingOverlay({ isDocumentLoading = false }: LoadingOverlayProps) {
  const isSolving = useSolverStore(s => s.isSolving)
  const isVisible = isDocumentLoading || isSolving

  return (
    <div className={`loading-overlay${isVisible ? ' visible' : ''}`}>
      <div className="loading-overlay-content">
        <div className="md3-spinner-container">
          <div className="md3-spinner-rotator">
            <Spinner className="md3-spinner-svg" circleClassName="md3-spinner-path" />
          </div>
        </div>
      </div>
    </div>
  )
}
