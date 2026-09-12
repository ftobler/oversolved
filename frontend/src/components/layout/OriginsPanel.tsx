import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { OriginResolver } from '@/workspace/originResolver'
import type { OriginStatus } from '@/workspace/import'
import { originState, updateFromOrigin } from '@/workspace/import'
import type { ProvenanceRecord, EntryMeta } from '@/workspace/types'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'

// U6: the origins panel. One row per local entry that was imported from
// outside, with its locator, the recorded source hash, whether the local copy
// was edited, and an explicit per-row pull. Status is computed only under the
// explicit check: a mount or a solve never resolves an origin (I2). An
// unreachable origin is a neutral chip, never an error (I1 made visible).
const EMPTY_RECORDS: ProvenanceRecord[] = []
const EMPTY_ENTRIES: EntryMeta[] = []
const STATUS_LABEL: Record<PanelStatus, string> = {
  unknown: 'Not checked',
  current: 'Up to date',
  changed: 'Origin changed',
  unreachable: 'Origin unavailable',
  'not-updatable': 'Not updatable',
}

type PanelStatus = OriginStatus | 'unknown'

interface OriginsPanelProps {
  // Injected by tests; the shipped panel uses the module resolver, whose only
  // read is the explicit check and update.
  resolver?: OriginResolver
}

export function OriginsPanel({ resolver }: OriginsPanelProps = {}) {
  const session = useWorkspaceSessionStore(s => s.session)
  const revision = useSyncExternalStore(subscribeWorkspaceStore, workspaceStoreRevision)
  const [records, setRecords] = useState<ProvenanceRecord[]>(EMPTY_RECORDS)
  const [entries, setEntries] = useState<EntryMeta[]>(EMPTY_ENTRIES)
  const [statuses, setStatuses] = useState<Map<string, PanelStatus>>(new Map())
  const [notices, setNotices] = useState<Map<string, string>>(new Map())
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const load = async () => {
      try {
        const [prov, list] = await Promise.all([session.provenance(), session.listEntries()])
        if (!cancelled) {
          setRecords(prov)
          setEntries(list)
        }
      } catch {
        if (!cancelled) {
          setRecords(EMPTY_RECORDS)
          setEntries(EMPTY_ENTRIES)
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [session, revision])

  const byId = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries])
  const live = session ? records : EMPTY_RECORDS

  const handleCheck = async () => {
    if (!session) return
    setChecking(true)
    try {
      const next = new Map<string, PanelStatus>()
      for (const record of live) {
        const localHash = byId.get(record.entry)?.contentHash
        const state = await originState(record, localHash, resolver)
        next.set(record.entry, state.status)
      }
      setStatuses(next)
    } finally {
      setChecking(false)
    }
  }

  const handleUpdate = async (record: ProvenanceRecord) => {
    if (!session) return
    setBusy(record.entry)
    try {
      const result = await updateFromOrigin(session.workspace, record.entry, resolver)
      // A pull that could not reach the source or find the recorded entry writes
      // nothing; the panel says so rather than leaving the click unanswered.
      const notice = result.unreachable
        ? 'Origin unavailable; nothing was updated.'
        : result.sourceMissing
          ? 'The source entry is gone; nothing was updated.'
          : ''
      setNotices(previous => new Map(previous).set(record.entry, notice))
      // store.save bumps the store revision, so the records reload.
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="origins-panel">
      <div className="sidebar-header">
        <span>Origins</span>
        {live.length > 0 && (
          <button
            type="button"
            className="origins-check-btn"
            aria-label="Check for updates"
            title="Check for updates"
            onClick={() => { void handleCheck() }}
            disabled={checking}
          >
            <span className="material-icons">refresh</span>
          </button>
        )}
      </div>
      {live.length === 0 && <div className="empty">Nothing was imported from outside.</div>}
      <ul className="origins-list" role="list" aria-label="Origins">
        {live.map(record => {
          const entry = byId.get(record.entry)
          const status = statuses.get(record.entry) ?? 'unknown'
          const editedLocally = record.hash !== undefined
            && entry?.contentHash !== undefined
            && entry.contentHash !== record.hash
          // Not updatable and unreachable can never pull; a current origin can
          // still be pulled to reset a local edit, which the title warns
          // overwrites. A changed origin is always pullable.
          const canUpdate = status !== 'not-updatable' && status !== 'unreachable'
            && (status === 'changed' || editedLocally)
          const updateTitle = status === 'not-updatable'
            ? 'No recorded source entry; this copy cannot be updated.'
            : status === 'unreachable'
              ? 'Origin unavailable.'
              : editedLocally
                ? 'Updating overwrites your local edits.'
                : status === 'current'
                  ? 'Already up to date.'
                  : 'Pull the source changes.'
          const notice = notices.get(record.entry)
          return (
            <li key={record.entry} className="origin-item">
              <div className="origin-item-title">
                <span className="origin-name" title={entry?.name ?? record.entry}>
                  {entry?.name ?? record.entry}
                </span>
                <span className={`origin-status origin-status-${status}`}>
                  {STATUS_LABEL[status]}
                </span>
              </div>
              <div className="origin-locator" title={record.originName ?? record.origin}>
                {record.originName ?? record.origin}
              </div>
              <div className="origin-meta">
                {record.rev !== undefined && <span className="origin-rev">rev {record.rev}</span>}
                {record.hash !== undefined && <span className="origin-hash">{record.hash.slice(0, 12)}</span>}
                {editedLocally && <span className="origin-edited">edited locally</span>}
              </div>
              {notice && <div className="origin-notice" role="status">{notice}</div>}
              <button
                type="button"
                className="origin-update-btn"
                aria-label={`Update ${entry?.name ?? record.entry}`}
                title={updateTitle}
                disabled={!canUpdate || busy === record.entry}
                onClick={() => { void handleUpdate(record) }}
              >
                Update
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
