import type { StatusMark } from '@/utils/core/statusMark'

/**
 * A status mark as a line of text inside an open editor: under the field it
 * belongs to for a field refusal, at the top of the editor for the item's last
 * solve. One component for both, so a refused pick, a bad value and a failed
 * build read alike. `role="status"` is announced without stealing focus from
 * the viewport the user keeps picking in.
 *
 * Clicks stop here: the line sits inside a tree row whose onClick selects the
 * row, which would disarm a mate field or feed `@<feature>` to an armed pick.
 */
export function StatusMessage({ mark }: { mark: Pick<StatusMark, 'level' | 'message'> }) {
  if (mark.level === null) return null
  return (
    <div
      className={`status-message status-message--${mark.level}`}
      role="status"
      onClick={(e) => e.stopPropagation()}
    >
      {mark.message}
    </div>
  )
}
