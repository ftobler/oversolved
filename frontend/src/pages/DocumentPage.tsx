import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { parse as parseYaml } from 'yaml'
import { backendBundle } from '@/adapters/backend'
import Part from '@/pages/Part'
import AssemblyEditor from '@/pages/AssemblyEditor'

export default function DocumentPage() {
  const { uuid } = useParams<{ uuid: string }>()
  const [kind, setKind] = useState<'part' | 'assembly' | null>(null)
  const [kindError, setKindError] = useState<string | null>(null)

  useEffect(() => {
    if (!uuid) return
    let cancelled = false
    const loadKind = async () => {
      try {
        let data
        try {
          data = await backendBundle.documents.load(uuid!)
        } catch (localErr) {
          const cloud = backendBundle.cloudDocuments
          if (!cloud) throw localErr
          data = await cloud.load(uuid!)
        }
        if (cancelled) return
        const parsed = (parseYaml(data.content) ?? {}) as { kind?: string }
        setKind((parsed.kind === 'assembly' ? 'assembly' : 'part'))
      } catch (e) {
        if (cancelled) return
        setKindError(e instanceof Error ? e.message : 'Failed to load document')
      }
    }
    loadKind()
    return () => { cancelled = true }
  }, [uuid])

  if (kindError) {
    return <div className="document-viewer"><p>Error: {kindError}</p></div>
  }
  if (!kind) {
    return <div className="document-viewer"><p>Loading...</p></div>
  }
  if (kind === 'assembly') {
    return <AssemblyEditor uuid={uuid!} />
  }
  // Keying by uuid forces a full Part remount per document, so a route change
  // (/documents/A -> /documents/B, including clone) cannot leak the previous
  // document's undo stacks, edit sessions, or stale refs into the new one. The
  // remount resets the store-owned fields (rollbackPosition, pickBoundary,
  // editingFeatureId) via useSyncPartEditorStore's unmount cleanup, which runs
  // when the keyed instance tears down.
  //
  // Deliberate behavior changes this introduces, not bugs: the camera auto-fits
  // the fresh instance (firstSolveDone is per-instance), mode/codeText/color
  // popover reset to per-doc defaults, and the Viewport (three.js scene) is
  // rebuilt. The solver Worker checkpoint cache is per doc-id, so B's
  // incremental solve is preserved.
  return <Part key={uuid} />
}
