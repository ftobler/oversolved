import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'
import {
  appendPartInstance,
  removeInstance,
  setInstanceVisible,
  setInstanceFixed,
} from '@/utils/assemblyMutations'
import type { AssemblyDoc, PartInstance, AssemblyFeature } from '@/types/cad'
import '@/pages/Part.css'
import '@/pages/Assembly.css'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

function extractInstances(features: AssemblyFeature[] | undefined): PartInstance[] {
  return (features ?? [])
    .filter((f): f is AssemblyFeature & { instance: PartInstance } => f.kind === 'part_instance' && !!f.instance)
    .map(f => f.instance!)
}

export default function AssemblyEditor({ uuid }: { uuid: string }) {
  const {
    doc,
    setDoc,
    loading,
    docName,
    instances,
    mates,
  } = useAssemblyDoc(uuid)
  const navigate = useNavigate()
  const [pickerOpen, setPickerOpen] = useState(false)

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

  // Apply a pure AssemblyDoc mutation, push it into the hook's doc state, and
  // flag the document dirty. The store re-syncs via the effect above.
  const mutate = useCallback((fn: (d: AssemblyDoc) => AssemblyDoc) => {
    setDoc(prev => (prev ? fn(prev) : prev))
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc])

  const openPicker = useCallback(() => setPickerOpen(true), [])

  const commands = useMemo(() => [
    { name: 'insert_part_instance', fn: openPicker },
  ], [openPicker])
  useCommandRegistration(commands)

  const handlePick = useCallback((docId: string, docRev: number) => {
    mutate(d => appendPartInstance(d, docId, docRev))
  }, [mutate])

  const handleOpenPart = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (!inst) return
    useAssemblyStore.getState().setActivePartHandle(handle)
    navigate(`/documents/${inst.doc_id}`)
  }, [instances, navigate])

  const handleDelete = useCallback((handle: string) => {
    mutate(d => removeInstance(d, handle))
  }, [mutate])

  const handleToggleVisible = useCallback((handle: string, visible: boolean) => {
    mutate(d => setInstanceVisible(d, handle, visible))
  }, [mutate])

  const handleToggleFixed = useCallback((handle: string, fixed: boolean) => {
    mutate(d => setInstanceFixed(d, handle, fixed))
  }, [mutate])

  if (loading) {
    return <div className="document-viewer"><p>Loading...</p></div>
  }

  return (
    <div className="document-viewer">
      <div className="doc-container">
        <aside className="doc-sidebar">
          <div className="assembly-tree-title">{docName || 'Untitled Assembly'}</div>
          <AssemblyTree
            instances={instances}
            mates={mates}
            onInsertPart={openPicker}
            onOpenPart={handleOpenPart}
            onDeleteInstance={handleDelete}
            onToggleVisible={handleToggleVisible}
            onToggleFixed={handleToggleFixed}
          />
        </aside>
        <div className="doc-editor" style={{ flex: 1 }}>
          <div style={{ padding: '2rem', color: '#e0e0e0' }}>
            {instances.length === 0 && mates.length === 0 && (
              <p>Empty assembly - insert parts to get started.</p>
            )}
          </div>
        </div>
      </div>
      <AssemblyPartPicker
        isOpen={pickerOpen}
        selfUuid={uuid}
        onClose={() => setPickerOpen(false)}
        onPick={handlePick}
      />
    </div>
  )
}
