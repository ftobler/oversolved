import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'

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
  const [isPickingBody, setIsPickingBody] = useState(false)
  const [isPickingPlane, setIsPickingPlane] = useState(false)

  useFieldPicking(isPickingBody, (selectionId) => {
    onMutation({ type: 'set_mirror_field', featureId: fid, field: 'body', value: selectionId })
    setIsPickingBody(false)
  })

  useFieldPicking(isPickingPlane, (selectionId) => {
    const value = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'set_mirror_field', featureId: fid, field: 'plane', value })
    setIsPickingPlane(false)
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Body</span>
        <PickChip
          values={mirror.body ? [mirror.body] : []}
          isPicking={isPickingBody}
          onActivate={() => setIsPickingBody(!isPickingBody)}
          onRemove={() => onMutation({ type: 'set_mirror_field', featureId: fid, field: 'body', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Mirror Plane</span>
        <PickChip
          values={mirror.plane ? [mirror.plane] : []}
          isPicking={isPickingPlane}
          onActivate={() => setIsPickingPlane(!isPickingPlane)}
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
