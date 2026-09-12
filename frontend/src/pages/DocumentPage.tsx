import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { backendBundle } from '@/adapters/backend'
import { interpretEntry, parseDocKind, refusalMessage } from '@/workspace/kinds'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import RecoveryDialog from '@/components/dialogs/RecoveryDialog'
import Part from '@/pages/Part'
import AssemblyEditor from '@/pages/AssemblyEditor'

export default function DocumentPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const [kind, setKind] = useState<'part' | 'assembly' | null>(null)
  const [kindError, setKindError] = useState<string | null>(null)
  const recoveryStatus = useRecoveryStore(s => s.status)
  const recoveryWorkspace = useRecoveryStore(s => s.workspace)
  const askingRecovery = recoveryStatus === 'asking' && recoveryWorkspace === uuid
  // Reset during render, not in the load effect: a child editor's passive
  // effects run before this component's own effect in the same commit, so an
  // effect-based reset would let the stale kind survive long enough for the
  // wrong editor to mount against the new uuid for one commit (and kick off a
  // spurious solve round-trip or error banner). The very next render then
  // takes the Loading branch until the new document's kind is known.
  //
  // The previous uuid is held in STATE rather than a ref: this is React's
  // documented adjust-state-during-render idiom, and a ref read/written during
  // render is what the react-hooks lint (rightly) rejects.
  const [lastUuid, setLastUuid] = useState(uuid)
  if (lastUuid !== uuid) {
    setLastUuid(uuid)
    if (kind !== null) setKind(null)
    if (kindError !== null) setKindError(null)
  }

  // U7: register the workspace for the header's dirty/save surface and arm the
  // recovery prompt before the editor mounts. A route change resets both, so
  // one document's prompt or dirty flag cannot follow the user to another.
  useEffect(() => {
    if (!uuid) return
    useUnsavedChangesStore.getState().setWorkspace(uuid)
    void useRecoveryStore.getState().begin(uuid)
    return () => {
      useUnsavedChangesStore.getState().setWorkspace(null)
      useRecoveryStore.getState().reset()
    }
  }, [uuid])

  useEffect(() => {
    if (!uuid) return
    let cancelled = false
    const loadKind = async () => {
      try {
        const data = await backendBundle.documents.load(uuid!)
        if (cancelled) return
        // The one interpretation gate. The store's open kind is authoritative;
        // content is only a fallback for a store that does not carry one. An
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
        setKindError(e instanceof Error ? e.message : 'Failed to load document')
      }
    }
    loadKind()
    return () => { cancelled = true }
  }, [uuid])

  // The key dispatcher must know which editor owns the document before it can
  // pick an assembly binding, and it must stay router-free, so the page writes
  // the mode here once the kind is known and clears it on the way out.
  useEffect(() => {
    useEditorModeStore.getState().setActiveEditor(kind)
    return () => { useEditorModeStore.getState().setActiveEditor(null) }
  }, [kind])

  // The recovery prompt owns the screen until the user chooses: mounting the
  // editor first would paint the working copy the user has not accepted (or the
  // checkpoint they have not accepted discarding).
  if (askingRecovery) {
    return (
      <div className="document-viewer">
        <p>Loading...</p>
        <RecoveryDialog />
      </div>
    )
  }
  if (kindError) {
    return <div className="document-viewer"><p>Error: {kindError}</p></div>
  }
  if (!kind) {
    return <div className="document-viewer"><p>Loading...</p></div>
  }
  if (kind === 'assembly') {
    // Keying by uuid forces a full AssemblyEditor remount per document, the same
    // contract the part editor keeps below: a route change (/documents/A ->
    // /documents/B, including clone) must not leak the previous document's undo
    // history, open edit sessions, or stale refs into the new one. The remount
    // resets the hook-local session refs; the module store's undo stacks are
    // cleared by useAssemblyDoc's load.
    return <AssemblyEditor key={uuid!} uuid={uuid!} />
  }
  // Keying by uuid forces a full Part remount per document, so a route change
  // (/documents/A -> /documents/B, including clone) cannot leak the previous
  // document's undo stacks, edit sessions, or stale refs into the new one. The
  // remount resets the store-owned fields (rollbackPosition, pickBoundary,
  // editingFeatureId) via useSyncPartEditorStore's unmount cleanup, which runs
  // when the keyed instance tears down.
  //
  // Deliberate behavior changes this introduces, not bugs: the camera auto-fits
  // the fresh instance (firstSolveDone is per-instance), the panel mode and
  // colour popover reset to per-doc defaults, and the Viewport (three.js scene) is
  // rebuilt. The solver Worker checkpoint cache is per doc-id, so B's
  // incremental solve is preserved.
  return <Part key={uuid} />
}
