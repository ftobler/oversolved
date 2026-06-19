import { useState, useRef, useCallback } from 'react'
import rebuildIcon from '@/assets/icons/context-rebuild.svg'
import { RebuildTimingPopover } from '@/components/rebuild/RebuildTimingPopover'
import type { PartFeature, RebuildValidation } from '@/types/cad'

interface RebuildButtonProps {
  featureTimings: Record<string, number>
  features: PartFeature[]
  onClick: () => void
  isLoading?: boolean
  disabled?: boolean
  validation?: RebuildValidation | null
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function RebuildButton({ featureTimings, features, onClick, isLoading, disabled, validation }: RebuildButtonProps) {
  const [isButtonHovered, setIsButtonHovered] = useState(false)
  const [isPopoverHovered, setIsPopoverHovered] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isVisible = isButtonHovered || isPopoverHovered
  const totalMs = Object.values(featureTimings).reduce((sum, ms) => sum + ms, 0)

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimerRef.current = setTimeout(() => {
      setIsButtonHovered(false)
      setIsPopoverHovered(false)
    }, 500)
  }, [cancelHide])

  return (
    <div className="rebuild-button-container">
      {totalMs > 0 && (
        <span className="rebuild-time-label">{formatMs(totalMs)}</span>
      )}
      <button
        className="rebuild-button"
        onClick={onClick}
        disabled={disabled || isLoading}
        title="Rebuild geometry (clears cache)"
        aria-label="Rebuild geometry"
        onMouseEnter={() => {
          cancelHide()
          setIsButtonHovered(true)
        }}
        onMouseLeave={scheduleHide}
      >
        {isLoading ? (
          <svg className="rebuild-spinner" viewBox="0 0 48 48">
            <circle
              cx="24"
              cy="24"
              r="18"
              fill="none"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <img src={rebuildIcon} alt="Rebuild" />
        )}
      </button>

      <RebuildTimingPopover
        featureTimings={featureTimings}
        features={features}
        isVisible={isVisible}
        validation={validation}
        onMouseEnter={() => {
          cancelHide()
          setIsPopoverHovered(true)
        }}
        onMouseLeave={scheduleHide}
      />
    </div>
  )
}
