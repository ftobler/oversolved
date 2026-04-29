import React from 'react'
import rebuildIcon from '../assets/icons/context-rebuild.svg'

interface RebuildButtonProps {
  onClick: () => void
  isLoading?: boolean
  disabled?: boolean
}

export const RebuildButton: React.FC<RebuildButtonProps> = ({ onClick, isLoading, disabled }) => {
  return (
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
  )
}
