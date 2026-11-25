import { useMemo } from 'react'
import TilePickerDialog, { type TilePickerGroup, type TilePickerItem } from '@/components/dialogs/TilePickerDialog'
import type { WorkspaceSummary } from '@/workspace/store'

interface WorkspacePickerDialogProps {
  isOpen: boolean
  // The workspace the entry is in now, left out of the tiles.
  currentWorkspace: string
  // The live workspaces in the browser's order. Null while the read is out.
  workspaces: readonly WorkspaceSummary[] | null
  listError?: string | null
  // The move's refusal for the picked workspace; the dialog stays open on it.
  notice?: string | null
  busy?: boolean
  onClose: () => void
  onSelect?: (workspace: string) => void
  onPick: (workspace: string) => void
}

const GROUPS: readonly TilePickerGroup[] = [{ key: 'workspace', label: 'Workspaces' }]

// "Move to workspace": the insert-part browser over workspaces instead of
// documents. Each tile is a workspace's library tile (its cover preview, name
// and modified date), in the order the library lists them.
export default function WorkspacePickerDialog({
  isOpen, currentWorkspace, workspaces, listError = null, notice = null, busy = false,
  onClose, onSelect, onPick,
}: WorkspacePickerDialogProps) {
  const items = useMemo((): TilePickerItem[] => (workspaces ?? [])
    .filter(summary => summary.workspace !== currentWorkspace && summary.trashedAt === undefined)
    .map(summary => ({
      id: summary.workspace,
      name: summary.name,
      group: 'workspace',
      preview: { workspace: summary.workspace, entry: summary.coverEntry ?? summary.workspace },
      updatedAt: summary.updatedAt,
    })), [workspaces, currentWorkspace])

  return (
    <TilePickerDialog
      isOpen={isOpen}
      title="Move to workspace"
      icon="drive_file_move"
      confirmLabel="Move"
      searchPlaceholder="Search workspaces..."
      emptyText="There is no other workspace to move to."
      itemNoun="workspaces"
      items={items}
      groups={GROUPS}
      loading={workspaces === null && !listError}
      error={listError}
      notice={notice}
      busy={busy}
      onClose={onClose}
      onSelect={onSelect}
      onPick={item => onPick(item.id)}
    />
  )
}
