import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useAssemblyStore, setAssemblyCallbacks } from '@/stores/assemblyStore'
import AssemblyViewport from '@/components/Viewport/AssemblyViewport'
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
  const { requestSolve } = useAssemblySolve(uuid, doc)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)

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

  // The store owns the drag/gizmo state machine but not the document; give it
  // the doc mutator and the one-solve-per-pointer-up trigger.
  useEffect(() => {
    setAssemblyCallbacks({ mutateDoc: mutate, requestSolve })
    return () => setAssemblyCallbacks(null)
  }, [mutate, requestSolve])

  // Nothing renders until the assembly has been solved once: the bodies dict is
  // filled only by a solve, never by loading the doc.
  const solvedOnce = useRef(false)
  useEffect(() => {
    if (!doc || solvedOnce.current) return
    solvedOnce.current = true
    requestSolve()
  }, [doc, requestSolve])

  const openPicker = useCallback(() => setPickerOpen(true), [])

  const commands = useMemo(() => [
    { name: 'insert_part_instance', fn: openPicker },
  ], [openPicker])
  useCommandRegistration(commands)

  const handlePick = useCallback((docId: string, docRev: number) => {
    mutate(d => appendPartInstance(d, docId, docRev))
    requestSolve()  // the new instance has no bodies until the assembly re-solves
  }, [mutate, requestSolve])

  const handleOpenPart = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (!inst) return
    useAssemblyStore.getState().setActivePartHandle(handle)
    navigate(`/documents/${inst.doc_id}`)
  }, [instances, navigate])

  const handleDelete = useCallback((handle: string) => {
    mutate(d => removeInstance(d, handle))
    if (useAssemblyStore.getState().selectedPartHandle === handle) {
      useAssemblyStore.getState().setSelectedPartHandle(null)
    }
    requestSolve()  // the removed instance's bodies must leave the scene
  }, [mutate, requestSolve])

  const handleToggleVisible = useCallback((handle: string, visible: boolean) => {
    mutate(d => setInstanceVisible(d, handle, visible))
  }, [mutate])

  const handleToggleFixed = useCallback((handle: string, fixed: boolean) => {
    mutate(d => setInstanceFixed(d, handle, fixed))
    // Grounding changes which bodies the LM solver may move: the current solve
    // is stale the moment the flag flips.
    requestSolve()
  }, [mutate, requestSolve])

  const handleSelect = useCallback((handle: string) => {
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [])

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
            selectedHandle={selectedPartHandle}
            onSelectPart={handleSelect}
            onInsertPart={openPicker}
            onOpenPart={handleOpenPart}
            onDeleteInstance={handleDelete}
            onToggleVisible={handleToggleVisible}
            onToggleFixed={handleToggleFixed}
          />
        </aside>
        <div className="doc-editor assembly-viewport-host">
          <AssemblyViewport />
          {instances.length === 0 && mates.length === 0 && (
            <p className="assembly-empty-hint">Empty assembly - insert parts to get started.</p>
          )}
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
