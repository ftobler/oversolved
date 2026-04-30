import React, { useState, useRef, useCallback } from 'react'
import rebuildIcon from '../assets/icons/context-rebuild.svg'
import { RebuildTimingPopover } from './RebuildTimingPopover'
import type { PartFeature } from '../types/cad'

interface RebuildButtonProps {
  featureTimings: Record<string, number>
  features: PartFeature[]
  onClick: () => void
  isLoading?: boolean
  disabled?: boolean
}

export const RebuildButton: React.FC<RebuildButtonProps> = ({ featureTimings, features, onClick, isLoading, disabled }) => {
  const [isButtonHovered, setIsButtonHovered] = useState(false)
  const [isPopoverHovered, setIsPopoverHovered] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isVisible = isButtonHovered || isPopoverHovered

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
        onMouseEnter={() => {
          cancelHide()
          setIsPopoverHovered(true)
        }}
        onMouseLeave={scheduleHide}
      />
    </div>
  )
}
