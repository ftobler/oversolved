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
// It names the product, not the holder, on purpose: this is branding, and the
// legal statement is LICENSE.md.
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
}

export default function AppHeader({ title, breadcrumb, children, rightContent }: AppHeaderProps) {
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

  // Ctrl/Cmd+S and the dialog's "Save & Exit" run the editor's registered
  // handler, the same save the toolbar button runs. Dirty is the handler's to
  // clear: it alone knows whether an edit landed while the bytes were in
  // flight, so clearing it here on success would mark that edit saved.
  const handleSaveWorkspace = useCallback(async () => {
    const save = useUnsavedChangesStore.getState().saveHandler
    if (!save || saving) return false
    setSaving(true)
    try {
      return await save()
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
  //
  // The deferred navigation takes the Link's route, never its rendered href:
  // the href carries the router basename, and navigate() would prefix it again,
  // landing on an unmatched blank page under a non-root deploy base.
  const guardLink = (to: string) => (e: MouseEvent) => {
    if (!confirmDiscardUnsavedChanges(() => navigate(to))) {
      e.preventDefault()
    }
  }

  // On the documents overview the burger points at the page it is already on,
  // so it opens the about notice instead of navigating nowhere.
  const isOverview = OVERVIEW_PATHS.has(location.pathname)

  const handleBurger = (e: MouseEvent) => {
    if (!isOverview) {
      guardLink('/workspaces')(e)
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
        <Link to="/" className="logo" title={COPYRIGHT} onClick={guardLink('/')}>
          Oversolved
        </Link>
        {breadcrumb}
        {title && <h2 className="doc-name">{title}</h2>}
        {children}
      </div>
      <div className="app-header-right">
        {/* No Save and no dirty state here: the editors' toolbar Save carries
            both. Off an editor the save handler is gone with the editor, so a
            button here could never be pressed; leaving is still guarded by the
            unsaved-changes dialog. Nor a sentence about durability: the one
            unsaved boundary is in memory, where no honest durability claim can
            be made; the stored library's durability is the disclaimer's
            subject, where it is true. */}
        {rightContent}
        {/* Docs is a navigation, not a dialog, so it is a Link -- but it leaves
            the editor the same way the burger does, hence the unsaved-changes
            guard. */}
        <Link
          to="/docs"
          className="toolbar-btn"
          aria-label="Docs"
          title="Docs"
          onClick={guardLink('/docs')}
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
