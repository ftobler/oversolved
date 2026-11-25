import { useEffect, useMemo, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { LoadingState } from '@/components/shared/LoadingState'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { formatRelativeDate } from '@/utils/core/relativeDate'
// The tile grid and search box reuse the documents page's classes so a tile
// looks the same here as in the library; import its sheet explicitly rather
// than relying on the page chunk having loaded it.
import '@/pages/Documents.css'
import '@/components/dialogs/AssemblyPartPicker.css'

export interface TilePickerItem {
  id: string
  name: string
  group: string  // a TilePickerGroup key
  // The preview record the tile paints: a document's own, or a workspace's cover.
  preview: { workspace: string; entry: string }
  updatedAt?: number  // epoch ms, shown as a relative date
  // Why the item cannot be picked. It stays listed, disabled, so the reason
  // can be read instead of the item silently missing.
  disabledReason?: string
}

export interface TilePickerGroup {
  key: string
  label: string
  icon?: string  // material icon ligature beside the heading
}

interface TilePickerDialogProps {
  isOpen: boolean
  title: string
  icon: string
  confirmLabel: string
  searchPlaceholder: string
  // The empty state with no search typed, and what the items are called in the
  // no-match line ("documents", "workspaces").
  emptyText: string
  itemNoun: string
  items: readonly TilePickerItem[]
  // Heading order is this array's order; an empty group is not drawn.
  groups: readonly TilePickerGroup[]
  // A read is in flight: the spinner shows and nothing can be confirmed, so
  // stale rows are never offered against a list that may have dropped one.
  loading: boolean
  // A failed read. Shown above the rows and blocks the confirm.
  error?: string | null
  // A refused pick (the owner's verdict on the selection). Shown in the same
  // line but leaves the confirm alone, so another tile can still be picked.
  notice?: string | null
  // The owner is acting on a pick; the shell seals its exits meanwhile.
  busy?: boolean
  onClose: () => void
  // Confirm or double-click. The owner decides whether the dialog closes.
  onPick: (item: TilePickerItem) => void
  // Told whenever the selection changes, so an owner can clear a stale notice.
  onSelect?: (id: string) => void
  // A rebind opens with its current document already selected, so Replace is a
  // real choice rather than a second browse from nothing. Other callers omit it.
  initialSelectedId?: string | null
}

// The shared shell of the pick-one-tile dialogs (insert a part, move to a
// workspace): a search box over a grouped tile grid, in the standardized
// dialog shell with a primary and a cancel button. It owns only browsing:
// search, selection and the empty states. What the items are and what a pick
// does belong to the owner.
export default function TilePickerDialog({
  isOpen, title, icon, confirmLabel, searchPlaceholder, emptyText, itemNoun, items, groups,
  loading, error = null, notice = null, busy = false, onClose, onPick, onSelect,
  initialSelectedId = null,
}: TilePickerDialogProps) {
  const [selected, setSelected] = useState<string | null>(initialSelectedId)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Search and selection are reset on CLOSE, never on open: a deferred reset
  // on open can land after the user's first keystroke and erase it. The reset
  // uses the owner's seeded pick so the next open starts from ITS current doc.
  useEffect(() => {
    if (isOpen) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setSearchQuery('')
      setDebouncedSearch('')
      setSelected(initialSelectedId)
    })
    return () => { cancelled = true }
  }, [isOpen, initialSelectedId])

  // A rebind seeds its current doc as the starting selection. Only the
  // selection is seeded here; the search box belongs to the user from open.
  useEffect(() => {
    if (!isOpen || initialSelectedId === null) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setSelected(initialSelectedId)
    })
    return () => { cancelled = true }
  }, [isOpen, initialSelectedId])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const visible = useMemo(() => {
    const needle = debouncedSearch.toLowerCase()
    return items.filter(item => !needle || item.name.toLowerCase().includes(needle))
  }, [items, debouncedSearch])

  // The selection is resolved against the VISIBLE rows on every render, so a
  // tile a search (or a refresh) narrowed away cannot be confirmed: the
  // primary button disables itself instead. The id itself is kept, so clearing
  // the search restores the highlight rather than silently dropping the pick.
  const selectedItem = visible.find(item => item.id === selected)
  const selectable = (item: TilePickerItem) => item.disabledReason === undefined

  const select = (id: string) => {
    setSelected(id)
    onSelect?.(id)
  }

  const pick = (item: TilePickerItem) => {
    // A refusal is a listing state, not a value the dialog may confirm.
    if (!selectable(item) || loading || busy) return
    onPick(item)
  }

  const tile = (item: TilePickerItem) => {
    const reason = item.disabledReason
    // Selection is otherwise only a CSS class; aria-pressed is what a screen
    // reader reads when the owner seeds a current document.
    return (
      <button
        type="button"
        key={item.id}
        className={`doc-tile doc-browser-tile${selected === item.id ? ' selected' : ''}${reason !== undefined ? ' disabled' : ''}`}
        aria-pressed={selected === item.id}
        onClick={() => { if (reason === undefined) select(item.id) }}
        onDoubleClick={() => pick(item)}
        disabled={reason !== undefined}
        title={reason}
        aria-description={reason}
      >
        <div className="doc-tile-preview">
          <DocTilePreview workspace={item.preview.workspace} entry={item.preview.entry} name={item.name} />
        </div>
        <div className="doc-tile-info">
          <span className="doc-tile-name" title={item.name}>
            {item.name || item.id}
          </span>
        </div>
        <div className="doc-tile-meta">
          <span className="doc-tile-date">{formatRelativeDate(new Date(item.updatedAt ?? 0).toISOString())}</span>
        </div>
      </button>
    )
  }

  const message = error ?? notice

  return (
    <Dialog
      isOpen={isOpen}
      title={title}
      icon={icon}
      onClose={onClose}
      onConfirm={() => { if (selectedItem) pick(selectedItem) }}
      confirmLabel={confirmLabel}
      confirmDisabled={loading || error !== null || !selectedItem || !selectable(selectedItem)}
      busy={busy}
      className="doc-browser-dialog"
    >
      <div className="doc-browser">
        <div className="doc-browser-main">
          <div className="search-input-container doc-browser-search">
            <span className="material-icons search-icon">search</span>
            <input
              type="text"
              placeholder={searchPlaceholder}
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
          {message && <p className="error-text" role="alert">{message}</p>}
          {!loading && !error && visible.length === 0 && (
            <p className="doc-browser-status">
              {debouncedSearch ? `No ${itemNoun} match "${debouncedSearch}"` : emptyText}
            </p>
          )}
          {!loading && visible.length > 0 && (
            <div className="doc-browser-groups">
              {groups.map(group => {
                const members = visible.filter(item => item.group === group.key)
                if (members.length === 0) return null
                return (
                  <section className="doc-browser-group" aria-label={group.label} key={group.key}>
                    <h3 className="doc-browser-group-title">
                      {group.icon && <span className="material-icons" aria-hidden="true">{group.icon}</span>}
                      {group.label}
                    </h3>
                    <div className="doc-tiles doc-browser-tiles">{members.map(tile)}</div>
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
