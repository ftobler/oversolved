import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import type { MouseEvent, ReactNode } from 'react'
import { confirmDiscardUnsavedChanges, saveOpenDocument, useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAboutDialogStore } from '@/stores/aboutDialogStore'
import { isEditableTarget } from '@/utils/core/commandRegistry'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import MessageDialog from '@/components/dialogs/MessageDialog'
import BugReportDialog from '@/components/dialogs/BugReportDialog'
import SaveButton from '@/components/layout/SaveButton'
import '@/components/layout/AppHeader.css'

// The copyright note rides on the logo's tooltip rather than a footer bar: it
// is a credit, not a control, and the editors need the vertical space.
const COPYRIGHT = 'Copyright 2026 - Oversolved'

// Where the burger has nowhere to go, because this IS the workspace overview.
const OVERVIEW_PATHS = new Set(['/', '/workspaces'])

// The one app-wide titlebar: burger, logo, page title, and the always-available
// controls on the right (Docs, bug report). There is no account slot and never a
// place for one -- the app runs entirely in this browser tab, so there is no
// session to show, sign out of, or report as unavailable.
interface AppHeaderProps {
  // A plain page title, for pages outside the workspace hierarchy (Docs).
  title?: string
  // The workspace trail, for pages inside it. The two are exclusive: a page is
  // either somewhere in `Workspaces / <workspace> / <document>` or it is not.
  breadcrumb?: ReactNode
  children?: ReactNode
  rightContent?: ReactNode
  // The page's own toolbar (in `children`) carries the Save button, so the
  // header adds none. Without it the header shows one while edits are
  // pending, so an editor that unmounted into a non-editor page still leaves
  // its unsaved state visible.
  ownsSave?: boolean
}

export default function AppHeader({ title, breadcrumb, children, rightContent, ownsSave = false }: AppHeaderProps) {
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

  // Ctrl/Cmd+S and the dialog's "Save & Exit" run the editor's registered
  // handler through saveOpenDocument, the same path the Save button takes, so
  // all three clear dirty the same way once the bytes landed.
  const handleSaveWorkspace = useCallback(async () => {
    if (!useUnsavedChangesStore.getState().saveHandler || saving) return false
    setSaving(true)
    try {
      return await saveOpenDocument()
    } finally {
      setSaving(false)
    }
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
        {/* Only where no toolbar Save exists, and only while dirty: the tinted
            button is the whole indicator, with no dot and no sentence about
            durability. There is one unsaved boundary and it is in memory,
            where no honest durability claim can be made; the stored library's
            durability is the disclaimer's subject, where it is true. */}
        {dirty && !ownsSave && <SaveButton />}
        {rightContent}
        {/* Docs is a navigation, not a dialog, so it is a Link -- but it leaves
            the editor the same way the burger does, hence the unsaved-changes
            guard. */}
        <Link
          to="/docs"
          className="toolbar-btn"
          aria-label="Docs"
          title="Docs"
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
