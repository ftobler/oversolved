import type { StatusMark } from '@/utils/core/statusMark'

/**
 * A status mark as a line of text: under the field it belongs to for a field
 * refusal, inside the status card under the open editor for the item's last
 * solve. One component for both, so a refused pick, a bad value and a failed
 * build read alike. `role="status"` is announced without stealing focus from
 * the viewport the user keeps picking in.
 *
 * Clicks stop here: the line renders beside editable controls (a field row, a
 * pick chip, the bug report's selection row), and clicking the mark must not be
 * read as clicking the control it sits under. The item line moved into its own
 * floating card with the rest of the editor; the field refusals still render
 * under their control, so one component keeps the guard for both. */
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
