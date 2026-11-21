import type { StatusMark } from '@/utils/core/statusMark'
import { StatusMessage } from '@/components/shared/StatusMessage'
import '@/components/layout/Glass.css'
import errorIcon from '@/assets/icons/status-error.svg'
import warningIcon from '@/assets/icons/status-warning.svg'

const LEVEL_ICONS = {
  error: errorIcon,
  warning: warningIcon,
} as const

/**
 * An item's solve mark as its own glass card after the open editor in the right
 * column's flow (components/layout/FeatureEditPanel.tsx, AssemblyEditPanel.tsx).
 * The editor card frames only the form; the mark follows it, so it pushes the
 * cards below down rather than covering them and it scrolls with the column
 * instead of being clipped. The editor's own markup is the same with or without
 * a mark.
 *
 * The icon is decorative (`alt=""`): the message carries the meaning and the
 * card's role comes from the StatusMessage inside it. Field refusals keep their
 * plain line under the offending control and never reach this card.
 */
export function StatusPanel({ mark }: { mark: Pick<StatusMark, 'level' | 'message'> }) {
  if (mark.level === null) return null
  return (
    <div className="glass-panel feature-status-panel">
      <img className="feature-status-icon" src={LEVEL_ICONS[mark.level]} alt="" />
      <StatusMessage mark={mark} />
    </div>
  )
}
