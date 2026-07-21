import { useEffect, useRef, useState } from 'react'
import { useSolverStore } from '@/stores/solverStore'
import { Spinner } from '@/components/shared/Spinner'
import '@/components/dialogs/LoadingOverlay.css'

interface LoadingOverlayProps {
  isDocumentLoading?: boolean
}

const CANCEL_DELAY_MS = 5000

export default function LoadingOverlay({ isDocumentLoading = false }: LoadingOverlayProps) {
  const isSolving = useSolverStore(s => s.isSolving)
  const onCancelSolve = useSolverStore(s => s.onCancelSolve)
  const isVisible = isDocumentLoading || isSolving
  const [showCancel, setShowCancel] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isSolving && onCancelSolve) {
      timerRef.current = setTimeout(() => setShowCancel(true), CANCEL_DELAY_MS)
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setShowCancel(false)
    }
  }, [isSolving, onCancelSolve])

  const handleCancel = () => {
    onCancelSolve?.()
  }

  return (
    <div className={`loading-overlay${isVisible ? ' visible' : ''}`}>
      <div className="loading-overlay-content">
        <div className="md3-spinner-container">
          <div className="md3-spinner-rotator">
            <Spinner className="md3-spinner-svg" circleClassName="md3-spinner-path" />
          </div>
        </div>
        {showCancel && (
          <button className="loading-cancel-btn" onClick={handleCancel} type="button">
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
