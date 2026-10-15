import MessageDialog from '@/components/dialogs/MessageDialog'
import type { RecoveryOffer } from '@/recovery/offer'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import './RecoveryRestoreDialog.css'

interface RecoveryRestoreDialogProps {
  offer: RecoveryOffer
  // A discard in flight: the journal delete is the only fallible choice here.
  busy: boolean
  error?: string | null
  onRestore: () => void
  onDiscard: () => void
}

// The open-time offer over the recovery journal. Unlike the workspace recovery
// prompt (keep or discard the working copy), restoring here adopts the
// journal's snapshot in memory only: nothing is written until the user saves,
// so a crash between the two clicks asks again rather than guessing.
//
// Close and Escape restore, like the workspace prompt's close keeps: the
// reflexive exit must be the one that cannot lose work, and the restored edits
// can still be reverted by reopening and discarding.
export default function RecoveryRestoreDialog({ offer, busy, error, onRestore, onDiscard }: RecoveryRestoreDialogProps) {
  const edited = offer.record.updatedAt > 0
    ? formatRelativeDate(new Date(offer.record.updatedAt).toISOString())
    : 'earlier'
  return (
    <MessageDialog
      isOpen
      title="Restore unsaved changes?"
      message={
        <>
          <p>
            {`This document has unsaved changes from ${edited}, kept by the recovery journal. `}
            Restore them, or discard them and open the last saved version?
          </p>
          {offer.thumbnail && (
            <img
              className="recovery-restore-thumbnail"
              src={`data:image/png;base64,${offer.thumbnail}`}
              alt="Preview of the unsaved document"
            />
          )}
          {error && <p className="message-dialog-failure">{error}</p>}
        </>
      }
      variant="info"
      busy={busy}
      onClose={onRestore}
      onConfirm={onRestore}
      confirmLabel="Restore changes"
      showCancel={false}
      extraAction={{ label: 'Discard changes', onClick: onDiscard }}
    />
  )
}
