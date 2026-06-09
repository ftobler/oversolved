import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/useFieldPicking'

interface MirrorEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function MirrorEditor({
  feature, onMutation, features, partLabels,
}: MirrorEditorProps) {
  const mirror = feature.mirror ?? { body: '', plane: '', keep_original: true, merge: true }
  const fid = feature.id
  const bodyPick = usePickField(fid, 'body', (selectionId) => {
    onMutation({ type: 'set_mirror_field', featureId: fid, field: 'body', value: selectionId })
  })

  const planePick = usePickField(fid, 'plane', (selectionId) => {
    const value = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'set_mirror_field', featureId: fid, field: 'plane', value })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Body</span>
        <PickChip
          values={mirror.body ? [mirror.body] : []}
          isPicking={bodyPick.isPicking}
          onActivate={bodyPick.toggle}
          onRemove={() => onMutation({ type: 'set_mirror_field', featureId: fid, field: 'body', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Mirror Plane</span>
        <PickChip
          values={mirror.plane ? [mirror.plane] : []}
          isPicking={planePick.isPicking}
          onActivate={planePick.toggle}
          onRemove={() => onMutation({ type: 'set_mirror_field', featureId: fid, field: 'plane', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Keep Original</span>
        <input
          type="checkbox"
          checked={mirror.keep_original ?? true}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMutation({ type: 'set_mirror_field', featureId: fid, field: 'keep_original', value: e.target.checked })}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Merge</span>
        <input
          type="checkbox"
          checked={mirror.merge ?? true}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMutation({ type: 'set_mirror_field', featureId: fid, field: 'merge', value: e.target.checked })}
        />
      </div>
    </div>
  )
}
