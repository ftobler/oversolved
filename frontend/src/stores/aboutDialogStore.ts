import { create } from 'zustand'

// The welcome/about dialog opened on demand. It normally greets a visitor off
// the disclaimer cookie (DisclaimerDialog), but the documents-overview burger
// -- which has nowhere else to go, being already on the overview -- reopens the
// same notice as an "about" box. Kept in a store because the dialog is mounted
// once at the app root while the button lives in the shared header.
interface AboutDialogState {
  open: boolean
  openAbout: () => void
  closeAbout: () => void
}

export const useAboutDialogStore = create<AboutDialogState>((set) => ({
  open: false,
  openAbout: () => set({ open: true }),
  closeAbout: () => set({ open: false }),
}))
