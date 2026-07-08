import { useEffect } from 'react'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblyStore } from '@/stores/assemblyStore'
import type { PartInstance, AssemblyFeature } from '@/types/cad'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

function extractInstances(features: AssemblyFeature[] | undefined): PartInstance[] {
  return (features ?? [])
    .filter((f): f is AssemblyFeature & { instance: PartInstance } => f.kind === 'part_instance' && !!f.instance)
    .map(f => f.instance!)
}

export default function AssemblyEditor({ uuid }: { uuid: string }) {
  const {
    doc,
    loading,
    docName,
    instances,
    mates,
  } = useAssemblyDoc(uuid)

  useEffect(() => {
    if (doc) {
      useAssemblyStore.getState().setSnapshot({
        ...useAssemblyStore.getState(),
        doc,
        instances: extractInstances(doc.features),
        mates,
      })
    }
  }, [doc, instances, mates])

  if (loading) {
    return <div className="document-viewer"><p>Loading...</p></div>
  }

  return (
    <div className="document-viewer">
      <div className="doc-container">
        <div className="doc-editor" style={{ flex: 1 }}>
          <div style={{ padding: '2rem', color: '#e0e0e0' }}>
            <h2>{docName || 'Untitled Assembly'}</h2>
            {instances.length > 0 && (
              <>
                <h3>Parts ({instances.length})</h3>
                <ul>
                  {instances.map(inst => (
                    <li key={inst.handle}>
                      {inst.doc_id} (rev {inst.doc_rev})
                      {inst.fixed ? ' [fixed]' : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {mates.length > 0 && (
              <>
                <h3>Mates ({mates.length})</h3>
                <ul>
                  {mates.map((m, i) => (
                    <li key={i}>
                      {m.kind}: {m.ref_a.part}/{m.ref_a.anchor} - {m.ref_b.part}/{m.ref_b.anchor}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {instances.length === 0 && mates.length === 0 && (
              <p>Empty assembly - insert parts to get started.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
