import { useEffect, useRef, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { backendBundle } from '@/adapters/backend'
import { errorMessage } from '@/utils/core/errorMessage'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import type { DocSummary } from '@/stores/documentStore'
// The tile grid and search box reuse the documents page's classes so a part
// looks the same here as in the library; import its sheet explicitly rather
// than relying on the page chunk having loaded it.
import '@/pages/Documents.css'
import '@/components/dialogs/AssemblyPartPicker.css'

interface AssemblyPartPickerProps {
  isOpen: boolean
  // The current assembly's own uuid, filtered out of the pick list.
  selfUuid: string
  onClose: () => void
  // Confirm with the picked part's id and its current rev (bundle cache key).
  onPick: (docId: string, docRev: number) => void
}

// Picks a PartDoc to instance into the assembly, presented as a document browser
// (search + preview tiles) in the standardized dialog shell. It shows the same
// library as the documents page, minus the Trash (a deleted doc is no insert
// source) and minus the tile verbs (duplicate/export/delete) -- this dialog only
// browses and picks, so there is no sidebar to put them behind.
//
// The list is filtered to parts: inserting an assembly yields a tree row with no
// geometry and no message, so it is kept out of the pick source. A summary with
// no kind (a legacy record) is treated as insertable, the safe default; the next
// save backfills it.
export default function AssemblyPartPicker({ isOpen, selfUuid, onClose, onPick }: AssemblyPartPickerProps) {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const store = backendBundle.documents

  // Each open starts fresh: empty search, nothing selected. The reset runs on
  // CLOSE (the dialog stays mounted, only isOpen toggles) so reopening never
  // paints, fetches, or double-click-inserts the previous session's stale
  // selection. Deferred a microtask to satisfy the no-sync-setState-in-effect
  // rule.
  useEffect(() => {
    if (isOpen) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setSearchQuery('')
      setDebouncedSearch('')
      setSelected(null)
    })
    return () => { cancelled = true }
  }, [isOpen])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Stale-response guard: typing fires a fresh list per debounce tick and
  // nothing promises they resolve in order, so only the latest sets state.
  const listReqRef = useRef(0)
  useEffect(() => {
    if (!isOpen) return
    const reqId = ++listReqRef.current
    queueMicrotask(() => {
      if (reqId !== listReqRef.current) return
      setLoading(true)
      setError(null)
    })
    store.list({ sort: 'name', search: debouncedSearch })
      .then(list => {
        if (reqId !== listReqRef.current) return
        const visible = list.filter(d => d.uuid !== selfUuid && d.kind !== 'assembly')
        setDocs(visible)
        // Keep the selection only while its tile is still on screen, so the
        // Insert button can never confirm a doc the user no longer sees.
        setSelected(prev => (visible.some(d => d.uuid === prev) ? prev : null))
        setLoading(false)
      })
      .catch(e => {
        if (reqId !== listReqRef.current) return
        setError(errorMessage(e, 'Failed to list documents'))
        setLoading(false)
      })
  }, [isOpen, store, debouncedSearch, selfUuid])

  const pick = (doc: DocSummary) => {
    // `meta.rev` is the assembly bundle cache key, so the picked rev is what
    // later forces a rebuild when the part is edited. `meta` is optional on the
    // interface, hence the 0 fallback for a store that does not track it.
    onPick(doc.uuid, doc.meta?.rev ?? 0)
    onClose()
  }

  const confirm = () => {
    const doc = docs.find(d => d.uuid === selected)
    if (doc) pick(doc)
  }

  return (
    <Dialog
      isOpen={isOpen}
      title="Insert part"
      icon="library_add"
      onClose={onClose}
      onConfirm={confirm}
      confirmLabel="Insert"
      confirmDisabled={!selected}
      className="doc-browser-dialog"
    >
      <div className="doc-browser">
        <div className="doc-browser-main">
          <div className="search-input-container doc-browser-search">
            <span className="material-icons search-icon">search</span>
            <input
              type="text"
              placeholder="Search documents..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="search-input"
            />
            {searchQuery && (
              <button
                className="btn btn-clear-search"
                onClick={() => setSearchQuery('')}
                title="Clear search"
                type="button"
              >
                <span className="material-icons">close</span>
              </button>
            )}
          </div>
          {loading && <p className="doc-browser-status">Loading...</p>}
          {error && <p className="error-text">{error}</p>}
          {!loading && !error && docs.length === 0 && (
            <p className="doc-browser-status">
              {debouncedSearch ? `No documents match "${debouncedSearch}"` : 'No parts available.'}
            </p>
          )}
          {!loading && !error && docs.length > 0 && (
            <div className="doc-tiles doc-browser-tiles">
              {docs.map(doc => (
                <button
                  type="button"
                  key={doc.uuid}
                  className={`doc-tile doc-browser-tile${selected === doc.uuid ? ' selected' : ''}`}
                  onClick={() => setSelected(doc.uuid)}
                  onDoubleClick={() => pick(doc)}
                >
                  <div className="doc-tile-preview">
                    <DocTilePreview doc={doc} store={store} />
                  </div>
                  <div className="doc-tile-info">
                    <span className="doc-tile-name" title={doc.name}>
                      {doc.name || doc.uuid}
                    </span>
                  </div>
                  <div className="doc-tile-meta">
                    <span className="doc-tile-date">{formatRelativeDate(doc.updated_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
