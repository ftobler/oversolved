import { useEffect, useRef, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { backendBundle } from '@/adapters/backend'
import { useCloudAvailable } from '@/hooks/useCloudAvailable'
import { parseHttpError } from '@/utils/core/httpClient'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import type { DocSummary, DocumentStore } from '@/stores/documentStore'
// The tile grid, sidebar entries and search box reuse the documents page's
// classes so a part looks the same here as in the library; import its sheet
// explicitly rather than relying on the page chunk having loaded it.
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

// A browsable category: domain + server-side filter, mirroring the Documents
// sidebar minus trash (a deleted doc is no insert source) and minus the tile
// verbs (share/copy/delete) -- this dialog only browses and picks.
interface Category {
  key: string
  label: string
  icon: string
  store: DocumentStore
  filter: 'owned' | 'shared' | 'public'
  domain: 'local' | 'cloud'
}

// Picks a PartDoc to instance into the assembly, presented as a full document
// browser (categories, search, preview tiles) in the standardized dialog shell.
// The summaries carry no `kind`, so all docs are shown (except the assembly
// itself). Choosing a non-part doc is a user error, not a crash: the bundle
// build just yields no anchors.
export default function AssemblyPartPicker({ isOpen, selfUuid, onClose, onPick }: AssemblyPartPickerProps) {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState('local')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Same availability rule as the Documents page; without the cloud domain the
  // sidebar collapses to the local library.
  const cloudOk = useCloudAvailable()
  const cloudStore = backendBundle.cloudDocuments
  const categories: Category[] = [
    { key: 'local', label: 'Local Documents', icon: 'computer', store: backendBundle.documents, filter: 'owned', domain: 'local' },
  ]
  if (cloudOk && cloudStore != null) {
    categories.push(
      { key: 'cloud-owned', label: 'My Documents', icon: 'folder', store: cloudStore, filter: 'owned', domain: 'cloud' },
      { key: 'cloud-shared', label: 'Shared with me', icon: 'people', store: cloudStore, filter: 'shared', domain: 'cloud' },
      { key: 'cloud-public', label: 'Public Documents', icon: 'public', store: cloudStore, filter: 'public', domain: 'cloud' },
    )
  }
  const cloudAvailable = categories.some(c => c.domain === 'cloud')
  // Falls back to local when the cloud domain vanishes (sign-out / offline)
  // while a cloud category is active.
  const activeCategory = categories.find(c => c.key === activeKey) ?? categories[0]

  // Each open starts fresh: local category, empty search, nothing selected.
  // The reset runs on CLOSE (the dialog stays mounted, only isOpen toggles) so
  // reopening never paints, fetches, or double-click-inserts the previous
  // session's stale category and selection. Deferred a microtask to satisfy
  // the no-sync-setState-in-effect rule.
  useEffect(() => {
    if (isOpen) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setActiveKey('local')
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

  // Stale-response guard: switching category fires a new list; a slow earlier
  // request (local IndexedDB read vs. fast cloud fetch, or vice versa) must not
  // overwrite the newer result. Only the latest request sets state.
  const listReqRef = useRef(0)
  const { store: activeListStore, filter: activeFilter } = activeCategory
  useEffect(() => {
    if (!isOpen) return
    const reqId = ++listReqRef.current
    queueMicrotask(() => {
      if (reqId !== listReqRef.current) return
      setLoading(true)
      setError(null)
    })
    activeListStore.list({ sort: 'name', filter: activeFilter, search: debouncedSearch })
      .then(list => {
        if (reqId !== listReqRef.current) return
        const visible = list.filter(d => d.uuid !== selfUuid)
        setDocs(visible)
        // Keep the selection only while its tile is still on screen, so the
        // Insert button can never confirm a doc the user no longer sees.
        setSelected(prev => (visible.some(d => d.uuid === prev) ? prev : null))
        setLoading(false)
      })
      .catch(e => {
        if (reqId !== listReqRef.current) return
        setError(parseHttpError(e, 'Failed to list documents'))
        setLoading(false)
      })
  }, [isOpen, activeListStore, activeFilter, debouncedSearch, selfUuid])

  const pick = (doc: DocSummary) => {
    // Cloud summaries carry no sync meta (the server is the source of truth
    // there), so their rev defaults to 0 -- same as the pre-browser picker.
    onPick(doc.uuid, doc.meta?.rev ?? 0)
    onClose()
  }

  const confirm = () => {
    const doc = docs.find(d => d.uuid === selected)
    if (doc) pick(doc)
  }

  const renderCategory = (c: Category) => (
    <div
      key={c.key}
      className={`sidebar-item ${activeCategory.key === c.key ? 'active' : ''}`}
      onClick={() => setActiveKey(c.key)}
      title={c.label}
    >
      <span className="material-icons sidebar-item-icon">{c.icon}</span>
      <span className="sidebar-item-label">{c.label}</span>
    </div>
  )

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
        <aside className="doc-browser-sidebar">
          <div className="sidebar-section-label">Local</div>
          {categories.filter(c => c.domain === 'local').map(renderCategory)}
          {cloudAvailable && (
            <>
              <div className="sidebar-section-label">Cloud</div>
              {categories.filter(c => c.domain === 'cloud').map(renderCategory)}
            </>
          )}
        </aside>
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
                    <DocTilePreview doc={doc} store={activeCategory.store} />
                  </div>
                  <div className="doc-tile-info">
                    <span
                      className="doc-tile-name"
                      title={doc.owner_username ? `${doc.owner_username}/${doc.name}` : doc.name}
                    >
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
