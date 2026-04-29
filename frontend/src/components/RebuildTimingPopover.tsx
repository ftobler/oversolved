import React from 'react'
import type { RebuildStats } from '../hooks/useRebuildStats'
import { RebuildSparkline } from './RebuildSparkline'

interface RebuildTimingPopoverProps {
  stats: RebuildStats | null
  isVisible: boolean
}

export const RebuildTimingPopover: React.FC<RebuildTimingPopoverProps> = ({ stats, isVisible }) => {
  if (!isVisible || !stats) return null

  const formatMs = (ms: number | null) => {
    if (ms === null) return '—'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const getTrendIcon = (trend: string | null) => {
    switch (trend) {
      case 'faster':
        return '↓ Faster'
      case 'slower':
        return '↑ Slower'
      case 'stable':
        return '→ Stable'
      default:
        return '?'
    }
  }

  return (
    <div className="rebuild-timing-popover">
      <div className="popover-header">
        <strong>Rebuild Times</strong>
      </div>

      <div className="popover-stats">
        <div className="stat-row">
          <span className="label">Last rebuild:</span>
          <span className="value">{formatMs(stats.last_duration_ms)}</span>
        </div>

        <div className="stat-row">
          <span className="label">Average:</span>
          <span className="value">{formatMs(stats.average_ms)}</span>
        </div>

        <div className="stat-row">
          <span className="label">Median:</span>
          <span className="value">{formatMs(stats.median_ms)}</span>
        </div>

        <div className="stat-row">
          <span className="label">Range:</span>
          <span className="value">
            {formatMs(stats.min_ms)}–{formatMs(stats.max_ms)}
          </span>
        </div>

        {stats.trend && (
          <div className="stat-row">
            <span className="label">Trend:</span>
            <span className={`value trend-${stats.trend}`}>
              {getTrendIcon(stats.trend)}
            </span>
          </div>
        )}

        <div className="stat-row">
          <span className="label">Samples:</span>
          <span className="value">{stats.rebuild_count}</span>
        </div>
      </div>

      {stats.history.length > 0 && (
        <>
          <div className="popover-divider" />
          <div className="popover-sparkline">
            <RebuildSparkline durations={stats.history.map(h => h.duration_ms)} />
          </div>
          <div className="sparkline-label">Last {stats.history.length} rebuilds</div>
        </>
      )}
    </div>
  )
}
