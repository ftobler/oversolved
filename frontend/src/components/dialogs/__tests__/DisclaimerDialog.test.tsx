import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import DisclaimerDialog from '@/components/dialogs/DisclaimerDialog'
import { hasAcknowledgedDisclaimer, acknowledgeDisclaimer } from '@/components/dialogs/disclaimerConsent'
import { useAboutDialogStore } from '@/stores/aboutDialogStore'
import { resetStoragePersistenceRequest } from '@/stores/storagePersistenceStore'

function clearDisclaimerCookie() {
  document.cookie = 'oversolved_disclaimer_ack=; max-age=0; path=/'
}

describe('DisclaimerDialog', () => {
  beforeEach(() => {
    clearDisclaimerCookie()
    useAboutDialogStore.getState().closeAbout()
    resetStoragePersistenceRequest()
    Object.defineProperty(navigator, 'storage', {
      value: undefined, configurable: true, writable: true,
    })
  })

  it('shows the welcome disclaimer when not yet acknowledged', () => {
    render(<DisclaimerDialog />)
    expect(screen.getByText('Welcome to Oversolved')).toBeInTheDocument()
    expect(screen.getByText(/100% client side based browser CAD/)).toBeInTheDocument()
    expect(screen.getAllByText(/early development version/).length).toBeGreaterThan(0)
    expect(screen.getByText(/uses cookies/)).toBeInTheDocument()
  })

  // The app has no server, so where the work lives and how to get it out is
  // load-bearing information, not fine print. Since the backend removal there
  // is no second copy anywhere.
  it('says where documents live and how to get them out', () => {
    render(<DisclaimerDialog />)
    expect(screen.getByText(/saved in this browser only, never uploaded/)).toBeInTheDocument()
    expect(screen.getByText(/Clearing this site's data deletes them/)).toBeInTheDocument()
    expect(screen.getByText(/Use Export to keep a copy of your own on disk/)).toBeInTheDocument()
  })

  it('reports the browser durability answer once it arrives', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: async () => false, persist: async () => false },
      configurable: true, writable: true,
    })
    render(<DisclaimerDialog />)
    expect(await screen.findByText(/may discard them when disk space runs short/)).toBeInTheDocument()
  })

  // Before the answer lands there is nothing honest to say about durability,
  // so the paragraph must carry no claim either way.
  it('makes no durability claim while the request is still in flight', () => {
    render(<DisclaimerDialog />)
    expect(screen.queryByText(/persistent storage/)).not.toBeInTheDocument()
  })

  it('states the usage and redistribution terms', () => {
    render(<DisclaimerDialog />)
    expect(screen.getByText(/break\s+without warning/)).toBeInTheDocument()
    expect(screen.getByText(/use is permitted for private\s+and commercial purposes/)).toBeInTheDocument()
    expect(screen.getByText(/Redistribution of the source code is not\s+allowed/)).toBeInTheDocument()
  })

  it('does not show when already acknowledged', () => {
    acknowledgeDisclaimer()
    render(<DisclaimerDialog />)
    expect(screen.queryByText('Welcome to Oversolved')).not.toBeInTheDocument()
  })

  it('OK dismisses the dialog and sets the acknowledgement cookie', () => {
    render(<DisclaimerDialog />)
    fireEvent.click(screen.getByText('OK'))
    expect(screen.queryByText('Welcome to Oversolved')).not.toBeInTheDocument()
    expect(hasAcknowledgedDisclaimer()).toBe(true)
  })

  it('the close button hides the dialog but does not set the cookie', () => {
    render(<DisclaimerDialog />)
    fireEvent.click(screen.getByTitle('Close'))
    expect(screen.queryByText('Welcome to Oversolved')).not.toBeInTheDocument()
    expect(hasAcknowledgedDisclaimer()).toBe(false)
  })

  it('shows no cancel button, only OK', () => {
    render(<DisclaimerDialog />)
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })

  // The same notice doubles as the app's about box (the documents-overview
  // burger opens it), so an acknowledged disclaimer must still be re-openable.
  it('reopens on request even after it was acknowledged', () => {
    acknowledgeDisclaimer()
    render(<DisclaimerDialog />)
    expect(screen.queryByText('Welcome to Oversolved')).not.toBeInTheDocument()

    act(() => { useAboutDialogStore.getState().openAbout() })
    expect(screen.getByText('Welcome to Oversolved')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Close'))
    expect(screen.queryByText('Welcome to Oversolved')).not.toBeInTheDocument()
    // Closing must clear the request, or the dialog would latch open forever.
    expect(useAboutDialogStore.getState().open).toBe(false)
  })
})
