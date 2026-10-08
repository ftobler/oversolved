import { useState } from 'react'
import type { MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'
import { useWorkspaceName } from '@/hooks/useWorkspaceName'

interface BreadcrumbProps {
  // The open document's crumb. Omitted on the library and workspace levels,
  // where the trail ends at the workspace it is on.
  docName?: string | null
  // What to show while the document has no name yet. The rename still compares
  // against the real docName, so committing the placeholder is not a rename.
  fallbackName?: string
  // Renaming the open document. Present only with docName: the last crumb is
  // where the editor's inline rename lives now, so the trail is both where you
  // are and what the thing is called.
  onRename?: (name: string) => Promise<boolean>
}

// The one title surface: `<workspace> / <document>`, one segment per route
// level below the library. It derives its own ancestor from the route rather
// than taking it as a prop, so the editors hand it nothing but their document
// name and the pages above hand it nothing at all.
//
// There is no crumb for the library itself: it would be the same word on every
// route, saying nothing about where you are, and the burger already goes there.
// So the trail starts at the workspace and disappears entirely above it.
//
// The workspace link leaves through the unsaved-changes guard, exactly as the
// burger and the Docs link do -- the trail is the only way out of an editor now
// that the workspace tree no longer rides in its sidebar.
export default function Breadcrumb({ docName, fallbackName, onRename }: BreadcrumbProps) {
  const { workspaceId } = useParams<{ workspaceId?: string }>()
  const workspaceName = useWorkspaceName(workspaceId)
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docName ?? '')

  // Navigates to the route, not the anchor's rendered href: that carries the
  // router basename, which navigate() would prefix a second time.
  const workspaceRoute = `/workspaces/${workspaceId}`
  const guardLink = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!confirmDiscardUnsavedChanges(() => navigate(workspaceRoute))) {
      e.preventDefault()
    }
  }

  // A commit that changes nothing just closes the editor; a rejected rename
  // restores the stored name rather than leaving the user's text in a field
  // that no longer describes the document.
  const commitRename = async () => {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === docName || !onRename) {
      setIsEditing(false)
      return
    }
    const success = await onRename(trimmed)
    if (success) setIsEditing(false)
    else setEditName(docName ?? '')
  }

  // The workspace crumb is a link only when something sits below it. On the
  // workspace's own page it is where you already are, so it is plain text --
  // the same rule the burger follows on the overview.
  //
  // An editor is open whenever docName was passed at all, `null` included: a
  // document that has not got a name yet still occupies the last crumb, which
  // is what fallbackName is for. The pages above pass nothing and get no crumb.
  const hasDoc = docName !== undefined

  // Above a workspace there is nothing left to name, so the header gets no
  // trail at all rather than an empty nav landmark.
  if (!workspaceId) return null

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {hasDoc ? (
        <Link
          to={workspaceRoute}
          className="breadcrumb-crumb"
          onClick={guardLink}
          title={workspaceName ?? workspaceId}
        >
          {workspaceName ?? workspaceId}
        </Link>
      ) : (
        <span className="breadcrumb-current" aria-current="page" title={workspaceName ?? workspaceId}>
          {workspaceName ?? workspaceId}
        </span>
      )}

      {hasDoc && (
        <>
          <span className="breadcrumb-sep" aria-hidden="true">/</span>
          {isEditing ? (
            <input
              className="breadcrumb-input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => { void commitRename() }}
              onKeyDown={e => {
                if (e.key === 'Enter') void commitRename()
                // Escape abandons the edit with the stored name intact, so a
                // half-typed name is never committed by the blur that follows.
                if (e.key === 'Escape') { setEditName(docName ?? ''); setIsEditing(false) }
              }}
              aria-label="Document name"
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="breadcrumb-current breadcrumb-name"
              aria-current="page"
              title="Rename document"
              disabled={!onRename}
              onClick={() => { setEditName(docName ?? ''); setIsEditing(true) }}
            >
              {docName || fallbackName}
            </button>
          )}
        </>
      )}
    </nav>
  )
}
