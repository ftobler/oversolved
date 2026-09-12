import MessageDialog from '@/components/dialogs/MessageDialog'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { formatRelativeDate } from '@/utils/core/relativeDate'

// U7's recovery prompt. The working copy is ahead of the checkpoint, so the
// edits from the last session are still there but were never explicitly saved.
// Keep adopts them; Discard resets to the checkpoint. The close button and
// Escape keep, because discarding by reflex would throw the edits away.
export default function RecoveryDialog() {
  const status = useRecoveryStore(s => s.status)
  const lastEditedAt = useRecoveryStore(s => s.lastEditedAt)
  const keep = useRecoveryStore(s => s.keep)
  const discard = useRecoveryStore(s => s.discard)

  const edited = lastEditedAt > 0 ? formatRelativeDate(new Date(lastEditedAt).toISOString()) : 'earlier'
  return (
    <MessageDialog
      isOpen={status === 'asking'}
      title="Recover unsaved edits?"
      message={`This workspace has edits from ${edited} that were not saved. Keep them, or discard them and use the last saved version?`}
      variant="info"
      onClose={keep}
      onConfirm={keep}
      confirmLabel="Keep edits"
      showCancel={false}
      extraAction={{ label: 'Discard edits', onClick: discard }}
    />
  )
}
