import MessageDialog from '@/components/dialogs/MessageDialog'
import { useCarrierChangeStore } from '@/stores/carrierChangeStore'

// P4's carrier-change prompt. The external folder or zip moved while the
// workspace was open, so the three outcomes are explicit and none is silent:
// Reload from carrier adopts the file, Keep my copy marks the divergence durable
// and saves over it later, Save over writes the working copy now. Closing the
// dialog keeps the working copy, the non-destructive default.
export default function CarrierChangedDialog() {
  const status = useCarrierChangeStore(s => s.status)
  const label = useCarrierChangeStore(s => s.label)
  const error = useCarrierChangeStore(s => s.error)
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
          {error && <p className="carrier-change-error">{error}</p>}
        </>
      }
      variant="info"
      onClose={keep}
      onConfirm={reload}
      confirmLabel="Reload from carrier"
      cancelLabel="Keep my copy"
      extraAction={{ label: 'Save over', onClick: saveOver }}
    />
  )
}
