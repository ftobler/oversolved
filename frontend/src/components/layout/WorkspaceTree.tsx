import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Dialog from '@/components/dialogs/Dialog'
import { getWorkspaceStore } from '@/workspace/store'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'
import type { EntryMeta } from '@/workspace/types'
import { randomUuid } from '@/utils/randomUuid'
import { dirtyEntryIds, groupEntries, isOpenEntry } from './workspaceTreeModel'
import { treeRowKeyDown } from './treeRowKeyDown'

// U2: the workspace navigator. It reads the live session and re-reads on every
// store mutation, holds no optimistic list state, and routes every mutation
// through the existing store verbs. The open entry is the route's entryId.
const EMPTY_ENTRIES: EntryMeta[] = []
const EMPTY_REVS = new Map<string, number>()

export function WorkspaceTree() {
  const session = useWorkspaceSessionStore(s => s.session)
  const revision = useSyncExternalStore(subscribeWorkspaceStore, workspaceStoreRevision)
  const { workspaceId: routeWorkspace, entryId } = useParams<{ workspaceId?: string; entryId?: string }>()
  const navigate = useNavigate()
  const store = getWorkspaceStore()

  const [loadedEntries, setLoadedEntries] = useState<EntryMeta[]>(EMPTY_ENTRIES)
  const [loadedRevs, setLoadedRevs] = useState<Map<string, number>>(EMPTY_REVS)
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'part' | 'assembly'>('part')
  const [renameTarget, setRenameTarget] = useState<EntryMeta | null>(null)
  const [renameName, setRenameName] = useState('')

  const workspace = session?.workspace ?? routeWorkspace

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const load = async () => {
      try {
        const [list, revs] = await Promise.all([session.listEntries(), session.savedRevs()])
        if (!cancelled) {
          setLoadedEntries(list)
          setLoadedRevs(revs)
        }
      } catch {
        // A workspace that cannot be listed shows the empty state; the page
        // above owns the loud error.
        if (!cancelled) setLoadedEntries(EMPTY_ENTRIES)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [session, revision])

  const entries = session ? loadedEntries : EMPTY_ENTRIES
  const savedRevs = session ? loadedRevs : EMPTY_REVS
  const grouped = useMemo(() => groupEntries(entries), [entries])
  const dirty = useMemo(() => dirtyEntryIds(entries, savedRevs), [entries, savedRevs])

  const openEntry = (entry: EntryMeta) => {
    if (!workspace) return
    navigate(`/workspaces/${workspace}/entries/${entry.id}`)
  }

  const handleAdd = async () => {
    if (!workspace || !session || !newName.trim()) return
    const id = randomUuid()
    await store.addEntry(workspace, { id, kind: 'document', name: newName.trim(), docKind: newKind, text: '' })
    setAddOpen(false)
    setNewName('')
    navigate(`/workspaces/${workspace}/entries/${id}`)
  }

  const handleRename = async () => {
    if (!workspace || !renameTarget || !renameName.trim()) return
    await store.renameEntry(workspace, renameTarget.id, renameName.trim())
    setRenameTarget(null)
    setRenameName('')
  }

  const handleDuplicate = async (entry: EntryMeta) => {
    if (!workspace) return
    await store.cloneEntry(workspace, entry.id)
  }

  const handleDelete = async (entry: EntryMeta) => {
    if (!workspace) return
    // A soft delete. If the deleted entry is the one on screen, the route must
    // leave it before the store event re-lists, or the editor would read a
    // trashed id.
    if (entryId === entry.id) navigate(`/workspaces/${workspace}`)
    await store.removeEntry(workspace, entry.id)
  }

  return (
    <div className="workspace-tree">
      <div className="sidebar-header">
        <span>Workspace</span>
        <button
          type="button"
          className="workspace-add-btn"
          aria-label="Add entry"
          title="Add entry"
          onClick={() => { setNewKind('part'); setNewName(''); setAddOpen(true) }}
        >
          <span className="material-icons">add</span>
        </button>
      </div>
      {entries.length === 0 && <div className="empty">No entries yet.</div>}
      <div className="workspace-tree-scroll">
        <TreeGroup
          label="Parts"
          entries={grouped.parts}
          openId={entryId}
          dirty={dirty}
          onOpen={openEntry}
          onRename={entry => { setRenameTarget(entry); setRenameName(entry.name) }}
          onDuplicate={entry => { void handleDuplicate(entry) }}
          onDelete={entry => { void handleDelete(entry) }}
        />
        <TreeGroup
          label="Assemblies"
          entries={grouped.assemblies}
          openId={entryId}
          dirty={dirty}
          onOpen={openEntry}
          onRename={entry => { setRenameTarget(entry); setRenameName(entry.name) }}
          onDuplicate={entry => { void handleDuplicate(entry) }}
          onDelete={entry => { void handleDelete(entry) }}
        />
        <TreeGroup
          label="Other documents"
          entries={grouped.otherDocs}
          openId={entryId}
          dirty={dirty}
          onOpen={openEntry}
          onRename={entry => { setRenameTarget(entry); setRenameName(entry.name) }}
          onDuplicate={entry => { void handleDuplicate(entry) }}
          onDelete={entry => { void handleDelete(entry) }}
        />
        <TreeGroup
          label="Files"
          entries={grouped.files}
          openId={entryId}
          dirty={dirty}
          onOpen={openEntry}
          onRename={entry => { setRenameTarget(entry); setRenameName(entry.name) }}
          onDuplicate={entry => { void handleDuplicate(entry) }}
          onDelete={entry => { void handleDelete(entry) }}
        />
      </div>

      <Dialog
        isOpen={addOpen}
        title="Add Entry"
        onClose={() => setAddOpen(false)}
        onConfirm={() => { void handleAdd() }}
        confirmLabel="Add"
      >
        <input
          type="text"
          placeholder="Entry name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleAdd() }}
          autoFocus
        />
        <select value={newKind} onChange={e => setNewKind(e.target.value as 'part' | 'assembly')}>
          <option value="part">Part</option>
          <option value="assembly">Assembly</option>
        </select>
      </Dialog>

      <Dialog
        isOpen={renameTarget !== null}
        title="Rename Entry"
        onClose={() => setRenameTarget(null)}
        onConfirm={() => { void handleRename() }}
        confirmLabel="Rename"
      >
        <input
          type="text"
          value={renameName}
          onChange={e => setRenameName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleRename() }}
          autoFocus
        />
      </Dialog>
    </div>
  )
}

interface TreeGroupProps {
  label: string
  entries: EntryMeta[]
  openId: string | undefined
  dirty: Set<string>
  onOpen: (entry: EntryMeta) => void
  onRename: (entry: EntryMeta) => void
  onDuplicate: (entry: EntryMeta) => void
  onDelete: (entry: EntryMeta) => void
}

// One listbox per document-kind group plus files. Rows are keyboard reachable
// on the AssemblyTree precedent: role=option, tabIndex 0, Enter/Space to open.
function TreeGroup({ label, entries, openId, dirty, onOpen, onRename, onDuplicate, onDelete }: TreeGroupProps) {
  if (entries.length === 0) return null
  return (
    <div className="workspace-group">
      <div className="workspace-group-label">{label}</div>
      <ul className="workspace-list" role="listbox" aria-label={label}>
        {entries.map(entry => {
          const open = isOpenEntry(entry, openId)
          return (
            <li
              key={entry.id}
              className={`workspace-row${open ? ' open' : ''}`}
              role="option"
              tabIndex={0}
              aria-selected={open}
              onClick={() => onOpen(entry)}
              onKeyDown={e => treeRowKeyDown(e, () => onOpen(entry))}
            >
              <span className="workspace-row-name" title={entry.name}>{entry.name}</span>
              {dirty.has(entry.id) && <span className="workspace-dirty-dot" title="Changed since last save" />}
              <span className="workspace-row-actions">
                <button
                  type="button"
                  className="workspace-row-btn"
                  aria-label={`Rename ${entry.name}`}
                  title="Rename"
                  onClick={e => { e.stopPropagation(); onRename(entry) }}
                >
                  <span className="material-icons">edit</span>
                </button>
                <button
                  type="button"
                  className="workspace-row-btn"
                  aria-label={`Duplicate ${entry.name}`}
                  title="Duplicate"
                  onClick={e => { e.stopPropagation(); onDuplicate(entry) }}
                >
                  <span className="material-icons">content_copy</span>
                </button>
                <button
                  type="button"
                  className="workspace-row-btn"
                  aria-label={`Delete ${entry.name}`}
                  title="Delete"
                  onClick={e => { e.stopPropagation(); onDelete(entry) }}
                >
                  <span className="material-icons">delete</span>
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
