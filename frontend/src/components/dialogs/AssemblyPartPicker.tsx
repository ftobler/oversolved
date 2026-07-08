import { useEffect, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { backendBundle } from '@/adapters/backend'
import type { DocSummary } from '@/stores/documentStore/types'

interface AssemblyPartPickerProps {
  isOpen: boolean
  // The current assembly's own uuid, filtered out of the pick list.
  selfUuid: string
  onClose: () => void
  // Confirm with the picked part's id and its current rev (bundle cache key).
  onPick: (docId: string, docRev: number) => void
}

// Picks a PartDoc to instance into the assembly. Lists the documents the store
// already serves; the summary carries no `kind`, so all owned docs are shown
// (except the assembly itself). Choosing a non-part doc is a user error, not a
// crash: the bundle build just yields no anchors.
export default function AssemblyPartPicker({ isOpen, selfUuid, onClose, onPick }: AssemblyPartPickerProps) {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      setSelected(null)
    })
    backendBundle.documents.list({ filter: 'owned' })
      .then(list => {
        if (cancelled) return
        setDocs(list.filter(d => d.uuid !== selfUuid))
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to list documents')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [isOpen, selfUuid])

  const confirm = () => {
    if (!selected) return
    const doc = docs.find(d => d.uuid === selected)
    if (!doc) return
    onPick(doc.uuid, doc.meta?.rev ?? 0)
    onClose()
  }

  return (
    <Dialog
      isOpen={isOpen}
      title="Insert part"
      onClose={onClose}
      onConfirm={confirm}
      confirmLabel="Insert"
      confirmDisabled={!selected}
    >
      {loading && <p>Loading...</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && !error && docs.length === 0 && <p>No parts available.</p>}
      {!loading && !error && docs.length > 0 && (
        <ul className="assembly-part-picker-list">
          {docs.map(d => (
            <li key={d.uuid}>
              <button
                type="button"
                className={`assembly-part-picker-item${selected === d.uuid ? ' selected' : ''}`}
                onClick={() => setSelected(d.uuid)}
              >
                {d.name || d.uuid}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
