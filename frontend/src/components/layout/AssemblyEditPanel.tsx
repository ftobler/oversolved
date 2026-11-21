import type { ReactNode } from 'react'
import type { MateFeature, PartInstance } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { mateFailure, partFailure, type AssemblyMark } from '@/utils/core/assemblyStatus'
import type { EditingSubject } from '@/utils/assemblyEditingSubject'
import { MATE_KIND_LABELS } from '@/utils/mateKinds'
import { StatusPanel } from '@/components/shared/StatusPanel'
import { MATE_KIND_ICONS } from '@/components/layout/mateKindIcons'
import '@/components/layout/Glass.css'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import featurePartIcon from '@/assets/icons/feature-part.svg'

/**
 * The open assembly editor as a floating card on the right side of the stage,
 * the part editor's FeatureEditPanel in assembly terms: the subject's icon and
 * name over its OK / Cancel pair, then the same instance or mate editor the
 * tree row used to expand into. The row keeps its `editing` highlight and swaps
 * its pencil for its own OK / Cancel pair, so an edit can be ended at either
 * end; the form itself lives only here.
 *
 * Presentational: the subject, the doc data it resolves against and both editor
 * bodies arrive as props, so the panel (and its test) needs no viewport and no
 * store. The card reuses the part editor's `.feature-edit-panel*` classes, so
 * the two editors' open cards read identically; the subject's own status mark
 * is a separate card after it in the same column, exactly as a feature editor
 * draws it.
 */
export interface AssemblyEditPanelProps {
  editing: EditingSubject
  instances: readonly PartInstance[]
  mates: readonly MateFeature[]
  // The whole solve verdict, so the open subject's failure reads here the same
  // way it marks its tree row.
  status?: AssemblySolveStatus | null
  // A part handle's display name (the part document's name).
  labelFor?: (handle: string) => string | undefined
  onCommitInstance: () => void
  onCancelInstance: () => void
  onCommitMate: () => void
  onCancelMate: () => void
  renderInstanceEditor: (instance: PartInstance) => ReactNode
  renderMateEditor: (mate: MateFeature) => ReactNode
}

interface EditCardProps {
  icon: string
  alt: string
  title: string
  mark: AssemblyMark
  onCommit: () => void
  onCancel: () => void
  children: ReactNode
}

// The one card frame both subjects share. Splitting it out keeps the instance
// and mate branches below as plain data resolution, with no duplicated header.
function EditCard({ icon, alt, title, mark, onCommit, onCancel, children }: EditCardProps) {
  // Two siblings: the page mounts this inside the same right overlay stack the
  // part editor uses, so the status card follows the panel with that gap.
  return (
    <>
      <div className="glass-panel feature-edit-panel">
        <div className="feature-edit-panel-header">
          <img className="feature-icon" src={icon} alt={alt} />
          <span className="feature-edit-panel-title">{title}</span>
          <button className="feature-ok-btn" onClick={onCommit} title="OK">
            <img src={okIcon} alt="OK" />
          </button>
          <button className="feature-cancel-btn" onClick={onCancel} title="Cancel">
            <img src={cancelIcon} alt="Cancel" />
          </button>
        </div>
        <div className="feature-edit-panel-body">
          {children}
        </div>
      </div>
      <StatusPanel mark={mark} />
    </>
  )
}

export function AssemblyEditPanel({
  editing,
  instances,
  mates,
  status,
  labelFor,
  onCommitInstance,
  onCancelInstance,
  onCommitMate,
  onCancelMate,
  renderInstanceEditor,
  renderMateEditor,
}: AssemblyEditPanelProps) {
  // A subject the doc no longer holds (an undo, a reload, a delete) leaves
  // nothing to edit; the page's store reset closes the card too, so this is a
  // frame that must not draw rather than a second close path.
  if (editing.kind === 'instance') {
    const instance = instances.find(i => i.handle === editing.handle)
    if (!instance) return null
    return (
      <EditCard
        icon={featurePartIcon}
        alt="part"
        title={labelFor?.(instance.handle) || instance.doc_id}
        mark={partFailure(instance.handle, status ?? null)}
        onCommit={onCommitInstance}
        onCancel={onCancelInstance}
      >
        {renderInstanceEditor(instance)}
      </EditCard>
    )
  }

  if (editing.kind === 'mate') {
    const mate = mates.find(m => m.id === editing.id)
    if (!mate) return null
    return (
      <EditCard
        icon={MATE_KIND_ICONS[mate.mate.kind]}
        alt={mate.mate.kind}
        title={mate.mate.label || MATE_KIND_LABELS[mate.mate.kind]}
        mark={mateFailure(mate.id, status ?? null, [mate.mate.ref_a.part, mate.mate.ref_b.part])}
        onCommit={onCommitMate}
        onCancel={onCancelMate}
      >
        {renderMateEditor(mate)}
      </EditCard>
    )
  }

  return null
}
