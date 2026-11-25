import { useEffect, useState } from 'react'
import MessageDialog from '@/components/dialogs/MessageDialog'
import WorkspacePickerDialog from '@/components/dialogs/WorkspacePickerDialog'
import { errorMessage } from '@/utils/core/errorMessage'
import { describeEntryMove, type EntryMovePlan } from '@/workspace/entryMove'
import type { EntryMoveReport, WorkspaceStore, WorkspaceSummary } from '@/workspace/store'
import type { EntryMeta } from '@/workspace/types'

interface WorkspaceEntryMoveProps {
  store: WorkspaceStore
  workspace: string
  // The row being moved; null while no move is under way.
  entry: EntryMeta | null
  // The workspace's rows, which name the parts and files a plan carries.
  entries: readonly EntryMeta[]
  onClose: () => void
  onMoved: (report: EntryMoveReport) => void
}

// The "Move to workspace" flow for one row: pick the target in the workspace
// browser, read the plan, confirm when more than the entry travels, then move.
// A refusal (still used here, an earlier copy in the target) stays in the
// picker's error line, so another workspace can be picked without reopening.
export default function WorkspaceEntryMove({ store, workspace, entry, entries, onClose, onMoved }: WorkspaceEntryMoveProps) {
  const [workspaces, setWorkspaces] = useState<{ for: string; rows: WorkspaceSummary[] } | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The confirm step: the target and the sentence naming what travels.
  const [confirm, setConfirm] = useState<{ target: string; message: string; plan: EntryMovePlan } | null>(null)
  const open = entry !== null
  const entryId = entry?.id ?? null

  // One fresh read per opened row, so a workspace created or trashed since the
  // page loaded is listed (or not) as the library would list it.
  useEffect(() => {
    if (entryId === null) return
    let cancelled = false
    store.list().then(
      rows => { if (!cancelled) setWorkspaces({ for: entryId, rows }) },
      e => { if (!cancelled) setListError(errorMessage(e, 'Failed to list the workspaces')) },
    )
    return () => { cancelled = true }
  }, [store, entryId])

  const reset = () => {
    setWorkspaces(null)
    setListError(null)
    setNotice(null)
    setConfirm(null)
    setBusy(false)
  }

  const close = () => {
    if (busy) return
    reset()
    onClose()
  }

  const names = new Map(entries.map(row => [row.id, row.name]))

  const move = async (target: string, confirmed: EntryMovePlan) => {
    if (!entry) return
    setBusy(true)
    try {
      const report = await store.moveEntry(workspace, entry.id, target, confirmed)
      reset()
      onMoved(report)
    } catch (e) {
      setConfirm(null)
      setNotice(errorMessage(e, `Failed to move ${entry.name}`))
      setBusy(false)
    }
  }

  const pick = async (target: string) => {
    if (!entry || busy) return
    setNotice(null)
    setBusy(true)
    let plan: EntryMovePlan
    let message: string | null
    try {
      const result = await store.planMove(workspace, entry.id, target)
      if (!result.ok) {
        setNotice(result.refused)
        setBusy(false)
        return
      }
      plan = result
      message = describeEntryMove(plan, id => names.get(id) ?? id)
    } catch (e) {
      setNotice(errorMessage(e, `Failed to move ${entry.name}`))
      setBusy(false)
      return
    }
    if (message === null) {
      await move(target, plan)
      return
    }
    setBusy(false)
    setConfirm({ target, message, plan })
  }

  const rows = workspaces !== null && workspaces.for === entryId ? workspaces.rows : null

  return (
    <>
      <WorkspacePickerDialog
        isOpen={open && confirm === null}
        currentWorkspace={workspace}
        workspaces={rows}
        listError={listError}
        notice={notice}
        busy={busy}
        onClose={close}
        onSelect={() => setNotice(null)}
        onPick={target => { void pick(target) }}
      />
      <MessageDialog
        isOpen={open && confirm !== null}
        title="Move to workspace"
        message={confirm?.message ?? ''}
        onClose={() => { if (!busy) setConfirm(null) }}
        onConfirm={() => { if (confirm) void move(confirm.target, confirm.plan) }}
        confirmLabel="Move"
        cancelLabel="Back"
        busy={busy}
      />
    </>
  )
}
