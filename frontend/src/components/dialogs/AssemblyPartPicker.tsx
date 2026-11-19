import { useEffect, useMemo, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { LoadingState } from '@/components/shared/LoadingState'
import DocTilePreview from '@/components/shared/DocTilePreview'
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
  // The open workspace session. It names the workspace for the tile previews
  // and marks "no workspace bound" as a terminal empty state; the pick source
  // itself is `entries`, never a fetch of its own.
  session: WorkspaceSession | null
  // The editor's one workspace entry list, the same rows the add_part guard
  // checks. Null means it has not landed yet (the dialog shows its spinner).
  // Sharing this list is what keeps a listed tile from being refused as an
  // unknown document: the picker and the guard cannot disagree.
  entries: readonly EntryMeta[] | null
  // Why the shared list could not be read. A failed read is shown here rather
  // than left as a spinner, because an insert that cannot even list its parts
  // must not look like a button that does nothing.
  listError?: string | null
  // Ask the editor for a fresh list. Called on open, so a part added since the
  // editor mounted is both shown and accepted.
  onRefresh: () => void
  // Why an assembly cannot be placed here (a cycle), by doc id. A refused
  // assembly stays listed, disabled, so the user sees the reason instead of
  // wondering why it vanished.
  cycleReasonFor?: (docId: string) => string | undefined
  onClose: () => void
  // Confirm with the picked document's id and its current rev, which becomes the
  // placement's provenance (the bundle cache keys on content hashes now, C5).
  onPick: (docId: string, docRev: number) => void
}

type InsertableKind = 'part' | 'assembly'

// The pick source is parts and assemblies, through the same interpretation gate
// the editor uses. A document whose kind is missing or unknown is refused
// rather than coerced to a part.
function insertableKind(entry: EntryMeta): InsertableKind | null {
  const interpreted = interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind })
  if (!interpreted.ok) return null
  return interpreted.docKind === 'part' || interpreted.docKind === 'assembly' ? interpreted.docKind : null
}

// Picks a PartDoc or an AssemblyDoc to instance into the assembly, presented as
// a document browser (search + preview tiles) in the standardized dialog shell.
// It browses the open workspace's documents, minus the assembly itself, and
// carries no tile verbs (duplicate/export/delete): this dialog only browses and
// picks.
//
// The rows arrive from the editor instead of being fetched here. The editor's
// list is also where the add_part guard's live set comes from, so a tile the
// user can click is exactly a document the operation will accept; a second
// fetch could list a part the guard had not learned about and turn Insert into
// a silent refusal.
export default function AssemblyPartPicker({
  isOpen, selfUuid, session, entries, listError, onRefresh, cycleReasonFor, onClose, onPick,
}: AssemblyPartPickerProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Each open starts fresh: empty search, nothing selected. The reset runs on
  // CLOSE (the dialog stays mounted, only isOpen toggles) so reopening never
  // paints or double-click-inserts the previous session's stale selection.
  // Deferred a microtask to satisfy the no-sync-setState-in-effect rule.
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

  // The one fetch on this path is the editor's, freshened when the dialog
  // opens so the tiles and the guard both learn about a part added since mount.
  useEffect(() => {
    if (isOpen) onRefresh()
  }, [isOpen, onRefresh])

  const docs = useMemo(() => {
    const needle = debouncedSearch.toLowerCase()
    return (entries ?? [])
      .filter(entry => entry.id !== selfUuid && insertableKind(entry) !== null)
      .filter(entry => !needle || entry.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [entries, selfUuid, debouncedSearch])

  // Null covers "no workspace bound" as well: with nothing to list, the dialog
  // settles into its empty state instead of holding the spinner up.
  const loading = session !== null && entries === null && !listError
  const error = listError ?? null

  const cycleReason = (entry: EntryMeta): string | undefined =>
    insertableKind(entry) === 'assembly' ? cycleReasonFor?.(entry.id) : undefined

  const pick = (entry: EntryMeta) => {
    // A refusal is a listing state, not a value the dialog may confirm.
    if (cycleReason(entry) !== undefined) return
    // `rev` is recorded on the instance as placement provenance. The bundle
    // cache no longer keys on it (C5), so this is informational.
    onPick(entry.id, entry.rev ?? 0)
    onClose()
  }

  const parts = docs.filter(entry => insertableKind(entry) === 'part')
  const assemblies = docs.filter(entry => insertableKind(entry) === 'assembly')
  // The selection is resolved against the VISIBLE rows on every render, so a
  // tile a search (or a refresh) narrowed away cannot be confirmed: Insert
  // disables itself instead. The id itself is kept, so clearing the search
  // restores the highlight rather than silently dropping the pick.
  const selectedEntry = docs.find(entry => entry.id === selected)
  const selectedRefused = selectedEntry !== undefined && cycleReason(selectedEntry) !== undefined

  const confirm = () => {
    if (selectedEntry) pick(selectedEntry)
  }

  const tile = (entry: EntryMeta) => {
    const reason = cycleReason(entry)
    return (
      <button
        type="button"
        key={entry.id}
        className={`doc-tile doc-browser-tile${selected === entry.id ? ' selected' : ''}${reason !== undefined ? ' disabled' : ''}`}
        onClick={() => { if (reason === undefined) setSelected(entry.id) }}
        onDoubleClick={() => pick(entry)}
        disabled={reason !== undefined}
        title={reason}
        aria-description={reason}
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
    )
  }

  return (
    <Dialog
      isOpen={isOpen}
      title="Insert part"
      icon="library_add"
      onClose={onClose}
      onConfirm={confirm}
      confirmLabel="Insert"
      confirmDisabled={!selectedEntry || selectedRefused}
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
              {debouncedSearch ? `No documents match "${debouncedSearch}"` : 'No parts or assemblies available.'}
            </p>
          )}
          {!loading && !error && docs.length > 0 && (
            <div className="doc-browser-groups">
              {parts.length > 0 && (
                <section className="doc-browser-group" aria-label="Parts">
                  <h3 className="doc-browser-group-title">Parts</h3>
                  <div className="doc-tiles doc-browser-tiles">{parts.map(tile)}</div>
                </section>
              )}
              {assemblies.length > 0 && (
                <section className="doc-browser-group" aria-label="Assemblies">
                  <h3 className="doc-browser-group-title">
                    <span className="material-icons" aria-hidden="true">account_tree</span>
                    Assemblies
                  </h3>
                  <div className="doc-tiles doc-browser-tiles">{assemblies.map(tile)}</div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
