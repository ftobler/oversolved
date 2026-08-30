import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import type { DocumentSort } from '@/hooks/useUserPreferences'
import { errorMessage } from '@/utils/core/errorMessage'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { exportBundle, importBundle, importStepFile } from '@/stores/documentStore'
import type { DocSummary, TrashDoc } from '@/stores/documentStore'
import { backendBundle } from '@/adapters/backend'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import { stringify as stringifyYaml } from 'yaml'
import { emptyAssemblyDoc } from '@/utils/assemblyMutations'
import '@/pages/Documents.css'

function stopClick(handler: () => void): React.MouseEventHandler {
  return (e) => {
    e.preventDefault()
    e.stopPropagation()
    handler()
  }
}

type DocumentMeta = DocSummary

// The document library, and the Trash it deletes into. They are two faces of one
// store -- a delete moves a document from the first to the second -- so they
// share a page and a sidebar rather than being separate routes.
export default function Documents() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [newDocKind, setNewDocKind] = useState<'part' | 'assembly'>('part')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [isTrashView, setIsTrashView] = useState(false)
  const [trashDocs, setTrashDocs] = useState<TrashDoc[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<{ uuid: string; name: string } | null>(null)
  const { preferences, updatePreference } = useUserPreferences()
  const sortBy = preferences.document_sort

  const store = backendBundle.documents
  // The recover/purge face of the same store's soft delete: what
  // handleDeleteDocument tombstones is exactly what this lists.
  const trash = backendBundle.localTrash

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const sortToStoreParam = (sort: DocumentSort): string => {
    if (sort === 'date_newest_first') return 'modified'
    if (sort === 'date_oldest_first') return 'modified_asc'
    return 'name'
  }

  // Guards against a stale list response winning the race: a sort or search
  // change fires a fresh list while the previous one may still be in flight, and
  // nothing promises they resolve in order. Only the latest request sets state.
  //
  // The tiles already on screen stay mounted while that request runs -- there is
  // no loading flip on refetch. Every refetch here is a revalidation of the same
  // library, and blanking the grid for it flashes an empty page over content
  // that is about to come back nearly identical.
  const listReqRef = useRef(0)
  const fetchDocuments = useCallback((search: string = '') => {
    const reqId = ++listReqRef.current
    store.list({ sort: sortToStoreParam(sortBy), search })
      .then(documents => {
        if (reqId !== listReqRef.current) return
        setDocuments(documents)
        setError(null)
        setLoading(false)
      })
      .catch(e => {
        if (reqId !== listReqRef.current) return
        setError(errorMessage(e, 'Failed to load documents'))
        setLoading(false)
      })
  }, [sortBy, store])

  useEffect(() => {
    fetchDocuments(debouncedSearch)
  }, [debouncedSearch, fetchDocuments])

  const handleAddDocument = async () => {
    if (!newDocName.trim()) {
      setAddError('Document name cannot be empty')
      return
    }

    try {
      const { uuid } = await store.create(newDocName.trim())
      // `create` always makes an empty document, and empty content parses to a
      // part (DocumentPage routes on `kind`). An assembly is therefore a create
      // + save of its seed content, the same two-step handleImportFile uses, so
      // the store never learns what a `kind` is.
      if (newDocKind === 'assembly') {
        await store.save(uuid, { content: stringifyYaml(emptyAssemblyDoc()) })
      }
      setNewDocName('')
      setShowAddForm(false)
      setAddError(null)
      fetchDocuments(debouncedSearch)
    } catch (e) {
      setAddError(errorMessage(e, 'Failed to create document'))
    }
  }

  const handleDeleteDocument = async (uuid: string) => {
    try {
      await store.remove(uuid)
      fetchDocuments(debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to delete document'))
    }
  }

  const handleDuplicate = async (uuid: string) => {
    try {
      await store.duplicate(uuid)
      fetchDocuments(debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to duplicate document'))
    }
  }

  const handleExport = async (uuid: string, name: string) => {
    try {
      const content = (await store.load(uuid)).content
      const blob = new Blob([content], { type: 'text/yaml' })
      downloadBlob(blob, `${name}.yaml`)
    } catch (e) {
      setError(errorMessage(e, 'Failed to export document'))
    }
  }

  // Whole-library backup: every document into one .oversolved bundle. Documents
  // live only in this browser's IndexedDB, so this is the one way to get them
  // onto disk or onto another machine -- clearing site data is otherwise final.
  const handleExportAll = async () => {
    try {
      const all = await store.list()
      if (all.length === 0) {
        setError('No documents to export')
        return
      }
      const blob = await exportBundle(store, all.map(d => d.uuid))
      downloadBlob(blob, `oversolved-backup-${new Date().toISOString().slice(0, 10)}.oversolved`)
    } catch (e) {
      setError(errorMessage(e, 'Failed to export documents'))
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''  // allow re-importing the same file

    // A bundle (.oversolved/.zip) round-trips through the store; a bare .yaml
    // stays on the single-document import path.
    if (/\.(oversolved|zip)$/i.test(file.name)) {
      try {
        await importBundle(store, file)
        fetchDocuments(debouncedSearch)
      } catch (err) {
        setError(errorMessage(err, 'Failed to import file'))
      }
      return
    }

    // A STEP file becomes a fresh document whose content is a single
    // import_step feature carrying the inline base64 bytes, decoded by the WASM
    // kernel. Same shape Part.tsx produces on import.
    if (/\.(step|stp)$/i.test(file.name)) {
      try {
        await importStepFile(store, file)
        fetchDocuments(debouncedSearch)
      } catch (err) {
        setError(errorMessage(err, 'Failed to import STEP file'))
      }
      return
    }

    const name = file.name.replace(/\.yaml$/, '').replace(/\.yml$/, '')
    if (!name) {
      setError('Invalid filename')
      return
    }

    try {
      const text = await file.text()
      const { uuid } = await store.create(name)
      await store.save(uuid, { content: text })
      fetchDocuments(debouncedSearch)
    } catch (err) {
      setError(errorMessage(err, 'Failed to import document'))
    }
  }

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true)
    try {
      setTrashDocs(await trash.list())
    } catch (e) {
      setError(errorMessage(e, 'Failed to load trash'))
    } finally {
      setTrashLoading(false)
    }
  }, [trash])

  const handleRecover = async (uuid: string) => {
    try {
      await trash.recover(uuid)
      fetchTrash()
      fetchDocuments(debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to recover document'))
    }
  }

  const handlePermanentDelete = async (uuid: string, name: string) => {
    setPermanentDeleteTarget({ uuid, name })
  }

  const handlePermanentDeleteConfirm = async () => {
    const target = permanentDeleteTarget
    if (!target) return
    setPermanentDeleteTarget(null)
    try {
      await trash.purge(target.uuid)
      fetchTrash()
    } catch (e) {
      setError(errorMessage(e, 'Failed to delete document'))
    }
  }

  // Two entries, no section label above them: a divider names a group only when
  // there is a second group to tell it apart from.
  type SidebarEntry = { label: string; icon: string; trash: boolean }

  const entries: SidebarEntry[] = [
    { label: 'Documents', icon: 'folder', trash: false },
    { label: 'Trash', icon: 'delete_outline', trash: true },
  ]

  const selectEntry = (e: SidebarEntry) => {
    setIsTrashView(e.trash)
    if (e.trash) fetchTrash()
  }

  const renderEntry = (e: SidebarEntry) => (
    <div
      key={e.label}
      className={`sidebar-item ${isTrashView === e.trash ? 'active' : ''}`}
      onClick={() => selectEntry(e)}
      title={e.label}
    >
      <span className="material-icons sidebar-item-icon">{e.icon}</span>
      <span className="sidebar-item-label">{e.label}</span>
    </div>
  )

  return (
    <div className="documents">
      <AppHeader title="Documents">
        <div className="doc-controls">
          <div className="search-input-container">
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
              >
                <span className="material-icons">close</span>
              </button>
            )}
          </div>
          <button
            className="toolbar-btn"
            onClick={() => {
              const cycle: DocumentSort[] = ['alphabetical', 'date_newest_first', 'date_oldest_first']
              const next = cycle[(cycle.indexOf(sortBy) + 1) % cycle.length]
              updatePreference('document_sort', next)
            }}
            title={
              sortBy === 'alphabetical' ? 'Sort: A-Z (click for newest first)' :
              sortBy === 'date_newest_first' ? 'Sort: Newest first (click for oldest first)' :
              'Sort: Oldest first (click for A-Z)'
            }
          >
            <span className="material-icons">
              {sortBy === 'alphabetical' ? 'sort_by_alpha' : sortBy === 'date_newest_first' ? 'update' : 'history'}
            </span>
          </button>
          <button className="toolbar-btn" onClick={() => { setShowAddForm(!showAddForm); setNewDocKind('part') }} title="Add part">
            <span className="material-icons">add</span>
          </button>
          <button className="toolbar-btn" onClick={() => { setShowAddForm(!showAddForm); setNewDocKind('assembly') }} title="Add assembly">
            <span className="material-icons">account_tree</span>
          </button>
          <label className="toolbar-btn btn-import" title="Import STEP, YAML, or .oversolved bundle">
            <input
              type="file"
              accept=".step,.stp,.yaml,.yml,.oversolved,.zip"
              onChange={handleImportFile}
              className="file-upload-input"
            />
            <span className="material-icons">upload</span>
          </label>
          <button className="toolbar-btn" onClick={handleExportAll} title="Export all as .oversolved bundle">
            <span className="material-icons">archive</span>
          </button>
        </div>
      </AppHeader>

      <div className="documents-layout">
        <aside className="documents-sidebar">
          {entries.map(renderEntry)}
        </aside>

        <div className="documents-main">
          <Dialog
            isOpen={showAddForm}
            title={newDocKind === 'assembly' ? 'Create New Assembly' : 'Create New Part'}
            onClose={() => setShowAddForm(false)}
            onConfirm={handleAddDocument}
            confirmLabel="Create"
          >
            <input
              type="text"
              placeholder={newDocKind === 'assembly' ? 'Assembly name' : 'Document name'}
              value={newDocName}
              onChange={e => {
                setNewDocName(e.target.value)
                if (e.target.value.trim()) setAddError(null)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddDocument()
                if (e.key === 'Escape') setShowAddForm(false)
              }}
              autoFocus
            />
            {addError && <p className="error-text">{addError}</p>}
          </Dialog>

          <MessageDialog
            isOpen={permanentDeleteTarget != null}
            title="Permanently Delete"
            message={`Permanently delete "${permanentDeleteTarget?.name}"? This cannot be undone.`}
            variant="error"
            onClose={() => setPermanentDeleteTarget(null)}
            onConfirm={handlePermanentDeleteConfirm}
            confirmLabel="Delete"
            cancelLabel="Cancel"
          />

          {isTrashView ? (
            <>
              {trashLoading && <p className="status">Loading trash...</p>}
              {!trashLoading && trashDocs.length === 0 && (
                <p className="status">Trash is empty.</p>
              )}
              {!trashLoading && trashDocs.length > 0 && (
                <div className="doc-tiles">
                  {trashDocs.map(doc => (
                      <div key={doc.uuid} className="doc-tile">
                        <div className="doc-tile-link">
                          <div className="doc-tile-preview">
                            <DocTilePreview doc={doc} store={store} />
                          </div>
                          <div className="doc-tile-info">
                            <span className="doc-tile-name" title={doc.name}>
                              {doc.name}
                            </span>
                          </div>
                          <div className="doc-tile-meta">
                            <span className="doc-tile-date">
                              Deleted: {formatRelativeDate(doc.deleted_at)}
                            </span>
                            <div className="doc-tile-actions">
                              <button
                                className="btn btn-tile-action"
                                onClick={() => handleRecover(doc.uuid)}
                                title="Recover document"
                              >
                                <span className="material-icons">restore</span>
                              </button>
                              <button
                                className="btn btn-delete-tile"
                                onClick={() => handlePermanentDelete(doc.uuid, doc.name)}
                                title="Permanently delete"
                              >
                                <span className="material-icons">delete_forever</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}

                </div>
              )}
            </>
          ) : (
            <>
              {loading && <p className="status">Loading documents...</p>}
              {error && <ErrorBanner message={`Error: ${error}`} onDismiss={() => setError(null)} />}
              {!loading && documents.length === 0 && debouncedSearch && (
                <p className="status">No documents match "{debouncedSearch}"</p>
              )}
              {!loading && documents.length === 0 && !debouncedSearch && (
                <p className="status">No documents yet.</p>
              )}

              {!loading && documents.length > 0 && (
                <div className="doc-tiles">
                  {documents.map(doc => (
                    <div key={doc.uuid} className="doc-tile">
                      <Link to={`/documents/${doc.uuid}`} className="doc-tile-link">
                        <div className="doc-tile-preview">
                          <DocTilePreview doc={doc} store={store} />
                        </div>
                        <div className="doc-tile-info">
                          <span className="doc-tile-name" title={doc.name}>
                            {doc.name}
                          </span>
                        </div>
                        <div className="doc-tile-meta">
                          <span className="doc-tile-date">{formatRelativeDate(doc.updated_at)}</span>
                          <div className="doc-tile-actions">
                            <button
                              className="btn btn-tile-action"
                              onClick={stopClick(() => handleDuplicate(doc.uuid))}
                              title="Duplicate"
                            >
                              <span className="material-icons">content_copy</span>
                            </button>
                            <button
                              className="btn btn-tile-action"
                              onClick={stopClick(() => handleExport(doc.uuid, doc.name))}
                              title="Export YAML"
                            >
                              <span className="material-icons">download</span>
                            </button>
                            <button
                              className="btn btn-delete-tile"
                              onClick={stopClick(() => handleDeleteDocument(doc.uuid))}
                              title="Delete document"
                            >
                              <span className="material-icons">delete</span>
                            </button>
                          </div>
                        </div>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
