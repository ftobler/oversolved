import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import Breadcrumb from '@/components/layout/Breadcrumb'
import { backendBundle } from '@/adapters/backend'
import { createWorkspaceSession } from '@/workspace/session'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import RecoveryDialog from '@/components/dialogs/RecoveryDialog'
import { LoadingState } from '@/components/shared/LoadingState'
import WorkspaceView from '@/pages/WorkspaceView'
import Part from '@/pages/Part'
import AssemblyEditor from '@/pages/AssemblyEditor'
import { interpretEntry, parseDocKind, refusalMessage } from '@/workspace/kinds'
import { migrateInlineStepPayloads } from '@/workspace/inlineStepMigration'
import { useNotifySafe } from '@/contexts/ToastContext'
import { errorMessage } from '@/utils/core/errorMessage'
import '@/pages/Documents.css'

// The workspace route. It binds the session on open so the editors and the solve
// relay read their own workspace, arms U7's recovery prompt, then renders the
// entry's editor. With no entryId it renders the workspace view, which is the
// only place the workspace layer lives now that the editor's sidebar is the
// document navigator alone.
export default function WorkspacePage() {
  const { workspaceId, entryId } = useParams<{ workspaceId: string; entryId?: string }>()
  const [kind, setKind] = useState<'part' | 'assembly' | null>(null)
  const [kindError, setKindError] = useState<string | null>(null)
  const notify = useNotifySafe()
  const recoveryStatus = useRecoveryStore(s => s.status)
  const recoveryWorkspace = useRecoveryStore(s => s.workspace)
  const askingRecovery = recoveryStatus === 'asking' && recoveryWorkspace === workspaceId

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
    void useRecoveryStore.getState().begin(workspaceId)

    // One-shot content migration, awaited before any editor sees a document:
    // it rewrites documents in place, and an editor that had already loaded the
    // old text would write it back over the migrated one on its next save. A
    // workspace that has been through it is marked, so a reopen costs one meta
    // read. A failure is reported and never blocks opening the workspace: the
    // documents it could not heal are exactly the ones that already refuse to
    // solve.
    const migrate = async () => {
      try {
        const report = await migrateInlineStepPayloads(workspaceId)
        if (cancelled || report.skipped || report.documents === 0) return
        notify(`Moved ${report.files} embedded STEP file(s) out of ${report.documents} document(s)`, 'info')
      } catch (e) {
        console.error('Inline STEP migration failed:', e)
        if (!cancelled) notify(errorMessage(e, 'Could not migrate embedded STEP files'), 'error')
      }
    }

    if (entryId) {
      const loadKind = async () => {
        try {
          await migrate()
          if (cancelled) return
          const data = await backendBundle.documents.load(entryId)
          if (cancelled) return
          // The one interpretation gate. The entry's structural kind decides
          // whether this is a document at all, so a file reached by a typed URL
          // refuses as a file rather than as a document with no kind. Its open
          // kind is then authoritative for which editor; content is only a
          // fallback for an entry that does not carry one. An absent or unknown
          // kind refuses by name instead of reading as a part.
          const view = { kind: data.kind, name: data.name, docKind: data.docKind ?? parseDocKind(data.content) }
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
      // The workspace view opens no document, so nothing can race the rewrite.
      void migrate()
    }

    return () => {
      cancelled = true
      useWorkspaceSessionStore.getState().clearSession(workspaceId)
      useUnsavedChangesStore.getState().setWorkspace(null)
      useRecoveryStore.getState().reset()
    }
  }, [workspaceId, entryId, notify])

  // The key dispatcher must know which editor owns the document before it can
  // pick an assembly binding, and it must stay router-free, so the page writes
  // the mode here once the kind is known and clears it on the way out.
  useEffect(() => {
    useEditorModeStore.getState().setActiveEditor(kind)
    return () => { useEditorModeStore.getState().setActiveEditor(null) }
  }, [kind])

  // Every branch that is not an editor keeps the header. An editor unmounting
  // into one still has its unsaved buffer and its dirty flag (the guard stopped
  // clearing them on unmount), so the guarded links have to be reachable here
  // to ask about them -- and a refused entry is a wrong turn, not a dead end
  // with no way back.
  const chrome = (body: ReactNode) => (
    <div className="document-viewer">
      <AppHeader breadcrumb={<Breadcrumb />} />
      {body}
    </div>
  )

  if (!workspaceId) return chrome(<p className="status">Workspace not found.</p>)

  // U7's prompt holds the editor back: the working copy it is asking about is
  // the one the editor would otherwise mount and start editing.
  if (askingRecovery) {
    return chrome(<><LoadingState /><RecoveryDialog /></>)
  }

  if (entryId) {
    if (kindError) return chrome(<p className="status">Error: {kindError}</p>)
    if (!kind) return chrome(<LoadingState />)
    if (kind === 'assembly') {
      // Keying by entry forces a full remount per document, the same contract
      // the part editor keeps below: a route change must not leak the previous
      // document's undo history, open edit sessions or stale refs into the new one.
      return <AssemblyEditor key={entryId} uuid={entryId} workspaceId={workspaceId} />
    }
    return <Part key={entryId} />
  }

  return chrome(<WorkspaceView />)
}
