import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'
import { resolveBodyPickRef } from '@/utils/resolveBodyPickRef'

interface DeleteBodyEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function DeleteBodyEditor({
  feature, onMutation, features, partLabels,
}: DeleteBodyEditorProps) {
  const db = feature.delete_body ?? { body: '' }
  const fid = feature.id
  const [isPickingBody, setIsPickingBody] = useState(false)

  useFieldPicking(isPickingBody, (selectionId) => {
    onMutation({ type: 'set_delete_body_field', featureId: fid, field: 'body', value: resolveBodyPickRef(selectionId) })
    setIsPickingBody(false)
  })

  return (
    <div className="feature-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Body</span>
        <PickChip
          values={db.body ? [db.body] : []}
          isPicking={isPickingBody}
          onActivate={() => setIsPickingBody(!isPickingBody)}
          onRemove={() => onMutation({ type: 'set_delete_body_field', featureId: fid, field: 'body', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
