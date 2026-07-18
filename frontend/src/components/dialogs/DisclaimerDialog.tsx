import { useState } from 'react'
import MessageDialog from './MessageDialog'
import { hasAcknowledgedDisclaimer, acknowledgeDisclaimer } from './disclaimerConsent'
import './DisclaimerDialog.css'

// Plain-language notice, not a formal license text.
const DISCLAIMER_MESSAGE = (
  <>
    <p>Welcome to Oversolved, a 100% client side based browser CAD.</p>
    <p>
      This is an early development version. Things are expected to break
      without warning and without fallback.
    </p>
    <p>
      As this is an early development version, use is permitted for private
      and commercial purposes. Redistribution of the source code is not
      allowed.
    </p>
    <p>This app uses cookies.</p>
  </>
)

// Shown on every page. Only OK (or Enter) sets the 48h snooze cookie; the
// close button, overlay and Escape just hide it for this mount, so it comes
// back on the next page load until it is properly acknowledged.
export default function DisclaimerDialog() {
  const [isOpen, setIsOpen] = useState(() => !hasAcknowledgedDisclaimer())

  const acknowledge = () => {
    acknowledgeDisclaimer()
    setIsOpen(false)
  }

  return (
    <MessageDialog
      isOpen={isOpen}
      title="Welcome to Oversolved"
      message={DISCLAIMER_MESSAGE}
      variant="info"
      className="disclaimer-dialog"
      onConfirm={acknowledge}
      confirmLabel="OK"
      showCancel={false}
      onClose={() => setIsOpen(false)}
    />
  )
}
