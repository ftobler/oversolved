import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PickChip } from '@/components/PickChip'

interface MirrorEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function MirrorEditor({
  feature, onMutation, pendingPickField, setPendingPickField, features, partLabels,
}: MirrorEditorProps) {
  const mirror = feature.mirror ?? { body: '', plane: '', keep_original: true, merge: true }
  const fid = feature.id
  const isPicking = (field: string) => pendingPickField?.featureId === fid && pendingPickField.field === field

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Body</span>
        <PickChip
          values={mirror.body ? [mirror.body] : []}
          isPicking={isPicking('body')}
          onActivate={() => {
            if (isPicking('body')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'body', hostKind: 'mirror' })
          }}
          onRemove={() => onMutation({ type: 'set_mirror_field', featureId: fid, field: 'body', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Mirror Plane</span>
        <PickChip
          values={mirror.plane ? [mirror.plane] : []}
          isPicking={isPicking('plane')}
          onActivate={() => {
            if (isPicking('plane')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'plane', hostKind: 'mirror' })
          }}
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
