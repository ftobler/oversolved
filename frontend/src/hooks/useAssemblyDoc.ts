import { useState, useRef, useEffect, useMemo } from 'react'
import { parse as parseYaml } from 'yaml'
import type { AssemblyDoc } from '@/types/cad'
import { errorMessage } from '@/utils/core/errorMessage'
import { backendBundle } from '@/adapters/backend'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { mateFeatures, partInstances } from '@/utils/assemblyMutations'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/assemblyBuiltins'
import { useDocPersistence } from '@/hooks/useDocPersistence'

// A loaded assembly is parsed once here. An empty assembly starts with its own
// Origin + 3 planes (its coordinate frame), mirroring the part-editor empty-doc
// prepend but with assembly built-ins so the assembly never inherits part
// built-ins.
function parseAssemblyContent(content: string): AssemblyDoc {
  const parsed = (parseYaml(content) ?? {}) as AssemblyDoc
  if (!parsed.features || parsed.features.length === 0) {
    parsed.features = ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f }))
  }
  return parsed
}

/** The React state and doc ref a load branch writes through. */
interface AssemblyLoadSink {
  docRef: { current: AssemblyDoc | null }
  setDoc: (doc: AssemblyDoc | null) => void
  setDocName: (name: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

function installLoadedAssembly(sink: AssemblyLoadSink, parsed: AssemblyDoc, name: string): void {
  sink.docRef.current = parsed
  // A document swap must not inherit the previous document's transient
  // editor state (a live drag, a pick, a selection): it describes geometry
  // the new doc does not have, and the first solve would take the live-drag
  // path against it. Clearing BEFORE setDoc/setSnapshot covers both the
  // keyed remount and any future in-place reload. The undo/redo stacks are
  // untouched here; clearAssemblyHistory below owns them.
  useAssemblyStore.getState().resetTransientAssemblyState()
  sink.setDoc(parsed)
  sink.setDocName(name)
  useUnsavedChangesStore.getState().setDirty(false)
  // A fresh document must not inherit the previous document's undo
  // history: Ctrl+Z in the new doc would otherwise restore the old one
  // into it, and a later save could write A's content under B's uuid.
  useAssemblyStore.getState().clearAssemblyHistory()
  sink.setLoading(false)
}

function installFailedAssembly(sink: AssemblyLoadSink, e: unknown): void {
  sink.setError(errorMessage(e, 'Failed to load document'))
  // A failed load must not leave the previous document on screen: with
  // the editor mounted over it, every mutate no-ops on the null doc and
  // the stale tree looks live. Null it so the page can show a terminal
  // panel instead.
  sink.docRef.current = null
  sink.setDoc(null)
  sink.setDocName('')
  // A failed load must not leave a previous document's history in the
  // module store: Ctrl+Z after the error would otherwise restore the old
  // document's content into the one that failed to load. Clearing on a
  // first mount with no prior doc is a harmless empty write.
  useAssemblyStore.getState().clearAssemblyHistory()
  sink.setLoading(false)
}

export function useAssemblyDoc(uuid: string | undefined, workspace?: string) {
  const [doc, setDoc] = useState<AssemblyDoc | null>(null)
  const [docName, setDocName] = useState<string>('')
  const docRef = useRef<AssemblyDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const store = backendBundle.documents

  useEffect(() => {
    if (!uuid) return
    let cancelled = false
    const sink: AssemblyLoadSink = { docRef, setDoc, setDocName, setLoading, setError }
    // A new load clears the previous failure: otherwise a stale error would
    // keep the terminal panel (and the `!error` empty-hint guard) engaged even
    // after a later load succeeds.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the stale failure synchronously at load start is the intended external-sync boundary
    setError(null)
    queueMicrotask(() => { if (!cancelled) setLoading(true) })
    store.load(uuid)
      .then(data => {
        if (cancelled) return
        installLoadedAssembly(sink, parseAssemblyContent(data.content), data.name)
      })
      .catch(e => {
        if (cancelled) return
        installFailedAssembly(sink, e)
      })
    return () => { cancelled = true }
  }, [uuid, store])

  const instances = useMemo(() => partInstances(doc), [doc])

  // Feature id included: the solve status keys its per-mate marks by it, so the
  // tree cannot mark a stale mate red without knowing which feature each row
  // came from.
  const mates = useMemo(() => (doc ? mateFeatures(doc) : []), [doc])

  const { saveDoc, renameDoc, cloneDoc } = useDocPersistence<AssemblyDoc>({
    docRef, setError, setDocName, workspace,
  })

  return {
    doc, setDoc, docRef, docName, setDocName,
    loading, error, setError,
    instances, mates,
    saveDoc, renameDoc, cloneDoc,
  }
}
