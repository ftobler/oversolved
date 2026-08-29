import { useState } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import type { MouseEvent, ReactNode } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { hasBackend } from '@/config/capabilities'
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

interface AppHeaderProps {
  title?: string
  children?: ReactNode
  rightContent?: ReactNode
}

export default function AppHeader({ title, children, rightContent }: AppHeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, online, logout } = useAuth()
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

  const handleLogout = async () => {
    if (!confirmDiscardUnsavedChanges(async () => {
      await logout()
      navigate('/documents')
    })) return
    // Logout is non-destructive: it drops the cloud credential and drops you back
    // to the guest session, still inside the app on your local library. So return
    // to the documents home, not the login page.
    await logout()
    navigate('/documents')
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
        <button
          className="toolbar-btn"
          aria-label="Report a bug"
          title="Report a bug"
          onClick={() => setBugReportOpen(true)}
        >
          <span className="material-icons-outlined">bug_report</span>
        </button>
        {/* Three states of one guest-first session:
            - no server reachable  -> "cloud not available" (login impossible here)
            - server, not signed in -> a "Sign in" affordance (the optional upgrade)
            - server, signed in     -> the account name + a logout button
            Signed in but the server went away mid-session is a deliberate offline
            state, not a crash: an "offline" marker, still on the local library. */}
        {!hasBackend ? (
          <span
            className="cloud-not-available"
            title="Sign-in requires the server build"
          >
            cloud not available
          </span>
        ) : user ? (
          <>
            {!online && (
              <span
                className="cloud-offline"
                title="Cloud unavailable - working on your local library"
              >
                <span className="material-icons-outlined">cloud_off</span>
                offline
              </span>
            )}
            <Link to="/settings/profile" className="header-username" onClick={guardLink}>{user.username}</Link>
            <button className="toolbar-btn" title="Sign out" onClick={handleLogout}>
              <span className="material-icons-outlined">logout</span>
            </button>
          </>
        ) : (
          <Link to="/login" className="header-login" title="Sign in" onClick={guardLink}>
            <span className="material-icons-outlined">login</span>
            <span className="header-login-label">Sign in</span>
          </Link>
        )}
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
