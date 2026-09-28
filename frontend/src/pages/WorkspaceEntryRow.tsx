import DocTilePreview from '@/components/shared/DocTilePreview'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import { formatBytes } from '@/utils/formatBytes'
import { fileKindOf, fileSizeOf } from '@/components/layout/filesModel'
import {
  ORIGIN_STATUS_LABEL,
  originLabel,
  originUpdatePolicy,
  type RowOriginStatus,
} from '@/components/layout/originsModel'
import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'

interface EntryRowProps {
  entry: EntryMeta
  workspace: string
  dirty: boolean
  deleting: boolean
  duplicating: boolean
  replacing: boolean
  updating: boolean
  exporting: boolean
  usedBy: string[] | undefined
  // The stored provenance record, on the rows that have one. Its presence is
  // what puts the origin meta and the pull control on a row: an entry made here
  // has no source to name and nothing to pull from.
  origin: ProvenanceRecord | undefined
  status: RowOriginStatus
  onOpen: (entry: EntryMeta) => void
  onRename: (entry: EntryMeta) => void
  onDuplicate: (entry: EntryMeta) => void
  onExport: (entry: EntryMeta) => void
  onDelete: (entry: EntryMeta) => void
  onReplace: (entry: EntryMeta, chosen: File) => void
  onUpdate: (entry: EntryMeta, origin: ProvenanceRecord) => void
}

// The library tile on its side. A document row is activatable (click, Enter,
// Space); a file row is not -- it carries the same thumb slot and verbs but
// there is no editor behind it.
export default function EntryRow({
  entry, workspace, dirty, deleting, duplicating, replacing, updating, exporting, usedBy, origin, status,
  onOpen, onRename, onDuplicate, onExport, onDelete, onReplace, onUpdate,
}: EntryRowProps) {
  const openable = entry.kind === 'document'
  const policy = origin
    ? originUpdatePolicy(origin, entry, status)
    : { canUpdate: false, title: '', edited: false }
  const meta = entry.kind === 'file'
    ? [fileKindOf(entry), formatBytes(fileSizeOf(entry))]
    : [entry.docKind ?? 'document', entry.updatedAt ? formatRelativeDate(new Date(entry.updatedAt).toISOString()) : '']

  // The openable surface is a real <button> INSIDE the row rather than a role on
  // the row itself: the row also holds three controls, and a role="button"
  // wrapping them is nested-interactive -- it swallows the list item and makes a
  // screen reader announce the row's whole contents, controls included, as one
  // button's name. A real button also brings Enter and Space with it.
  const face = (
    <>
      <div className="doc-tile-preview workspace-entry-preview">
        <DocTilePreview workspace={workspace} entry={entry.id} name={entry.name} />
      </div>
      <div className="workspace-entry-body">
        <div className="workspace-entry-title">
          <span className="workspace-entry-name" title={entry.name}>{entry.name}</span>
          {dirty && <span className="workspace-entry-dot" role="img" aria-label="Changed since last save" />}
        </div>
        <div className="workspace-entry-meta">
          {meta.filter(Boolean).map(text => <span key={text}>{text}</span>)}
        </div>
        {usedBy && usedBy.length > 0 && (
          <div className="workspace-entry-usedby" title={`Used by ${usedBy.join(', ')}`}>
            used by {usedBy.join(', ')}
          </div>
        )}
        {origin && (
          <div className="workspace-entry-origin">
            <span className="workspace-entry-origin-name" title={originLabel(origin)}>
              {originLabel(origin)}
            </span>
            <span className={`workspace-entry-origin-status status-${status}`}>
              {ORIGIN_STATUS_LABEL[status]}
            </span>
            {origin.rev !== undefined && <span>rev {origin.rev}</span>}
            {policy.edited && <span className="workspace-entry-origin-edited">edited locally</span>}
          </div>
        )}
      </div>
    </>
  )

  return (
    <li className={`workspace-entry-row${openable ? ' openable' : ''}`}>
      {openable ? (
        // The label is the entry's name and nothing else. Without it the
        // button's accessible name is every scrap of text inside it, and the
        // row has grown four of them: a screen reader announced "Bracket
        // changed since last save part 2 days ago used by Gearbox cad not
        // checked rev 3 edited locally" as the name of one button. The text
        // itself stays where it is and stays readable; it just is not the name
        // of the verb.
        <button type="button" className="workspace-entry-open" aria-label={entry.name} onClick={() => onOpen(entry)}>
          {face}
        </button>
      ) : (
        <div className="workspace-entry-open">{face}</div>
      )}
      <div className="workspace-entry-actions">
        {origin && (
          <button
            className="btn btn-tile-action"
            aria-label={`Update ${entry.name}`}
            title={policy.title}
            disabled={!policy.canUpdate || updating}
            onClick={() => onUpdate(entry, origin)}
          >
            <span className="material-icons">{updating ? 'hourglass_empty' : 'sync'}</span>
          </button>
        )}
        {entry.kind === 'file' && (
          // A label around a visually-hidden input, not a hidden one: the panel
          // this replaces used `display: none`, which takes the input out of the
          // tab order and leaves the label unfocusable, so replacing bytes was
          // reachable by mouse only. The input keeps its own focus ring through
          // `:focus-within` on the label.
          <label
            className="btn btn-tile-action workspace-entry-replace"
            title={replacing ? 'Replacing...' : 'Replace bytes'}
          >
            <input
              type="file"
              className="workspace-entry-replace-input"
              aria-label={`Replace ${entry.name}`}
              // aria-disabled, not disabled: a disabled input leaves the tab
              // order, so a keyboard user who started the replace would lose
              // focus to the body mid-gesture and land nowhere when it
              // finished. The guard that actually refuses the second pick is
              // the early return below.
              aria-disabled={replacing}
              onChange={e => {
                const chosen = e.target.files?.[0]
                // Clearing the value is what lets the same file be picked twice
                // in a row: an unchanged value fires no second change event.
                e.target.value = ''
                if (chosen && !replacing) onReplace(entry, chosen)
              }}
            />
            <span className="material-icons">{replacing ? 'hourglass_empty' : 'upload_file'}</span>
          </label>
        )}
        <button
          className="btn btn-tile-action"
          aria-label={`Rename ${entry.name}`}
          title="Rename"
          onClick={() => onRename(entry)}
        >
          <span className="material-icons">edit</span>
        </button>
        <button
          className="btn btn-tile-action"
          aria-label={`Duplicate ${entry.name}`}
          title="Duplicate"
          disabled={duplicating}
          onClick={() => onDuplicate(entry)}
        >
          <span className="material-icons">{duplicating ? 'hourglass_empty' : 'content_copy'}</span>
        </button>
        <button
          className="btn btn-tile-action"
          aria-label={`Export ${entry.name}`}
          title="Export"
          disabled={exporting}
          onClick={() => onExport(entry)}
        >
          <span className="material-icons">{exporting ? 'hourglass_empty' : 'download'}</span>
        </button>
        <button
          className="btn btn-delete-tile"
          aria-label={`Delete ${entry.name}`}
          title="Delete"
          disabled={deleting}
          onClick={() => onDelete(entry)}
        >
          <span className="material-icons">{deleting ? 'hourglass_empty' : 'delete'}</span>
        </button>
      </div>
    </li>
  )
}
