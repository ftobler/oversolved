import { useState } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import type { MouseEvent, ReactNode } from 'react'
import { confirmDiscardUnsavedChanges, useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAboutDialogStore } from '@/stores/aboutDialogStore'
import MessageDialog from '@/components/dialogs/MessageDialog'
import BugReportDialog from '@/components/dialogs/BugReportDialog'
import '@/components/layout/AppHeader.css'

// The copyright note rides on the logo's tooltip rather than a footer bar: it
// is a credit, not a control, and the editors need the vertical space.
const COPYRIGHT = 'Copyright 2026 - Oversolved'

// Where the burger has nowhere to go, because this IS the documents overview.
const OVERVIEW_PATHS = new Set(['/', '/documents'])

// The one app-wide titlebar: burger, logo, page title, and the always-available
// controls on the right (Help, bug report). There is no account slot and never a
// place for one -- the app runs entirely in this browser tab, so there is no
// session to show, sign out of, or report as unavailable.
interface AppHeaderProps {
  title?: string
  children?: ReactNode
  rightContent?: ReactNode
}

export default function AppHeader({ title, children, rightContent }: AppHeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const pendingCallback = useUnsavedChangesStore(s => s.pendingCallback)
  const dismissConfirm = useUnsavedChangesStore(s => s.dismissConfirm)
  const saveHandler = useUnsavedChangesStore(s => s.saveHandler)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleUnsavedConfirm = () => {
    const cb = useUnsavedChangesStore.getState().pendingCallback
    if (!cb) return
    cb()
    dismissConfirm()
  }

  // The third way out of the unsaved-changes dialog: write the document, then
  // do what the user was trying to do. A save that fails holds the dialog open
  // -- proceeding anyway would drop the very edits the save was meant to keep;
  // the editor's own error banner says why it failed.
  const handleSaveAndExit = async () => {
    const { pendingCallback: cb, saveHandler: save } = useUnsavedChangesStore.getState()
    if (!cb || !save || saving) return
    setSaving(true)
    let saved = false
    try {
      saved = await save()
    } finally {
      setSaving(false)
    }
    if (!saved) return
    cb()
    dismissConfirm()
  }

  // The header is the only in-app way out of the part editor, and react-router's
  // client-side Links bypass the browser's beforeunload prompt. Cancel the click
  // when the user backs out of discarding unsaved edits so the Link does not
  // navigate.
  const guardLink = (e: MouseEvent) => {
    const href = (e.currentTarget as HTMLAnchorElement).getAttribute('href')
    if (!confirmDiscardUnsavedChanges(() => {
      if (href) navigate(href)
    })) {
      e.preventDefault()
    }
  }

  // On the documents overview the burger points at the page it is already on,
  // so it opens the about notice instead of navigating nowhere.
  const isOverview = OVERVIEW_PATHS.has(location.pathname)

  const handleBurger = (e: MouseEvent) => {
    if (!isOverview) {
      guardLink(e)
      return
    }
    e.preventDefault()
    useAboutDialogStore.getState().openAbout()
  }

  return (
    <>
    <header className="app-header">
      <div className="app-header-left">
        <Link
          to="/documents"
          className="toolbar-btn burger"
          title={isOverview ? 'About Oversolved' : 'Documents'}
          onClick={handleBurger}
        >
          <span className="material-icons-outlined">menu</span>
        </Link>
        <Link to="/" className="logo" title={COPYRIGHT} onClick={guardLink}>
          Oversolved
        </Link>
        {title && <h2 className="doc-name">{title}</h2>}
        {children}
      </div>
      <div className="app-header-right">
        {rightContent}
        {/* Help is a navigation, not a dialog, so it is a Link -- but it leaves
            the editor the same way the burger does, hence the unsaved-changes
            guard. */}
        <Link
          to="/help"
          className="toolbar-btn"
          aria-label="Help"
          title="Help"
          onClick={guardLink}
        >
          <span className="material-icons-outlined">help_outline</span>
        </Link>
        <button
          className="toolbar-btn"
          aria-label="Report a bug"
          title="Report a bug"
          onClick={() => setBugReportOpen(true)}
        >
          <span className="material-icons-outlined">bug_report</span>
        </button>
      </div>
    </header>

    {/* Save & Exit takes the confirm slot where an editor registered a save:
        it is the safe answer, and confirm is what Enter and the initial focus
        reach. Discarding is still one click away, just no longer the default.
        With no save handler (a page with nothing to save) the dialog keeps its
        original two-button shape. */}
    <MessageDialog
      isOpen={pendingCallback != null}
      title="Unsaved Changes"
      message="You have unsaved changes that will be lost. Leave without saving?"
      variant="error"
      onClose={dismissConfirm}
      onConfirm={saveHandler ? handleSaveAndExit : handleUnsavedConfirm}
      confirmLabel={saveHandler ? (saving ? 'Saving...' : 'Save & Exit') : 'Discard'}
      extraAction={saveHandler ? { label: 'Discard', onClick: handleUnsavedConfirm, disabled: saving } : undefined}
      cancelLabel="Stay"
    />

    <BugReportDialog isOpen={bugReportOpen} onClose={() => setBugReportOpen(false)} />
    </>
  )
}
