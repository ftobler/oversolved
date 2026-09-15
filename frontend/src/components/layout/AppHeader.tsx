import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import type { MouseEvent, ReactNode } from 'react'
import { confirmDiscardUnsavedChanges, useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAboutDialogStore } from '@/stores/aboutDialogStore'
import { isEditableTarget } from '@/utils/core/commandRegistry'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import MessageDialog from '@/components/dialogs/MessageDialog'
import BugReportDialog from '@/components/dialogs/BugReportDialog'
import '@/components/layout/AppHeader.css'

// The copyright note rides on the logo's tooltip rather than a footer bar: it
// is a credit, not a control, and the editors need the vertical space.
const COPYRIGHT = 'Copyright 2026 - Oversolved'

// Where the burger has nowhere to go, because this IS the workspace overview.
const OVERVIEW_PATHS = new Set(['/', '/workspaces'])

// The one app-wide titlebar: burger, logo, page title, and the always-available
// controls on the right (Help, bug report). There is no account slot and never a
// place for one -- the app runs entirely in this browser tab, so there is no
// session to show, sign out of, or report as unavailable.
interface AppHeaderProps {
  // A plain page title, for pages outside the workspace hierarchy (Help).
  title?: string
  // The workspace trail, for pages inside it. The two are exclusive: a page is
  // either somewhere in `Workspaces / <workspace> / <document>` or it is not.
  breadcrumb?: ReactNode
  children?: ReactNode
  rightContent?: ReactNode
}

export default function AppHeader({ title, breadcrumb, children, rightContent }: AppHeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const pendingCallback = useUnsavedChangesStore(s => s.pendingCallback)
  const dismissConfirm = useUnsavedChangesStore(s => s.dismissConfirm)
  const saveHandler = useUnsavedChangesStore(s => s.saveHandler)
  const dirty = useUnsavedChangesStore(s => s.dirty)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleUnsavedConfirm = () => {
    const cb = useUnsavedChangesStore.getState().pendingCallback
    if (!cb) return
    cb()
    dismissConfirm()
  }

  // One save path for the header's Save button, Ctrl/Cmd+S, and the dialog's
  // "Save & Exit": the editor's registered handler writes the document and its
  // workspace checkpoint, then this clears dirty once the bytes landed.
  const handleSaveWorkspace = useCallback(async () => {
    const save = useUnsavedChangesStore.getState().saveHandler
    if (!save || saving) return false
    setSaving(true)
    let saved = false
    try {
      saved = await save()
    } finally {
      setSaving(false)
    }
    if (saved) useUnsavedChangesStore.getState().setDirty(false)
    return saved
  }, [saving])

  // The header's own hotkey, so a global save works without the toolbar. It
  // defers to the same guards the command dispatcher uses: a text field owns
  // its key, and an open dialog (including the unsaved-changes one) owns it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      if (isEditableTarget(e) || modalOwnsEscape()) return
      if (!useUnsavedChangesStore.getState().saveHandler) return
      e.preventDefault()
      void handleSaveWorkspace()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSaveWorkspace])

  // The third way out of the unsaved-changes dialog: write the document, then
  // do what the user was trying to do. A save that fails holds the dialog open
  // -- proceeding anyway would drop the very edits the save was meant to keep;
  // the editor's own error banner says why it failed.
  const handleSaveAndExit = async () => {
    const cb = useUnsavedChangesStore.getState().pendingCallback
    if (!cb || saving) return
    const saved = await handleSaveWorkspace()
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
          to="/workspaces"
          className="toolbar-btn burger"
          title={isOverview ? 'About Oversolved' : 'Workspaces'}
          onClick={handleBurger}
        >
          <span className="material-icons-outlined">menu</span>
        </Link>
        <Link to="/" className="logo" title={COPYRIGHT} onClick={guardLink}>
          Oversolved
        </Link>
        {breadcrumb}
        {title && <h2 className="doc-name">{title}</h2>}
        {children}
      </div>
      <div className="app-header-right">
        {/* The dot and the button, and no sentence about durability: there is
            one unsaved boundary now and it is in memory, where no honest
            durability claim can be made. The stored library's durability is
            the disclaimer's subject, where it is true. Not a live region
            either -- a dot appearing is not a status change worth interrupting
            a screen reader for. */}
        {dirty && (
          <div className="workspace-dirty">
            <span className="header-dirty-dot" aria-hidden="true" />
            <button
              className="toolbar-btn"
              aria-label="Save workspace"
              title="Save (Ctrl+S)"
              onClick={() => { void handleSaveWorkspace() }}
              disabled={saving || saveHandler === null}
            >
              <span className="material-icons-outlined">{saving ? 'hourglass_empty' : 'save'}</span>
            </button>
          </div>
        )}
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
