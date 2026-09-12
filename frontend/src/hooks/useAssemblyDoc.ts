import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'
import type { AssemblyDoc } from '@/types/cad'
import { errorMessage } from '@/utils/core/errorMessage'
import { backendBundle } from '@/adapters/backend'
import { getPreviewStore } from '@/stores/previewStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { mateFeatures, partInstances } from '@/utils/assemblyMutations'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/assemblyBuiltins'

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
    // A new load clears the previous failure: otherwise a stale error would
    // keep the terminal panel (and the `!error` empty-hint guard) engaged even
    // after a later load succeeds.
    setError(null)
    queueMicrotask(() => { if (!cancelled) setLoading(true) })
    store.load(uuid)
      .then(data => {
        if (cancelled) return
        const parsed = (parseYaml(data.content) ?? {}) as AssemblyDoc
        // An empty assembly starts with its own Origin + 3 planes (its coordinate
        // frame), mirroring the part-editor empty-doc prepend but with assembly
        // built-ins so the assembly never inherits part built-ins.
        if (!parsed.features || parsed.features.length === 0) {
          parsed.features = ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f }))
        }
        docRef.current = parsed
        // A document swap must not inherit the previous document's transient
        // editor state (a live drag, a pick, a selection): it describes geometry
        // the new doc does not have, and the first solve would take the live-drag
        // path against it. Clearing BEFORE setDoc/setSnapshot covers both the
        // keyed remount and any future in-place reload. The undo/redo stacks are
        // untouched here; clearAssemblyHistory below owns them.
        useAssemblyStore.getState().resetTransientAssemblyState()
        setDoc(parsed)
        setDocName(data.name)
        useUnsavedChangesStore.getState().setDirty(false)
        // A fresh document must not inherit the previous document's undo
        // history: Ctrl+Z in the new doc would otherwise restore the old one
        // into it, and a later save could write A's content under B's uuid.
        useAssemblyStore.getState().clearAssemblyHistory()
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(errorMessage(e, 'Failed to load document'))
        // A failed load must not leave the previous document on screen: with
        // the editor mounted over it, every mutate no-ops on the null doc and
        // the stale tree looks live. Null it so the page can show a terminal
        // panel instead.
        docRef.current = null
        setDoc(null)
        setDocName('')
        // A failed load must not leave a previous document's history in the
        // module store: Ctrl+Z after the error would otherwise restore the old
        // document's content into the one that failed to load. Clearing on a
        // first mount with no prior doc is a harmless empty write.
        useAssemblyStore.getState().clearAssemblyHistory()
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [uuid, store])

  const instances = useMemo(() => partInstances(doc), [doc])

  // Feature id included: the solve status keys its per-mate marks by it, so the
  // tree cannot mark a stale mate red without knowing which feature each row
  // came from.
  const mates = useMemo(() => (doc ? mateFeatures(doc) : []), [doc])

  const saveChain = useRef<Promise<void>>(Promise.resolve())

  const saveDoc = useCallback(async (uuid: string, document: AssemblyDoc, screenshot?: () => Promise<string | null>) => {
    // Single-flight chain: a save landing while another is in flight waits, so
    // arrival order is landing order. Without it, two saves started close
    // together (the toolbar Save and Save & Exit) can reach the store out of
    // order and leave the older bytes stored under dirty=false.
    const prior = saveChain.current
    let release!: () => void
    const mine = new Promise<void>(resolve => { release = resolve })
    saveChain.current = mine
    await prior
    try {
      try {
        // Reference at entry: every mutation installs a fresh doc object (never
        // edits in place), so identity still holding after the awaits below
        // proves no edit landed while the save was in flight.
        const savedRef = docRef.current
        // Previews are keyed by (workspace, entry) so a multi-document
        // workspace's tile and picker read the same record a save wrote.
        if (screenshot) {
          const dataUrl = await screenshot()
          if (dataUrl) await getPreviewStore().put(workspace ?? uuid, uuid, dataUrl.split(',')[1])
        }
        await store.save(uuid, { content: stringifyYaml(document) })
        // Same guard as the part editor's saveDoc: an edit during the save
        // windows postdates the stored bytes, so its dirty flag must survive
        // or a reload would silently drop those edits.
        if (docRef.current === savedRef) {
          useUnsavedChangesStore.getState().setDirty(false)
        }
        return true
      } catch (e) {
        setError(errorMessage(e, 'Failed to save document'))
        return false
      }
    } finally {
      release()
    }
  }, [store, workspace])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      await store.rename(uuid, name)
      setDocName(name)
      return true
    } catch (e) {
      setError(errorMessage(e, 'Failed to rename document'))
      return false
    }
  }, [store])

  const cloneDoc = useCallback(async (id: string): Promise<{ uuid: string }> => {
    return store.clone(id)
  }, [store])

  return {
    doc, setDoc, docRef, docName, setDocName,
    loading, error, setError,
    instances, mates,
    saveDoc, renameDoc, cloneDoc,
  }
}
