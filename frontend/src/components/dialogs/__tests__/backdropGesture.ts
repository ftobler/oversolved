import { fireEvent } from '@testing-library/react'

// A backdrop dismiss is a whole gesture, not a bare `click`: Dialog reads press
// and release separately so a text-selection drag that merely ENDS on the
// overlay cannot close it. Tests that mean "the user clicked the backdrop" have
// to spell the gesture out, and this is that spelling, shared so the two dialog
// suites cannot drift apart on what a backdrop click is.
export function backdropClick(overlay: Element) {
  fireEvent.pointerDown(overlay)
  fireEvent.pointerUp(overlay)
  fireEvent.click(overlay)
}
