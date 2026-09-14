import MessageDialog from '@/components/dialogs/MessageDialog'
import { useCarrierChangeStore } from '@/stores/carrierChangeStore'

// P4's carrier-change prompt. The external folder or zip moved while the
// workspace was open, so the three outcomes are explicit and none is silent:
// Reload from carrier adopts the file, Keep my copy marks the divergence durable
// and saves over it later, Save over writes the working copy now. Closing the
// dialog keeps the working copy, the non-destructive default.
//
// The three are mutually exclusive, so the dialog seals while one is in flight:
// a second click would resolve the same prompt twice. A failure unseals it and
// shows the reason, because the prompt is still unanswered.
export default function CarrierChangedDialog() {
  const status = useCarrierChangeStore(s => s.status)
  const label = useCarrierChangeStore(s => s.label)
  const error = useCarrierChangeStore(s => s.error)
  const resolving = useCarrierChangeStore(s => s.resolving)
  const reload = useCarrierChangeStore(s => s.reload)
  const keep = useCarrierChangeStore(s => s.keep)
  const saveOver = useCarrierChangeStore(s => s.saveOver)

  const target = label ?? 'the workspace folder'
  return (
    <MessageDialog
      isOpen={status === 'changed'}
      title="Workspace changed on disk"
      message={
        <>
          <p>{`The saved copy in ${target} is different from the version you have open. Reload that copy, keep yours, or save over it?`}</p>
          {error && <p className="message-dialog-failure">{error}</p>}
        </>
      }
      variant="info"
      busy={resolving}
      onClose={keep}
      onConfirm={reload}
      confirmLabel="Reload from carrier"
      cancelLabel="Keep my copy"
      extraAction={{ label: 'Save over', onClick: saveOver }}
    />
  )
}
