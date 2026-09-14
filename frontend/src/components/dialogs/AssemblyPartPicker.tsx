import { useEffect, useRef, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { LoadingState } from '@/components/shared/LoadingState'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { errorMessage } from '@/utils/core/errorMessage'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'
import { interpretEntry } from '@/workspace/kinds'
// The tile grid and search box reuse the documents page's classes so a part
// looks the same here as in the library; import its sheet explicitly rather
// than relying on the page chunk having loaded it.
import '@/pages/Documents.css'
import '@/components/dialogs/AssemblyPartPicker.css'

interface AssemblyPartPickerProps {
  isOpen: boolean
  // The current assembly's own uuid, filtered out of the pick list.
  selfUuid: string
  // The open workspace session: the pick source is exactly this workspace's
  // parts, never the library. Null means no workspace is bound (the picker
  // shows its empty state rather than reaching across workspaces).
  session: WorkspaceSession | null
  onClose: () => void
  // Confirm with the picked part's id and its current rev, which becomes the
  // placement's provenance (the bundle cache keys on content hashes now, C5).
  onPick: (docId: string, docRev: number) => void
}

// The pick source is parts only, through the same interpretation gate the
// editor uses. An assembly is not insertable, and neither is a document whose
// kind is missing or unknown: it is refused rather than coerced to a part.
function isInsertablePart(entry: EntryMeta): boolean {
  const interpreted = interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind })
  return interpreted.ok && interpreted.docKind === 'part'
}

// Picks a PartDoc to instance into the assembly, presented as a document browser
// (search + preview tiles) in the standardized dialog shell. It browses the open
// workspace's parts only, minus the assembly itself, and carries no tile verbs
// (duplicate/export/delete): this dialog only browses and picks.
//
// The list is filtered to parts: inserting an assembly yields a tree row with no
// geometry and no message, so it is kept out of the pick source. Only an entry
// the kinds gate interprets as a part is insertable; an absent or unknown kind
// is refused, never treated as an insertable default.
export default function AssemblyPartPicker({ isOpen, selfUuid, session, onClose, onPick }: AssemblyPartPickerProps) {
  const [docs, setDocs] = useState<EntryMeta[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

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
    if (!isOpen || !session) return
    const reqId = ++listReqRef.current
    queueMicrotask(() => {
      if (reqId !== listReqRef.current) return
      setLoading(true)
      setError(null)
    })
    const needle = debouncedSearch.toLowerCase()
    session.listEntries()
      .then(list => {
        if (reqId !== listReqRef.current) return
        const visible = list
          .filter(entry => entry.id !== selfUuid && isInsertablePart(entry))
          .filter(entry => !needle || entry.name.toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name))
        setDocs(visible)
        // Keep the selection only while its tile is still on screen, so the
        // Insert button can never confirm a doc the user no longer sees.
        setSelected(prev => (visible.some(entry => entry.id === prev) ? prev : null))
        setLoading(false)
      })
      .catch(e => {
        if (reqId !== listReqRef.current) return
        setError(errorMessage(e, 'Failed to list parts'))
        setLoading(false)
      })
  }, [isOpen, session, debouncedSearch, selfUuid])

  const pick = (entry: EntryMeta) => {
    // `rev` is recorded on the instance as placement provenance. The bundle
    // cache no longer keys on it (C5), so this is informational.
    onPick(entry.id, entry.rev ?? 0)
    onClose()
  }

  const confirm = () => {
    const entry = docs.find(d => d.id === selected)
    if (entry) pick(entry)
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
          {loading && <LoadingState label="Loading..." />}
          {error && <p className="error-text">{error}</p>}
          {!loading && !error && docs.length === 0 && (
            <p className="doc-browser-status">
              {debouncedSearch ? `No documents match "${debouncedSearch}"` : 'No parts available.'}
            </p>
          )}
          {!loading && !error && docs.length > 0 && (
            <div className="doc-tiles doc-browser-tiles">
              {docs.map(entry => (
                <button
                  type="button"
                  key={entry.id}
                  className={`doc-tile doc-browser-tile${selected === entry.id ? ' selected' : ''}`}
                  onClick={() => setSelected(entry.id)}
                  onDoubleClick={() => pick(entry)}
                >
                  <div className="doc-tile-preview">
                    <DocTilePreview workspace={session?.workspace ?? selfUuid} entry={entry.id} name={entry.name} />
                  </div>
                  <div className="doc-tile-info">
                    <span className="doc-tile-name" title={entry.name}>
                      {entry.name || entry.id}
                    </span>
                  </div>
                  <div className="doc-tile-meta">
                    <span className="doc-tile-date">{formatRelativeDate(new Date(entry.updatedAt ?? 0).toISOString())}</span>
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
