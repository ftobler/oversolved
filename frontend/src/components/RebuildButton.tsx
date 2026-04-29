import React, { useState, useEffect } from 'react'
import rebuildIcon from '../assets/icons/context-rebuild.svg'
import { useRebuildStats } from '../hooks/useRebuildStats'
import { RebuildTimingPopover } from './RebuildTimingPopover'

interface RebuildButtonProps {
  docId?: string
  onClick: () => void
  isLoading?: boolean
  disabled?: boolean
}

export const RebuildButton: React.FC<RebuildButtonProps> = ({ docId, onClick, isLoading, disabled }) => {
  const [isHovering, setIsHovering] = useState(false)
  const { stats, fetchStats } = useRebuildStats(docId)

  useEffect(() => {
    if (isHovering) {
      fetchStats()
    }
  }, [isHovering, fetchStats])

  return (
    <div
      className="rebuild-button-container"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <button
        className="rebuild-button"
        onClick={onClick}
        disabled={disabled || isLoading}
        title="Rebuild geometry (clears cache)"
        aria-label="Rebuild geometry"
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

      <RebuildTimingPopover stats={stats} isVisible={isHovering} />
    </div>
  )
}
