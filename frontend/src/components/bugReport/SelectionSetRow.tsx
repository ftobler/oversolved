import { useState } from 'react'
import { PickChip } from '@/components/sketch/PickChip'
import { StatusMessage } from '@/components/shared/StatusMessage'
import { useBugReportPick } from '@/hooks/useBugReportPick'
import { useBugReportStore, type SelectionSet } from '@/stores/bugReportStore'
import type { PartFeature } from '@/types/cad'
import { fieldRefusal } from '@/utils/core/statusMark'

interface SelectionSetRowProps {
  set: SelectionSet
  canPick: boolean
  // The bar RIGHT NOW. A pick made at another position is still valid, only
  // not on screen; the row says which position it came from instead of
  // treating it as stale.
  currentRollback: number | null
  features: PartFeature[]
  partLabels: Record<string, string>
  onInsertReference: (name: string) => void
}

export function SelectionSetRow({
  set,
  canPick,
  currentRollback,
  features,
  partLabels,
  onInsertReference,
}: SelectionSetRowProps) {
  const renameSet = useBugReportStore(s => s.renameSet)
  const removeSet = useBugReportStore(s => s.removeSet)
  const removePick = useBugReportStore(s => s.removePick)
  const reorderPick = useBugReportStore(s => s.reorderPick)
  const pickState = useBugReportPick(set.id)

  // The name field mirrors the stored name while idle and owns a local draft
  // only while focused, so a refusal can keep the typed text without writing a
  // bad name into the report.
  const [draft, setDraft] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const shownName = draft ?? set.name

  const commitName = () => {
    if (draft === null) return
    const reason = renameSet(set.id, draft.trim())
    if (reason !== null) {
      setRefusal(reason)
      return
    }
    setRefusal(null)
    setDraft(null)
  }

  const inactiveValues = new Set<string>()
  const valueTitles: Record<string, string> = {}
  // A null bar means the end of the stack, which the tree also reports as the
  // feature count; compare the two forms as one position so a pick made at the
  // end does not dim merely because the bar was dragged there numerically.
  const currentBar = currentRollback ?? features.length
  for (const pick of set.picks) {
    const pickBar = pick.rollback ?? features.length
    if (pickBar === currentBar) continue
    inactiveValues.add(pick.query)
    valueTitles[pick.query] = pick.barFeatureId
      ? `Picked after ${pick.barFeatureId}`
      : pick.rollback === null
        ? 'Picked with the bar at the end'
        : `Picked with the bar at ${pick.rollback}`
  }

  return (
    <div className="bug-report-set">
      <div className="bug-report-set-header">
        <input
          type="text"
          className={`bug-report-set-name${refusal !== null ? ' bug-report-set-name--error' : ''}`}
          aria-label="Selection set name"
          value={shownName}
          onFocus={() => setDraft(set.name)}
          onChange={(e) => { setDraft(e.target.value); setRefusal(null) }}
          onBlur={commitName}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button
          type="button"
          className="bug-report-set-action"
          title="Insert reference"
          aria-label="Insert reference"
          onClick={() => onInsertReference(set.name)}
        >
          #
        </button>
        <button
          type="button"
          className="bug-report-set-action"
          title="Remove selection set"
          aria-label="Remove selection set"
          onClick={() => removeSet(set.id)}
        >
          ×
        </button>
      </div>
      <PickChip
        values={set.picks.map(p => p.query)}
        isPicking={canPick && pickState.isPicking}
        onActivate={canPick ? pickState.toggle : () => {}}
        onRemove={(index) => {
          const pick = set.picks[index]
          if (pick) removePick(set.id, pick.query)
        }}
        onReorder={canPick
          ? (from, to) => reorderPick(set.id, from, to)
          : undefined}
        emptyText={canPick ? 'Click to pick' : undefined}
        features={features}
        partLabels={partLabels}
        inactiveValues={inactiveValues}
        valueTitles={valueTitles}
      />
      <StatusMessage mark={fieldRefusal('Value', refusal)} />
    </div>
  )
}
