import { useEffect, useMemo } from 'react'
import TilePickerDialog, { type TilePickerGroup, type TilePickerItem } from '@/components/dialogs/TilePickerDialog'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'
import { interpretEntry } from '@/workspace/kinds'

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
  // A read is in flight. The dialog shows its spinner and cannot confirm while
  // true, so the previous rows are never offered against a list that may have
  // dropped one of them.
  refreshing: boolean
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

const GROUPS: readonly TilePickerGroup[] = [
  { key: 'part', label: 'Parts' },
  { key: 'assembly', label: 'Assemblies', icon: 'account_tree' },
]

// The pick source is parts and assemblies, through the same interpretation gate
// the editor uses. A document whose kind is missing or unknown is refused
// rather than coerced to a part.
function insertableKind(entry: EntryMeta): InsertableKind | null {
  const interpreted = interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind })
  if (!interpreted.ok) return null
  return interpreted.docKind === 'part' || interpreted.docKind === 'assembly' ? interpreted.docKind : null
}

// Picks a PartDoc or an AssemblyDoc to instance into the assembly, presented as
// a document browser (search + preview tiles) on the shared tile picker. It
// browses the open workspace's documents, minus the assembly itself, and
// carries no tile verbs (duplicate/export/delete): this dialog only browses and
// picks.
//
// The rows arrive from the editor instead of being fetched here. The editor's
// list is also where the add_part guard's live set comes from, so a tile the
// user can click is exactly a document the operation will accept; a second
// fetch could list a part the guard had not learned about and turn Insert into
// a silent refusal.
export default function AssemblyPartPicker({
  isOpen, selfUuid, session, entries, refreshing, listError, onRefresh, cycleReasonFor, onClose, onPick,
}: AssemblyPartPickerProps) {
  // The one fetch on this path is the editor's, freshened when the dialog
  // opens so the tiles and the guard both learn about a part added since mount.
  useEffect(() => {
    if (isOpen) onRefresh()
  }, [isOpen, onRefresh])

  const revs = useMemo(() => new Map((entries ?? []).map(entry => [entry.id, entry.rev ?? 0])), [entries])

  const items = useMemo((): TilePickerItem[] => (entries ?? [])
    .flatMap(entry => {
      const kind = entry.id === selfUuid ? null : insertableKind(entry)
      if (kind === null) return []
      const item: TilePickerItem = {
        id: entry.id,
        name: entry.name,
        group: kind,
        preview: { workspace: session?.workspace ?? selfUuid, entry: entry.id },
        updatedAt: entry.updatedAt,
      }
      const reason = kind === 'assembly' ? cycleReasonFor?.(entry.id) : undefined
      if (reason !== undefined) item.disabledReason = reason
      return [item]
    })
    .sort((a, b) => a.name.localeCompare(b.name)), [entries, selfUuid, session, cycleReasonFor])

  // A read in flight is a pending answer, so the grid is held back rather than
  // painted from the previous read. Null covers "no workspace bound" as well:
  // with nothing to list, the dialog settles into its empty state instead of
  // holding the spinner up.
  const loading = session !== null && (refreshing || (entries === null && !listError))

  return (
    <TilePickerDialog
      isOpen={isOpen}
      title="Insert part"
      icon="library_add"
      confirmLabel="Insert"
      searchPlaceholder="Search documents..."
      emptyText="No parts or assemblies available."
      itemNoun="documents"
      items={items}
      groups={GROUPS}
      loading={loading}
      error={listError ?? null}
      onClose={onClose}
      onPick={item => {
        // `rev` is recorded on the instance as placement provenance. The bundle
        // cache no longer keys on it (C5), so this is informational.
        onPick(item.id, revs.get(item.id) ?? 0)
        onClose()
      }}
    />
  )
}
