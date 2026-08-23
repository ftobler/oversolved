import { useState, useRef, useCallback, useEffect } from 'react'
import rebuildIcon from '@/assets/icons/context-rebuild.svg'
import { RebuildTimingPopover } from '@/components/rebuild/RebuildTimingPopover'
import { formatMs } from '@/components/rebuild/formatMs'
import { Spinner } from '@/components/shared/Spinner'
import type { PartFeature, RebuildValidation } from '@/types/cad'

interface RebuildButtonProps {
  featureTimings: Record<string, number>
  features: PartFeature[]
  onClick: () => void
  isLoading?: boolean
  disabled?: boolean
  validation?: RebuildValidation | null
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

  // A hover-then-navigate-away can unmount within the pending hide window;
  // without this the timeout still fires and calls setState on an unmounted
  // component.
  useEffect(() => cancelHide, [cancelHide])

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
          <Spinner className="rebuild-spinner" />
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
