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

// The one title surface: `Workspaces / <workspace> / <document>`, one segment
// per route level. It derives its own ancestors from the route rather than
// taking them as props, so the editors hand it nothing but their document name
// and the pages above hand it nothing at all.
//
// Every ancestor link leaves through the unsaved-changes guard, exactly as the
// burger and the Help link do -- the trail is the only way out of an editor now
// that the workspace tree no longer rides in its sidebar.
export default function Breadcrumb({ docName, fallbackName, onRename }: BreadcrumbProps) {
  const { workspaceId } = useParams<{ workspaceId?: string }>()
  const workspaceName = useWorkspaceName(workspaceId)
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docName ?? '')

  const guardLink = (e: MouseEvent<HTMLAnchorElement>) => {
    const href = e.currentTarget.getAttribute('href')
    if (!confirmDiscardUnsavedChanges(() => { if (href) navigate(href) })) {
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

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {workspaceId ? (
        <Link to="/workspaces" className="breadcrumb-crumb" onClick={guardLink}>Workspaces</Link>
      ) : (
        <span className="breadcrumb-current">Workspaces</span>
      )}

      {workspaceId && (
        <>
          <span className="breadcrumb-sep" aria-hidden="true">/</span>
          {hasDoc ? (
            <Link
              to={`/workspaces/${workspaceId}`}
              className="breadcrumb-crumb"
              onClick={guardLink}
              title={workspaceName ?? workspaceId}
            >
              {workspaceName ?? workspaceId}
            </Link>
          ) : (
            <span className="breadcrumb-current" title={workspaceName ?? workspaceId}>
              {workspaceName ?? workspaceId}
            </span>
          )}
        </>
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
              aria-label="Edit document name"
              title={docName ?? fallbackName}
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
