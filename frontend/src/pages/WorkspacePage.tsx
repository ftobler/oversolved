import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import Breadcrumb from '@/components/layout/Breadcrumb'
import { backendBundle } from '@/adapters/backend'
import { createWorkspaceSession } from '@/workspace/session'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useCarrierChangeStore } from '@/stores/carrierChangeStore'
import RecoveryDialog from '@/components/dialogs/RecoveryDialog'
import CarrierChangedDialog from '@/components/dialogs/CarrierChangedDialog'
import { LoadingState } from '@/components/shared/LoadingState'
import WorkspaceView from '@/pages/WorkspaceView'
import Part from '@/pages/Part'
import AssemblyEditor from '@/pages/AssemblyEditor'
import { interpretEntry, parseDocKind, refusalMessage } from '@/workspace/kinds'
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
        <LoadingState />
        {askingCarrier ? <CarrierChangedDialog /> : <RecoveryDialog />}
      </div>
    )
  }

  if (entryId) {
    if (kindError) return <div className="document-viewer"><p>Error: {kindError}</p></div>
    if (!kind) return <div className="document-viewer"><LoadingState /></div>
    if (kind === 'assembly') {
      // Keying by entry forces a full remount per document, the same contract
      // the part editor keeps below: a route change must not leak the previous
      // document's undo history, open edit sessions or stale refs into the new one.
      return <AssemblyEditor key={entryId} uuid={entryId} workspaceId={workspaceId} />
    }
    return <Part key={entryId} />
  }

  return (
    <div className="document-viewer">
      <AppHeader breadcrumb={<Breadcrumb />} />
      <WorkspaceView />
    </div>
  )
}
