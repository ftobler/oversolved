import { useEffect, useState } from 'react'
import MessageDialog from './MessageDialog'
import { useAboutDialogStore } from '@/stores/aboutDialogStore'
import { useStoragePersistenceStore } from '@/stores/storagePersistenceStore'
import { durabilityNotice } from '@/adapters/storagePersistence'
import { hasAcknowledgedDisclaimer, acknowledgeDisclaimer } from './disclaimerConsent'
import './DisclaimerDialog.css'

// Plain-language notice, not a formal license text. The storage paragraph is
// part of it rather than tucked into a help page because "where does my work
// live" is the one thing a server-less CAD app owes a first-time visitor, and
// this dialog is the only screen guaranteed to be read.
function disclaimerMessage(durability: string | null) {
  return (
    <>
      <p>Welcome to Oversolved, a 100% client side based browser CAD.</p>
      <p>
        This is an early development version. Things are expected to break
        without warning and without fallback.
      </p>
      <p>
        Your documents are saved in this browser only, never uploaded anywhere.
        Clearing this site's data deletes them.
        {durability ? ` ${durability}` : ''}
        {' '}Use Export to keep a copy of your own on disk.
      </p>
      <p>
        As this is an early development version, use is permitted for private
        and commercial purposes. Redistribution of the source code is not
        allowed.
      </p>
      <p>This app uses cookies.</p>
    </>
  )
}

// Shown on every page. Only OK (or Enter) sets the 48h snooze cookie; the
// close button, overlay and Escape just hide it for this mount, so it comes
// back on the next page load until it is properly acknowledged.
//
// Doubles as the app's about box: the same notice is what the documents-overview
// burger reopens, through the store (aboutDialogStore). The greeting and the
// on-demand open are tracked apart so dismissing one cannot leave the other
// latched open.
export default function DisclaimerDialog() {
  const [greeting, setGreeting] = useState(() => !hasAcknowledgedDisclaimer())
  const requested = useAboutDialogStore(s => s.open)
  const persistence = useStoragePersistenceStore(s => s.state)
  const isOpen = greeting || requested

  // Boot fires the same request; this covers the dialog being reached in a
  // context that did not (a test mount, a future embed). Idempotent by design.
  useEffect(() => { useStoragePersistenceStore.getState().ensureRequested() }, [])

  const close = () => {
    setGreeting(false)
    useAboutDialogStore.getState().closeAbout()
  }

  const acknowledge = () => {
    acknowledgeDisclaimer()
    close()
  }

  return (
    <MessageDialog
      isOpen={isOpen}
      title="Welcome to Oversolved"
      message={disclaimerMessage(durabilityNotice(persistence))}
      variant="info"
      className="disclaimer-dialog"
      onConfirm={acknowledge}
      confirmLabel="OK"
      showCancel={false}
      onClose={close}
    />
  )
}
