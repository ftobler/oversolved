import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { usePickField } from '@/hooks/useFieldPicking'
import { normalizeSweepSketch } from '@/utils/yamlMutations'
import { resolveBodyMergeRef } from '@/utils/resolveBodyPickRef'

interface SweepEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function SweepEditor({
  feature, onMutation, features, partLabels,
}: SweepEditorProps) {
  const sweep = feature.sweep ?? { sketch: [], path: '' }
  const fid = feature.id
  const profiles = normalizeSweepSketch(sweep.sketch)
  const showMergeTarget = sweep.operation !== 'new'

  const sketchPick = usePickField(fid, 'sketch', (selectionId) => {
    const sketchQuery = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'add_sweep_profile', featureId: fid, sketchQuery })
  }, { multi: true })

  const pathPick = usePickField(fid, 'path', (selectionId) => {
    const pathQuery = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'set_sweep_field', featureId: fid, field: 'path', value: pathQuery })
  })

  const mergePick = usePickField(fid, 'merge_target', (selectionId) => {
    onMutation({ type: 'set_sweep_field', featureId: fid, field: 'merge_target', value: resolveBodyMergeRef(selectionId) })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Profile</span>
        <PickChip
          values={profiles}
          isPicking={sketchPick.isPicking}
          onActivate={sketchPick.toggle}
          onRemove={(index) => onMutation({ type: 'remove_sweep_profile', featureId: fid, index })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Path</span>
        <PickChip
          values={sweep.path ? [sweep.path] : []}
          isPicking={pathPick.isPicking}
          onActivate={pathPick.toggle}
          onRemove={() => onMutation({ type: 'set_sweep_field', featureId: fid, field: 'path', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Operation"
          value={sweep.operation ?? 'add'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({
              type: 'set_sweep_field',
              featureId: fid,
              field: 'operation',
              value: e.target.value,
            })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="add">Add</option>
          <option value="cut">Cut</option>
          <option value="new">New</option>
        </select>
      </div>
      {showMergeTarget && (
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Merge Target</span>
          <PickChip
            values={sweep.merge_target ? [sweep.merge_target] : []}
            isPicking={mergePick.isPicking}
            onActivate={mergePick.toggle}
            onRemove={() => onMutation({ type: 'set_sweep_field', featureId: fid, field: 'merge_target', value: undefined })}
            emptyText="(all bodies)"
            features={features}
            partLabels={partLabels}
          />
        </div>
      )}
    </div>
  )
}
