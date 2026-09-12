import { useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import { backendBundle } from '@/adapters/backend'
import { createWorkspaceSession } from '@/workspace/session'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useCarrierChangeStore } from '@/stores/carrierChangeStore'
import RecoveryDialog from '@/components/dialogs/RecoveryDialog'
import CarrierChangedDialog from '@/components/dialogs/CarrierChangedDialog'
import Part from '@/pages/Part'
import AssemblyEditor from '@/pages/AssemblyEditor'
import { interpretEntry, parseDocKind, refusalMessage } from '@/workspace/kinds'
import { errorMessage } from '@/utils/core/errorMessage'
import type { EntryMeta } from '@/workspace/types'
import '@/pages/Documents.css'

// The workspace route. It binds the session on open so the editors and the solve
// relay read their own workspace, arms U7's recovery prompt, then renders the
// entry's editor. With no entryId it renders a minimal entry list (C4's tree
// replaces it) and forwards a single-document workspace straight to its editor,
// so C2's degenerate workspaces keep opening.
export default function WorkspacePage() {
  const { workspaceId, entryId } = useParams<{ workspaceId: string; entryId?: string }>()
  const [entries, setEntries] = useState<EntryMeta[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [kind, setKind] = useState<'part' | 'assembly' | null>(null)
  const [kindError, setKindError] = useState<string | null>(null)
  const recoveryStatus = useRecoveryStore(s => s.status)
  const recoveryWorkspace = useRecoveryStore(s => s.workspace)
  const askingRecovery = recoveryStatus === 'asking' && recoveryWorkspace === workspaceId
  const carrierStatus = useCarrierChangeStore(s => s.status)
  const carrierWorkspace = useCarrierChangeStore(s => s.workspace)
  const askingCarrier = carrierStatus === 'changed' && carrierWorkspace === workspaceId

  // Reset during render, not in the load effect: a child editor's effects run
  // before the host's effect in the same commit, so an effect-based reset would
  // let the stale kind pair with the new entry for one commit and mount the
  // wrong editor. The next render takes the Loading branch until the new kind
  // is known. The previous entry is held in state to satisfy the render rules.
  const [lastEntry, setLastEntry] = useState(entryId)
  if (lastEntry !== entryId) {
    setLastEntry(entryId)
    if (kind !== null) setKind(null)
    if (kindError !== null) setKindError(null)
  }

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    const session = createWorkspaceSession(workspaceId)
    useWorkspaceSessionStore.getState().setSession(session)
    // U7: register the workspace for the header's dirty/save surface and arm the
    // recovery prompt. A route change resets both so one workspace's prompt or
    // dirty flag cannot follow the user to another.
    useUnsavedChangesStore.getState().setWorkspace(workspaceId)
    // Carrier first, then U7: a carrier change must be resolved before asking
    // about a working copy that reload-from-carrier is about to replace.
    void useCarrierChangeStore.getState().begin(workspaceId).then(asking => {
      if (!asking && !cancelled) void useRecoveryStore.getState().begin(workspaceId)
    })

    if (entryId) {
      const loadKind = async () => {
        try {
          const data = await backendBundle.documents.load(entryId)
          if (cancelled) return
          // The one interpretation gate. The entry's open kind is authoritative;
          // content is only a fallback for an entry that does not carry one. An
          // absent or unknown kind refuses by name instead of reading as a part.
          const view = { kind: 'document' as const, name: data.name, docKind: data.kind ?? parseDocKind(data.content) }
          const interpreted = interpretEntry(view)
          if (!interpreted.ok) {
            setKindError(refusalMessage(view, interpreted))
            return
          }
          setKind(interpreted.docKind)
        } catch (e) {
          if (cancelled) return
          setKindError(errorMessage(e, 'Failed to load document'))
        }
      }
      void loadKind()
    } else {
      void session.listEntries()
        .then(list => { if (!cancelled) setEntries(list) })
        .catch(e => { if (!cancelled) setListError(errorMessage(e, 'Failed to open workspace')) })
    }

    return () => {
      cancelled = true
      useWorkspaceSessionStore.getState().clearSession(workspaceId)
      useUnsavedChangesStore.getState().setWorkspace(null)
      useCarrierChangeStore.getState().reset()
      useRecoveryStore.getState().reset()
    }
  }, [workspaceId, entryId])

  // The key dispatcher must know which editor owns the document before it can
  // pick an assembly binding, and it must stay router-free, so the page writes
  // the mode here once the kind is known and clears it on the way out.
  useEffect(() => {
    useEditorModeStore.getState().setActiveEditor(kind)
    return () => { useEditorModeStore.getState().setActiveEditor(null) }
  }, [kind])

  if (!workspaceId) return <div className="document-viewer"><p>Workspace not found.</p></div>

  // Both prompts hold the editor back, and only one may be up: the carrier check
  // owns the first decision, and U7 is armed only after a non-reload resolution.
  if (askingRecovery || askingCarrier) {
    return (
      <div className="document-viewer">
        <p>Loading...</p>
        {askingCarrier ? <CarrierChangedDialog /> : <RecoveryDialog />}
      </div>
    )
  }

  if (entryId) {
    if (kindError) return <div className="document-viewer"><p>Error: {kindError}</p></div>
    if (!kind) return <div className="document-viewer"><p>Loading...</p></div>
    if (kind === 'assembly') {
      // Keying by entry forces a full remount per document, the same contract
      // the part editor keeps below: a route change must not leak the previous
      // document's undo history, open edit sessions or stale refs into the new one.
      return <AssemblyEditor key={entryId} uuid={entryId} workspaceId={workspaceId} />
    }
    return <Part key={entryId} />
  }

  if (listError) return <div className="document-viewer"><p>Error: {listError}</p></div>
  if (entries === null) return <div className="document-viewer"><p>Loading...</p></div>

  const documents = entries.filter(entry => entry.kind === 'document')
  if (documents.length === 1) {
    return <Navigate to={`/workspaces/${workspaceId}/entries/${documents[0].id}`} replace />
  }

  return (
    <div className="documents">
      <AppHeader>
        <Link className="toolbar-btn" to="/workspaces" title="All workspaces">
          <span className="material-icons">arrow_back</span>
        </Link>
      </AppHeader>
      <div className="documents-main">
        {entries.length === 0 && <p className="status">This workspace is empty.</p>}
        {entries.length > 0 && (
          <div className="doc-tiles">
            {entries.map(entry => (
              <div key={entry.id} className="doc-tile">
                <Link to={`/workspaces/${workspaceId}/entries/${entry.id}`} className="doc-tile-link">
                  <div className="doc-tile-info">
                    <span className="doc-tile-name" title={entry.name}>{entry.name}</span>
                    <span className="doc-tile-date">{entry.kind}</span>
                  </div>
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
