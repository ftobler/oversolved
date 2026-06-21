import type { PartFeature, RebuildValidation } from '@/types/cad'
import { formatMs } from '@/components/rebuild/formatMs'

interface RebuildTimingPopoverProps {
  featureTimings: Record<string, number>
  features: PartFeature[]
  isVisible: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  validation?: RebuildValidation | null
}

function validationBadge(v: RebuildValidation) {
  if (v.passed) {
    return { color: '#2e7d32', symbol: '✓', label: 'rebuild matches', kind: 'green' as const }
  }
  if (v.fp_only) {
    return { color: '#f9a825', symbol: '⚠', label: `L${v.level} FP drift only`, kind: 'yellow' as const }
  }
  return { color: '#c62828', symbol: '✕', label: `L${v.level} structural mismatch`, kind: 'red' as const }
}

export function RebuildTimingPopover({ featureTimings, features, isVisible, onMouseEnter, onMouseLeave, validation }: RebuildTimingPopoverProps) {
  if (!isVisible) return null

  const entries = features
    .filter(f => f.id in featureTimings)
    .map(f => ({ id: f.id, label: f.label ?? f.kind, ms: featureTimings[f.id] }))

  const totalMs = Object.values(featureTimings).reduce((sum, ms) => sum + ms, 0)

  if (entries.length === 0 && !validation) return null

  const badge = validation ? validationBadge(validation) : null

  return (
    <div className="rebuild-timing-popover" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="popover-header">
        <strong>Rebuild Times</strong>
        {badge && (
          <span
            className={`rebuild-validation-badge rebuild-validation-${badge.kind}`}
            data-testid="rebuild-validation-badge"
            data-validation-kind={badge.kind}
            title={badge.label}
            style={{ color: badge.color, marginLeft: 8, fontWeight: 'bold' }}
          >
            {badge.symbol} {badge.label}
          </span>
        )}
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
