import React from 'react'
import type { PartFeature } from '@/types/cad'

interface RebuildTimingPopoverProps {
  featureTimings: Record<string, number>
  features: PartFeature[]
  isVisible: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export const RebuildTimingPopover: React.FC<RebuildTimingPopoverProps> = ({ featureTimings, features, isVisible, onMouseEnter, onMouseLeave }) => {
  if (!isVisible) return null

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const entries = features
    .filter(f => f.id in featureTimings)
    .map(f => ({ id: f.id, label: f.label ?? f.kind, ms: featureTimings[f.id] }))

  const totalMs = Object.values(featureTimings).reduce((sum, ms) => sum + ms, 0)

  if (entries.length === 0) return null

  return (
    <div className="rebuild-timing-popover" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="popover-header">
        <strong>Rebuild Times</strong>
      </div>
      <div className="popover-stats">
        {entries.map(e => (
          <div key={e.id} className="stat-row">
            <span className="label">{e.label}:</span>
            <span className="value">{formatMs(e.ms)}</span>
          </div>
        ))}
        <div className="stat-row total">
          <span className="label">Total:</span>
          <span className="value">{formatMs(totalMs)}</span>
        </div>
      </div>
    </div>
  )
}
