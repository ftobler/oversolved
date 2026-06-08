import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import rebuildIcon from '@/assets/icons/context-rebuild.svg'
import { RebuildTimingPopover } from '@/components/RebuildTimingPopover'
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
  const buttonRef = useRef<HTMLButtonElement>(null)
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

  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({})

  const updatePopoverPos = useCallback(() => {
    const el = buttonRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPopoverStyle({
      position: 'fixed',
      top: rect.bottom + 8,
      right: document.documentElement.clientWidth - rect.right + 8,
      zIndex: 1000,
    })
  }, [])

  return (
    <div className="rebuild-button-container">
      <button
        ref={buttonRef}
        className="rebuild-button"
        onClick={onClick}
        disabled={disabled || isLoading}
        title="Rebuild geometry (clears cache)"
        aria-label="Rebuild geometry"
        onMouseEnter={() => {
          cancelHide()
          setIsButtonHovered(true)
          updatePopoverPos()
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

      {isVisible && createPortal(
        <RebuildTimingPopover
          featureTimings={featureTimings}
          features={features}
          isVisible={true}
          validation={validation}
          style={popoverStyle}
          onMouseEnter={() => {
            cancelHide()
            setIsPopoverHovered(true)
          }}
          onMouseLeave={scheduleHide}
        />,
        document.body,
      )}
    </div>
  )
}
